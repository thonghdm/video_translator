// Script đóng gói extension: nén dist/ thành release/subtrans-extension-v<version>.zip
// Sử dụng thuần Node.js (node:fs, node:path, node:zlib), không phụ thuộc công cụ ngoài.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

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

const kb = (zipBuffer.length / 1024).toFixed(1);
console.log(`[zip] Created ${zipFilePath} (${kb} KB, ${files.length} files)`);
