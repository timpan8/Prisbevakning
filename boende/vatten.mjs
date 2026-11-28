// Avstånd till vatten för bostadsbevakningen, beräknat lokalt ur boende/vatten.json (strandpunkter ur OpenStreetMap,
// byggt med boende/vatten-bygg.mjs). Fågelväg till närmaste strandpunkt; ett rutnätsindex byggs vid första anropet.
//
//   import { narmasteVatten } from './vatten.mjs';   narmasteVatten(59.3445, 17.9858) -> { meter: 210, namn: 'Mälaren' }
//   node boende/vatten.mjs --test                     provkör några kända lägen
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RAD = Math.PI / 180;
const CELL = 0.01;          // grader lat per ruta (~1,1 km); lon-rutan skalas så att rutorna blir ungefär kvadratiska
const MAX_M = 20000;        // längre bort än så söker vi inte
let IX = null;

function ladda() {
  const d = JSON.parse(readFileSync(path.join(DIR, 'vatten.json'), 'utf8'));
  const kLon = Math.cos(59.5 * RAD), cLon = CELL / kLon;
  // Avkoda deltakodade linjer: [namnindex, lat0, lon0, dlat, dlon, ...] i 1e-4 grader från d.bas
  const n = d.antal, lat = new Float64Array(n), lon = new Float64Array(n), nm = new Int32Array(n);
  const rutor = new Map();
  let i = 0;
  for (const rad of d.linjer) {
    let qa = rad[1], qo = rad[2];
    for (let k = 1; k < rad.length; k += 2) {
      if (k > 1) { qa += rad[k]; qo += rad[k + 1]; }
      const la = d.bas[0] + qa / 1e4, lo = d.bas[1] + qo / 1e4;
      lat[i] = la; lon[i] = lo; nm[i] = rad[0];
      const key = Math.floor(la / CELL) * 100000 + Math.floor(lo / cLon);
      let r = rutor.get(key); if (!r) rutor.set(key, r = []); r.push(i);
      i++;
    }
  }
  IX = { lat, lon, nm, namn: d.namn || [], rutor, cLon };
}

function meter(la1, lo1, la2, lo2) {
  const dLat = (la2 - la1) * RAD, dLon = (lo2 - lo1) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * RAD) * Math.cos(la2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

// Närmaste vatten: { meter (avrundat till 10 m), namn? } eller null om inget inom 20 km / ogiltig koordinat
export function narmasteVatten(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!IX) ladda();
  const { rutor, cLon } = IX;
  const r0 = Math.floor(lat / CELL), c0 = Math.floor(lon / cLon);
  const rutaM = CELL * 110540; // ruthöjd i meter (≈ bredd)
  let bäst = Infinity, bi = -1;
  for (let ring = 0; ring * rutaM <= MAX_M + rutaM; ring++) {
    // Alla punkter i ringen "ring" rutor bort; vi kan sluta när det bästa är närmare än ringens inre kant
    if (bi >= 0 && bäst <= (ring - 1) * rutaM) break;
    for (let dr = -ring; dr <= ring; dr++) for (let dc = -ring; dc <= ring; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
      const lista = rutor.get((r0 + dr) * 100000 + (c0 + dc)); if (!lista) continue;
      for (const i of lista) {
        const m = meter(lat, lon, IX.lat[i], IX.lon[i]);
        if (m < bäst) { bäst = m; bi = i; }
      }
    }
  }
  if (bi < 0 || bäst > MAX_M) return null;
  const ut = { meter: Math.round(bäst / 10) * 10 };
  if (IX.nm[bi] >= 0) ut.namn = IX.namn[IX.nm[bi]];
  return ut;
}

if (process.argv.includes('--test')) {
  const lägen = [
    ['Huvudsta strand', 59.3445, 17.9858, 'nära'],
    ['Hornsbergs strand', 59.3376, 18.0103, 'nära'],
    ['Solna centrum', 59.3600, 18.0000, 'längre bort'],
    ['Tensta', 59.3946, 17.9010, '?'],
    ['Gamla stan, Skeppsbron', 59.3247, 18.0761, 'mycket nära'],
    ['Södermalm, Medborgarplatsen', 59.3144, 18.0733, '~400 m'],
    ['Vasastan, Odenplan', 59.3430, 18.0496, '~1 km'],
    ['Kista centrum', 59.4030, 17.9445, 'långt'],
    ['Sundbyberg centrum', 59.3612, 17.9718, '?'],
  ];
  const t0 = performance.now(); narmasteVatten(59.33, 18.06); const tLadd = performance.now() - t0;
  for (const [n, la, lo, väntat] of lägen) {
    const r = narmasteVatten(la, lo);
    console.log(`${n.padEnd(30)} ${String(r?.meter ?? '-').padStart(6)} m  ${(r?.namn || '(hav/namnlöst)').padEnd(24)} väntat: ${väntat}`);
  }
  const t1 = performance.now();
  for (let i = 0; i < 1500; i++) narmasteVatten(59.0 + Math.random() * 1.0, 17.5 + Math.random() * 1.4);
  console.log(`\nladdning + index ${tLadd.toFixed(0)} ms, 1500 slumpvisa uppslag ${(performance.now() - t1).toFixed(0)} ms, ${IX.lat.length} punkter`);
}
