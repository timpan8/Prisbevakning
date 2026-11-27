// Slår ihop AI-rutinens bostadsfynd (inbox/boende-*.json, från collector/hemnet.js) med data/boende.enc.json.
// Körs av inkorgsjobbet (local/run.mjs). Räknar restid med SL för nya annonser, bedömer, arkiverar sålda och skriver
// ut notiser (rader som börjar med NOTIS; inkorgsjobbet skickar dem via Homey).
//
//   PRIS_KOD=... node boende/merge.mjs fil.json [--no-notify] [--no-sl]
//   PRIS_KOD=... node boende/merge.mjs --plan        vad rutinen ska hämta i Chrome (JSON till hnKor i collector/hemnet.js)
//   PRIS_KOD=... node boende/merge.mjs --dump        databasen och valen (för granskning)
//
// Filen:
// { "annonser": [ { kalla: "hemnet", kod (annonsens id), url, adress, omrade, kommun, lat, lon, rum, kvm, biarea, vaning,
//     hiss, avgift (kr/mån), drift, byggar, brf, bilder: [..], beskrivning, balkong, uteplats, takterrass, vattenutsikt,
//     vattenMeter, grill, unikt, unikText, publicerad (ÅÅÅÅ-MM-DD), visningar: [ISO], utrop, budgivning, hogstaBud } ],
//   "borta": [ { kalla, kod, status: "sald" | "borttagen", slutpris, datum } ],
//   "kallorLasta": [ { kalla, djupTill: sista sidan som lästes i den stegvisa genomsökningen, svept: true när sökningen tog slut } ],
//   "nyaKallor": [ { id, namn, url, hamtning: "webblasare", aktiv, not } ] }
import { readFile } from 'node:fs/promises';
import { PATHS, loadAll, saveDb, writeJson, mergeAnnons, arkivera, bedom, bedomAlla, pickNotices, today, uteslutet } from './lib.mjs';
import { restid, meter } from './sl.mjs';

const pass = process.env.PRIS_KOD;
if (!pass) { console.error('PRIS_KOD saknas'); process.exit(2); }
const { db, val, inst, kallor } = await loadAll(pass);
const arg = process.argv[2];

if (arg === '--dump') { console.log(JSON.stringify({ ...db, val }, null, 1)); process.exit(0); }

if (arg === '--plan') {
  const now = Date.now(), gamla = d => !d || now - Date.parse(d) > 2 * 864e5;
  const aktiva = Object.values(db.annonser);
  const kolla = aktiva.filter(a => val[a.id]?.val === 'gilla' || (!a.detaljHamtad && a.kategori !== 'ovriga') || (a.kategori !== 'ovriga' && val[a.id]?.val !== 'ogilla' && gamla(a.kollad))
    || (a.kategori === 'ovriga' && now - Date.parse(a.kollad) > 7 * 864e5))
    .sort((a, b) => (val[b.id]?.val === 'gilla') - (val[a.id]?.val === 'gilla') || Date.parse(a.kollad) - Date.parse(b.kollad)).slice(0, 60);
  const U = inst.uteslutnaOmraden || {};
  console.log(JSON.stringify({
    // Nyaste sidorna varje gång; äldre annonser stegvis (20 sidor per körning) tills hela sökningen lästs, sedan om var 14:e dag
    sok: kallor.kallor.filter(k => k.aktiv && k.id === 'hemnet').flatMap(k => {
      const s = db.svept?.[k.id], fran = s?.till ? s.till + 1 : 4, klar = s?.klar && Date.parse(today()) - Date.parse(s.klar) < 14 * 864e5;
      return [{ kalla: k.id, url: k.url, fran: 1, till: 3 }, ...(klar ? [] : [{ kalla: k.id, url: k.url, fran: s?.klar ? 4 : fran, till: (s?.klar ? 4 : fran) + 19, djup: true }])];
    }),
    kanda: [...aktiva, ...Object.values(db.arkiv || {})].filter(a => a.id.startsWith('hemnet-')).map(a => a.id.slice(7)),
    kolla: kolla.map(a => ({ kod: a.kod, url: a.url })),
    filter: { maxUtrop: inst.maxUtrop, minRum: inst.minRumTvaor || 2, maxKm: inst.forfilterKm || 22, mal: [inst.mal.lat, inst.mal.lon],
      uteslutna: [...(U.sarskiltUtsatta || []), ...(U.utsatta || []), ...(U.egna || [])] },
  }));
  process.exit(0);
}

if (!arg) { console.error('Ange en fil'); process.exit(2); }
const inp = JSON.parse(await readFile(arg, 'utf8'));
const out = [];
let kallorAndrat = false;
for (const s of inp.nyaKallor || []) {
  if (!s?.id || !s.url || kallor.kallor.some(x => x.id === s.id)) continue;
  kallor.kallor.push({ aktiv: true, hamtning: 'webblasare', ...s }); kallorAndrat = true; out.push(`ny källa: ${s.namn || s.id}`);
}

