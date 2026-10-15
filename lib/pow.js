/**
 * DeepSeekHashV1 — the proof-of-work hash DeepSeek's web app requires before
 * `/api/v0/chat/completion`.
 *
 * It is SHA3-256 with one deviation: Keccak-f[1600] runs rounds 1..23 and
 * skips round 0. Every lane is a 64-bit word, carried here as a pair of 32-bit
 * halves (`L`/`H`) because the search tries ~10^5 candidates and BigInt would
 * be orders of magnitude too slow.
 *
 * Ported from the reference Go implementation and validated against the same
 * vectors its tests use.
 */

/**
 * Iota round constants, split into 32-bit halves, indexed by round number.
 * Round 0 is skipped entirely, so `RC_LO[0]` is never applied — it is kept so
 * the index still means "round r".
 */
const RC_LO = new Uint32Array([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001,
  0x80008081, 0x00008009, 0x0000008a, 0x00000088, 0x80008009, 0x8000000a,
  0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080,
  0x0000800a, 0x8000000a, 0x80008081, 0x00008080, 0x80000001, 0x80008008,
]);
const RC_HI = new Uint32Array([
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000,
  0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x00000000, 0x00000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000,
  0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
]);

const RATE = 136;

/**
 * One Keccak-f[1600] permutation restricted to rounds 1..23, in place.
 *
 * Rotation amounts follow the reference's `b<dst> := rotl64(a<src>, k)` table.
 * Note that a left rotation by k >= 32 is a rotation by k-32 with the halves
 * exchanged, which is why several lanes below read `h` where the amount looks
 * small.
 */
