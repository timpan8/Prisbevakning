// Gemensam logik för bostadsbevakningen (fliken Boende): läsa/spara krypterat, bedöma lägenheter (krav, bonus, inlärda
// regler, likhet med gillade), slå ihop AI-rutinens fynd och välja notiser. Används av boende/merge.mjs.
//
// data/boende.enc.json (krypterad med samma kod som databasen):
//   annonser: { "<kalla>-<kod>": { id, kalla, kod, url, adress, omrade, kommun, lat, lon, rum, kvm, biarea, vaning, hiss,
//       avgift (kr/mån), drift, byggar, brf, bilder: [url], beskrivning, balkong, uteplats, takterrass, vattenutsikt,
//       vattenMeter, grill, unikt, unikText, publicerad, visningar: [ISO], utrop, budgivning, status, priser: [{datum, pris, typ}],
//       hittad, kollad, restid: {solnaStrand, centrum, byten, linjer, tbanaNamn, tbanaMeter, hamtad},
//       -- uträknat: kategori ("huvud" | "tvaa" | "ovriga"), kravMiss [..], bonus [..], poang, liknar [id] } }
//   arkiv: { "<id>": { id, adress, omrade, kommun, rum, kvm, avgift, utrop, slutpris, status ("sald"|"borttagen"), datum,
//       publicerad, dagar, bild, url, priser, lat, lon } }   sålda och borttagna, sparas för alltid
//   notiserade: { "<id>": { pris, visning, sald } }, kallstatus: { kalla: { senast, antal } }, svept: { kalla: datum }
// data/boende-val.enc.json (skrivs av sidan): { "<id>": { val: "gilla"|"ogilla", datum, orsaker: [..], text, snap: {...} } }
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { encryptJson, decryptJson } from '../tools/crypt.mjs';
import { today, norm, kr } from '../resor/lib.mjs';
import { meter } from './sl.mjs';
export { today, norm, kr };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Pendeltåg, lokalbanor och spårväg (inte tunnelbana): [namn, lat, lon, typ]
const SPAR = JSON.parse(readFileSync(path.join(ROOT, 'boende', 'spar.json'), 'utf8')).stationer;
// Närmaste station med spår (utom T-bana): { namn, typ, meter (ungefärlig gångväg, fågelväg × 1,25) }
export function narmasteSpar(lat, lon) {
  let b = null;
  for (const [namn, la, lo, typ] of SPAR) { const m = meter([lat, lon], [la, lo]); if (!b || m < b.m) b = { namn, typ, m }; }
  return b && { namn: b.namn, typ: b.typ, meter: Math.round(b.m * 1.25 / 10) * 10 };
}
export const PATHS = {
  data: process.env.BOENDE_DATA || path.join(ROOT, 'data', 'boende.enc.json'), // BOENDE_DATA: annan fil vid test
  val: process.env.BOENDE_VAL || path.join(ROOT, 'data', 'boende-val.enc.json'),
  inst: path.join(ROOT, 'boende', 'installningar.json'),
  kallor: path.join(ROOT, 'boende', 'kallor.json'),
};
export const PAGE = 'https://timpan8.github.io/Prisbevakning/#/boende';
const readJson = async (f, fallback) => existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : fallback;
export const writeJson = (f, o) => writeFile(f, JSON.stringify(o, null, 1) + '\n');
const daysBetween = (a, b) => Math.round((Date.parse(b.slice(0, 10) + 'T12:00:00Z') - Date.parse(a.slice(0, 10) + 'T12:00:00Z')) / 864e5);

export async function loadAll(pass) {
  if (!pass) throw new Error('PRIS_KOD saknas');
  const [box, vbox, inst, kallor] = await Promise.all([readJson(PATHS.data, null), readJson(PATHS.val, null), readJson(PATHS.inst, {}), readJson(PATHS.kallor, { kallor: [] })]);
  const db = box ? await decryptJson(box, pass) : { version: 1, uppdaterad: null, annonser: {}, arkiv: {}, notiserade: {}, kallstatus: {}, svept: {} };
  let val = {};
  if (vbox) try { val = await decryptJson(vbox, pass) || {}; } catch (e) { console.error('Kunde inte läsa valen (boende-val.enc.json): ' + e.message); }
  return { db, val, inst, kallor };
}
export async function saveDb(db, pass) { await writeJson(PATHS.data, await encryptJson(db, pass)); }