// Förfilter för nya annonser: för långt bort, för få rum, för dyrt eller utsatt område sparas inte alls
let nya = 0, bortfiltrerade = 0, uppdaterade = 0;
for (const o of inp.annonser || []) {
  if (!o?.kalla || !o.kod) { out.push('hoppar över en annons utan kalla/kod'); continue; }
  const id = `${o.kalla}-${o.kod}`, finns = !!db.annonser[id];
  if (!finns) {
    if (db.arkiv?.[id]) continue; // redan såld/borttagen
    const langt = o.lat != null && meter([+o.lat, +o.lon], [inst.mal.lat, inst.mal.lon]) > (inst.forfilterKm || 22) * 1000;
    if (langt || (o.rum != null && +o.rum < (inst.minRumTvaor || 2)) || (o.utrop && +o.utrop > inst.maxUtrop) || uteslutet(o, inst)) { bortfiltrerade++; continue; }
    nya++;
  } else uppdaterade++;
  const a = db.annonser[mergeAnnons(db, o)];
  if (a.restid && a.restid.pos !== `${a.lat},${a.lon}`) delete a.restid; // flyttad position: räkna om
}

for (const k of inp.kallorLasta || []) {
  const id = typeof k === 'string' ? k : k.kalla;
  db.kallstatus[id] = { senast: new Date().toISOString(), antal: (inp.annonser || []).filter(o => o.kalla === id).length };
  if (k.djupTill) { const s = (db.svept ||= {})[id] ||= {}; if (k.svept) { s.klar = today(); s.till = 0; } else { s.till = k.djupTill; if (s.klar && Date.parse(today()) - Date.parse(s.klar) >= 14 * 864e5) delete s.klar; } }
}

// Sålda och borttagna
const salda = [];
for (const b of inp.borta || []) {
  const id = `${b.kalla}-${b.kod}`;
  const s = arkivera(db, id, { status: b.status === 'borttagen' ? 'borttagen' : 'sald', slutpris: b.slutpris, datum: b.datum });
  if (s) salda.push(s);
}
// Inte sedd på 21 dagar trots att rutinen kollat sajten i dag: räknas som borttagen. Annonser som inte klarar kraven
// kollas bara ibland; de tas bort tyst efter 30 dagar utan att hamna i arkivet.
const dagarSedan = a => (Date.parse(today()) - Date.parse(a.sedd || a.hittad)) / 864e5;
for (const a of Object.values(db.annonser)) {
  if (db.kallstatus[a.kalla]?.senast?.slice(0, 10) !== today()) continue;
  if (a.kategori === 'ovriga' && val[a.id]?.val !== 'gilla') { if (dagarSedan(a) > 30) delete db.annonser[a.id]; }
  else if (dagarSedan(a) > 21) { const s = arkivera(db, a.id, { status: 'borttagen' }); if (s) salda.push(s); }
}

// Restid med SL för annonser som saknar den (högst 80 per körning, resten nästa gång)
let slAntal = 0, slFel = 0;
if (!process.argv.includes('--no-sl')) {
  const HOME = (process.env.AUTOMATION_HOME || 'C:/Users/TimLi/Dev/Automation').replace(/\\/g, '/');
  const { getJson } = await import('file:///' + HOME + '/lib/fetch.mjs');
  for (const a of Object.values(db.annonser).filter(a => !a.restid && a.lat != null).slice(0, 80)) {
    try { a.restid = { ...(await restid(a.lat, a.lon, inst, { getJson })), pos: `${a.lat},${a.lon}` }; slAntal++; }
    catch (e) { slFel++; if (slFel >= 3) { out.push(`SL-restid avbruten: ${e.message}`); break; } }
  }
}

bedomAlla(db, inst, val);
const notices = process.argv.includes('--no-notify') ? [] : pickNotices(db, inst, val, { salda });
db.uppdaterad = new Date().toISOString(); db.installningar = inst;
await saveDb(db, pass);
if (kallorAndrat) await writeJson(PATHS.kallor, kallor);

const A = Object.values(db.annonser);
console.log(`Boende: ${nya} nya, ${uppdaterade} uppdaterade, ${bortfiltrerade} bortfiltrerade, ${salda.length} till arkivet, ${slAntal} restider`
  + ` · ${A.filter(a => a.kategori === 'huvud').length} treor+ och ${A.filter(a => a.kategori === 'tvaa').length} tvåor klarar kraven${out.length ? '; ' + out.join('; ') : ''}`);
for (const n of notices) console.log('NOTIS ' + n);
