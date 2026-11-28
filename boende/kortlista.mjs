// Kommande bostäder hos mäklare som inte vill ha automatisk hämtning (Fastighetsbyrån) eller vars sökning bara går att
// bläddra i webbläsaren (Mäklarhuset). AI-rutinen tittar på listan i Chrome som en besökare och sparar korten som syns
// (RUTIN.md 5d) som { kalla, rows: [{ id, url, t (korttext), img }] }. Det här skriptet gör om filen till inkorgsformat
// och slår upp koordinater för adresserna med OpenStreetMaps Nominatim (1 anrop per sekund, cache i Automation/state).
//
//   node boende/kortlista.mjs fb-pagang.json > inbox/boende-fastighetsbyran-ÅÅÅÅMMDD-HHMM.json
//   node boende/kortlista.mjs mh-kommande.json > inbox/boende-maklarhuset-ÅÅÅÅMMDD-HHMM.json
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const HOME = (process.env.AUTOMATION_HOME || 'C:/Users/TimLi/Dev/Automation').replace(/\\/g, '/');
const CACHE = path.join(HOME, 'state', 'geokod-cache.json');
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const sov = ms => new Promise(r => setTimeout(r, ms));
const NAMN = { fastighetsbyran: 'Fastighetsbyrån', maklarhuset: 'Mäklarhuset' };
const DAG = /^(MÅN|TIS|ONS|TORS?|FRE|LÖR|SÖN) \d+\/\d+ /;
const tal = s => s == null ? null : +String(s).replace(',', '.');
const versal = w => w === w.toUpperCase() && /[A-ZÅÄÖÉ]/.test(w) || /^[—/-]$/.test(w);
const fin = s => s.toLowerCase().replace(/(^|[\s/-])\p{L}/gu, x => x.toUpperCase());

// Korttext -> delar. Fastighetsbyrån: "PÅ GÅNG SE FLER SÖN 29/11 RITORP Nydalavägen 38 2 695 000 kr 5 rum 116.5 kvm"
// Mäklarhuset: "NACKA — SALTSJÖ-BOO — BJÖRKNÄS/ÄNGSBACKEN Ängsbacken 19 2 495 000 kr 2 Rum 54,7 kvm Lägenhet"
export function tolka(r) {
  let t = r.t.replace(/PÅ GÅNG|SE FLER|BUDGIVNING PÅGÅR|\bAI\b/g, ' ').replace(/\s+/g, ' ').trim();
  const visning = DAG.test(t); t = t.replace(DAG, '');
  const rum = tal((t.match(/([\d.,]+) rum/i) || [])[1]), kvm = tal((t.match(/([\d.,]+)(?:\s*\+\s*[\d.,]+)?\s*kvm/i) || [])[1]);
  const pris = +(((t.match(/(\d{1,2}(?: \d{3}){2}) kr/) || [])[1] || '').replace(/\s/g, '')) || null;
  const fore = t.split(/ \d{1,2}(?: \d{3}){2} kr| [\d.,]+ rum/i)[0];
  // Området skrivs med versaler först (Mäklarhuset: kommun — område — delområde), sedan adressen
  const ord = fore.split(' '); let i = 0;
  while (i < ord.length && versal(ord[i])) i++;
  const delar = ord.slice(0, i).join(' ').split(/\s+—\s+/).map(fin).filter(Boolean);
  return { rum, kvm, pris, omrade: delar[delar.length - 1] || null, kommun: delar.length > 1 ? delar[0] : null, adress: ord.slice(i).join(' ') || null, visning };
}

async function geokod(adress, omrade, kommun) {
  const gata = adress.replace(/,.*$/, '').replace(/\s+(lgh|vån|BV)\b.*$/i, '').trim(), nyckel = `${gata}|${kommun || omrade || ''}`;
  if (nyckel in cache) return cache[nyckel];
  const u = new URL('https://nominatim.openstreetmap.org/search');
  for (const [k, v] of Object.entries({ q: kommun ? `${gata}, ${kommun}` : gata, format: 'jsonv2', countrycodes: 'se', viewbox: '17.3,60.05,19.1,58.95', bounded: '1', limit: '5' })) u.searchParams.set(k, v);
  await sov(1100);
  const r = await fetch(u, { headers: { 'User-Agent': 'prisbevakning-boende/1.0 (personligt bruk)', 'Accept-Language': 'sv' } });
  const j = r.ok ? await r.json() : [];
  const ord = `${omrade || ''} ${kommun || ''}`.toLowerCase().split(/[\s/-]+/).filter(x => x.length > 3);
  const best = j.find(x => ord.some(d => x.display_name.toLowerCase().includes(d))) || j[0];
  const res = best ? { lat: +(+best.lat).toFixed(5), lon: +(+best.lon).toFixed(5) } : null;
  cache[nyckel] = res;
  return res;
}

if (process.argv[2]) {
  const inp = JSON.parse(readFileSync(process.argv[2], 'utf8')), kalla = inp.kalla || 'fastighetsbyran';
  const annonser = [];
  for (const r of inp.rows || []) {
    const d = tolka(r);
    if (!d.adress || (d.rum != null && d.rum < 2) || (d.pris && d.pris > 4e6)) continue;
    const pos = await geokod(d.adress, d.omrade, d.kommun).catch(() => null);
    if (!pos) { console.error('hittar inte', d.adress, d.omrade); continue; }
    annonser.push({ kalla, kod: String(r.id), url: r.url, adress: d.adress, omrade: d.omrade, kommun: d.kommun, rum: d.rum, kvm: d.kvm, utrop: d.pris,
      bilder: r.img ? [r.img] : [], lat: pos.lat, lon: pos.lon, kommande: true, maklare: NAMN[kalla] || kalla });
  }
  mkdirSync(path.dirname(CACHE), { recursive: true }); writeFileSync(CACHE, JSON.stringify(cache));
  console.error(`${kalla}: ${annonser.length} av ${(inp.rows || []).length} med läge`);
  console.log(JSON.stringify({ annonser, borta: [], kallorLasta: [], klar: new Date().toISOString() }, null, 1));
}
