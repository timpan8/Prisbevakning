// Bygger boende/vatten.json: strandpunkter för Stockholms län ur OpenStreetMap (Overpass).
// Hämtar sjöar, vikar, större vattendrag (natural=water, waterway=riverbank) och havets strandlinje
// (natural=coastline) i rutor med geometrin klippt till rutan, slänger småvatten och små öar,
// och lägger punkter längs stränderna var ~STEG m. Rådata cachas per ruta, så en omkörning hämtar bara det som saknas.
//
//   node boende/vatten-bygg.mjs [cachekatalog]     hämtar (eller läser cachad rådata) och skriver boende/vatten.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE = process.argv[2] || path.join(os.tmpdir(), 'vatten-osm');
const SERVRAR = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const BBOX = [58.95, 17.3, 60.05, 19.1];
const RUTOR = [2, 2];                     // lat × lon (~60 × 50 km per ruta)
const STEG = 35;                          // meter mellan strandpunkter
const MIN_VATTEN = 5000;                  // m² (0,5 ha)
const MIN_O = 20000;                      // m²: öar (sluten coastline/inre ring) under 2 ha hoppas över
const SMÅ = new Set(['pool', 'fountain', 'basin', 'wastewater', 'reflecting_pool', 'swimming_pool', 'ditch', 'drain', 'moat']);
const RAD = Math.PI / 180;
const vänta = ms => new Promise(r => setTimeout(r, ms));

function fråga([s, w, n, e]) {
  const b = `${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)}`;
  return `[out:json][timeout:300];
(
  way["natural"="water"](${b});
  way["waterway"="riverbank"](${b});
  way["natural"="coastline"](${b});
  rel["natural"="water"](${b});
  rel["waterway"="riverbank"](${b});
);
out geom(${b});`;
}

async function hämta(ruta, i) {
  const fil = path.join(CACHE, `ruta-${i}.json`);
  if (existsSync(fil)) return { j: JSON.parse(readFileSync(fil, 'utf8')), cachad: true };
  for (let försök = 0; försök < 12; försök++) {
    const url = SERVRAR[försök % SERVRAR.length];
    try {
      const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(330000), headers: { 'User-Agent': 'vattenavstand-script/1.0', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(fråga(ruta)) });
      if (!r.ok) throw new Error(`${r.status}`);
      const txt = await r.text();
      const j = JSON.parse(txt);
      if (j.remark && /error|timed out|runtime/i.test(j.remark)) throw new Error(j.remark);
      writeFileSync(fil, txt);
      console.log(`ruta ${i}: ${j.elements.length} element, ${(txt.length / 1e6).toFixed(1)} MB (${url})`);
      return { j, cachad: false };
    } catch (e) {
      console.log(`ruta ${i} försök ${försök + 1} mot ${url}: ${String(e.message).slice(0, 80)}`);
      await vänta(Math.min(30000 * (försök + 1), 180000));
    }
  }
  throw new Error(`ruta ${i} gick inte att hämta`);
}

// Area (m²) för en sluten ring av {lat, lon}
function area(g) {
  if (g.length < 4) return 0;
  const k = Math.cos(g[0].lat * RAD) * 111320, l = 110540;
  let s = 0;
  for (let i = 0, j = g.length - 1; i < g.length; j = i++) s += (g[j].lon * k) * (g[i].lat * l) - (g[i].lon * k) * (g[j].lat * l);
  return Math.abs(s / 2);
}
const lika = (a, b) => a.lat === b.lat && a.lon === b.lon;
const sluten = g => g.length > 3 && lika(g[0], g[g.length - 1]);
const klippt = g => !g || !g.length || g.some(p => !p);   // geometrin är avskuren vid rutkanten

// Sätter ihop hela (oklippta) medlemsvägar till ringar
function ringar(vägar) {
  const öppna = vägar.map(v => v.slice()), klara = [];
  while (öppna.length) {
    let r = öppna.pop(), ändrad = true;
    while (!sluten(r) && ändrad) {
      ändrad = false;
      const sist = r[r.length - 1];
      for (let i = 0; i < öppna.length; i++) {
        const v = öppna[i];
        if (lika(v[0], sist)) r = r.concat(v.slice(1));
        else if (lika(v[v.length - 1], sist)) r = r.concat(v.slice(0, -1).reverse());
        else continue;
        öppna.splice(i, 1); ändrad = true; break;
      }
    }
    klara.push(r);
  }
  return klara;
}

