/**
 * SubTrans Extension — Edge TTS Sec-MS-GEC v2 DRM Token Generator
 * Port thuần TypeScript từ rany2/edge-tts (drm.py, Sec-MS-GEC-Version 2-143.0.3650.75).
 * Dùng Math.imul + >>> 0 cho toàn bộ phép nhân/cộng 32-bit unsigned không mất độ chính xác.
 */

const WIN_EPOCH_SEC = 11644473600n;
const FIVE_MIN_SEC = 300n;
const TICKS_PER_SEC = 10000000n;

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a,
  0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
] as const;

const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba,
  0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
  0xd258b060, 0x72766564,
] as const;

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;

const CS64_COEFFICIENTS: ReadonlyArray<readonly [number, number]> = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];

const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

function rotr32(v: number, n: number): number {
  return ((v >>> n) | (v << (32 - n))) >>> 0;
}

function rol16(v: number): number {
  return ((v << 16) | (v >>> 16)) >>> 0;
}

function sigma0(v: number): number {
  return (rotr32(v, 7) ^ rotr32(v, 18) ^ (v >>> 3)) >>> 0;
}

function sigma1(v: number): number {
  return (rotr32(v, 17) ^ rotr32(v, 19) ^ (v >>> 10)) >>> 0;
}

function bigSigma0(v: number): number {
  return (rotr32(v, 2) ^ rotr32(v, 13) ^ rotr32(v, 22)) >>> 0;
}

function bigSigma1(v: number): number {
  return (rotr32(v, 6) ^ rotr32(v, 11) ^ rotr32(v, 25)) >>> 0;
}

function expandSha256Schedule(words: number[], firstWord = 16): void {
  for (let i = firstWord; i < 64; i++) {
    const x = words[i - 2];
    const y = words[i - 15];
    words[i] = (sigma1(x) + words[i - 7] + sigma0(y) + words[i - 16]) >>> 0;
  }
}

function sha256Rounds(
  state: readonly number[],
  words: readonly number[],
  firstRound = 0
): number[] {
  let [a, b, c, d, e, f, g, h] = state;
  const constants =
    firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;

  for (let i = firstRound; i < 64; i++) {
    const t1 =
      (h + bigSigma1(e) + ((g ^ (e & (f ^ g))) >>> 0) + constants[i] + words[i]) >>> 0;
    const t2 = (bigSigma0(a) + (((a & b) | (c & (a | b))) >>> 0)) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

function sha256Init(first7: Uint8Array): number[] {
  const words = new Array<number>(64).fill(0);
  words[14] = ((first7[0] << 16) | (first7[1] << 8) | first7[2]) >>> 0;
  words[15] =
    ((first7[3] << 24) | (first7[4] << 16) | (first7[5] << 8) | first7[6]) >>> 0;

  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) {
      const s1 = sigma1(words[i - 2]);
      value = (value + (i === 16 ? (s1 ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0 : s1)) >>> 0;
    }
    if (i - 7 >= 14) {
      value = (value + words[i - 7]) >>> 0;
    }
    if (i - 15 >= 14) {
      const s0 = sigma0(words[i - 15]);
      value = (value + (i === 29 ? (s0 ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0 : s0)) >>> 0;
    }
    words[i] = value >>> 0;
  }

  words[30] =
    (sigma1(words[28]) +
      words[23] +
      sigma0(words[15]) +
      words[14] +
      SHA256_ADJUSTMENT -
      SHA256_ROUND_CONSTANTS[14]) >>>
    0;

  expandSha256Schedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, idx) => (x + working[idx]) >>> 0);
}

function sha256Digest(data: Uint8Array): Uint8Array {
  if (data.length < 7) {
    throw new Error("Token salt must contain at least seven bytes");
  }
  const length = 57 + data.length;
  const tail = data.subarray(7);
  const zeroPadLen = (((55 - length) % 64) + 64) % 64;
  const padded = new Uint8Array(tail.length + 1 + zeroPadLen + 8);
  padded.set(tail, 0);
  padded[tail.length] = 0x80;
  const dv = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const bitLen = BigInt(length) * 8n;
  dv.setUint32(padded.length - 8, Number((bitLen >> 32n) & 0xffffffffn), false);
  dv.setUint32(padded.length - 4, Number(bitLen & 0xffffffffn), false);

  let state = sha256Init(data.subarray(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Array<number>(64);
    for (let i = 0; i < 16; i++) {
      words[i] = dv.getUint32(offset + i * 4, false);
    }
    expandSha256Schedule(words, 16);
    const working = sha256Rounds(state, words, 0);
    state = state.map((x, idx) => (x + working[idx]) >>> 0);
  }

  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    outDv.setUint32(i * 4, state[i], false);
  }
  return out;
}

