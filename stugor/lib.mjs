// Gemensam logik för stugbevakningen (fliken Stugor): läsa/spara, bedöma hus (krav, bonuspoäng, restid),
// slå ihop körningar och välja notiser. Används av stugor/run.mjs (datorns jobb) och stugor/merge.mjs (AI-rutinens inkorg).
//
// data/stugor.json:
//   hus: { "<kalla>-<kod>": { id, kalla, kallaNamn, kod, namn, typ, ort, lat, lon, baddar, sangar (sängar; dubbelsäng = 1), sovrum, bilder: [url],
//          url, betyg, bubbelpool (true/false/null), bubbelpoolText, bastu, vattenMeter, restaurangMeter,
//          ortMeter, ortNamn, grannarMeter, not, detaljHamtad,
//          stadning { typ: 'ingar' | 'extra' | 'sjalv' | 'okand', kr, text }, stadningKollad,
//          vagTimmar {stad: timmar} (bilväg enligt OSRM, null = ingen bilväg), vagKollad,
//          barMeter, barNamn, osmKollad, osmFalt [fält som kommer från OpenStreetMap], osmUngefar (airbnb: läget är slumpat),
//          -- uträknat: narmast {stad, timmar}, restider {stad: timmar}, restidVag (true = bilväg, annars fågelväg),
//             kravOk, kravMiss [..], poang, bonus [..] } }
//   erbjudanden: [ { id, hus, kalla, helg (ankomst, fredag), avresa, natter, prisSajt (sajtens pris),
//                    pris (totalt = prisSajt + obligatorisk städning), stadKr (städavgiften som lagts på), forraPris, lagsta,
//                    url, hittad, senast, borta? } ]
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { today, norm, kr, fmtDate } from '../resor/lib.mjs';
export { today, norm, kr, fmtDate };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PATHS = {
  data: process.env.STUGOR_DATA || path.join(ROOT, 'data', 'stugor.json'), // STUGOR_DATA: annan fil vid test
  inst: path.join(ROOT, 'stugor', 'installningar.json'),
  kallor: path.join(ROOT, 'stugor', 'kallor.json'),
  roster: path.join(ROOT, 'data', 'stugor-roster.json'),
};
export const PAGE = 'https://timpan8.github.io/Prisbevakning/#/stugor';
const readJson = async (f, fallback) => existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : fallback;
export const writeJson = (f, o) => writeFile(f, JSON.stringify(o, null, 1) + '\n');
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);

export async function loadAll() {
  const [db, inst, kallor] = await Promise.all([readJson(PATHS.data, null), readJson(PATHS.inst, {}), readJson(PATHS.kallor, { kallor: [] })]);
  return { db: db || { version: 1, uppdaterad: null, hus: {}, erbjudanden: [], notiserade: {}, kallstatus: {} }, inst, kallor };
}

// Ankomstdagar (fredagar) från i morgon och manaderFram framåt
export function helger(inst) {
  const wd = inst.ankomstVeckodag ?? 5, out = [];
  let d = addDays(today(), 1);
  while (new Date(d + 'T12:00:00Z').getUTCDay() !== wd) d = addDays(d, 1);
  const slut = addDays(today(), Math.round((inst.manaderFram || 6) * 30.5));
  for (; d <= slut; d = addDays(d, 7)) out.push(d);
  return out;
}