function keccakF23(L, H) {
  let a0l = L[0], a1l = L[1], a2l = L[2], a3l = L[3], a4l = L[4];
  let a5l = L[5], a6l = L[6], a7l = L[7], a8l = L[8], a9l = L[9];
  let a10l = L[10], a11l = L[11], a12l = L[12], a13l = L[13], a14l = L[14];
  let a15l = L[15], a16l = L[16], a17l = L[17], a18l = L[18], a19l = L[19];
  let a20l = L[20], a21l = L[21], a22l = L[22], a23l = L[23], a24l = L[24];
  let a0h = H[0], a1h = H[1], a2h = H[2], a3h = H[3], a4h = H[4];
  let a5h = H[5], a6h = H[6], a7h = H[7], a8h = H[8], a9h = H[9];
  let a10h = H[10], a11h = H[11], a12h = H[12], a13h = H[13], a14h = H[14];
  let a15h = H[15], a16h = H[16], a17h = H[17], a18h = H[18], a19h = H[19];
  let a20h = H[20], a21h = H[21], a22h = H[22], a23h = H[23], a24h = H[24];

  for (let r = 1; r < 24; r++) {
    // theta
    const c0l = a0l ^ a5l ^ a10l ^ a15l ^ a20l;
    const c1l = a1l ^ a6l ^ a11l ^ a16l ^ a21l;
    const c2l = a2l ^ a7l ^ a12l ^ a17l ^ a22l;
    const c3l = a3l ^ a8l ^ a13l ^ a18l ^ a23l;
    const c4l = a4l ^ a9l ^ a14l ^ a19l ^ a24l;
    const c0h = a0h ^ a5h ^ a10h ^ a15h ^ a20h;
    const c1h = a1h ^ a6h ^ a11h ^ a16h ^ a21h;
    const c2h = a2h ^ a7h ^ a12h ^ a17h ^ a22h;
    const c3h = a3h ^ a8h ^ a13h ^ a18h ^ a23h;
    const c4h = a4h ^ a9h ^ a14h ^ a19h ^ a24h;

    const d0l = (c4l ^ ((c1l << 1) | (c1h >>> 31))) >>> 0;
    const d0h = (c4h ^ ((c1h << 1) | (c1l >>> 31))) >>> 0;
    const d1l = (c0l ^ ((c2l << 1) | (c2h >>> 31))) >>> 0;
    const d1h = (c0h ^ ((c2h << 1) | (c2l >>> 31))) >>> 0;
    const d2l = (c1l ^ ((c3l << 1) | (c3h >>> 31))) >>> 0;
    const d2h = (c1h ^ ((c3h << 1) | (c3l >>> 31))) >>> 0;
    const d3l = (c2l ^ ((c4l << 1) | (c4h >>> 31))) >>> 0;
    const d3h = (c2h ^ ((c4h << 1) | (c4l >>> 31))) >>> 0;
    const d4l = (c3l ^ ((c0l << 1) | (c0h >>> 31))) >>> 0;
    const d4h = (c3h ^ ((c0h << 1) | (c0l >>> 31))) >>> 0;

    a0l = (a0l ^ d0l) >>> 0; a0h = (a0h ^ d0h) >>> 0;
    a5l = (a5l ^ d0l) >>> 0; a5h = (a5h ^ d0h) >>> 0;
    a10l = (a10l ^ d0l) >>> 0; a10h = (a10h ^ d0h) >>> 0;
    a15l = (a15l ^ d0l) >>> 0; a15h = (a15h ^ d0h) >>> 0;
    a20l = (a20l ^ d0l) >>> 0; a20h = (a20h ^ d0h) >>> 0;
    a1l = (a1l ^ d1l) >>> 0; a1h = (a1h ^ d1h) >>> 0;
    a6l = (a6l ^ d1l) >>> 0; a6h = (a6h ^ d1h) >>> 0;
    a11l = (a11l ^ d1l) >>> 0; a11h = (a11h ^ d1h) >>> 0;
    a16l = (a16l ^ d1l) >>> 0; a16h = (a16h ^ d1h) >>> 0;
    a21l = (a21l ^ d1l) >>> 0; a21h = (a21h ^ d1h) >>> 0;
    a2l = (a2l ^ d2l) >>> 0; a2h = (a2h ^ d2h) >>> 0;
    a7l = (a7l ^ d2l) >>> 0; a7h = (a7h ^ d2h) >>> 0;
    a12l = (a12l ^ d2l) >>> 0; a12h = (a12h ^ d2h) >>> 0;
    a17l = (a17l ^ d2l) >>> 0; a17h = (a17h ^ d2h) >>> 0;
    a22l = (a22l ^ d2l) >>> 0; a22h = (a22h ^ d2h) >>> 0;
    a3l = (a3l ^ d3l) >>> 0; a3h = (a3h ^ d3h) >>> 0;
    a8l = (a8l ^ d3l) >>> 0; a8h = (a8h ^ d3h) >>> 0;
    a13l = (a13l ^ d3l) >>> 0; a13h = (a13h ^ d3h) >>> 0;
    a18l = (a18l ^ d3l) >>> 0; a18h = (a18h ^ d3h) >>> 0;
    a23l = (a23l ^ d3l) >>> 0; a23h = (a23h ^ d3h) >>> 0;
    a4l = (a4l ^ d4l) >>> 0; a4h = (a4h ^ d4h) >>> 0;
    a9l = (a9l ^ d4l) >>> 0; a9h = (a9h ^ d4h) >>> 0;
    a14l = (a14l ^ d4l) >>> 0; a14h = (a14h ^ d4h) >>> 0;
    a19l = (a19l ^ d4l) >>> 0; a19h = (a19h ^ d4h) >>> 0;
    a24l = (a24l ^ d4l) >>> 0; a24h = (a24h ^ d4h) >>> 0;

    // rho + pi, fused into the destination-indexed temporaries chi consumes.
    // b<dst> = rotl64(a<src>, k):
    //   0<-0(0)  1<-6(44)  2<-12(43) 3<-18(21) 4<-24(14)
    //   5<-3(28) 6<-9(20)  7<-10(3)  8<-16(45) 9<-22(61)
    //  10<-1(1) 11<-7(6) 12<-13(25) 13<-19(8) 14<-20(18)
    //  15<-4(27) 16<-5(36) 17<-11(10) 18<-17(15) 19<-23(56)
    //  20<-2(62) 21<-8(55) 22<-14(39) 23<-15(41) 24<-21(2)
    const b0l = a0l, b0h = a0h;
    const b1l = ((a6h << 12) | (a6l >>> 20)) >>> 0;
    const b1h = ((a6l << 12) | (a6h >>> 20)) >>> 0;
    const b2l = ((a12h << 11) | (a12l >>> 21)) >>> 0;
    const b2h = ((a12l << 11) | (a12h >>> 21)) >>> 0;
    const b3l = ((a18l << 21) | (a18h >>> 11)) >>> 0;
    const b3h = ((a18h << 21) | (a18l >>> 11)) >>> 0;
    const b4l = ((a24l << 14) | (a24h >>> 18)) >>> 0;
    const b4h = ((a24h << 14) | (a24l >>> 18)) >>> 0;
    const b5l = ((a3l << 28) | (a3h >>> 4)) >>> 0;
    const b5h = ((a3h << 28) | (a3l >>> 4)) >>> 0;
    const b6l = ((a9l << 20) | (a9h >>> 12)) >>> 0;
    const b6h = ((a9h << 20) | (a9l >>> 12)) >>> 0;
    const b7l = ((a10l << 3) | (a10h >>> 29)) >>> 0;
    const b7h = ((a10h << 3) | (a10l >>> 29)) >>> 0;
    const b8l = ((a16h << 13) | (a16l >>> 19)) >>> 0;
    const b8h = ((a16l << 13) | (a16h >>> 19)) >>> 0;
    const b9l = ((a22h << 29) | (a22l >>> 3)) >>> 0;
    const b9h = ((a22l << 29) | (a22h >>> 3)) >>> 0;
    const b10l = ((a1l << 1) | (a1h >>> 31)) >>> 0;
    const b10h = ((a1h << 1) | (a1l >>> 31)) >>> 0;
    const b11l = ((a7l << 6) | (a7h >>> 26)) >>> 0;
    const b11h = ((a7h << 6) | (a7l >>> 26)) >>> 0;
    const b12l = ((a13l << 25) | (a13h >>> 7)) >>> 0;
    const b12h = ((a13h << 25) | (a13l >>> 7)) >>> 0;
    const b13l = ((a19l << 8) | (a19h >>> 24)) >>> 0;
    const b13h = ((a19h << 8) | (a19l >>> 24)) >>> 0;
    const b14l = ((a20l << 18) | (a20h >>> 14)) >>> 0;
    const b14h = ((a20h << 18) | (a20l >>> 14)) >>> 0;
    const b15l = ((a4l << 27) | (a4h >>> 5)) >>> 0;
    const b15h = ((a4h << 27) | (a4l >>> 5)) >>> 0;
    const b16l = ((a5h << 4) | (a5l >>> 28)) >>> 0;
    const b16h = ((a5l << 4) | (a5h >>> 28)) >>> 0;
    const b17l = ((a11l << 10) | (a11h >>> 22)) >>> 0;
    const b17h = ((a11h << 10) | (a11l >>> 22)) >>> 0;
    const b18l = ((a17l << 15) | (a17h >>> 17)) >>> 0;
    const b18h = ((a17h << 15) | (a17l >>> 17)) >>> 0;
    const b19l = ((a23h << 24) | (a23l >>> 8)) >>> 0;
    const b19h = ((a23l << 24) | (a23h >>> 8)) >>> 0;
    const b20l = ((a2h << 30) | (a2l >>> 2)) >>> 0;
    const b20h = ((a2l << 30) | (a2h >>> 2)) >>> 0;
    const b21l = ((a8h << 23) | (a8l >>> 9)) >>> 0;
    const b21h = ((a8l << 23) | (a8h >>> 9)) >>> 0;
    const b22l = ((a14h << 7) | (a14l >>> 25)) >>> 0;
    const b22h = ((a14l << 7) | (a14h >>> 25)) >>> 0;
    const b23l = ((a15h << 9) | (a15l >>> 23)) >>> 0;
    const b23h = ((a15l << 9) | (a15h >>> 23)) >>> 0;
    const b24l = ((a21l << 2) | (a21h >>> 30)) >>> 0;
    const b24h = ((a21h << 2) | (a21l >>> 30)) >>> 0;

    // chi + iota
    a0l = (b0l ^ (~b1l & b2l)) >>> 0; a0h = (b0h ^ (~b1h & b2h)) >>> 0;
    a1l = (b1l ^ (~b2l & b3l)) >>> 0; a1h = (b1h ^ (~b2h & b3h)) >>> 0;
    a2l = (b2l ^ (~b3l & b4l)) >>> 0; a2h = (b2h ^ (~b3h & b4h)) >>> 0;
    a3l = (b3l ^ (~b4l & b0l)) >>> 0; a3h = (b3h ^ (~b4h & b0h)) >>> 0;
    a4l = (b4l ^ (~b0l & b1l)) >>> 0; a4h = (b4h ^ (~b0h & b1h)) >>> 0;
    a5l = (b5l ^ (~b6l & b7l)) >>> 0; a5h = (b5h ^ (~b6h & b7h)) >>> 0;
    a6l = (b6l ^ (~b7l & b8l)) >>> 0; a6h = (b6h ^ (~b7h & b8h)) >>> 0;
    a7l = (b7l ^ (~b8l & b9l)) >>> 0; a7h = (b7h ^ (~b8h & b9h)) >>> 0;
    a8l = (b8l ^ (~b9l & b5l)) >>> 0; a8h = (b8h ^ (~b9h & b5h)) >>> 0;
    a9l = (b9l ^ (~b5l & b6l)) >>> 0; a9h = (b9h ^ (~b5h & b6h)) >>> 0;
    a10l = (b10l ^ (~b11l & b12l)) >>> 0; a10h = (b10h ^ (~b11h & b12h)) >>> 0;
    a11l = (b11l ^ (~b12l & b13l)) >>> 0; a11h = (b11h ^ (~b12h & b13h)) >>> 0;
    a12l = (b12l ^ (~b13l & b14l)) >>> 0; a12h = (b12h ^ (~b13h & b14h)) >>> 0;
    a13l = (b13l ^ (~b14l & b10l)) >>> 0; a13h = (b13h ^ (~b14h & b10h)) >>> 0;
    a14l = (b14l ^ (~b10l & b11l)) >>> 0; a14h = (b14h ^ (~b10h & b11h)) >>> 0;
    a15l = (b15l ^ (~b16l & b17l)) >>> 0; a15h = (b15h ^ (~b16h & b17h)) >>> 0;
    a16l = (b16l ^ (~b17l & b18l)) >>> 0; a16h = (b16h ^ (~b17h & b18h)) >>> 0;
    a17l = (b17l ^ (~b18l & b19l)) >>> 0; a17h = (b17h ^ (~b18h & b19h)) >>> 0;
    a18l = (b18l ^ (~b19l & b15l)) >>> 0; a18h = (b18h ^ (~b19h & b15h)) >>> 0;
    a19l = (b19l ^ (~b15l & b16l)) >>> 0; a19h = (b19h ^ (~b15h & b16h)) >>> 0;
    a20l = (b20l ^ (~b21l & b22l)) >>> 0; a20h = (b20h ^ (~b21h & b22h)) >>> 0;
    a21l = (b21l ^ (~b22l & b23l)) >>> 0; a21h = (b21h ^ (~b22h & b23h)) >>> 0;
    a22l = (b22l ^ (~b23l & b24l)) >>> 0; a22h = (b22h ^ (~b23h & b24h)) >>> 0;
    a23l = (b23l ^ (~b24l & b20l)) >>> 0; a23h = (b23h ^ (~b24h & b20h)) >>> 0;
    a24l = (b24l ^ (~b20l & b21l)) >>> 0; a24h = (b24h ^ (~b20h & b21h)) >>> 0;

    a0l = (a0l ^ RC_LO[r]) >>> 0;
    a0h = (a0h ^ RC_HI[r]) >>> 0;
  }

  L[0] = a0l; L[1] = a1l; L[2] = a2l; L[3] = a3l; L[4] = a4l;
  L[5] = a5l; L[6] = a6l; L[7] = a7l; L[8] = a8l; L[9] = a9l;
  L[10] = a10l; L[11] = a11l; L[12] = a12l; L[13] = a13l; L[14] = a14l;
  L[15] = a15l; L[16] = a16l; L[17] = a17l; L[18] = a18l; L[19] = a19l;
  L[20] = a20l; L[21] = a21l; L[22] = a22l; L[23] = a23l; L[24] = a24l;
  H[0] = a0h; H[1] = a1h; H[2] = a2h; H[3] = a3h; H[4] = a4h;
  H[5] = a5h; H[6] = a6h; H[7] = a7h; H[8] = a8h; H[9] = a9h;
  H[10] = a10h; H[11] = a11h; H[12] = a12h; H[13] = a13h; H[14] = a14h;
  H[15] = a15h; H[16] = a16h; H[17] = a17h; H[18] = a18h; H[19] = a19h;
  H[20] = a20h; H[21] = a21h; H[22] = a22h; H[23] = a23h; H[24] = a24h;
}

