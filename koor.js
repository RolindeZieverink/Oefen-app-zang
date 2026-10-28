/* Naklank: koorcodes. Stukken staan versleuteld (AES-GCM) op de site; alleen met de code van het koor te openen. */
(() => {
'use strict';
const enc = new TextEncoder();
const norm = c => String(c || '').toLowerCase().replace(/[\s\-_]+/g, '');

// Uit de code komen twee dingen: een mapnaam (id, zodat niemand kan zien welke koren er zijn) en de sleutel.
async function derive(code){
  const n = norm(code);
  if (n.length < 8) throw new Error('kort');
  const base = await crypto.subtle.importKey('raw', enc.encode(n), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('naklank-koor-v1'), iterations: 300000 }, base, 512));
  const id = [...bits.slice(0, 10)].map(b => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', bits.slice(32, 64), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { id, key };
}
async function encrypt(key, bytes){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(16 + ct.length);
  out.set([78, 75, 49, 0], 0); out.set(iv, 4); out.set(ct, 16);     // "NK1" + iv + data
  return out;
}
async function decrypt(key, buf){
  const u = new Uint8Array(buf);
  if (u.length < 32 || u[0] !== 78 || u[1] !== 75) throw new Error('formaat');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(4, 16) }, key, u.slice(16)));
}
window.NKkoor = { derive, encrypt, decrypt, norm };
})();