// Delar en (ev. klippt) geometri i sammanhängande bitar utan null
function bitar(g) {
  const ut = []; let cur = [];
  for (const p of g || []) { if (p) cur.push(p); else { if (cur.length > 1) ut.push(cur); cur = []; } }
  if (cur.length > 1) ut.push(cur);
  return ut;
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const [s, w, n, e] = BBOX, dLa = (n - s) / RUTOR[0], dLo = (e - w) / RUTOR[1];
  const linjer = [];   // [geometri, namn]
  const stats = { sjöar: 0, kust: 0, relationer: 0, småvatten: 0, småöar: 0 };
  let i = 0;
  for (let a = 0; a < RUTOR[0]; a++) for (let b = 0; b < RUTOR[1]; b++) {
    const { j, cachad } = await hämta([s + a * dLa, w + b * dLo, s + (a + 1) * dLa, w + (b + 1) * dLo], i++);
    if (!cachad) await vänta(10000);
    const iRel = new Set();
    for (const el of j.elements) if (el.type === 'relation') for (const m of el.members || []) if (m.type === 'way') iRel.add(m.ref);
    for (const el of j.elements) {
      const t = el.tags || {};
      if (SMÅ.has(t.water)) { stats.småvatten++; continue; }
      if (el.type === 'relation') {
        const ms = (el.members || []).filter(m => m.type === 'way');
        const yttre = ms.filter(m => m.role !== 'inner'), inre = ms.filter(m => m.role === 'inner');
        const hela = ms.every(m => !klippt(m.geometry));
        if (hela) {
          const ry = ringar(yttre.map(m => m.geometry));
          if (ry.every(sluten) && ry.reduce((x, g) => x + area(g), 0) < MIN_VATTEN) { stats.småvatten++; continue; }
        }
        for (const m of yttre) for (const g of bitar(m.geometry)) linjer.push([g, t.name]);
        const ri = ringar(inre.filter(m => !klippt(m.geometry)).map(m => m.geometry));
        for (const g of ri) { if (sluten(g) && area(g) < MIN_O) { stats.småöar++; continue; } linjer.push([g, t.name]); }
        for (const m of inre) if (klippt(m.geometry)) for (const g of bitar(m.geometry)) linjer.push([g, t.name]);
        stats.relationer++;
      } else if (el.type === 'way') {
        const g = el.geometry;
        if (t.natural === 'coastline') {
          if (!klippt(g) && sluten(g) && area(g) < MIN_O) { stats.småöar++; continue; }
          for (const x of bitar(g)) linjer.push([x, null]);
          stats.kust++;
        } else {
          if (iRel.has(el.id) && !t.name) continue; // ritas redan via relationen
          if (!klippt(g) && sluten(g) && area(g) < MIN_VATTEN) { stats.småvatten++; continue; }
          for (const x of bitar(g)) linjer.push([x, t.name]);
          stats.sjöar++;
        }
      }
    }
  }
  console.log(stats);

  // Punkter längs linjerna var STEG m i heltal (1e-4 grader, ~10 m) räknat från BAS. Högst en punkt per ~20 × 20 m-ruta,
  // så att överlappande linjer (t.ex. en namngiven vik inuti Mälaren-relationen) inte ger dubbletter. Namngivna linjer först,
  // så att namnet följer med. Varje linje lagras deltakodad: [namnindex|-1, lat0, lon0, dlat1, dlon1, dlat2, dlon2, ...].
  const BAS = [58.9, 17.2];
  linjer.sort((x, y) => (y[1] ? 1 : 0) - (x[1] ? 1 : 0));
  const namn = [], namnIdx = new Map(), ut_linjer = [], sett = new Set();
  let antal = 0;
  for (const [g, nm] of linjer) {
    let ni = -1;
    if (nm) { if (!namnIdx.has(nm)) { namnIdx.set(nm, namn.length); namn.push(nm); } ni = namnIdx.get(nm); }
    let rad = null, pLa = 0, pLo = 0;
    const lägg = (la, lo) => {
      if (la < s - 0.05 || la > n + 0.05 || lo < w - 0.1 || lo > e + 0.1) return;
      const k = Math.floor(la / 0.00018) * 1e5 + Math.floor(lo / 0.00036);
      if (sett.has(k)) return; sett.add(k);
      const qa = Math.round((la - BAS[0]) * 1e4), qo = Math.round((lo - BAS[1]) * 1e4);
      if (!rad) { rad = [ni, qa, qo]; ut_linjer.push(rad); } else rad.push(qa - pLa, qo - pLo);
      pLa = qa; pLo = qo; antal++;
    };
    let kvar = 0;
    lägg(g[0].lat, g[0].lon);
    for (let k = 1; k < g.length; k++) {
      const a = g[k - 1], b = g[k];
      const dx = (b.lon - a.lon) * Math.cos(a.lat * RAD) * 111320, dy = (b.lat - a.lat) * 110540, d = Math.hypot(dx, dy);
      let t = STEG - kvar;
      while (t <= d) { const f = t / d; lägg(a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f); t += STEG; }
      kvar = d - (t - STEG);
    }
    lägg(g[g.length - 1].lat, g[g.length - 1].lon);
  }
  const ut = {
    om: `Strandpunkter för Stockholms län (bbox ${BBOX.join(',')}) ur OpenStreetMap (© OpenStreetMap-bidragsgivare, ODbL), hämtat via Overpass ${new Date().toISOString().slice(0, 10)}. ` +
      `Med: natural=water och waterway=riverbank med area ≥ 0,5 ha (utom water=pool/fountain/basin/wastewater m.fl.), samt havets strandlinje natural=coastline; öar under 2 ha utelämnade. ` +
      `Punkter var ~${STEG} m längs stranden, högst en per ~20 × 20 m. Format: linjer = [[namnindex (-1 = namnlöst/hav), lat0, lon0, dlat, dlon, dlat, dlon, ...]], ` +
      `heltal i 1e-4 grader (~10 m) från "bas" [lat, lon]; varje punkt = föregående + delta. Byggt med boende/vatten-bygg.mjs.`,
    bas: BAS,
    antal,
    namn,
    linjer: ut_linjer,
  };
  const fil = path.join(DIR, 'vatten.json');
  const txt = JSON.stringify(ut);
  writeFileSync(fil, txt);
  console.log(`${linjer.length} linjer, ${antal} punkter, ${namn.length} namn, ${(txt.length / 1e6).toFixed(2)} MB -> ${fil}`);
}
main().catch(e => { console.error(e); process.exit(1); });
