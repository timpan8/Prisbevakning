// Uppdaterar databasen med resultat från en insamling.
//
//   PRIS_KOD=... node tools/update.mjs run.json        → slår ihop run.json i data/data.enc.json
//   PRIS_KOD=... node tools/update.mjs --dump          → skriver ut dekrypterad databas
//   PRIS_KOD=... node tools/update.mjs --plan          → vilka produkter som behöver prishistorik idag
//   PRIS_KOD=... node tools/update.mjs --set-products products.json  → ersätter produktlistan
//
// run.json: { prisjakt:{key:{name,lowNow,offers,hist?}}, tradera:{key:{buyNow,auction}}, blocket:{key:{...}|null} }
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { encryptJson, decryptJson } from './crypt.mjs';

const FILE = new URL('../data/data.enc.json', import.meta.url);
const pass = process.env.PRIS_KOD;
if (!pass) { console.error('PRIS_KOD saknas'); process.exit(1); }

const empty = () => ({ version: 1, updated: null, products: [], latest: {}, bestSeen: {}, log: {}, removed: [] });
const load = async () => existsSync(FILE) ? decryptJson(JSON.parse(await readFile(FILE, 'utf8')), pass) : empty();
const save = async db => writeFile(FILE, JSON.stringify(await encryptJson(db, pass)) + '\n');
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });

const usable = o => o.cond === 'New' && o.price > 0 && !['OutOfStock', 'PreOrder', 'NotInStock'].includes(o.stock);
const total = o => o.price + (o.ship ?? 49);

const arg = process.argv[2];
const db = await load();

if (arg === '--dump') { console.log(JSON.stringify(db, null, 2)); process.exit(0); }

if (arg === '--plan') {
  // Prishistorik hämtas max en gång per dag och produkt (färre anrop)
  console.log(JSON.stringify(db.products.map(p => ({
    key: p.key, prisjaktId: p.prisjaktId,
    history: (db.latest[p.key]?.histFetched || '') !== today()
  }))));
  process.exit(0);
}

if (arg === '--set-products') {
  const list = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const keep = new Set(list.map(p => p.key));
  for (const p of db.products) if (!keep.has(p.key)) db.removed.push({ ...p, removedAt: today() });
  db.products = list;
  await save(db);
  console.log('Produkter:', list.map(p => p.key).join(', '));
  process.exit(0);
}

const run = JSON.parse(await readFile(arg, 'utf8'));
const now = new Date().toISOString();
const d = today();
const newLow = new Set();
for (const p of db.products) {
  const pj = run.prisjakt?.[p.key];
  const prev = db.latest[p.key] || {};
  const cur = { ...prev, ts: now };
  if (pj && !pj.error) {
    cur.name = pj.name || prev.name;
    cur.lowNow = pj.lowNow;
    cur.offers = (pj.offers || [])
      .map(o => Array.isArray(o) ? { shop: o[0], price: o[1], ship: o[2], cond: 'New', stock: o[3] ? 'InStock' : 'Limited' } : o)
      .filter(usable)
      .map(o => ({ shop: o.shop, price: o.price, ship: o.ship, stock: o.stock }))
      .sort((a, b) => total(a) - total(b));
    if (pj.hist) { cur.hist = pj.hist; cur.histFetched = d; }
    const best = cur.offers[0];
    if (best) {
      const t = total(best);
      const bs = db.bestSeen[p.key];
      if (!bs || t < bs.total) { if (bs) newLow.add(p.key); db.bestSeen[p.key] = { total: t, price: best.price, shop: best.shop, date: d }; }
      const log = db.log[p.key] ||= [];
      const last = log[log.length - 1];
      if (last && last[0] === d) { if (t < last[1]) log[log.length - 1] = [d, t, best.shop]; }
      else log.push([d, t, best.shop]);
      if (log.length > 400) log.splice(0, log.length - 400);
    }
  }
  if (run.tradera?.[p.key] && !run.tradera[p.key].error) cur.tradera = run.tradera[p.key];
  if (p.key in (run.blocket || {}) && !run.blocket[p.key]?.error) cur.blocket = run.blocket[p.key];
  db.latest[p.key] = cur;
}
db.updated = now;
await save(db);

// Kort sammanfattning för notisen
const lines = db.products.map(p => {
  const l = db.latest[p.key] || {}; const b = l.offers?.[0];
  const bs = db.bestSeen[p.key];
  return `${p.name}: ${b ? total(b) + ' kr (' + b.shop + ')' : '–'}${newLow.has(p.key) ? ' ★ nytt lägsta' : ''}`;
});
console.log(lines.join('\n'));
