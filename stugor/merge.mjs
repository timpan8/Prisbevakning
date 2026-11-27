// Slår ihop AI-rutinens stugfynd (inbox/stugor-*.json) med data/stugor.json. Körs av inkorgsjobbet (local/run.mjs).
//
//   node stugor/merge.mjs fil.json [--no-notify]
//
// Filen:
// { "erbjudanden": [ {
//     kalla, kod (annonsens id på sajten), namn, typ ("stuga", "hus", "villa" …), ort, lat, lon,
//     baddar, sovrum, bilder: [upp till 4 bildadresser], url (annonsen), betyg,
//     bubbelpool (true = badtunna/bubbelpool/utomhusspa hör till boendet; false = saknas eller bara bubbelbadkar),
//     bubbelpoolText, bastu, sjotomt, vattenMeter, restaurangMeter, grannarMeter, avskilt, not,
//     helg (fredagens datum ÅÅÅÅ-MM-DD), natter (2), pris (totalt för hela boendet hela helgen, inkl. avgifter),
//     prisUrl (länk med datumen, om annan än url) } ],
//   "kallorLasta": [ { "kalla": "airbnb", "helger": ["ÅÅÅÅ-MM-DD", ...] } ]   sökningar som lästes i sin helhet
//   "borta": ["<erbjudandets id>"],
//   "nyaKallor": [ { id, namn, url, hamtning: "webblasare", aktiv, not } ] }
// Skriver ut nya notiser (rader som börjar med NOTIS); inkorgsjobbet skickar dem via Homey.
import { readFile } from 'node:fs/promises';
import { PATHS, loadAll, writeJson, mergeHus, mergeErbjudanden, bedomAlla, pickNotices, today, norm } from './lib.mjs';

const file = process.argv[2];
if (!file) { console.error('Ange en fil'); process.exit(2); }
const inp = JSON.parse(await readFile(file, 'utf8'));
const { db, inst, kallor } = await loadAll();
const slug = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const out = [];
let kallorAndrat = false;

for (const s of inp.nyaKallor || []) {
  if (!s?.id || !s.url || kallor.kallor.some(x => x.id === s.id)) continue;
  kallor.kallor.push({ aktiv: true, hamtning: 'webblasare', ...s });
  kallorAndrat = true; out.push(`ny källa: ${s.namn || s.id}`);
}

const HUSF = ['kalla', 'kallaNamn', 'kod', 'namn', 'typ', 'ort', 'lat', 'lon', 'baddar', 'sovrum', 'badrum', 'bilder', 'url', 'betyg',
  'bubbelpool', 'bubbelpoolText', 'bastu', 'sjotomt', 'vattenMeter', 'restaurangMeter', 'grannarMeter', 'avskilt', 'not'];
const namn = id => kallor.kallor.find(k => k.id === id)?.namn || id;
const hus = {}, byKalla = {};
for (const o of inp.erbjudanden || []) {
  if (!o?.kalla || !(o.pris > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(o.helg || '') || !(o.kod || o.url || o.namn)) { out.push(`hoppar över ett erbjudande utan kalla/pris/helg/id`); continue; }
  const id = `${o.kalla}-${slug(o.kod || o.url || o.namn)}`;
  const h = hus[id] ||= { id, kallaNamn: namn(o.kalla) };
  for (const f of HUSF) if (o[f] !== undefined && o[f] !== null) h[f] = f === 'bilder' ? [].concat(o[f]).filter(Boolean).slice(0, 6) : o[f];
  if (o.lat != null) h.lat = +o.lat; if (o.lon != null) h.lon = +o.lon;
  (byKalla[o.kalla] ||= []).push({ hus: id, kalla: o.kalla, helg: o.helg, natter: o.natter || inst.natter || 2, pris: Math.round(o.pris), url: o.prisUrl || o.url });
}
mergeHus(db, Object.values(hus), inst);
const lasta = new Map((inp.kallorLasta || []).map(k => typeof k === 'string' ? [k, null] : [k.kalla, k.helger || null]));
for (const [k, l] of Object.entries(byKalla)) mergeErbjudanden(db, k, l, { full: lasta.has(k), helger: lasta.get(k) });
for (const [k, h] of lasta) if (!byKalla[k]) mergeErbjudanden(db, k, [], { full: true, helger: h });
for (const id of inp.borta || []) { const o = db.erbjudanden.find(x => x.id === id); if (o) o.borta = today(); }

bedomAlla(db, inst);
const notices = process.argv.includes('--no-notify') ? [] : pickNotices(db, inst);
db.uppdaterad = new Date().toISOString(); db.installningar = inst;
await writeJson(PATHS.data, db);
if (kallorAndrat) await writeJson(PATHS.kallor, kallor);

const ok = Object.values(hus).filter(h => db.hus[h.id]?.kravOk).length;
console.log(`Stugor: ${Object.keys(hus).length} hus (${ok} klarar kraven), ${Object.values(byKalla).flat().length} helgpriser${out.length ? '; ' + out.join('; ') : ''}`);
for (const n of notices) console.log('NOTIS ' + n);
