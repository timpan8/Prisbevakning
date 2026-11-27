// Gemensam logik för resebevakningen: läsa/spara, kategorisera erbjudanden, slå ihop körningar och välja notiser.
// Används av resor/run.mjs (datorns dagliga jobb) och resor/merge.mjs (AI-rutinens inkorg).
//
// Ett erbjudande: { id, kalla, typ: paket|sammansatt|flyg|flygfynd, fran, ort, land, avresa, hem, dagar,
//   prisPerPerson, prisTva, hotell, kost, rum, url, not, kategori, varm, temp, region, hittad, senast, borta?, lagsta }
// prisTva = totalt för två personer (resor/installningar.json). Malaga-flyget räknas per person.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = {
  data: path.join(ROOT, 'data', 'resor.json'),
  inst: path.join(ROOT, 'resor', 'installningar.json'),
  kallor: path.join(ROOT, 'resor', 'kallor.json'),
  klimat: path.join(ROOT, 'resor', 'klimat.json'),
};
export const PATHS = P;
const readJson = async (f, fallback) => existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : fallback;
export const writeJson = (f, o) => writeFile(f, JSON.stringify(o, null, 1) + '\n');

export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
export const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const slug = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export async function loadAll() {
  const [db, inst, kallor, klimat] = await Promise.all([
    readJson(P.data, null), readJson(P.inst, {}), readJson(P.kallor, { kallor: [] }), readJson(P.klimat, { resmal: {} })]);
  return { db: db || { version: 1, uppdaterad: null, erbjudanden: [], malaga: null, flygFran: {}, notiserade: {}, kallstatus: {} }, inst, kallor, klimat };
}

// Resmålet i klimattabellen: exakt nyckel, alternativt namn, eller ett namn som ingår i orten ("Side, Turkiet").
export function resmal(klimat, ort, land) {
  const R = klimat.resmal || {}, o = norm(ort), l = norm(land);
  if (R[o]) return { key: o, ...R[o] };
  for (const [k, v] of Object.entries(R)) if ((v.namn || []).map(norm).includes(o)) return { key: k, ...v };
  for (const [k, v] of Object.entries(R)) if (o && (o.includes(k) || (v.namn || []).some(n => n.length > 3 && o.includes(norm(n))))) return { key: k, ...v };
  if (l && R[l]) return { key: l, ...R[l] };
  return null;
}

// Kategori enligt installningar.json: weekend (avresa tors–lör, 3–5 dagar), vecka (6–11 dagar, varmt), lång (≥ 14 dagar, fjärran).
export function classify(o, inst, klimat) {
  const r = resmal(klimat, o.ort, o.land);
  const man = o.avresa ? +o.avresa.slice(5, 7) - 1 : null;
  o.region = r?.region || null;
  o.land = o.land || r?.land || null;
  o.temp = r && man != null ? r.temp[man] : null;
  o.varm = o.temp == null ? null : o.temp >= (inst.varmGrad || 25);
  const K = inst.kategorier || {}, d = o.dagar, wd = o.avresa ? new Date(o.avresa + 'T12:00:00Z').getUTCDay() : null;
  const inR = (k, x) => K[k] && x >= K[k].dagar[0] && x <= K[k].dagar[1];
  o.kategori = null;
  if (o.typ === 'flyg') return o;
  if (inR('weekend', d) && [4, 5, 6].includes(wd)) o.kategori = 'weekend';
  else if (inR('vecka', d) && o.varm !== false && o.region !== 'fjarran') o.kategori = 'vecka';
  else if (inR('lang', d) && (o.region == null || (K.lang.regioner || ['fjarran']).includes(o.region))) o.kategori = 'lang';
  else if (o.typ === 'flygfynd' && o.region === 'fjarran') o.kategori = 'lang';
  return o;
}

