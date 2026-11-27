// Gemensam logik för stugbevakningen (fliken Stugor): läsa/spara, bedöma hus (krav, bonuspoäng, restid),
// slå ihop körningar och välja notiser. Används av stugor/run.mjs (datorns jobb) och stugor/merge.mjs (AI-rutinens inkorg).
//
// data/stugor.json:
//   hus: { "<kalla>-<kod>": { id, kalla, kallaNamn, kod, namn, typ, ort, lat, lon, baddar, sovrum, bilder: [url],
//          url, betyg, bubbelpool (true/false/null), bubbelpoolText, bastu, vattenMeter, restaurangMeter,
//          ortMeter, ortNamn, grannarMeter, not, detaljHamtad,
//          -- uträknat: narmast {stad, timmar}, restider {stad: timmar}, kravOk, kravMiss [..], poang, bonus [..] } }
//   erbjudanden: [ { id, hus, kalla, helg (ankomst, fredag), avresa, natter, pris (totalt), forraPris, lagsta,
//                    url, hittad, senast, borta? } ]
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { today, norm, kr, fmtDate } from '../resor/lib.mjs';
export { today, norm, kr, fmtDate };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PATHS = {
  data: process.env.STUGOR_DATA || path.join(ROOT, 'data', 'stugor.json'), // STUGOR_DATA: annan fil vid test
  inst: path.join(ROOT, 'stugor', 'installningar.json'),
  kallor: path.join(ROOT, 'stugor', 'kallor.json'),
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

// Krav och bonuspoäng för ett hus. Okänt (null) räknas inte som miss för bonus, men bubbelpool måste vara bekräftad.
export function bedom(h, inst) {
  const B = inst.bonus || {};
  h.restider = restider(h.lat, h.lon, inst);
  if (h.restider) { const [stad, timmar] = Object.entries(h.restider).sort((a, b) => a[1] - b[1])[0]; h.narmast = { stad, timmar }; }
  const typ = norm(h.typ), miss = [];
  if (h.bubbelpool !== true) miss.push(h.bubbelpool === false ? 'ingen bubbelpool' : 'bubbelpool ej bekräftad');
  // Ordet eller ett sammansatt ord som slutar på det ("semesterlägenhet", "hotellrum")
  const ord = typ.split(/[^a-z0-9]+/).filter(Boolean);
  if ((inst.nekadeTyper || []).some(t => ord.some(w => w.endsWith(norm(t))))) miss.push('inte ett helt hus');
  if (h.baddar != null && h.baddar < (inst.minBaddar || 4)) miss.push(`bara ${h.baddar} bäddar`);
  if (h.narmast && h.narmast.timmar > (inst.maxTimmar || 3)) miss.push(`för långt bort (≈ ${h.narmast.timmar} h)`);
  h.kravMiss = miss; h.kravOk = !miss.length;
  const bonus = [];
  if (h.bastu) bonus.push('bastu');
  if (h.sjotomt || (h.vattenMeter != null && h.vattenMeter <= (B.sjotomt?.maxMeter ?? 150))) bonus.push('sjotomt');
  if (h.restaurangMeter != null && h.restaurangMeter <= (B.bar?.maxMeter ?? 2500)) bonus.push('bar');
  if (h.avskilt || (h.grannarMeter != null && h.grannarMeter >= (B.avskilt?.minMeter ?? 200))) bonus.push('avskilt');
  if (h.baddar >= (inst.helstBaddar || 6)) bonus.push('baddar');
  h.bonus = bonus; h.poang = bonus.reduce((s, b) => s + (B[b]?.poang ?? 1), 0);
  return h;
}

// Slår ihop hus (fakta uppdateras, uträknade fält räknas om) och en källas erbjudanden.
// full = källan söktes i sin helhet för de helger som anges i `helger`; det som saknas där har försvunnit.
export function mergeHus(db, list, inst) {
  for (const h of list) {
    if (!h?.id) continue;
    const old = db.hus[h.id] || {};
    const clean = Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined));
    db.hus[h.id] = bedom({ ...old, ...clean, sedd: today() }, inst);
  }
}
export function mergeErbjudanden(db, kalla, list, { full = false, helger: sokta = null } = {}) {
  const d = today(), now = new Date().toISOString(), seen = new Set();
  for (const o of list) {
    if (!o.hus || !o.helg || !o.pris) continue;
    o.id ||= `${o.hus}-${o.helg}`;
    o.avresa ||= addDays(o.helg, o.natter || 2);
    seen.add(o.id);
    const old = db.erbjudanden.find(x => x.id === o.id);
    if (old) {
      Object.assign(old, o, { hittad: old.hittad, senast: now, lagsta: Math.min(old.lagsta ?? old.pris, o.pris),
        forraPris: old.pris !== o.pris ? old.pris : old.forraPris });
      delete old.borta;
    } else db.erbjudanden.push({ ...o, hittad: now, senast: now, lagsta: o.pris });
  }
  if (full) {
    const S = sokta ? new Set(sokta) : null;
    for (const x of db.erbjudanden) if (x.kalla === kalla && !seen.has(x.id) && !x.borta && (!S || S.has(x.helg))) x.borta = d;
  }
  // Passerade helger och sådant som varit borta i en vecka rensas bort, liksom hus utan erbjudanden på 60 dagar
  db.erbjudanden = db.erbjudanden.filter(x => x.helg >= d && (!x.borta || daysBetween(x.borta, d) <= 7));
  const used = new Set(db.erbjudanden.map(x => x.hus));
  for (const [id, h] of Object.entries(db.hus)) if (!used.has(id) && h.sedd && daysBetween(h.sedd, d) > 60) delete db.hus[id];
  db.forstaKorning ||= d;
  db.kallstatus[kalla] = { ...(db.kallstatus[kalla] || {}), senast: now, antal: list.length };
  delete db.kallstatus[kalla].fel;
}

