// Geodata för stugorna, en gång per hus (alla källor):
//  - Bilrestid från OSRM:s öppna demotjänst (router.project-osrm.org, OpenStreetMap-data). Ett table-anrop per ca 80 hus
//    med de tre utgångspunkterna som sources → vagTimmar {stad: timmar} (× restid.osrmFaktor) + vagKollad.
//    Hittar OSRM ingen väg (ö utan bro, punkten långt från närmaste väg) blir vagTimmar null → bedom: för långt bort.
//  - Avstånd från OpenStreetMap via Overpass (overpass-api.de), en fråga per hus: närmaste vatten (sjö/å/hav inom 300 m)
//    → vattenMeter, närmaste pub/bar/restaurang inom 3 km → barMeter, närmaste annan byggnad inom 300 m → grannarMeter.
//    Bara det som saknas fylls i (källans egna värden går före); fälten som kom från OSM listas i osmFalt.
//    Airbnb slumpar läget några hundra meter, så där sätts osmUngefar (sidan skriver "ca", sjötomt kräver ≤ 100 m).
// Takten styrs av Automation/lib/fetch.mjs + hosts.json (OSRM ≥ 1,5 s mellan anrop, Overpass ≥ 2,5 s).
//
//   node stugor/geo.mjs [--max=150]     fyll i det som saknas och spara data/stugor.json (run.mjs gör samma sak)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATHS, loadAll, writeJson, bedomAlla, today } from './lib.mjs';

const OSRM = 'https://router.project-osrm.org/table/v1/driving/';
const OVERPASS = 'https://overpass-api.de/api/interpreter'; // annan server: geo.overpassUrl i installningar.json
const UA = { 'User-Agent': 'Prisbevakning-stugor/1.0 (privat bevakning, ett anrop i taget)' };
const OSRM_MAX_ANROP = 10, SNAP_MAX = 2000; // punkt > 2 km från närmaste bilväg = ingen väg dit
const EJ_VATTEN = new Set(['pond', 'basin', 'wastewater', 'fountain', 'reflecting_pool', 'fishpond', 'moat', 'lock', 'swimming_pool', 'pool']);
const EJ_GRANNE = new Set(['shed', 'garage', 'garages', 'carport', 'greenhouse', 'roof', 'hut', 'sauna', 'boathouse', 'toilets',
  'bunker', 'ruins', 'container', 'kiosk', 'transformer_tower', 'service', 'outbuilding', 'storage_tank']);