export function finish(o, inst) {
  const n = inst.personer || 2;
  if (o.prisTva == null && o.prisPerPerson != null) o.prisTva = Math.round(o.prisPerPerson * n);
  if (o.prisPerPerson == null && o.prisTva != null) o.prisPerPerson = Math.round(o.prisTva / n);
  if (!o.hem && o.avresa && o.dagar) o.hem = addDays(o.avresa, o.dagar - 1);
  if (!o.dagar && o.avresa && o.hem) o.dagar = daysBetween(o.avresa, o.hem) + 1;
  o.id = o.id || slug([o.kalla, o.fran, o.ort, o.avresa, o.dagar, o.hotell].filter(Boolean).join(' ')).slice(0, 120);
  return o;
}

// Slår ihop en källas erbjudanden. full = källan lästes i sin helhet, så det som saknas har försvunnit.
export function mergeSource(db, kalla, list, { full = true } = {}) {
  const d = today(), now = new Date().toISOString(), seen = new Set();
  for (const o of list) {
    seen.add(o.id);
    const old = db.erbjudanden.find(x => x.id === o.id);
    if (old) {
      const lagsta = Math.min(old.lagsta ?? old.prisTva, o.prisTva);
      Object.assign(old, o, { hittad: old.hittad, senast: now, lagsta, forraPris: old.prisTva !== o.prisTva ? old.prisTva : old.forraPris });
      delete old.borta;
    } else db.erbjudanden.push({ ...o, hittad: now, senast: now, lagsta: o.prisTva });
  }
  if (full) for (const x of db.erbjudanden) if (x.kalla === kalla && !seen.has(x.id) && !x.borta) x.borta = d;
  // Passerade avresor och sådant som varit borta i två veckor rensas bort
  db.erbjudanden = db.erbjudanden.filter(x => (!x.avresa || x.avresa >= d) && (!x.borta || daysBetween(x.borta, d) <= 14));
  db.kallstatus[kalla] = { senast: now, antal: list.length };
}

// Nya fynd som ska ge pushnotis: kategorins mål (långresor ända upp till max), och Malaga under målet.
// Varje fynd notifieras en gång, och igen bara om priset sjunker.
export function pickNotices(db, inst) {
  const K = inst.kategorier || {}, out = [];
  db.notiserade ||= {};
  for (const o of db.erbjudanden) {
    const k = K[o.kategori]; if (!k || o.borta) continue;
    const grans = k.notisUpp === 'max' ? k.max : k.mal;
    if (o.prisTva > grans) continue;
    if (k.varm === 'krav' && o.varm === false) continue;
    const was = db.notiserade[o.id];
    if (was && o.prisTva >= was) continue;
    db.notiserade[o.id] = o.prisTva;
    out.push(`${{ weekend: '🌴', vecka: '☀️', lang: '🌏' }[o.kategori] || '✈️'} ${k.namn}: ${o.ort}${o.land && !norm(o.ort).includes(norm(o.land)) ? ', ' + o.land : ''} ${fmtDate(o.avresa)}, ${o.dagar} dagar – ${kr(o.prisTva)} för två${o.prisTva <= k.mal ? ' (under målet)' : ''} (${o.hotell ? o.hotell + ', ' : ''}${o.kallaNamn || o.kalla})`);
  }
  const m = db.malaga?.basta, M = inst.malaga;
  if (m && M && m.pris < M.mal) {
    const was = db.notiserade.malaga;
    if (!was || m.pris < was.pris - 50 || was.ut < today()) {
      db.notiserade.malaga = { pris: m.pris, ut: m.ut };
      out.push(`✈️ Malaga tur och retur ${kr(m.pris)} per person (${m.fran} ${fmtDate(m.ut)}–${fmtDate(m.hem)}, Ryanair)`);
    }
  }
  // Rensa notiser för erbjudanden som inte finns kvar
  for (const id of Object.keys(db.notiserade)) if (id !== 'malaga' && !db.erbjudanden.some(o => o.id === id)) delete db.notiserade[id];
  return out;
}

const MON = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
export const fmtDate = d => d ? `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]}` : '';
export const kr = n => Math.round(n).toLocaleString('sv-SE') + ' kr';
export const PAGE = 'https://timpan8.github.io/Prisbevakning/#/resor';