/** XOR 136 bytes of `buf` starting at `off` into the state's rate lanes. */
function absorbBlock(L, H, buf, off) {
  for (let i = 0; i < 17; i++) {
    const p = off + i * 8;
    const lo = (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0;
    const hi = (buf[p + 4] | (buf[p + 5] << 8) | (buf[p + 6] << 16) | (buf[p + 7] << 24)) >>> 0;
    L[i] = (L[i] ^ lo) >>> 0;
    H[i] = (H[i] ^ hi) >>> 0;
  }
}

/**
 * DeepSeekHashV1 digest of `data`.
 * @param {Uint8Array} data
 * @returns {Uint8Array} 32 bytes, little-endian lanes 0..3
 */
export function deepseekHashV1(data) {
  const L = new Uint32Array(25);
  const H = new Uint32Array(25);
  let off = 0;
  while (off + RATE <= data.length) {
    absorbBlock(L, H, data, off);
    keccakF23(L, H);
    off += RATE;
  }
  const final = new Uint8Array(RATE);
  final.set(data.subarray(off));
  final[data.length - off] = 0x06;
  final[RATE - 1] |= 0x80;
  absorbBlock(L, H, final, 0);
  keccakF23(L, H);

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    out[i * 8] = L[i] & 0xff;
    out[i * 8 + 1] = (L[i] >>> 8) & 0xff;
    out[i * 8 + 2] = (L[i] >>> 16) & 0xff;
    out[i * 8 + 3] = (L[i] >>> 24) & 0xff;
    out[i * 8 + 4] = H[i] & 0xff;
    out[i * 8 + 5] = (H[i] >>> 8) & 0xff;
    out[i * 8 + 6] = (H[i] >>> 16) & 0xff;
    out[i * 8 + 7] = (H[i] >>> 24) & 0xff;
  }
  return out;
}

