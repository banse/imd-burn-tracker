// Keccak-f[1600], with Ethereum's Keccak-256 padding (not FIPS SHA3-256).
// Input: UTF-8 string or Uint8Array. Output: lowercase hex, without 0x.
const MASK = (1n << 64n) - 1n;
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const rot = (v, n) => n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK;
function permute(a) {
  for (const rc of RC) {
    const c = Array.from({length: 5}, (_, x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rot(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) a[x + 5 * y] ^= d;
    }
    const b = Array(25).fill(0n);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rot(a[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x + 5 * y] = b[x + 5 * y] ^ ((~b[(x + 1) % 5 + 5 * y]) & b[(x + 2) % 5 + 5 * y]);
    a[0] ^= rc;
  }
}
export function keccak256Bytes(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('keccak256 expects a string or Uint8Array');
  const rate = 136;
  const padded = new Uint8Array((Math.floor(bytes.length / rate) + 1) * rate);
  padded.set(bytes); padded[bytes.length] = 0x01; padded[padded.length - 1] |= 0x80;
  const a = Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate; i++) a[Math.floor(i / 8)] ^= BigInt(padded[offset + i]) << BigInt((i % 8) * 8);
    permute(a);
  }
  return Uint8Array.from({length: 32}, (_, i) => Number((a[Math.floor(i / 8)] >> BigInt((i % 8) * 8)) & 255n));
}
export function keccak256(input) { return Buffer.from(keccak256Bytes(input)).toString('hex'); }
export function selector(signature) { return '0x' + keccak256(signature).slice(0, 8); }
// Mirrors the reference's literal UTF-8 labels; callers supply normalized ENS names.
export function namehash(name) {
  let node = new Uint8Array(32);
  if (name) for (const label of name.split('.').reverse()) {
    const joined = new Uint8Array(64);
    joined.set(node); joined.set(keccak256Bytes(label), 32); node = keccak256Bytes(joined);
  }
  return Buffer.from(node).toString('hex');
}
