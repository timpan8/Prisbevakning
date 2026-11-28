// Fastighetsbyrån: listan "På gång" (kommande lägenheter i Stockholms län) läses av AI-rutinen i Chrome genom att titta
// på sidan och spara korten som syns (RUTIN.md 5d) – ingen genomsökning av sajten och inga annonssidor, eftersom
// Fastighetsbyrån inte vill ha automatisk hämtning. Det här skriptet gör om den sparade filen till inkorgsformat och
// slår upp koordinater för adresserna med OpenStreetMaps Nominatim (1 anrop per sekund, cache i Automation/state).
//
//   node boende/fastighetsbyran.mjs fb-pagang.json > inbox/boende-fastighetsbyran-ÅÅÅÅMMDD-HHMM.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const HOME = (process.env.AUTOMATION_HOME || 'C:/Users/TimLi/Dev/Automation').replace(/\\/g, '/');
const CACHE = path.join(HOME, 'state', 'geokod-cache.json');
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const sov = ms => new Promise(r => setTimeout(r, ms));
const DAG = /^(MÅN|TIS|ONS|TORS?|FRE|LÖR|SÖN) \d+\/\d+ /;

// "PÅ GÅNG SE FLER SÖN 29/11 RITORP Nydalavägen 38 2 695 000 kr 5 rum 116.5 kvm" -> delar
export function tolka(r) {
  let t = r.t.replace(/PÅ GÅNG|SE FLER|BUDGIVNING PÅGÅR|\bAI\b/g, ' ').replace(/\s+/g, ' ').trim();
  const visning = DAG.test(t); t = t.replace(DAG, '');
  const rum = +((t.match(/([\d.]+) rum/) || [])[1]) || null, kvm = +((t.match(/([\d.]+) kvm/) || [])[1]) || null;
  const pris = +(((t.match(/(\d{1,2}(?: \d{3}){2}) kr/) || [])[1] || '').replace(/\s/g, '')) || null;
  const fore = t.split(/ \d{1,2}(?: \d{3}){2} kr| [\d.]+ rum/)[0];
  // Området skrivs med versaler först, sedan adressen
  const ord = fore.split(' '); let i = 0;
  while (i < ord.length && ord[i] === ord[i].toUpperCase() && /[A-ZÅÄÖÉ/-]/.test(ord[i])) i++;
  const omrade = ord.slice(0, i).join(' ').toLowerCase().replace(/(^|[\s/-])\p{L}/gu, s => s.toUpperCase()) || null;
  const adress = ord.slice(i).join(' ') || null;
  return { rum, kvm, pris, omrade, adress, visning };
}

async function geokod(adress, omrade) {
  const gata = adress.replace(/,.*$/, '').trim(), nyckel = `${gata}|${omrade || ''}`;
  if (nyckel in cache) return cache[nyckel];
  const u = new URL('https://nominatim.openstreetmap.org/search');
  for (const [k, v] of Object.entries({ q: gata, format: 'jsonv2', countrycodes: 'se', viewbox: '17.3,60.05,19.1,58.95', bounded: '1', limit: '5' })) u.searchParams.set(k, v);
  await sov(1100);
  const r = await fetch(u, { headers: { 'User-Agent': 'prisbevakning-boende/1.0 (personligt bruk)', 'Accept-Language': 'sv' } });
  const j = r.ok ? await r.json() : [];
  const delar = (omrade || '').toLowerCase().split(/[\s/-]+/).filter(x => x.length > 3);
  const best = j.find(x => delar.some(d => x.display_name.toLowerCase().includes(d))) || j[0];
  const res = best ? { lat: +(+best.lat).toFixed(5), lon: +(+best.lon).toFixed(5) } : null;
  cache[nyckel] = res;
  return res;
}

if (process.argv[2]) {
  const inp = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const annonser = [];
  for (const r of inp.rows || []) {
    const d = tolka(r);
    if (!d.adress || (d.rum != null && d.rum < 2) || (d.pris && d.pris > 4e6)) continue;
    const pos = await geokod(d.adress, d.omrade).catch(() => null);
    if (!pos) { console.error('hittar inte', d.adress, d.omrade); continue; }
    annonser.push({ kalla: 'fastighetsbyran', kod: r.id, url: r.url, adress: d.adress, omrade: d.omrade, rum: d.rum, kvm: d.kvm, utrop: d.pris,
      bilder: r.img ? [r.img] : [], lat: pos.lat, lon: pos.lon, kommande: true, maklare: 'Fastighetsbyrån' });
  }
  mkdirSync(path.dirname(CACHE), { recursive: true }); writeFileSync(CACHE, JSON.stringify(cache));
  console.error(`${annonser.length} av ${(inp.rows || []).length} med läge`);
  console.log(JSON.stringify({ annonser, borta: [], kallorLasta: [], klar: new Date().toISOString() }, null, 1));
}