// Ord som eget ord (eller början av ett sammansatt ord: "Rinkebyskolan" men inte "Ålby" i "Kålbyn")
// Korta namn (Lina, Alby) bara som hela ord.
const harOrd = (text, ord) => { const o = norm(ord); return new RegExp(`(^|[^a-z0-9])${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${o.length <= 4 ? '($|[^a-z0-9])' : ''}`).test(text); };
const harNagot = (text, lista) => (lista || []).find(o => text.includes(norm(o)));
const omradeText = a => norm([a.omrade, a.adress, a.kommun].filter(Boolean).join(' , '));

export function uteslutet(a, inst) {
  const U = inst.uteslutnaOmraden || {}, t = omradeText(a);
  return [...(U.sarskiltUtsatta || []), ...(U.utsatta || []), ...(U.egna || [])].find(o => harOrd(t, o)) || null;
}
export const krKvmAr = a => a.avgift && a.kvm ? Math.round(a.avgift * 12 / a.kvm) : null;
export const kvmPris = a => a.utrop && a.kvm ? Math.round(a.utrop / a.kvm) : null;

// Inlärda regler (installningar.larda): { falt, op ("<", "<=", ">", ">=", "==", "ord"), varde, poang, varfor }
function regelTraff(a, r) {
  if (r.op === 'ord') return norm(a.beskrivning).includes(norm(r.varde)) || omradeText(a).includes(norm(r.varde));
  const v = r.falt === 'krKvmAr' ? krKvmAr(a) : r.falt === 'kvmPris' ? kvmPris(a) : r.falt?.startsWith('restid.') ? a.restid?.[r.falt.slice(7)] : a[r.falt];
  if (v == null) return false;
  return { '<': v < r.varde, '<=': v <= r.varde, '>': v > r.varde, '>=': v >= r.varde, '==': v == r.varde }[r.op] ?? false;
}

// Liknar en gillad: inom 1,5 km, kvm-pris inom ±20 % och minst lika många rum (eller samma område och samma bonusar)
export function liknar(a, val, db) {
  const out = [];
  for (const [id, v] of Object.entries(val || {})) {
    if (v.val !== 'gilla' || id === a.id) continue;
    const g = db.annonser[id] || db.arkiv?.[id] || v.snap;
    if (!g || g.lat == null || a.lat == null) continue;
    const nara = meter([a.lat, a.lon], [g.lat, g.lon]) <= 1500;
    const kp = kvmPris(a), gkp = kvmPris(g);
    const pris = kp && gkp ? Math.abs(kp - gkp) / gkp <= 0.2 : true;
    const rum = !g.rum || !a.rum || a.rum >= g.rum - 0.5;
    const bonus = (g.bonus || []).filter(b => !['restid', 'tbana'].includes(b));
    const sammaBonus = bonus.length >= 2 && bonus.every(b => a.bonus?.includes(b));
    if ((nara && pris && rum) || (sammaBonus && pris && rum)) out.push(id);
  }
  return out;
}

