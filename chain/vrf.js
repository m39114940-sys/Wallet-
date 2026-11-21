// ECVRF-EDWARDS25519-SHA512-TAI as specified in RFC 9381, section 5.5.
// Arithmetic is pure BigInt on edwards25519 (Node exposes no point operations).
//
// Limits: scalar multiplication is not constant time. This is acceptable for the testnet, where
// VRF inputs are public, but a production deployment needs a hardened and audited implementation.
// Correctness is checked against the RFC 9381 test vector and against Node's own Ed25519 keys.

import { createHash } from "node:crypto";

export { add, multiply, encodePoint, decodePoint, encodeToCurve, BASE, IDENTITY, samePoint, Q as ORDER };
const SUITE = 0x03;
const sha512 = (...parts) => createHash("sha512").update(Buffer.concat(parts)).digest();

export const P = 2n ** 255n - 19n; // field prime
export const Q = 2n ** 252n + 27742317777372353535851937790883648493n; // group order

const mod = (a, m = P) => ((a % m) + m) % m;

function powmod(base, exp, m = P) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

const inv = (a) => powmod(a, P - 2n);

const D = mod(-121665n * inv(121666n));
const SQRT_M1 = powmod(2n, (P - 1n) / 4n); // sqrt(-1) in the field

const toLE = (n, length) => {
  const out = Buffer.alloc(length);
  let v = n;
  for (let i = 0; i < length; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};
const fromLE = (bytes) => {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
};

// Points are [X, Y, Z, T] in extended coordinates.
const IDENTITY = [0n, 1n, 1n, 0n];

function add(p1, p2) {
  const [X1, Y1, Z1, T1] = p1;
  const [X2, Y2, Z2, T2] = p2;
  const A = mod((Y1 - X1) * (Y2 - X2));
  const B = mod((Y1 + X1) * (Y2 + X2));
  const C = mod(T1 * 2n * D * T2);
  const Dd = mod(Z1 * 2n * Z2);
  const E = mod(B - A);
  const F = mod(Dd - C);
  const G = mod(Dd + C);
  const H = mod(B + A);
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}

const negate = ([X, Y, Z, T]) => [mod(-X), Y, Z, mod(-T)];

function multiply(scalar, point) {
  let result = IDENTITY;
  let addend = point;
  let s = scalar;
  while (s > 0n) {
    if (s & 1n) result = add(result, addend);
    addend = add(addend, addend);
    s >>= 1n;
  }
  return result;
}

// Projective equality: two points are equal when their normalised coordinates match.
function samePoint(p1, p2) {
  return mod(p1[0] * p2[2]) === mod(p2[0] * p1[2]) && mod(p1[1] * p2[2]) === mod(p2[1] * p1[2]);
}

// point_to_string (RFC 8032): y in little-endian, with the sign of x in the top bit.
function encodePoint([X, Y, Z]) {
  const zi = inv(Z);
  const x = mod(X * zi);
  const y = mod(Y * zi);
  const bytes = toLE(y, 32);
  if (x & 1n) bytes[31] |= 0x80;
  return bytes;
}

// string_to_point (RFC 8032). Returns null for any encoding that is not a point on the curve.
function decodePoint(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) return null;
  const sign = bytes[31] >> 7;
  const y = fromLE(bytes) & ((1n << 255n) - 1n);
  if (y >= P) return null;
  const y2 = mod(y * y);
  const target = mod((y2 - 1n) * inv(mod(D * y2 + 1n))); // x^2 = (y^2 - 1) / (d y^2 + 1)
  let x = powmod(target, (P + 3n) / 8n);
  if (mod(x * x) !== target) x = mod(x * SQRT_M1);
  if (mod(x * x) !== target) return null;
  if (x === 0n && sign === 1) return null;
  if (Number(x & 1n) !== sign) x = mod(-x);
  return [x, y, 1n, mod(x * y)];
}

const BASE = decodePoint(Buffer.from("5866666666666666666666666666666666666666666666666666666666666666", "hex"));

