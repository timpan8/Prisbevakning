// Restid med kollektivtrafik för bostadsbevakningen: SL:s öppna reseplanerare v2 (ingen nyckel behövs).
// Från annonsens koordinat till Solna strand och T-Centralen en vardag med ankomst 08:30. Gångavståndet till närmaste
// tunnelbana räknas från stationslistan i boende/tbana.json (fågelväg × 1,25). Hämtningen går via den gemensamma
// snälla hämtningen i Automation (lib/fetch.mjs), som håller takten mot sajten.
//
//   node boende/sl.mjs --test        provkör några kända adresser
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const TBANA = JSON.parse(readFileSync(path.join(DIR, 'tbana.json'), 'utf8')).stationer;
const API = 'https://journeyplanner.integration.sl.se/v2/trips';
const RAD = Math.PI / 180;
export function meter(a, b) {
  const dLat = (b[0] - a[0]) * RAD, dLon = (b[1] - a[1]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

// Närmaste tunnelbanestation: { namn, meter (ungefärlig gångväg) }
export function narmasteTbana(lat, lon) {
  let best = null;
  for (const [namn, la, lo] of TBANA) { const m = meter([lat, lon], [la, lo]); if (!best || m < best.m) best = { namn, m }; }
  return best && { namn: best.namn, meter: Math.round(best.m * 1.25 / 10) * 10 };
}

// Nästa vardag (måndag–fredag) från i morgon, som ÅÅÅÅMMDD
function vardag() {
  const d = new Date(Date.now() + 864e5);
  while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' }).replace(/-/g, '');
}
const LAG = { 0: 'pendeltåg', 1: 'pendeltåg', 2: 'tunnelbana', 4: 'spårväg', 5: 'buss', 7: 'buss', 9: 'båt', 10: 'buss' };

// Kortaste resan (minuter) till en hållplats. Returnerar { min, byten, linjer: ["T10", "buss 512"] } eller null.
export async function resa(lat, lon, till, { getJson, ankomst = '08:30' }) {
  const u = new URL(API);
  const q = { type_origin: 'coord', name_origin: `${(+lon).toFixed(5)}:${(+lat).toFixed(5)}:WGS84[dd.ddddd]`, type_destination: 'any',
    name_destination: till.id, calc_number_of_trips: '3', itd_date: vardag(), itd_time: ankomst.replace(':', ''), itd_trip_date_time_dep_arr: 'arr' };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  const j = await getJson(u.toString());
  const res = (j.journeys || []).filter(x => x.tripDuration > 0).sort((a, b) => a.tripDuration - b.tripDuration)[0];
  if (!res) return null;
  const linjer = res.legs.filter(l => l.transportation?.product?.class < 99)
    .map(l => { const c = l.transportation.product.class, n = l.transportation.disassembledName || l.transportation.number || ''; return c === 2 ? `T${n}` : `${LAG[c] || l.transportation.product.name || 'linje'} ${n}`.trim(); });
  return { min: Math.round(res.tripDuration / 60), byten: res.interchanges ?? Math.max(0, linjer.length - 1), linjer };
}

// Allt för en annons: { solnaStrand, centrum, byten, linjer, tbanaNamn, tbanaMeter, hamtad }
export async function restid(lat, lon, inst, ctx) {
  const tb = narmasteTbana(lat, lon), out = { tbanaNamn: tb?.namn, tbanaMeter: tb?.meter, hamtad: new Date().toISOString().slice(0, 10) };
  const a = await resa(lat, lon, inst.mal, { ...ctx, ankomst: inst.ankomst });
  // Mycket nära målet: gångavståndet räcker
  if (!a && meter([lat, lon], [inst.mal.lat, inst.mal.lon]) < 1200) Object.assign(out, { solnaStrand: Math.round(meter([lat, lon], [inst.mal.lat, inst.mal.lon]) * 1.25 / 80), byten: 0, linjer: ['gång'] });
  else if (a) Object.assign(out, { solnaStrand: a.min, byten: a.byten, linjer: a.linjer });
  // T-Centralen bara när resan till målet klarar kravet (sparar hälften av anropen)
  if (inst.centrum?.id && (out.solnaStrand ?? 99) <= (inst.maxMinuter || 40)) { const c = await resa(lat, lon, inst.centrum, { ...ctx, ankomst: inst.ankomst }).catch(() => null); if (c) out.centrum = c.min; }
  return out;
}

if (process.argv.includes('--test')) {
  const HOME = (process.env.AUTOMATION_HOME || 'C:/Users/TimLi/Dev/Automation').replace(/\\/g, '/');
  const { getJson } = await import('file:///' + HOME + '/lib/fetch.mjs');
  const inst = JSON.parse(readFileSync(path.join(DIR, 'installningar.json'), 'utf8'));
  for (const [namn, lat, lon] of [['Sundbyberg centrum', 59.3612, 17.9719], ['Medborgarplatsen', 59.3150, 18.0710], ['Täby centrum', 59.4440, 18.0687], ['Hagsätra', 59.2626, 18.0128]])
    console.log(namn, JSON.stringify(await restid(lat, lon, inst, { getJson })));
}