export function bedom(a, inst, val = {}, db = { annonser: {} }) {
  const B = inst.bonus || {}, O = inst.ord || {}, text = norm([a.beskrivning, a.unikText].filter(Boolean).join(' '));
  const miss = [];
  if (a.utrop > (inst.maxUtrop || 4e6)) miss.push(`utropspris ${kr(a.utrop)}`);
  const ut = uteslutet(a, inst);
  if (ut) miss.push(`utsatt område (${ut})`);
  if (a.restid?.solnaStrand != null && a.restid.solnaStrand > (inst.maxMinuter || 40)) miss.push(`${a.restid.solnaStrand} min till ${inst.mal?.namn || 'målet'}`);
  if (!a.restid) miss.push(a.lat == null ? 'saknar position' : 'restiden räknas ut vid nästa körning');
  else if (a.restid.solnaStrand == null) miss.push('restiden gick inte att räkna ut');
  if (a.rum != null && a.rum < (inst.minRumTvaor || 2)) miss.push(`${a.rum} rum`);
  a.kravMiss = miss;
  a.kategori = miss.length ? 'ovriga' : (a.rum ?? 0) >= (inst.minRum || 3) ? 'huvud' : 'tvaa';

  const bonus = [];
  if (a.takterrass || harNagot(text, O.takterrass)) bonus.push('takterrass');
  if (a.vattenutsikt || harNagot(text, O.vattenutsikt)) bonus.push('vattenutsikt');
  if (a.balkong || (/balkong/.test(text) && !/(ingen|saknar|utan) balkong/.test(text))) bonus.push('balkong');
  if (a.grill || harNagot(text, O.grill)) bonus.push('grill');
  const city = inst.centrum && a.lat != null ? meter([a.lat, a.lon], [inst.centrum.lat, inst.centrum.lon]) : null;
  if ((a.restid?.centrum != null && a.restid.centrum <= (B.centrum?.maxMinuter ?? 20)) || (city != null && city <= (B.centrum?.maxKm ?? 4) * 1000)) bonus.push('centrum');
  const ka = krKvmAr(a); if (ka != null && ka <= (B.avgift?.maxKrKvm ?? 650)) bonus.push('avgift');
  if (a.unikt || harNagot(text, O.unikt)) bonus.push('unikt');
  if (a.restid?.tbanaMeter != null && a.restid.tbanaMeter <= (B.tbana?.maxMeter ?? 700)) bonus.push('tbana');
  // Gångavstånd till pendeltåg, lokalbana eller spårväg (räknas bara när T-banan inte redan gett bonus)
  a.spar = a.lat != null ? narmasteSpar(a.lat, a.lon) : null;
  if (B.spar && a.spar && a.spar.meter <= (B.spar.maxMeter ?? 700) && !bonus.includes('tbana')) bonus.push('spar');
  if (a.restid?.solnaStrand != null && a.restid.solnaStrand <= (B.restid?.maxMinuter ?? 25)) bonus.push('restid');
  // Stor tvåa: plats för en arbetsplats
  if (a.kategori === 'tvaa' && B.stor2a && a.kvm >= (B.stor2a.minKvm ?? 55)) bonus.push('stor2a');
  a.bonus = bonus;
  let p = bonus.reduce((s, b) => s + (B[b]?.poang ?? 1), 0);
  a.larda = [];
  for (const r of inst.larda || []) if (regelTraff(a, r)) { p += r.poang || 0; a.larda.push(r.varfor || `${r.falt} ${r.op} ${r.varde}`); }
  a.liknar = liknar(a, val, db);
  if (a.liknar.length) p += 2;
  a.poang = p;
  return a;
}
export const bedomAlla = (db, inst, val) => { for (const a of Object.values(db.annonser)) bedom(a, inst, val, db); };

const FALT = ['kalla', 'kod', 'url', 'adress', 'omrade', 'kommun', 'lat', 'lon', 'rum', 'kvm', 'biarea', 'vaning', 'hiss', 'avgift', 'drift',
  'byggar', 'brf', 'bilder', 'beskrivning', 'balkong', 'uteplats', 'takterrass', 'vattenutsikt', 'vattenMeter', 'grill', 'unikt', 'unikText',
  'publicerad', 'visningar', 'utrop', 'budgivning', 'energiklass', 'typ', 'upplatelse', 'nyproduktion', 'dagarHemnet', 'visad', 'detaljHamtad'];
const NUM = ['lat', 'lon', 'rum', 'kvm', 'biarea', 'avgift', 'drift', 'byggar', 'utrop', 'vattenMeter', 'dagarHemnet', 'visad'];

// En annons från inkorgen: uppdaterar fakta, prishistorik och status. Returnerar id.
export function mergeAnnons(db, o) {
  const id = `${o.kalla}-${o.kod}`, d = today(), now = new Date().toISOString();
  const old = db.annonser[id], a = old || { id, priser: [], hittad: now };
  for (const f of FALT) if (o[f] !== undefined && o[f] !== null && o[f] !== '') a[f] = NUM.includes(f) ? +o[f] : o[f];
  if (Array.isArray(a.bilder)) a.bilder = a.bilder.filter(Boolean).slice(0, 8);
  if (typeof a.beskrivning === 'string') a.beskrivning = a.beskrivning.slice(0, 2500);
  const sista = [...a.priser].reverse().find(x => ['utrop', 'sankt', 'hojt'].includes(x.typ));
  if (a.utrop && (!sista || sista.pris !== a.utrop)) a.priser.push({ datum: d, pris: a.utrop, typ: !sista ? 'utrop' : a.utrop < sista.pris ? 'sankt' : 'hojt' });
  if (o.budgivning && !a.priser.some(x => x.typ === 'budgivning')) a.priser.push({ datum: d, typ: 'budgivning', pris: o.hogstaBud || null });
  if (o.hogstaBud) { const b = a.priser.find(x => x.typ === 'budgivning'); if (b) b.pris = Math.max(b.pris || 0, +o.hogstaBud); }
  a.status = o.budgivning ? 'budgivning' : 'till-salu';
  a.kollad = now; a.sedd = d;
  db.annonser[id] = a;
  return id;
}