// Ungefärlig bilrestid: fågelväg × vägfaktor / hastighet
const RAD = Math.PI / 180;
export function km(a, b) {
  const dLat = (b[0] - a[0]) * RAD, dLon = (b[1] - a[1]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
export function restider(lat, lon, inst) {
  if (lat == null || lon == null) return null;
  const R = inst.restid || {}, f = R.vagfaktor || 1.25, v = R.kmh || 85, out = {};
  for (const [stad, p] of Object.entries(inst.utgangspunkter || {})) out[stad] = Math.round(km(p, [lat, lon]) * f / v * 10) / 10;
  return out;
}

// Antal sängar ur annonsens korta text ("3 sovrum · 8 sängar · 1,5 badrum", "2 dubbelsängar", "1 bäddsoffa"): talet direkt
// före varje ord med "säng" (dubbelsäng = 1 säng) eller "bäddsoffa", summerat. null = står inget.
export function sangarUrText(t) {
  let n = null;
  for (const [, x] of String(t || '').matchAll(/(\d+)\s+[a-zåäö-]*(?:säng|bäddsoff)[a-zåäö]*/gi)) n = (n || 0) + +x;
  return n;
}

// Krav och bonuspoäng för ett hus. Okänt (null) räknas inte som miss för bonus, men bubbelpool måste vara bekräftad.
// Restid: bilväg (vagTimmar, från OSRM via stugor/geo.mjs) när den finns, annars fågelväg. vagKollad utan vagTimmar =
// ingen bilväg (ö utan bro) → för långt bort.
export function bedom(h, inst) {
  const B = inst.bonus || {};
  const vag = h.vagTimmar && Object.fromEntries(Object.entries(h.vagTimmar).filter(([, t]) => t != null));
  const ingenVag = !!h.vagKollad && !(vag && Object.keys(vag).length);
  h.restidVag = !!(vag && Object.keys(vag).length);
  h.restider = h.restidVag ? vag : ingenVag ? null : restider(h.lat, h.lon, inst);
  delete h.narmast;
  if (h.restider) { const [stad, timmar] = Object.entries(h.restider).sort((a, b) => a[1] - b[1])[0]; h.narmast = { stad, timmar }; }
  const typ = norm(h.typ), miss = [];
  if (h.bubbelpool !== true) miss.push(h.bubbelpool === false ? 'ingen bubbelpool' : 'bubbelpool ej bekräftad');
  // Ordet eller ett sammansatt ord som slutar på det ("semesterlägenhet", "hotellrum")
  const ord = typ.split(/[^a-z0-9]+/).filter(Boolean);
  if ((inst.nekadeTyper || []).some(t => ord.some(w => w.endsWith(norm(t))))) miss.push('inte ett helt hus');
  if (h.baddar != null && h.baddar < (inst.minBaddar || 4)) miss.push(`bara ${h.baddar} bäddar`);
  if (h.sangar == null && h.not) { const n = sangarUrText(h.not); if (n != null) h.sangar = n; }
  if (h.sangar != null && h.sangar < (inst.minSangar || 4)) miss.push(`bara ${h.sangar} ${h.sangar === 1 ? 'säng' : 'sängar'}`);
  if (ingenVag) miss.push('för långt bort (ingen bilväg)');
  else if (h.narmast && h.narmast.timmar > (inst.maxTimmar || 3)) miss.push(`för långt bort (≈ ${h.narmast.timmar} h${h.restidVag ? ' bil' : ''})`);
  h.kravMiss = miss; h.kravOk = !miss.length;
  const bonus = [];
  if (h.bastu) bonus.push('bastu');
  // Vattenavstånd från OpenStreetMap: kräver ≤ 100 m (läget kan vara ungefärligt) och ersätter gissningen från rubriken
  const osmVatten = (h.osmFalt || []).includes('vattenMeter') && h.vattenMeter != null;
  const maxVatten = osmVatten ? (B.sjotomt?.osmMaxMeter ?? 100) : (B.sjotomt?.maxMeter ?? 150);
  if ((h.sjotomt && !osmVatten) || (h.vattenMeter != null && h.vattenMeter <= maxVatten)) bonus.push('sjotomt');
  const bar = [h.restaurangMeter, h.barMeter].filter(m => m != null);
  if (bar.length && Math.min(...bar) <= (B.bar?.maxMeter ?? 2500)) bonus.push('bar');
  if (h.avskilt || (h.grannarMeter != null && h.grannarMeter >= (B.avskilt?.minMeter ?? 200))) bonus.push('avskilt');
  if (h.baddar >= (inst.helstBaddar || 6)) bonus.push('baddar');
  if (h.sovrum >= (B.sovrum?.min ?? 4)) bonus.push('sovrum');
  h.bonus = bonus; h.poang = bonus.reduce((s, b) => s + (B[b]?.poang ?? 1), 0);
  return h;
}

// Slår ihop hus (fakta uppdateras, uträknade fält räknas om) och en källas erbjudanden.
// full = källan söktes i sin helhet för de helger som anges i `helger`; det som saknas där har försvunnit.
// sedd: false = bara husfakta (inkorgens husInfo), räknas inte som att huset setts i en sökning.
// Källans egna värden går före OpenStreetMaps (osmFalt); null från källan tar inte bort ett OSM-värde.
// Flyttas huset (> ca 500 m) räknas bilväg och OSM om.
const GEO_FALT = ['vagTimmar', 'vagKollad', 'osmKollad', 'osmFalt', 'osmUngefar'];
export function mergeHus(db, list, inst, { sedd = true } = {}) {
  for (const h of list) {
    if (!h?.id) continue;
    const old = { ...(db.hus[h.id] || {}) };
    const clean = Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined));
    if (old.lat != null && clean.lat != null && (Math.abs(old.lat - clean.lat) > 0.005 || Math.abs(old.lon - clean.lon) > 0.008)) {
      for (const f of old.osmFalt || []) delete old[f];
      for (const f of GEO_FALT) delete old[f];
    }
    // Ny annonstext utan sängantal: räkna om sängarna ur texten (bedom)
    if (clean.not != null && clean.not !== old.not && clean.sangar === undefined && old.kalla !== 'novasol') delete old.sangar;
    if (old.osmFalt?.length) {
      for (const f of old.osmFalt) if (clean[f] === null) delete clean[f];
      old.osmFalt = old.osmFalt.filter(f => clean[f] == null);
    }
    db.hus[h.id] = bedom({ ...old, ...clean, ...(sedd ? { sedd: today() } : {}) }, inst);
  }
}

