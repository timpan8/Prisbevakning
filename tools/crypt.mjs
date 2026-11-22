// Kryptering för data.enc.json (samma format som sidan läser).
// AES-GCM 256, nyckel via PBKDF2-SHA256 (250 000 varv). Koden normaliseras (trim + gemener).
import { webcrypto as crypto } from 'node:crypto';

const ITER = 250000;
const enc = new TextEncoder();
const b64 = buf => Buffer.from(buf).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
const norm = p => p.trim().toLowerCase();

async function key(pass, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(norm(pass)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptJson(obj, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(pass, salt), enc.encode(JSON.stringify(obj)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function decryptJson(box, pass) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) },
    await key(pass, unb64(box.salt)), unb64(box.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