// Såld eller borttagen: flyttas till arkivet (kompakt) och sparas för alltid
export function arkivera(db, id, { status = 'sald', slutpris = null, datum = null } = {}) {
  const a = db.annonser[id]; if (!a) return null;
  const d = datum || today();
  if (slutpris) a.priser.push({ datum: d, pris: +slutpris, typ: 'slutpris' });
  db.arkiv ||= {};
  db.arkiv[id] = { id, adress: a.adress, omrade: a.omrade, kommun: a.kommun, rum: a.rum, kvm: a.kvm, avgift: a.avgift, utrop: a.priser.find(x => x.typ === 'utrop')?.pris ?? a.utrop,
    sistaUtrop: a.utrop, slutpris: slutpris ? +slutpris : null, status, datum: d, publicerad: a.publicerad, dagar: a.publicerad ? daysBetween(a.publicerad, d) : null,
    bild: a.bilder?.[0] || null, url: a.url, priser: a.priser, lat: a.lat, lon: a.lon, kategori: a.kategori, bonus: a.bonus, restid: a.restid?.solnaStrand ?? null };
  delete db.annonser[id];
  return db.arkiv[id];
}

// Notiser: ny bra matchning (huvudlistan, poäng ≥ notisPoang eller liknar en gillad); för gillade även prissänkning,
// ny visning och såld. En gång per händelse.
export function pickNotices(db, inst, val, { salda = [] } = {}) {
  db.notiserade ||= {};
  const out = [], B = inst.bonus || {};
  const rad = a => `${a.rum ?? '?'} rok ${a.kvm ? a.kvm + ' kvm' : ''}, ${a.omrade || a.adress}: ${kr(a.utrop)}${a.avgift ? `, avgift ${kr(a.avgift)}` : ''}${a.restid?.solnaStrand != null ? `, ${a.restid.solnaStrand} min till ${inst.mal?.namn}` : ''}`;
  const bon = a => (a.bonus || []).filter(b => !['restid'].includes(b)).map(b => (B[b]?.namn || b).toLowerCase()).join(', ');
  const nya = [];
  for (const a of Object.values(db.annonser)) {
    const n = db.notiserade[a.id], gillad = val[a.id]?.val === 'gilla', ogillad = val[a.id]?.val === 'ogilla';
    if (ogillad) continue;
    if (!n && (a.kategori === 'huvud' || a.bonus?.includes('stor2a')) && (a.poang >= (inst.notisPoang ?? 6) || a.liknar?.length)) {
      nya.push(a); db.notiserade[a.id] = { pris: a.utrop, visning: a.visningar?.[0] || null };
      continue;
    }
    if (!n) { if (gillad) db.notiserade[a.id] = { pris: a.utrop, visning: (a.visningar || []).filter(x => x >= new Date().toISOString()).sort()[0] || null }; continue; }
    if (gillad && a.utrop && n.pris && a.utrop < n.pris) out.push(`📉 ${a.adress || a.omrade}: sänkt till ${kr(a.utrop)} (var ${kr(n.pris)})`);
    const v = (a.visningar || []).filter(x => x >= new Date().toISOString()).sort()[0];
    if (gillad && v && v !== n.visning) out.push(`👀 ${a.adress || a.omrade}: visning ${new Date(v).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`);
    Object.assign(n, { pris: a.utrop, visning: v || n.visning });
  }
  for (const s of salda) if (val[s.id]?.val === 'gilla') out.push(`🔨 ${s.adress || s.omrade}: ${s.status === 'sald' ? `såld${s.slutpris ? ` för ${kr(s.slutpris)} (utrop ${kr(s.utrop)})` : ''}` : 'borttagen från Hemnet'}`);
  nya.sort((a, b) => b.poang - a.poang);
  const top = nya.slice(0, 6).map(a => `🏠 ${rad(a)}${bon(a) ? ' · ' + bon(a) : ''}${a.liknar?.length ? ' · liknar en du gillat' : ''}`);
  if (nya.length > 6) top.push(`… och ${nya.length - 6} till`);
  for (const id of Object.keys(db.notiserade)) if (!db.annonser[id]) delete db.notiserade[id];
  return [...top, ...out];
}
