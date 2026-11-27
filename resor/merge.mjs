// Slår ihop AI-rutinens resultat (inbox/resor-*.json) med data/resor.json. Körs av inkorgsjobbet (local/run.mjs).
//
//   node resor/merge.mjs fil.json [--no-notify]
//
// Filen kan vara:
// 1. Reseguiden-skriptets fil (collector/reseguiden.js): { kalla, typ: "lista", sokning, erbjudanden } eller
//    { kalla, typ: "kalender", sokning, dagar: { "ÅÅÅÅ-MM-DD": prisPerPerson } }
// 2. AI-rutinens egen fil:
//    { "erbjudanden": [ { kalla, typ, fran, ort, land, avresa, hem|dagar, prisPerPerson|prisTva, hotell, kost, url, not } ],
//      "kallorLasta": ["ving", ...]      källor som lästes i sin helhet (det som saknas från dem markeras som borta)
//      "borta": ["<id>", ...]           erbjudanden AI:n sett att de inte finns längre
//      "klimat": { "<resmål>": { land, region, temp: [12 tal], namn: [...] } }   nya resmål till resor/klimat.json
//      "nyaKallor": [ { id, namn, url, typ, kategorier, hamtning, aktiv, not } ]   nya sajter till resor/kallor.json
//      "kalendrar": [ <kalender som ovan> ] }
// Skriver ut nya notiser (rader som börjar med NOTIS); inkorgsjobbet skickar dem via Homey.
import { readFile } from 'node:fs/promises';
import { PATHS, loadAll, writeJson, classify, finish, mergeSource, pickNotices, today } from './lib.mjs';

const file = process.argv[2];
if (!file) { console.error('Ange en fil'); process.exit(2); }
const inp = JSON.parse(await readFile(file, 'utf8'));
const { db, inst, kallor, klimat } = await loadAll();
const now = new Date().toISOString();
let klimatAndrat = false, kallorAndrat = false;
const out = [];

// Nya resmål i klimattabellen
for (const [k, v] of Object.entries(inp.klimat || {})) {
  if (!Array.isArray(v?.temp) || v.temp.length !== 12) { out.push(`hoppar över klimat för ${k}: temp måste vara 12 tal`); continue; }
  klimat.resmal[k.toLowerCase()] = { land: v.land || null, region: v.region || null, temp: v.temp.map(Number), ...(v.namn ? { namn: v.namn } : {}) };
  klimatAndrat = true;
}
// Nya sajter i källistan
for (const s of inp.nyaKallor || []) {
  if (!s?.id || !s.url) continue;
  if (kallor.kallor.some(x => x.id === s.id)) continue;
  kallor.kallor.push({ aktiv: true, hamtning: 'webblasare', ...s });
  kallorAndrat = true; out.push(`ny källa: ${s.namn || s.id}`);
}
// Priskalendrar (billigaste per avresedag för en sökning)
db.kalendrar ||= {};
for (const k of [...(inp.typ === 'kalender' ? [inp] : []), ...(inp.kalendrar || [])]) {
  const s = k.sokning || {};
  const key = [k.kalla || 'okand', s.sida || '', s.langd || 'alla', s.omrade || 'karta', s.maxPerPerson || ''].join('|');
  db.kalendrar[key] = { kalla: k.kalla, sokning: s, dagar: k.dagar || {}, hamtad: k.hamtad || now };
  out.push(`kalender ${s.langd || 'alla'} dagar${s.omrade ? ', område ' + s.omrade : ''}: ${Object.keys(k.dagar || {}).length} dagar`);
}
// Kalendrar äldre än 14 dagar tas bort
for (const [k, v] of Object.entries(db.kalendrar)) if ((Date.now() - Date.parse(v.hamtad)) / 864e5 > 14) delete db.kalendrar[k];

// Erbjudanden
const list = (inp.erbjudanden || []).filter(o => o && o.kalla && (o.prisPerPerson || o.prisTva) && (o.ort || o.hotell))
  .map(o => classify(finish({ ...o }, inst), inst, klimat));
const byKalla = {};
for (const o of list) (byKalla[o.kalla] ||= []).push(o);
const lasta = new Set(inp.kallorLasta || []);
for (const [k, l] of Object.entries(byKalla)) mergeSource(db, k, l, { full: lasta.has(k) });
for (const k of lasta) if (!byKalla[k]) mergeSource(db, k, [], { full: true });
for (const id of inp.borta || []) { const o = db.erbjudanden.find(x => x.id === id); if (o) o.borta = today(); }

db.erbjudanden = db.erbjudanden.map(o => classify(o, inst, klimat));
const notices = process.argv.includes('--no-notify') ? [] : pickNotices(db, inst);
db.uppdaterad = now; db.installningar = inst;
await writeJson(PATHS.data, db);
if (klimatAndrat) await writeJson(PATHS.klimat, klimat);
if (kallorAndrat) await writeJson(PATHS.kallor, kallor);

const cat = c => list.filter(o => o.kategori === c).length;
console.log(`Resor: ${list.length} erbjudanden (weekend ${cat('weekend')}, vecka ${cat('vecka')}, långresa ${cat('lang')})${out.length ? '; ' + out.join('; ') : ''}`);
for (const n of notices) console.log('NOTIS ' + n);