// Erbjudandets totalpris: sajtens pris + obligatorisk städning som sajten inte räknar in
const stadExtra = h => h?.stadning?.typ === 'extra' && h.stadning.kr > 0 ? Math.round(h.stadning.kr) : 0;
function prisa(o, h) {
  if (o.prisSajt == null) o.prisSajt = o.pris; // gamla erbjudanden: priset var sajtens pris
  const extra = stadExtra(h), delta = extra - (o.stadKr || 0);
  o.pris = o.prisSajt + extra;
  if (delta) { // städavgiften ändrades: flytta jämförelsepriserna lika mycket
    if (o.lagsta != null) o.lagsta += delta;
    if (o.forraPris != null) o.forraPris += delta;
    if (o.ordPris != null) o.ordPris += delta;
  }
  if (extra) o.stadKr = extra; else delete o.stadKr;
}

// Priser från webbläsarsajter (Airbnb, Booking …) som inte setts på några dagar räknas som borta (uppbokade)
export function markeraGamla(db, inst = db.installningar || {}) {
  const d = today(), ttl = inst.webbprisDagar ?? 4, now = Date.now();
  for (const x of db.erbjudanden)
    if (x.kalla !== 'novasol' && !x.borta && x.senast && (now - Date.parse(x.senast)) / 864e5 > ttl) x.borta = d;
}

export function mergeErbjudanden(db, kalla, list, { full = false, helger: sokta = null } = {}) {
  const d = today(), now = new Date().toISOString(), seen = new Set();
  for (const o of list) {
    if (!o.hus || !o.helg || !o.pris) continue;
    o.id ||= `${o.hus}-${o.helg}`;
    o.avresa ||= addDays(o.helg, o.natter || 2);
    seen.add(o.id);
    const h = db.hus[o.hus], extra = stadExtra(h);
    const ny = { ...o, prisSajt: o.pris, pris: o.pris + extra, ordPris: o.ordPris != null ? o.ordPris + extra : o.ordPris };
    if (extra) ny.stadKr = extra;
    const old = db.erbjudanden.find(x => x.id === o.id);
    if (old) {
      prisa(old, h); // gamla priset på samma grund (med städning) som det nya
      Object.assign(old, ny, { hittad: old.hittad, senast: now, lagsta: Math.min(old.lagsta ?? old.pris, ny.pris),
        forraPris: old.pris !== ny.pris ? old.pris : old.forraPris });
      if (!extra) delete old.stadKr;
      delete old.borta;
    } else db.erbjudanden.push({ ...ny, hittad: now, senast: now, lagsta: ny.pris });
  }
  if (full) {
    const S = sokta ? new Set(sokta) : null;
    for (const x of db.erbjudanden) if (x.kalla === kalla && !seen.has(x.id) && !x.borta && (!S || S.has(x.helg))) x.borta = d;
  }
  markeraGamla(db);
  // Passerade helger och sådant som varit borta i en vecka rensas bort, liksom hus utan erbjudanden på 60 dagar
  db.erbjudanden = db.erbjudanden.filter(x => x.helg >= d && (!x.borta || daysBetween(x.borta, d) <= 7));
  const used = new Set(db.erbjudanden.map(x => x.hus));
  for (const [id, h] of Object.entries(db.hus)) if (!used.has(id) && h.sedd && daysBetween(h.sedd, d) > 60) delete db.hus[id];
  db.forstaKorning ||= d;
  db.kallstatus[kalla] = { ...(db.kallstatus[kalla] || {}), senast: now, antal: list.length };
  delete db.kallstatus[kalla].fel;
}