// Lokal plan projektion runt huset (meter) och avstånd punkt–sträcka
const proj = (lat0, lon0) => { const kx = 111320 * Math.cos(lat0 * Math.PI / 180); return (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * 110540]; };
function segDist([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function lineDist(p, pts) { // pts: [[x,y]|null]; sträckor med okänd ände (utanför bbox) hoppas över
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) if (pts[i - 1] && pts[i]) d = Math.min(d, segDist(p, pts[i - 1], pts[i]));
  if (pts.length === 1 && pts[0]) d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
  return d;
}
function inside([x, y], pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const area = pts => Math.abs(pts.reduce((s, [x, y], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return s + x * y2 - x2 * y; }, 0)) / 2;
const centroid = pts => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
const rund = m => m == null ? null : m < 1000 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50;

// ---- OSRM ----
async function osrm(hus, inst, { getJson, log }) {
  const U = Object.entries(inst.utgangspunkter || {}), f = inst.restid?.osrmFaktor ?? 1, per = inst.geo?.osrmPerAnrop || 80;
  let anrop = 0, klara = 0;
  const ingen = [];
  for (let i = 0; i < hus.length && anrop < OSRM_MAX_ANROP; i += per) {
    const del = hus.slice(i, i + per);
    const coords = [...U.map(([, p]) => p), ...del.map(h => [h.lat, h.lon])].map(([la, lo]) => `${(+lo).toFixed(5)},${(+la).toFixed(5)}`).join(';');
    const q = `sources=${U.map((_, k) => k).join(';')}&destinations=${del.map((_, k) => k + U.length).join(';')}&annotations=duration`;
    anrop++;
    const r = await getJson(`${OSRM}${coords}?${q}`, { headers: UA });
    if (r.code !== 'Ok') throw new Error(`OSRM svarade ${r.code}: ${r.message || ''}`);
    del.forEach((h, k) => {
      const snap = r.destinations?.[k]?.distance ?? 0;
      const t = Object.fromEntries(U.map(([stad], s) => {
        const sek = r.durations?.[s]?.[k];
        return [stad, sek == null || snap > SNAP_MAX ? null : Math.round(sek / 3600 * f * 10) / 10];
      }));
      const ok = Object.values(t).some(x => x != null);
      h.vagTimmar = ok ? t : null; h.vagKollad = today();
      if (snap > 300) h.vagSnapMeter = Math.round(snap); else delete h.vagSnapMeter;
      ok ? klara++ : ingen.push(h);
    });
    log?.(`OSRM: ${Math.min(i + per, hus.length)}/${hus.length} hus`);
  }
  return { anrop, klara, ingen, kvar: Math.max(0, hus.length - anrop * per) };
}

// ---- Overpass ----
function fraga(h, inst) {
  const G = inst.geo || {}, rv = G.vattenRadie || 300, rb = G.barRadie || 3000, rg = G.grannRadie || 300;
  const P = `${(+h.lat).toFixed(6)},${(+h.lon).toFixed(6)}`;
  const dLat = 0.01, dLon = 0.01 / Math.cos(h.lat * Math.PI / 180), bb = [h.lat - dLat, h.lon - dLon, h.lat + dLat, h.lon + dLon].map(x => x.toFixed(5)).join(',');
  // (is_in för "punkten ligger i sjön" är tungt för servern; i stället testas slutna vattenytor i tolka())
  return `[out:json][timeout:25];
(nwr(around:${rv},${P})[natural=water];nwr(around:${rv},${P})[waterway=riverbank];way(around:${rv},${P})[natural=coastline];)->.w;
nwr(around:${rb},${P})[amenity~"^(pub|bar|restaurant)$"]->.b;
way(around:${rg},${P})[building]->.g;
.w out tags geom(${bb});
.b out tags center;
.g out tags geom;`;
}

export function tolka(h, els, inst) {
  const G = inst.geo || {}, rg = G.grannRadie || 300;
  const pr = proj(h.lat, h.lon), P = [0, 0];
  const pts = g => (g || []).map(n => n && n.lat != null ? pr(n.lat, n.lon) : null);
  const vattenNamn = t => t.name || (t.natural === 'coastline' ? 'Hav' : (t.water === 'river' || t.waterway === 'riverbank') ? 'Å' : 'Sjö');
  let vatten = null, bar = null;
  const grannar = [];
  for (const e of els) {
    const t = e.tags || {};
    if (e.type === 'area') { // huset (punkten) ligger i vattnet – oftast ett förskjutet läge vid stranden
      if (!EJ_VATTEN.has(t.water)) vatten = { m: 0, namn: vattenNamn(t) };
      continue;
    }
    if (t.building) {
      const p = pts(e.geometry).filter(Boolean);
      if (p.length < 3) continue;
      grannar.push({ p, typ: t.building, yta: area(p), c: centroid(p), d: lineDist(P, pts(e.geometry)), i: inside(P, p) });
      continue;
    }
    if (t.amenity) {
      const c = e.lat != null ? e : e.center;
      if (!c) continue;
      const d = Math.hypot(...pr(c.lat, c.lon));
      if (!bar || d < bar.m) bar = { m: d, namn: t.name || null };
      continue;
    }
    if (t.natural === 'water' || t.waterway === 'riverbank' || t.natural === 'coastline') {
      if (EJ_VATTEN.has(t.water)) continue;
      const linjer = e.type === 'relation' ? (e.members || []).filter(m => m.geometry).map(m => pts(m.geometry)) : [pts(e.geometry)];
      if (e.type === 'way' && t.natural !== 'coastline') { // liten damm (< 3000 m²) räknas inte
        const g = e.geometry || [];
        const p = linjer[0];
        if (g.length > 3 && p.every(Boolean) && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon) {
          if (area(p) < 3000 && !t.name) continue;
          if (inside(P, p)) { vatten = { m: 0, namn: vattenNamn(t) }; continue; }
        }
      }
      const d = Math.min(...linjer.map(l => lineDist(P, l)));
      if (Number.isFinite(d) && (!vatten || d < vatten.m)) vatten = { m: d, namn: vattenNamn(t) };
    }
  }
  // Grannar: huset självt = byggnaden punkten ligger i, annars närmaste (inom 50 m, Airbnb 150 m). Avstånd mäts från
  // husets byggnad; småhus/uthus (< 40 m², förråd, garage …) och byggnader inom 25 m (egna annex) räknas inte.
  const ungefar = h.kalla === 'airbnb';
  grannar.sort((a, b) => a.d - b.d);
  const eget = grannar.find(g => g.i) || (grannar[0] && grannar[0].d <= (ungefar ? 150 : 50) ? grannar[0] : null);
  let granne = null;
  for (const g of grannar) {
    if (g === eget || g.yta < 40 || EJ_GRANNE.has(g.typ)) continue;
    const d = eget ? Math.min(...eget.p.map(q => lineDist(q, [...g.p, g.p[0]])), ...g.p.map(q => lineDist(q, [...eget.p, eget.p[0]]))) : g.d;
    if (eget && d < 25) continue;
    if (!granne || d < granne) granne = d;
  }
  return {
    vatten: vatten && vatten.m <= (G.vattenRadie || 300) + 50 ? { m: rund(vatten.m), namn: vatten.namn } : null,
    bar: bar ? { m: rund(bar.m), namn: bar.namn } : null,
    grannar: rund(granne != null ? Math.min(granne, rg) : rg), // ingen inom radien = minst så långt
  };
}

async function overpass(hus, inst, { getText, log }) {
  let n = 0, vatten = 0, bar = 0, grannar = 0, iRad = 0;
  const fel = [], url = inst.geo?.overpassUrl || OVERPASS;
  for (const h of hus) {
    let j;
    try {
      const txt = await getText(url, { method: 'POST', body: 'data=' + encodeURIComponent(fraga(h, inst)),
        headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } });
      j = JSON.parse(txt);
      if (/error|timed out/i.test(j.remark || '')) throw new Error(j.remark.slice(0, 120));
    } catch (e) {
      fel.push(`${h.id}: ${e.message}`);
      if (e.constructor?.name === 'Blocked' || ++iRad >= 3) break; // spärr eller fullt hos tjänsten: fortsätt nästa körning
      continue;
    }
    n++; iRad = 0;
    const r = tolka(h, j.elements || [], inst), osm = new Set(h.osmFalt || []);
    if (h.vattenMeter == null && r.vatten) { h.vattenMeter = r.vatten.m; h.vattenNamn = r.vatten.namn; osm.add('vattenMeter'); vatten++; }
    if (r.bar) { h.barMeter = r.bar.m; h.barNamn = r.bar.namn; osm.add('barMeter'); bar++; }
    if (h.grannarMeter == null && r.grannar != null) { h.grannarMeter = r.grannar; osm.add('grannarMeter'); grannar++; }
    h.osmFalt = [...osm];
    if (h.kalla === 'airbnb') h.osmUngefar = true;
    h.osmKollad = today();
    if (n % 25 === 0) log?.(`Overpass: ${n}/${hus.length} hus`);
  }
  return { n, vatten, bar, grannar, fel };
}

// Fyller i bilväg och OSM-avstånd för alla hus som saknar dem. Hus som klarar kraven först.
export async function geoAlla(db, inst, { getText, getJson, log, maxOverpass = inst.geo?.overpassPerKorning ?? 150 } = {}) {
  const alla = Object.values(db.hus).filter(h => h.lat != null && h.lon != null && Number.isFinite(+h.lat) && Number.isFinite(+h.lon));
  const prio = (a, b) => (b.kravOk ? 1 : 0) - (a.kravOk ? 1 : 0);
  const res = { osrm: null, overpass: null, fel: [] };
  const utanVag = alla.filter(h => !h.vagKollad);
  if (utanVag.length) {
    try { res.osrm = await osrm(utanVag, inst, { getJson, log }); }
    catch (e) { res.fel.push(`OSRM: ${e.message}`); }
  }
  bedomAlla(db, inst); // restider från bilvägen innan vi väljer vilka hus som är värda en Overpass-fråga
  const utanOsm = alla.filter(h => !h.osmKollad && (h.vattenMeter == null || h.grannarMeter == null || (h.restaurangMeter == null && h.barMeter == null)))
    .sort(prio);
  if (utanOsm.length) {
    res.overpass = await overpass(utanOsm.slice(0, maxOverpass), inst, { getText, log });
    res.overpass.kvar = utanOsm.length - res.overpass.n;
    if (res.overpass.fel.length) res.fel.push(`Overpass: ${res.overpass.fel.length} fel, t.ex. ${res.overpass.fel[0]}`);
  }
  bedomAlla(db, inst);
  return res;
}

export function geoInfo(r) {
  const o = r.osrm, p = r.overpass, out = [];
  if (o) out.push(`bilväg för ${o.klara} hus (${o.anrop} OSRM-anrop)${o.ingen.length ? `, ingen bilväg: ${o.ingen.map(h => h.namn || h.id).join(', ')}` : ''}${o.kvar ? `, ${o.kvar} kvar` : ''}`);
  if (p) out.push(`OSM för ${p.n} hus: vatten ${p.vatten}, bar ${p.bar}, grannar ${p.grannar}${p.kvar ? `, ${p.kvar} kvar` : ''}`);
  return out.join('; ') || 'inget att hämta';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const HOME = (process.env.AUTOMATION_HOME || 'C:/Users/TimLi/Dev/Automation').replace(/\\/g, '/');
  const { getText, getJson } = await import('file:///' + HOME + '/lib/fetch.mjs');
  const max = +(process.argv.find(a => a.startsWith('--max=')) || '').slice(6) || undefined;
  const log = (...a) => console.log(new Date().toLocaleTimeString('sv-SE'), ...a);
  const { db, inst } = await loadAll();
  const r = await geoAlla(db, inst, { getText, getJson, log, ...(max ? { maxOverpass: max } : {}) });
  db.installningar = inst;
  await writeJson(PATHS.data, db);
  log('Geo: ' + geoInfo(r));
  r.fel.forEach(f => log('PROBLEM', f));
}