/** Hex digest, for logging and test comparison. */
export function deepseekHashV1Hex(data) {
  return Buffer.from(deepseekHashV1(data)).toString('hex');
}

/** `"<salt>_<expire_at>_"` — the prefix every candidate hashes under. */
export function buildPrefix(salt, expireAt) {
  return `${salt}_${expireAt}_`;
}

/**
 * Search `nonce ∈ [0, difficulty)` for the one whose digest equals `challengeHex`.
 *
 * The prefix is absorbed once into a base state; each candidate then only pays
 * for its own final block. Yields to the event loop periodically so a long
 * search cannot wedge the host process.
 *
 * @param {string} challengeHex 64 lowercase hex chars
 * @param {string} salt
 * @param {number|string} expireAt
 * @param {number} difficulty
 * @param {{ signal?: AbortSignal, onProgress?: (tried: number, total: number) => void }} [options]
 * @returns {Promise<number>} the answer nonce
 */
export async function solvePow(challengeHex, salt, expireAt, difficulty, options = {}) {
  if (typeof challengeHex !== 'string' || challengeHex.length !== 64) {
    throw new Error('pow: challenge must be 64 hex chars');
  }
  const target = new Uint8Array(32);
  for (let i = 0; i < 32; i++) target[i] = parseInt(challengeHex.substr(i * 2, 2), 16);
  const t0l = (target[0] | (target[1] << 8) | (target[2] << 16) | (target[3] << 24)) >>> 0;
  const t0h = (target[4] | (target[5] << 8) | (target[6] << 16) | (target[7] << 24)) >>> 0;
  const t1l = (target[8] | (target[9] << 8) | (target[10] << 16) | (target[11] << 24)) >>> 0;
  const t1h = (target[12] | (target[13] << 8) | (target[14] << 16) | (target[15] << 24)) >>> 0;
  const t2l = (target[16] | (target[17] << 8) | (target[18] << 16) | (target[19] << 24)) >>> 0;
  const t2h = (target[20] | (target[21] << 8) | (target[22] << 16) | (target[23] << 24)) >>> 0;
  const t3l = (target[24] | (target[25] << 8) | (target[26] << 16) | (target[27] << 24)) >>> 0;
  const t3h = (target[28] | (target[29] << 8) | (target[30] << 16) | (target[31] << 24)) >>> 0;

  const prefix = new TextEncoder().encode(buildPrefix(salt, expireAt));
  const baseL = new Uint32Array(25);
  const baseH = new Uint32Array(25);
  let off = 0;
  while (off + RATE <= prefix.length) {
    absorbBlock(baseL, baseH, prefix, off);
    keccakF23(baseL, baseH);
    off += RATE;
  }
  const tailLen = prefix.length - off;

  // Two reusable blocks, each kept otherwise zero so a shorter candidate never
  // inherits a longer one's trailing digits.
  const blk = new Uint8Array(RATE);
  blk.set(prefix.subarray(off));
  const blk2 = new Uint8Array(RATE);
  const zero = new Uint8Array(RATE);
  const L = new Uint32Array(25);
  const H = new Uint32Array(25);
  const digits = new Uint8Array(20);
  const limit = Math.max(1, Number(difficulty) || 1);
  const signal = options.signal;
  const onProgress = options.onProgress;

  for (let n = 0; n < limit; n++) {
    if ((n & 0x3ff) === 0) {
      if (signal && signal.aborted) throw new Error('pow: aborted');
      if (n > 0) {
        if (onProgress) onProgress(n, limit);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    let v = n;
    let pos = 20;
    if (v === 0) {
      pos -= 1;
      digits[pos] = 48;
    } else {
      while (v > 0) {
        pos -= 1;
        digits[pos] = 48 + (v % 10);
        v = Math.floor(v / 10);
      }
    }
    const numLen = 20 - pos;
    const totalTail = tailLen + numLen;
    L.set(baseL);
    H.set(baseH);
    let matched;
    if (totalTail < RATE) {
      blk.set(digits.subarray(pos, 20), tailLen);
      blk[totalTail] = 0x06;
      blk[RATE - 1] |= 0x80;
      absorbBlock(L, H, blk, 0);
      keccakF23(L, H);
      blk.set(zero.subarray(tailLen, RATE), tailLen); // leave blk as it started
      matched = L[0] === t0l && H[0] === t0h && L[1] === t1l && H[1] === t1h &&
        L[2] === t2l && H[2] === t2h && L[3] === t3l && H[3] === t3h;
    } else {
      const first = RATE - tailLen;
      blk.set(digits.subarray(pos, pos + first), tailLen);
      absorbBlock(L, H, blk, 0);
      keccakF23(L, H);
      blk.set(zero.subarray(tailLen, RATE), tailLen);
      const rem = totalTail - RATE;
      blk2.set(digits.subarray(pos + first, pos + first + rem));
      blk2[rem] = 0x06;
      blk2[RATE - 1] |= 0x80;
      absorbBlock(L, H, blk2, 0);
      keccakF23(L, H);
      blk2.set(zero.subarray(0, rem + 1));
      blk2[RATE - 1] = 0;
      matched = L[0] === t0l && H[0] === t0h && L[1] === t1l && H[1] === t1h &&
        L[2] === t2l && H[2] === t2h && L[3] === t3l && H[3] === t3h;
    }
    if (matched) {
      if (onProgress) onProgress(n + 1, limit);
      return n;
    }
  }
  throw new Error('pow: no solution within difficulty');
}

/**
 * Serialize a solved challenge into the `x-ds-pow-response` header value:
 * base64 of `{algorithm, challenge, salt, answer, signature, target_path}`.
 * `difficulty` and `expire_at` are deliberately omitted, matching the client.
 */
export function buildPowHeader(challenge, answer) {
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** End-to-end: challenge object → `x-ds-pow-response` header value. */
export async function solveAndBuildHeader(challenge, options = {}) {
  if (!challenge || challenge.algorithm !== 'DeepSeekHashV1') {
    throw new Error(`pow: unsupported algorithm: ${challenge && challenge.algorithm}`);
  }
  const difficulty = Number(challenge.difficulty) || 144000;
  const answer = await solvePow(
    challenge.challenge,
    challenge.salt,
    challenge.expire_at,
    difficulty,
    options,
  );
  return { answer, header: buildPowHeader(challenge, answer) };
}