// Räkna om alla hus (inställningarna kan ha ändrats) och alla priser (städning kan ha blivit känd)
export const bedomAlla = (db, inst) => {
  for (const h of Object.values(db.hus)) bedom(h, inst);
  for (const o of db.erbjudanden) prisa(o, db.hus[o.hus]);
  markeraGamla(db, inst);
};

// Gillade hus: senaste rösten per namn och hus gäller; +1 = gillad
export function gillade(roster) {
  const sist = {};
  for (const r of [...(roster?.roster || [])].sort((a, b) => (a.t || 0) - (b.t || 0))) sist[`${r.hus}\n${r.namn}`] = r;
  const out = new Set();
  for (const r of Object.values(sist)) if (r.rost === 1) out.add(r.hus);
  return out;
}

// Notiser, bara två slag:
//  (a) nya hus (aldrig notifierade) som klarar kraven, har en helg under målet och minst 3 bonuspoäng – högst 5 rader;
//  (b) hus som någon gillat, när billigaste helgen sjunkit minst 300 kr (jämfört med db.gillatPris, som följer med uppåt).
// roster = innehållet i data/stugor-roster.json (läses från fil om det inte skickas in).
export function pickNotices(db, inst, roster) {
  if (roster === undefined) { try { roster = JSON.parse(readFileSync(PATHS.roster, 'utf8')); } catch { roster = null; } }
  db.notiserade ||= {}; db.gillatPris ||= {};
  const mal = inst.mal || 6000, max = inst.max || 8000, minPoang = inst.notisMinPoang ?? 3, sank = inst.notisSankning ?? 300;
  const billigast = {};
  for (const o of db.erbjudanden) {
    if (o.borta || !db.hus[o.hus] || o.pris > max) continue;
    if (!billigast[o.hus] || o.pris < billigast[o.hus].pris) billigast[o.hus] = o;
  }
  const B = inst.bonus || {};
  const rad = (h, o, extra = '', ikon = '🛁') => `${ikon} ${h.namn || h.ort}${h.narmast ? ` (≈ ${fmtH(h.narmast.timmar)} från ${h.narmast.stad})` : ''}: ${fmtDate(o.helg)}–${fmtDate(o.avresa)} ${kr(o.pris)}${extra}`
    + `${h.baddar ? `, ${h.baddar} bäddar` : ''}${h.bonus?.some(b => b !== 'baddar') ? ', ' + h.bonus.filter(b => b !== 'baddar').map(b => (B[b]?.namn || b).toLowerCase()).join(', ') : ''} (${h.kallaNamn || h.kalla})`;

  const nya = [];
  for (const [hid, o] of Object.entries(billigast)) {
    const h = db.hus[hid];
    if (db.notiserade[hid] || !h.kravOk || o.pris > mal || (h.poang || 0) < minPoang) continue;
    nya.push([h, o]);
  }
  nya.sort((a, b) => b[0].poang - a[0].poang || a[1].pris - b[1].pris);
  const out = nya.slice(0, 5).map(([h, o]) => { db.notiserade[h.id] = { pris: o.pris, helg: o.helg }; return rad(h, o); });

  const gill = gillade(roster);
  for (const hid of gill) {
    const o = billigast[hid], ref = db.gillatPris[hid];
    if (!o) continue;
    if (ref == null || o.pris > ref.pris) { db.gillatPris[hid] = { pris: o.pris, helg: o.helg }; continue; }
    if (o.pris > ref.pris - sank) continue;
    db.gillatPris[hid] = { pris: o.pris, helg: o.helg };
    out.push(rad(db.hus[hid], o, ` (förut ${kr(ref.pris)})`, '👍'));
  }
  for (const id of Object.keys(db.notiserade)) if (!db.hus[id]) delete db.notiserade[id];
  for (const id of Object.keys(db.gillatPris)) if (!gill.has(id) || !db.hus[id]) delete db.gillatPris[id];
  return out;
}
export const fmtH = t => { const h = Math.floor(t), m = Math.round((t - h) * 60 / 5) * 5; return m === 60 ? `${h + 1} h` : h ? `${h} h${m ? ' ' + m : ''}` : `${m} min`; };