// Räkna om alla hus (inställningarna kan ha ändrats)
export const bedomAlla = (db, inst) => { for (const h of Object.values(db.hus)) bedom(h, inst); };

// Notis: hus som klarar kraven med en helg under målet. En gång per hus, och igen bara om husets
// billigaste helg blir minst 300 kr billigare än när vi notifierade. Högst 8 rader per notis.
export function pickNotices(db, inst) {
  db.notiserade ||= {};
  const per = {};
  for (const o of db.erbjudanden) {
    const h = db.hus[o.hus];
    if (o.borta || !h?.kravOk || o.pris > (inst.mal || 6000)) continue;
    if (!per[o.hus] || o.pris < per[o.hus].pris) per[o.hus] = o;
  }
  const nya = [];
  for (const [hid, o] of Object.entries(per)) {
    const was = db.notiserade[hid];
    if (was && o.pris > was.pris - 300 && was.helg >= today()) continue;
    db.notiserade[hid] = { pris: o.pris, helg: o.helg };
    nya.push([db.hus[hid], o]);
  }
  for (const id of Object.keys(db.notiserade)) if (!per[id]) delete db.notiserade[id];
  nya.sort((a, b) => b[0].poang - a[0].poang || a[1].pris - b[1].pris);
  const B = inst.bonus || {};
  const out = nya.slice(0, 8).map(([h, o]) => `🛁 ${h.namn || h.ort}${h.narmast ? ` (≈ ${fmtH(h.narmast.timmar)} från ${h.narmast.stad})` : ''}: ${fmtDate(o.helg)}–${fmtDate(o.avresa)} ${kr(o.pris)}`
    + `${h.baddar ? `, ${h.baddar} bäddar` : ''}${h.bonus?.some(b => b !== 'baddar') ? ', ' + h.bonus.filter(b => b !== 'baddar').map(b => (B[b]?.namn || b).toLowerCase()).join(', ') : ''} (${h.kallaNamn || h.kalla})`);
  if (nya.length > 8) out.push(`… och ${nya.length - 8} stugor till under ${kr(inst.mal || 6000)}`);
  return out;
}
export const fmtH = t => { const h = Math.floor(t), m = Math.round((t - h) * 60 / 5) * 5; return m === 60 ? `${h + 1} h` : h ? `${h} h${m ? ' ' + m : ''}` : `${m} min`; };