// Key expansion (RFC 8032 section 5.1.5): scalar x and the nonce prefix.
function expandSecret(sk) {
  const h = createHash("sha512").update(sk).digest();
  const a = Buffer.from(h.subarray(0, 32));
  a[0] &= 248;
  a[31] &= 127;
  a[31] |= 64;
  return { x: fromLE(a), prefix: h.subarray(32, 64) };
}

// ECVRF_encode_to_curve_try_and_increment (RFC 9381, section 5.4.1.1), with the public key as the salt.
function encodeToCurve(pkBytes, alpha) {
  for (let ctr = 0; ctr < 256; ctr++) {
    const hash = sha512(Buffer.from([SUITE, 0x01]), pkBytes, alpha, Buffer.from([ctr]), Buffer.from([0x00]));
    const candidate = decodePoint(Buffer.from(hash.subarray(0, 32)));
    if (candidate === null) continue;
    const H = multiply(8n, candidate); // cofactor clearing
    if (samePoint(H, IDENTITY)) continue;
    return H;
  }
  throw new Error("encode_to_curve did not find a point");
}

// ECVRF_challenge_generation (RFC 9381, section 5.4.3): 16 bytes, read little-endian.
function challenge(points) {
  const encoded = points.map(encodePoint);
  const hash = sha512(Buffer.from([SUITE, 0x02]), ...encoded, Buffer.from([0x00]));
  return fromLE(hash.subarray(0, 16));
}

// ECVRF_nonce_generation (RFC 9381, section 5.4.2.2, SHA-512 variant).
function nonce(prefix, hString) {
  const hash = sha512(prefix, hString);
  return mod(fromLE(hash), Q);
}

// ECVRF_prove (RFC 9381, section 5.1). Returns the 80-byte proof pi.
export function vrfProve(skHex, alphaHex) {
  const sk = Buffer.from(skHex, "hex");
  const alpha = Buffer.from(alphaHex, "hex");
  if (sk.length !== 32) throw new Error("مفتاح VRF الخاص يجب أن يكون 32 بايت.");
  const { x, prefix } = expandSecret(sk);
  const Y = multiply(x, BASE);
  const pk = encodePoint(Y);
  const H = encodeToCurve(pk, alpha);
  const hString = encodePoint(H);
  const Gamma = multiply(x, H);
  const k = nonce(prefix, hString);
  const c = challenge([Y, H, Gamma, multiply(k, BASE), multiply(k, H)]);
  const s = mod(k + c * x, Q);
  return Buffer.concat([encodePoint(Gamma), toLE(c, 16), toLE(s, 32)]).toString("hex");
}

// ECVRF_proof_to_hash (RFC 9381, section 5.2): the 64-byte output beta.
function proofToHash(gamma) {
  return sha512(Buffer.from([SUITE, 0x03]), encodePoint(multiply(8n, gamma)), Buffer.from([0x00])).toString("hex");
}

// ECVRF_verify (RFC 9381, section 5.3). Returns the output beta (hex) if valid, otherwise null.
export function vrfVerify(pkHex, alphaHex, proofHex) {
  const pkBytes = Buffer.from(pkHex, "hex");
  const alpha = Buffer.from(alphaHex, "hex");
  const pi = Buffer.from(proofHex, "hex");
  if (pi.length !== 80) return null;
  const Y = decodePoint(pkBytes);
  if (Y === null || samePoint(multiply(8n, Y), IDENTITY)) return null; // key must be valid and not small-order
  const Gamma = decodePoint(pi.subarray(0, 32));
  if (Gamma === null) return null;
  const c = fromLE(pi.subarray(32, 48));
  const s = fromLE(pi.subarray(48, 80));
  if (s >= Q) return null;
  const H = encodeToCurve(pkBytes, alpha);
  const U = add(multiply(s, BASE), negate(multiply(c, Y)));
  const V = add(multiply(s, H), negate(multiply(c, Gamma)));
  if (challenge([Y, H, Gamma, U, V]) !== c) return null;
  return proofToHash(Gamma);
}

// Public key for a secret key, as the RFC's Y = x * B encoded with point_to_string.
export function vrfPublicKey(skHex) {
  const { x } = expandSecret(Buffer.from(skHex, "hex"));
  return encodePoint(multiply(x, BASE)).toString("hex");
}
