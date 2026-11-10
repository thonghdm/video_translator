// Script đóng gói extension: nén dist/ thành release/subtrans-extension-v<version>.zip
// Sử dụng thuần Node.js (node:fs, node:path, node:zlib), không phụ thuộc công cụ ngoài.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import * as zlib from "node:zlib";

const { deflateRawSync, inflateRawSync } = zlib;

// zlib.crc32 chỉ có từ Node 20.15 / 22.2 → tự cài CRC-32 (IEEE) để chạy được trên Node 18 như README ghi.
let CRC_TABLE = null;
function crc32Fallback(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const crc32 =
  typeof zlib.crc32 === "function" && !process.env.SUBTRANS_ZIP_FORCE_JS_CRC ? zlib.crc32 : crc32Fallback;

function toDosDateTime(d = new Date()) {
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = Math.floor(d.getSeconds() / 2);
  return {
    dosTime: (hours << 11) | (minutes << 5) | seconds,
    dosDate: ((year - 1980) << 9) | (month << 5) | day
  };
}

function collectFiles(dir, baseDir = dir) {
  const result = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry.startsWith(".")) continue; // bỏ file/thư mục ẩn (.vite, .DS_Store...)
    const fullPath = join(dir, entry);
    const st = statSync(fullPath);
    if (st.isDirectory()) {
      result.push(...collectFiles(fullPath, baseDir));
    } else if (st.isFile()) {
      const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");
      result.push({
        name: relPath,
        mtime: st.mtime,
        data: readFileSync(fullPath)
      });
    }
  }
  return result;
}

function buildZip(files) {
  files.sort((a, b) => a.name.localeCompare(b.name));

  const localChunks = [];
  const cdChunks = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const dataBuf = f.data;
    const uncompressedSize = dataBuf.length;
    const crc = crc32(dataBuf);
    const compressed = uncompressedSize > 0 ? deflateRawSync(dataBuf) : Buffer.alloc(0);
    const method = uncompressedSize > 0 ? 8 : 0;
    const compressedSize = compressed.length;
    const { dosTime, dosDate } = toDosDateTime(f.mtime);

    // Local file header (30 bytes)
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // signature
    lh.writeUInt16LE(20, 4);         // version needed: 2.0
    lh.writeUInt16LE(0x0800, 6);     // flags: UTF-8 filename
    lh.writeUInt16LE(method, 8);     // method: 8 (deflate) hoặc 0 (stored)
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressedSize, 18);
    lh.writeUInt32LE(uncompressedSize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);         // extra field len

    localChunks.push(lh, nameBuf, compressed);

    // Central directory header (46 bytes)
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // signature
    cd.writeUInt16LE(20, 4);         // version made by
    cd.writeUInt16LE(20, 6);         // version needed
    cd.writeUInt16LE(0x0800, 8);     // flags: UTF-8
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressedSize, 20);
    cd.writeUInt32LE(uncompressedSize, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);         // extra len
    cd.writeUInt16LE(0, 32);         // comment len
    cd.writeUInt16LE(0, 34);         // disk number start
    cd.writeUInt16LE(0, 36);         // internal attrs
    cd.writeUInt32LE(0x81a40000, 38);// external attrs (-rw-r--r--)
    cd.writeUInt32LE(offset, 42);    // local header offset

    cdChunks.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + compressed.length;
  }

  const cdOffset = offset;
  const cdSize = cdChunks.reduce((acc, c) => acc + c.length, 0);

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4);          // disk number
  eocd.writeUInt16LE(0, 6);          // cd start disk
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);         // comment len

  return Buffer.concat([...localChunks, ...cdChunks, eocd]);
}

const distDir = "dist";
if (!existsSync(distDir)) {
  console.error("[zip] LỖI: Thư mục dist/ không tồn tại. Hãy chạy 'pnpm run build' trước.");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version || "0.1.0";
const releaseDir = "release";
mkdirSync(releaseDir, { recursive: true });

const files = collectFiles(distDir);
if (files.length === 0) {
  console.error("[zip] LỖI: Thư mục dist/ không có file nào.");
  process.exit(1);
}

const zipBuffer = buildZip(files);
const zipFileName = `subtrans-extension-v${version}.zip`;
const zipFilePath = join(releaseDir, zipFileName);

writeFileSync(zipFilePath, zipBuffer);

// Tự kiểm tra: đọc lại central directory, giải nén từng file và so CRC + nội dung với dist/
function verifyZip(buf, expected) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("thiếu End of Central Directory");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count !== expected.length) throw new Error(`số file ${count} ≠ ${expected.length}`);
  const byName = new Map(expected.map((f) => [f.name, f.data]));
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("central directory hỏng");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const raw = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    const orig = byName.get(name);
    if (!orig || !orig.equals(data) || crc32(data) !== crc) throw new Error(`nội dung sai: ${name}`);
    p += 46 + nlen + elen + clen;
  }
}
try {
  verifyZip(zipBuffer, files);
} catch (err) {
  console.error(`[zip] LỖI: file zip không hợp lệ (${err.message})`);
  process.exit(1);
}
if (!files.some((f) => f.name === "manifest.json")) {
  console.error("[zip] LỖI: zip không có manifest.json ở gốc");
  process.exit(1);
}

const kb = (zipBuffer.length / 1024).toFixed(1);
console.log(`[zip] Created ${zipFilePath} (${kb} KB, ${files.length} files)`);

// 2. Tạo bản đóng gói tương thích riêng cho Mozilla Firefox (AMO)
const firefoxFiles = files.map((f) => {
  if (f.name !== "manifest.json") return f;
  const manifestObj = JSON.parse(f.data.toString("utf8"));
  manifestObj.browser_specific_settings = {
    gecko: {
      id: "subtrans-extension@thonghdm.com",
      strict_min_version: "115.0",
      data_collection_permissions: {
        required: ["none"]
      }
    }
  };
  if (manifestObj.background && manifestObj.background.service_worker) {
    manifestObj.background.scripts = [manifestObj.background.service_worker];
  }
  delete manifestObj.minimum_chrome_version;
  return {
    name: f.name,
    mtime: f.mtime,
    data: Buffer.from(JSON.stringify(manifestObj, null, 2), "utf8")
  };
});

const ffZipBuffer = buildZip(firefoxFiles);
const ffZipFileName = `subtrans-extension-firefox-v${version}.zip`;
const ffZipFilePath = join(releaseDir, ffZipFileName);
writeFileSync(ffZipFilePath, ffZipBuffer);
try {
  verifyZip(ffZipBuffer, firefoxFiles);
} catch (err) {
  console.error(`[zip] LỖI: file zip Firefox không hợp lệ (${err.message})`);
  process.exit(1);
}
const ffKb = (ffZipBuffer.length / 1024).toFixed(1);
console.log(`[zip] Created ${ffZipFilePath} (${ffKb} KB, ${firefoxFiles.length} files) [Firefox AMO]`);