function wordsLe4Even(data: Uint8Array): number[] {
  const padLen = (4 - (data.length % 4)) % 4;
  const total = data.length + padLen;
  if (total === 0) return [];
  const padded = new Uint8Array(total);
  padded.set(data, 0);
  const dv = new DataView(padded.buffer);
  const words: number[] = [];
  for (let i = 0; i < total; i += 4) {
    words.push(dv.getUint32(i, true));
  }
  if (words.length % 2 === 1) {
    words.push(0);
  }
  return words;
}

function cs64Digest(data: Uint8Array, digest: Uint8Array): [number, number] {
  const dv = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const keyA = (dv.getUint32(0, true) | 1) >>> 0;
  const keyB = (dv.getUint32(4, true) | 1) >>> 0;
  const factorA = Math.imul(keyA, CS64_FACTOR) >>> 0;
  const factorB = Math.imul(keyB, CS64_FACTOR) >>> 0;

  const terms: number[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < CS64_COEFFICIENTS.length; i++) {
    const [coeff, off] = CS64_COEFFICIENTS[i];
    terms.push(Math.imul(coeff, i % 2 === 0 ? factorA : factorB) >>> 0);
    offsets.push(off >>> 0);
  }

  const prefixed = new Uint8Array(1 + data.length);
  prefixed[0] = 0;
  prefixed.set(data, 1);

  const words = wordsLe4Even(prefixed);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    let term = Math.imul(word, i % 2 === 0 ? keyA : keyB) >>> 0;
    let offset = Math.imul(rol16(word), i % 2 === 0 ? 0xef0569fb : 0xc31713db) >>> 0;
    if (i === 0) {
      term = (term + (Math.imul(CS64_ADJUSTMENT0, factorA) >>> 0)) >>> 0;
      offset = (offset + CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  }

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;

  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i];
    const y = terms[i + 1];

    let t = rol16((offsets[i] + x) >>> 0);
    let q = Math.imul(t, 0x76f50f34) >>> 0;
    swapAcc = (swapAcc + (((Math.imul(rol16(q), 0xc3efea97) >>> 0) + q) >>> 0)) >>> 0;

    t = rol16((offsets[i + 1] + y) >>> 0);
    q = Math.imul(t, 0x1881ce3c) >>> 0;
    swapLast = ((Math.imul(rol16(q), 0x35bd1ec9) >>> 0) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = ((Math.imul(state, keyA) >>> 0) + x) >>> 0;
    state = Math.imul(rol16(state), 0xcf98b111) >>> 0;
    state = Math.imul(rol16(state), 0x87085b9f) >>> 0;
    state = Math.imul(rol16(state), 0x12ceb96d) >>> 0;
    state = Math.imul(rol16(state), 0x257e1d83) >>> 0;
    acc = (acc + state) >>> 0;

    t = ((Math.imul(state, keyB) >>> 0) + y) >>> 0;
    t = Math.imul(rol16(t), 0xa27416f5) >>> 0;
    t = Math.imul(rol16(t), 0xd38396ff) >>> 0;
    state = Math.imul(rol16(Math.imul(rol16(t), 0x7c932b89) >>> 0), 0xbfa49f69) >>> 0;
    acc = (acc + state) >>> 0;
  }

  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

function bytesToUpperHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out.toUpperCase();
}

/**
 * Sinh token Sec-MS-GEC v2 định dạng "<16 HEX>-<64 HEX>".
 */
export function generateSecMsGecV2(
  trustedClientToken: string,
  nowMs = Date.now(),
  clockSkewSec = 0
): string {
  const unixSec = Math.floor(nowMs / 1000) + Math.round(clockSkewSec);
  let ticks = BigInt(unixSec) + WIN_EPOCH_SEC;
  ticks -= ticks % FIVE_MIN_SEC;
  const ticks100ns = ticks * TICKS_PER_SEC;
  const strToHash = `${ticks100ns.toString()}${trustedClientToken}`;
  const data = new TextEncoder().encode(strToHash);

  const digest = sha256Digest(data);
  const [w0, w1] = cs64Digest(data, digest);
  const cs64Bytes = new Uint8Array(8);
  const csDv = new DataView(cs64Bytes.buffer);
  csDv.setUint32(0, w0, true);
  csDv.setUint32(4, w1, true);

  return `${bytesToUpperHex(cs64Bytes)}-${bytesToUpperHex(digest)}`;
}

export function generateRandomMuid(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytesToUpperHex(bytes);
}
