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
  console.log(JSON.stringify(db.products.filter(p => p.prisjaktId && p.sokprofil?.prisjakt !== false).map(p => ({
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
  const pjOk = pj && !pj.error;

  // Butiker utanför Prisjakt (collector/extra-shops.json). En tom lista = kollat, finns inte.
  // Varje erbjudande har eget datum: Kinabutiker kollas en gång i veckan och gäller 8 dagar, andra butiker var 3:e dag
  // och gäller 4 dagar. Nya uppgifter ersätter samma butiks gamla; {shop, gone: true} tar bort butiken.
  const ex = run.extra?.[p.key];
  const age = o => (Date.parse(d) - Date.parse(o.checked || cur.extra?.checked || d)) / 864e5;
  const fresh = o => age(o) <= (o.kina ? 8 : 4);
  if (Array.isArray(ex)) {
    const touched = new Set(ex.filter(o => o?.shop).map(o => o.shop));
    const ok = ex.filter(o => o && o.shop && !o.gone && o.price > 0 && o.stock !== 'OutOfStock');
    const keep = list => (list || []).filter(o => !touched.has(o.shop) && fresh(o));
    cur.extra = { checked: d,
      offers: [...keep(cur.extra?.offers), ...ok.filter(o => !o.used).map(o => ({ shop: o.shop, price: o.price, ship: o.ship ?? null, stock: o.stock || 'InStock', url: o.url, src: 'extra', checked: d, ...(o.kina ? { kina: true } : {}), ...(o.note ? { note: o.note } : {}) }))],
      used: [...keep(cur.extra?.used), ...ok.filter(o => o.used).map(o => ({ shop: o.shop, price: o.price, url: o.url, checked: d }))] };
  }
  const exFresh = (cur.extra?.offers || []).filter(fresh);

  if (pjOk || Array.isArray(ex)) {
    if (pjOk) { cur.name = pj.name || prev.name; cur.lowNow = pj.lowNow; }
    const base = pjOk ? (pj.offers || [])
      .map(o => Array.isArray(o) ? { shop: o[0], price: o[1], ship: o[2], cond: 'New', stock: o[3] ? 'InStock' : 'Limited', go: o[4], was: o[5], promo: o[6] } : o)
      .filter(usable)
      .map(o => ({ shop: o.shop, price: o.price, ship: o.ship, stock: o.stock, ...(o.go ? { go: o.go } : {}),
        ...(o.was > o.price ? { was: o.was } : {}), ...(o.promo ? { promo: o.promo } : {}) }))
      : (prev.offers || []).filter(o => o.src !== 'extra');
    // Har en extra-butik också ett Prisjakt-erbjudande behålls det billigaste
    cur.offers = [...base.filter(o => !exFresh.some(e => e.shop === o.shop && total(e) <= total(o))),
                  ...exFresh.filter(e => !base.some(o => o.shop === e.shop && total(o) < total(e)))]
      .sort((a, b) => total(a) - total(b));
  }
  if (pjOk || Array.isArray(ex)) {
    if (pjOk && pj.hist) { cur.hist = pj.hist; cur.histFetched = d; }
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
  // Facebook Marketplace: bästa relevanta annons enligt Claude-uppgiftens bedömning (data från Apify-jobbet), null = ingen
  if (p.key in (run.marketplace || {})) cur.marketplace = run.marketplace[p.key] && run.marketplace[p.key].pris ? { titel: run.marketplace[p.key].titel, pris: run.marketplace[p.key].pris, url: run.marketplace[p.key].url, ort: run.marketplace[p.key].ort || null } : null;
  db.latest[p.key] = cur;
}
// Köplägen för båda listorna. Skäl: under målpris, rekordlågt/lägsta på 3 mån, rea ≥ 15 %, begagnat under målpris
// (utan målpris: under 65 % av nypris). Nivå "missa" (missa inte) = under målpris, rekordlågt eller begagnat under målpris;
// annars "bra". "nytt" sätts när skälen eller priset blivit bättre sedan förra körningen, så att notiser bara går ut för
// nya köplägen. Sammanfattningen sparas i db.koplagen (översiktssidan) och, när datorns jobb kör, i koplagen.json
// i jobbets utmapp (för Homey).
const nyaFynd = [];
for (const p of db.products) {
  const l = db.latest[p.key]; if (!l) continue;
  const b = l.offers?.[0], t = b ? total(b) : null, h = l.hist || {}, bs = db.bestSeen[p.key];
  // Rekordlågt kräver en historik att jämföra med: Prisjakts prishistorik, eller vår egen logg över minst 30 dagar.
  // Annars blir varje nytillagd vara utanför Prisjakt "rekordlåg" första dagen.
  const ownLong = (db.log[p.key]?.[0]?.[0] || '9') <= new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const lowEver = Math.min(...[h.low?.price, h.low || ownLong ? bs?.total : null].filter(x => x != null));
  const skal = [];
  if (t != null && p.malpris && t <= p.malpris) skal.push(`under målpris ${p.malpris} kr`);
  if (t != null && isFinite(lowEver) && t <= lowEver) skal.push('rekordlågt');
  else if (t != null && h.low3m && t <= h.low3m.price) skal.push('lägsta på 3 mån');
  if (b?.was > b?.price && (b.was - b.price) / b.was >= 0.15) skal.push(`rea −${Math.round((b.was - b.price) / b.was * 100)} %`);
  const ref = p.malpris || t;
  const used = [l.tradera?.buyNow && ['Tradera', l.tradera.buyNow.pris, l.tradera.buyNow.url], l.blocket && ['Blocket', l.blocket.pris, l.blocket.url],
    l.marketplace && ['Marketplace', l.marketplace.pris, l.marketplace.url]].filter(x => x && x[1] > 0).sort((a, c) => a[1] - c[1])[0];
  if (used && ref && p.sokprofil?.begagnat !== false && used[1] <=(p.malpris ? p.malpris : ref * 0.65)) skal.push(`begagnat ${used[1]} kr på ${used[0]}`);
  const prev = l.fynd;
  if (!skal.length) { delete l.fynd; continue; }
  const pris = Math.min(...[t, used && skal.some(s => s.startsWith('begagnat')) ? used[1] : null].filter(x => x != null));
  const nytt = !prev || pris < prev.pris || skal.some(s => !prev.skal.includes(s));
  const niva = skal.some(s => /målpris|rekordlågt/.test(s)) ? 'missa' : 'bra';
  const viaUsed = used && skal.some(s => s.startsWith('begagnat')) && used[1] === pris;
  l.fynd = { skal, pris, niva, butik: viaUsed ? used[0] : b?.shop || null, url: viaUsed ? used[2] : b?.url || (b?.go ? 'https://www.prisjakt.nu/go-to-shop/' + b.go : null),
    sedan: prev?.sedan || d, nytt: nytt ? now : prev.nytt };
  if (nytt) nyaFynd.push({ niva, text: `${niva === 'missa' ? '🔥' : '🎯'} ${p.onskelista ? 'Önskelista' : 'Inköpslistan'} – ${p.name}: ${skal.join(', ')} (${t != null ? t + ' kr hos ' + b.shop : ''}${used ? ', begagnat ' + used[1] + ' kr' : ''})` });
}
db.koplagen = { tid: now, lista: db.products.filter(p => db.latest[p.key]?.fynd).map(p => ({ key: p.key, namn: p.name, lista: p.onskelista ? 'onskelista' : 'inkop', ...db.latest[p.key].fynd })) };
db.updated = now;
await save(db);
if (process.env.JOB_OUT_DIR) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(process.env.JOB_OUT_DIR, { recursive: true });
  const missa = db.koplagen.lista.filter(x => x.niva === 'missa');
  await writeFile(new URL(`file:///${process.env.JOB_OUT_DIR.replace(/\\/g, '/')}/koplagen.json`), JSON.stringify({ ...db.koplagen,
    // Kort text för telefonnotis: bara nya "missa inte" sedan förra körningen
    notis: nyaFynd.filter(x => x.niva === 'missa').map(x => x.text).join('\n') || null, antalMissa: missa.length }, null, 1));
}

// Kort sammanfattning för notisen
if (nyaFynd.length) console.log('NYA KÖPLÄGEN\n' + nyaFynd.map(x => x.text).join('\n') + '\n');
const lines = db.products.map(p => {
  const l = db.latest[p.key] || {}; const b = l.offers?.[0];
  const bs = db.bestSeen[p.key];
  return `${p.onskelista ? '[önskelista] ' : ''}${p.name}: ${b ? total(b) + ' kr (' + b.shop + ')' : '–'}${newLow.has(p.key) ? ' ★ nytt lägsta' : ''}${l.fynd ? ' 🎯 ' + l.fynd.skal.join(', ') : ''}`;
});
console.log(lines.join('\n'));
