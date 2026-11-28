// Mäklarnas egna sajter för fliken Boende: (A) annonstext från en mäklarsida och (B) bostäder som bara finns hos mäklaren än
// (kommande / snart till salu / underhand / på förhand) plus mäklarens vanliga till salu-lista. Körs från node utan Chrome,
// med den gemensamma snälla hämtningen (C:/Users/TimLi/Dev/Automation/lib/fetch.mjs: takt per sajt enligt hosts.json, paus vid
// spärr). robots.txt läses och följs för varje sajt innan något hämtas. Ingen inloggning, inga formulär, inga intresseanmälningar,
// ingen kontakt med mäklare. Vilka mäklare och hur: boende/maklare.json.
//
//   node boende/maklare.mjs --sok > inbox/boende-maklare-ÅÅÅÅMMDD-HHMM.json   alla aktiva mäklare (inkorgsformat)
//   node boende/maklare.mjs --sok --bara erikolsson,skandia [--plan plan.json] [--max-detaljer 20] [--sidor 2]
//   node boende/maklare.mjs --text <mäklar-URL>                                annonstext + balkong/hiss/våning m.m. (JSON)
//
//   import { lasText, tolkaText, sokMaklare, sokAlla } from './maklare.mjs'
//   await lasText('https://www.husmanhagberg.se/objekt/annons/OBJ...')   -> { url, beskrivning, balkong, hiss, vaning, avgift, ... }
//   await sokAlla({ bara: ['svenskfast'], kanda: new Set(['svenskfast-475815']) })  -> { annonser, borta, kallorLasta, logg }
//
// --plan: JSON med { kanda: ["svenskfast-475815" | "475815", ...], filter: {...} } (samma form som merge.mjs --plan). Kända annonser
// får ingen ny detaljhämtning (men listdatan skickas ändå, så pris och status uppdateras).
// Detaljer (koordinater, avgift, text) sparas i en cache (maklare.json: "cache") så att varje bostadssida hämtas en gång per 30 dagar.
import { getText, Gone, Blocked, ldObjects } from 'file:///C:/Users/TimLi/Dev/Automation/lib/fetch.mjs';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONF = JSON.parse(readFileSync(path.join(HERE, 'maklare.json'), 'utf8'));
const MAL = CONF.filter.mal;

// ---------- småhjälp ----------
const RAD = Math.PI / 180;
export const km = (a, b) => { const dLat = (b[0] - a[0]) * RAD, dLon = (b[1] - a[1]) * RAD; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2; return 6371 * 2 * Math.asin(Math.sqrt(h)); };
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', ndash: '–', mdash: '—', aring: 'å', auml: 'ä', ouml: 'ö', Aring: 'Å', Auml: 'Ä', Ouml: 'Ö', eacute: 'é', sup2: '²', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·' };
export const decode = s => String(s ?? '').replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&([a-z]+\d?);/gi, (m, n) => ENT[n] ?? m);
const strip = s => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
// Heltal ur "3 295 000 kr", "3,295,000 kr", "4 138 kr/mån"
const heltal = s => { if (s == null) return null; if (typeof s === 'number') return s; const d = String(s).replace(/[^\d]/g, ''); return d ? +d : null; };
// Decimaltal ur "79,5 kvm", "2 rum", "1.5"
const tal = s => { if (s == null) return null; if (typeof s === 'number') return s; const m = String(s).replace(/\s| /g, '').match(/\d+(?:[.,]\d+)?/); return m ? +m[0].replace(',', '.') : null; };
const rensa = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length) && !Number.isNaN(v)));
const titel = s => s && s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, c => c.toUpperCase()) : s;
const dag = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });

// ---------- robots.txt ----------
const robots = new Map();
function tolkaRobots(txt) {
  // Grupper: rader User-agent följda av regler. Vi följer gruppen för "Claude-User" om den finns, annars "*".
  const grupper = []; let g = null, iRegler = false;
  for (let rad of String(txt).split(/\r?\n/)) {
    rad = rad.replace(/#.*/, '').trim(); if (!rad) continue;
    const m = rad.match(/^([A-Za-z-]+)\s*:\s*(.*)$/); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!g || iRegler) { g = { ua: [], regler: [] }; grupper.push(g); iRegler = false; } g.ua.push(v.toLowerCase()); }
    else if ((k === 'allow' || k === 'disallow') && g) { iRegler = true; if (v || k === 'allow') g.regler.push({ allow: k === 'allow', v }); }
  }
  const val = grupper.filter(x => x.ua.includes('claude-user'));
  return (val.length ? val : grupper.filter(x => x.ua.includes('*'))).flatMap(x => x.regler).filter(r => r.v);
}
const regelRe = v => new RegExp('^' + v.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
export async function robotsTillater(url) {
  const u = new URL(url);
  if ((CONF.forbjudna || []).some(d => u.hostname === d || u.hostname.endsWith('.' + d))) return false;
  if (!robots.has(u.origin)) robots.set(u.origin, getText(u.origin + '/robots.txt').then(tolkaRobots).catch(e => e instanceof Gone || /svarade 4\d\d/.test(e.message) ? [] : null));
  const regler = await robots.get(u.origin);
  if (regler === null) return false; // robots.txt gick inte att läsa (5xx/spärr): rör inte sajten
  const p = decodeURI(u.pathname) + u.search;
  let bast = null;
  for (const r of regler) { let v = r.v; try { v = decodeURI(v); } catch {} if (regelRe(v).test(p) && (!bast || v.length > bast.v.length || (v.length === bast.v.length && r.allow))) bast = { ...r, v }; }
  return !bast || bast.allow;
}
async function hamta(url) {
  if (!(await robotsTillater(url))) throw new Error(`robots.txt (eller villkoren) förbjuder ${url}`);
  return getText(url);
}

// ---------- cache för detaljer ----------
let cache = null;
const CACHE_DAGAR = 30;
function cacheLas() { if (!cache) { try { cache = existsSync(CONF.cache) ? JSON.parse(readFileSync(CONF.cache, 'utf8')) : {}; } catch { cache = {}; } } return cache; }
function cacheGet(id) { const c = cacheLas()[id]; return c && Date.now() - Date.parse(c.hamtad) < CACHE_DAGAR * 864e5 ? c.d : null; }
function cacheSet(id, d) { cacheLas()[id] = { hamtad: new Date().toISOString(), d }; }
function cacheSpara() { if (!cache) return; const gr = Date.now() - 90 * 864e5; for (const [k, v] of Object.entries(cache)) if (Date.parse(v.hamtad) < gr) delete cache[k]; try { writeFileSync(CONF.cache, JSON.stringify(cache)); } catch (e) { console.error('kunde inte spara cachen: ' + e.message); } }

// ---------- inbäddad data ----------
// self.__next_f.push([1,"..."]) – Next.js app-routerns RSC-data
export function nextF(html) {
  const out = [], re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g; let m;
  while ((m = re.exec(html))) { try { out.push(JSON.parse(m[1])); } catch {} }
  return out.join('');
}
export function nextData(html) { const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } }
// JSON-värdet ([..] eller {..}) som börjar på position s
function balanserad(t, s) {
  const open = t[s], close = open === '[' ? ']' : '}'; let d = 0, inS = false, esc = false;
  for (let k = s; k < t.length; k++) {
    const c = t[k];
    if (inS) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inS = false; continue; }
    if (c === '"') inS = true; else if (c === open) d++; else if (c === close && !--d) { try { return JSON.parse(t.slice(s, k + 1)); } catch { return null; } }
  }
  return null;
}
const meta = (html, namn) => { const m = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${namn}["'][^>]*content=["']([^"']*)["']`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${namn}["']`, 'i')); return m ? decode(m[1]).trim() : null; };

// Sidans text som rader (block-element blir radbrytningar). utanBrus: utan header/nav/footer/formulär.
function rader(html, utanBrus = true) {
  let h = html.replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  if (utanBrus) h = h.replace(/<(header|nav|footer|form|aside|dialog)\b[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<(br|\/p|\/div|\/li|\/h\d|\/dt|\/dd|\/tr|\/td|\/th|\/section|\/article|\/ul|\/ol|p|div|li|h\d|dt|dd|tr|td|th|section|article)\b[^>]*>/gi, '\n');
  return decode(h.replace(/<[^>]+>/g, ' ')).split('\n').map(s => s.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean);
}

// ---------- (A) annonstext ----------
const LISTTYP = /RealEstateListing|Product|Apartment|Residence|House|SingleFamilyResidence|Accommodation|Offer|Place|Article/;
const BRUS = /cookie|personuppgift|integritetspolicy|samtycke|gdpr|javascript|webbläsare|nyhetsbrev|prenumerera|värdering av din bostad|boka (en )?värdering|kontakta (mig|oss|mäklaren)/i;
// Text som ser ut som löptext (meningar), inte menyer
const lopt = s => s.length >= 120 && /[a-zåäö]{3,}[.!,]\s/.test(s) && !BRUS.test(s);

// Fakta ur "Etikett: värde"-rader (eller etikett på en rad och värde på nästa)
const ETIKETT = [
  ['vaning', /^(våning|våningsplan|plan)$/i], ['hiss', /^hiss$/i], ['balkong', /^(balkong|balkong\/uteplats|balkong\/terrass)$/i],
  ['uteplats', /^(uteplats|terrass)$/i], ['takterrass', /^takterrass$/i], ['avgift', /^(månadsavgift|avgift|avgift\/mån|avgift per månad)$/i],
  ['byggar', /^(byggnadsår|byggår|byggt)$/i], ['drift', /^(driftkostnad|drift)$/i], ['brf', /^(förening|bostadsrättsförening|brf)$/i],
  ['kvm', /^(boarea|boyta|bostadsyta)$/i], ['rum', /^(rum|antal rum)$/i], ['energiklass', /^energiklass$/i],
];
function faktaUrRader(L) {
  const f = {};
  for (let i = 0; i < L.length; i++) {
    const m = L[i].match(/^([A-Za-zÅÄÖåäö/ ]{2,30}?)\s*:\s*(.*)$/) || [null, L[i], ''];
    const et = m[1].trim(); let v = (m[2] || '').replace(/^:\s*/, '').trim();
    const hit = ETIKETT.find(([, re]) => re.test(et)); if (!hit) continue;
    if (!v && L[i + 1] && L[i + 1].length < 60) v = L[i + 1].replace(/^:\s*/, '').trim();
    if (!v || v.length > 80) continue;
    const k = hit[0]; if (f[k] !== undefined) continue;
    if (k === 'hiss' || k === 'balkong' || k === 'uteplats' || k === 'takterrass') f[k] = !/^(nej|no|saknas|ingen|finns ej|-)/i.test(v);
    else if (k === 'avgift' || k === 'drift') { const n = heltal(v.split(/kr/i)[0]); if (n && n < 100000) f[k] = n; }
    else if (k === 'byggar') { const y = v.match(/\b(1[6-9]\d\d|20\d\d)\b/); if (y) f[k] = +y[1]; }
    else if (k === 'kvm' || k === 'rum') { const n = tal(v); if (n) f[k] = n; }
    else if (k === 'vaning') { const n = v.match(/(-?\d+(?:[.,]5)?)(?:\s*(?:av|\/)\s*(\d+))?/); if (n) f.vaning = n[2] ? `${n[1]} av ${n[2]}` : n[1]; if (/hiss/i.test(v) && f.hiss === undefined) f.hiss = !/ej hiss|ingen hiss|utan hiss|hiss saknas/i.test(v); }
    else if (k === 'energiklass') { const e = v.match(/^[A-G]\b/); if (e) f[k] = e[0]; }
    else if (k === 'brf') { if (/brf|förening|bostadsrätts/i.test(v)) f[k] = v; }
    else f[k] = v;
  }
  return f;
}
// Fakta ur beskrivningen (bara det som etiketterna inte gav)
export function faktaUrText(t, f = {}) {
  const s = ' ' + String(t || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  const out = {};
  if (f.balkong === undefined) {
    const b = s.replace(/fransk(a)? balkong(er)?/g, ' ');
    if (/(ingen|saknar|utan) balkong|balkong saknas/.test(b)) out.balkong = false;
    else if (/balkong/.test(b) && !/möjlighet (till|att bygga) balkong|balkong(er)? planeras|balkongprojekt|balkongbygge/.test(b)) out.balkong = true;
  }
  if (f.takterrass === undefined && /takterrass/.test(s)) out.takterrass = true;
  if (f.uteplats === undefined && /uteplats|egen terrass|stor terrass|privat terrass|\bterrass\b/.test(s.replace(/takterrass/g, ''))) out.uteplats = true;
  if (f.hiss === undefined) { if (/(ingen|saknar|utan) hiss|hiss saknas|hiss finns ej/.test(s)) out.hiss = false; else if (/\bhiss(en)?\b/.test(s)) out.hiss = true; }
  if (f.vaning === undefined) {
    const m = s.match(/(?:våning|vån\.?)\s*(\d{1,2})(?:\s*(?:av|\/)\s*(\d{1,2}))?/) || s.match(/(\d{1,2}):?(?:a|e|dje|nde)\s+våning(?:en)?(?:\s+av\s+(\d{1,2}))?/);
    if (m) out.vaning = m[2] ? `${m[1]} av ${m[2]}` : m[1];
    else if (/högsta våning|översta våning|takvåning/.test(s)) out.vaning = 'översta';
    else if (/bottenvåning|entréplan|markplan/.test(s)) out.vaning = '0';
  }
  if (/sjöutsikt|havsutsikt|vattenutsikt|utsikt (mot|över) (vattnet|sjön|mälaren|saltsjön|riddarfjärden|strömmen|fjärden|havet|kanalen|viken)/.test(s)) out.vattenutsikt = true;
  return out;
}

// Alla långa textsträngar i ett JSON-träd (nyckel som "description"/"text"), utom mäklarpresentationer och CMS-block
function langaStrangar(o, ut = [], vag = '', d = 0) {
  if (!o || d > 14) return ut;
  if (Array.isArray(o)) { o.forEach((x, i) => langaStrangar(x, ut, vag, d + 1)); return ut; }
  if (typeof o !== 'object') return ut;
  for (const [k, v] of Object.entries(o)) {
    const p = vag + '.' + k;
    if (typeof v === 'string') { if (v.length >= 200 && /desc|text|beskriv|selling|presentation|body|content/i.test(k) && !/broker|agent|employee|maklare|office|cms|navigation|settings|seo|footer|cookie|association|surrounding|area/i.test(p) && !/<[a-z]/i.test(v.slice(0, 50))) ut.push({ k: p, v }); }
    else langaStrangar(v, ut, p, d + 1);
  }
  return ut;
}

// Tolkar en hämtad mäklarsida. Returnerar { beskrivning, kallaText, rubrik, balkong, uteplats, takterrass, hiss, vaning, avgift, ... }
export function tolkaText(html, url) {
  const kand = [];
  // 1. JSON-LD
  const ld = ldObjects(html);
  for (const o of ld) {
    const typ = [].concat(o['@type'] || []).join(',');
    for (const x of [o, o.product, o.about, o.itemOffered, o.offers?.itemOffered, o.mainEntity].filter(y => y && typeof y === 'object'))
      if (typeof x.description === 'string' && (LISTTYP.test(typ) || x.description.length > 300)) kand.push({ src: 'ld', v: decode(x.description) });
  }
  // 2. __NEXT_DATA__
  const nd = nextData(html);
  let hh = null;
  if (nd) {
    hh = nd.props?.pageProps?.estateDetails?.estate || null; // HusmanHagberg m.fl. Vitec-sajter
    const d = hh?.details?.description;
    if (d?.longSellingDescription) kand.push({ src: 'next', v: [d.sellingHeading, d.longSellingDescription].filter(Boolean).join('\n\n') });
    else for (const s of langaStrangar(nd.props?.pageProps || nd)) kand.push({ src: 'next', v: s.v });
  }
  // 3. RSC-data (self.__next_f)
  const rsc = nextF(html);
  if (rsc) { const re = /"(description|longDescription|sellingText|longSellingDescription|text|body)":("(?:[^"\\]|\\.){300,}?")/g; let m; while ((m = re.exec(rsc))) { try { const v = JSON.parse(m[2]); if (!/<[a-z]/i.test(v.slice(0, 50)) && !BRUS.test(v.slice(0, 300))) kand.push({ src: 'rsc', v }); } catch {} } }
  // 4. Sidans löptext
  const L = rader(html);
  const stycken = [...new Set(L.filter(lopt))];
  if (stycken.length) kand.push({ src: 'html', v: stycken.join('\n\n').slice(0, 6000) });
  // 5. meta-beskrivning
  const md = meta(html, 'og:description') || meta(html, 'description') || meta(html, 'twitter:description');
  const struct = kand.filter(k => k.src !== 'html').sort((a, b) => b.v.length - a.v.length);
  const htm = kand.find(k => k.src === 'html');
  let val = struct.find(k => k.v.length >= 300) || (htm && htm.v.length >= 300 ? htm : null) || struct[0] || htm || (md ? { src: 'meta', v: md } : null);
  // En kort ld/next-text (t.ex. bara rubriken) men lång löptext på sidan: ta löptexten
  if (val && val.src !== 'html' && val.v.length < 300 && htm && htm.v.length > val.v.length * 2) val = htm;
  const beskrivning = val ? val.v.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : null;

  // Fakta: etiketter i faktarutan, sedan HusmanHagbergs data, sedan nyckelord i texten
  const f = faktaUrRader(rader(html, false));
  if (hh) {
    const b = hh.baseInformation || {}, d = hh.details || {};
    if (d.balconyPatio) { if (d.balconyPatio.balcony != null) f.balkong = !!d.balconyPatio.balcony; if (d.balconyPatio.patio) f.uteplats = true; }
    const fe = d.floorAndElevator; if (fe) { if (fe.elevator) f.hiss = /yes|ja|true/i.test(String(fe.elevator)); if (fe.floor != null) f.vaning = fe.totalFloors ? `${fe.floor} av ${fe.totalFloors}` : String(fe.floor); }
    if (b.monthlyFee) f.avgift = b.monthlyFee;
    if (d.building?.buildingYear) f.byggar = +d.building.buildingYear || f.byggar;
    if (d.association?.name) f.brf = d.association.name;
    if (f.hiss === undefined && /med hiss/i.test(d.building?.buildingType || '')) f.hiss = true;
  }
  const t = faktaUrText(beskrivning, f);
  const rubrik = meta(html, 'og:title') || ld.find(o => o.name)?.name || (html.match(/<title>([^<]*)/i) || [])[1];
  return rensa({ url, beskrivning, kallaText: val?.src, rubrik: rubrik ? decode(rubrik).trim() : null, ...f, ...t, langd: beskrivning?.length });
}

// Hämtar en mäklarsida och plockar ut annonstexten. Fel (förbjudet av robots.txt, borta, spärr) blir { url, fel }.
export async function lasText(url) {
  try {
    const html = await hamta(url);
    const r = tolkaText(html, url);
    // Omdirigerad (t.ex. connect-resolve.maklare.vitec.net -> mäklarens sajt): kolla robots.txt för slutsajten också
    const slut = meta(html, 'og:url') || (html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)/i) || [])[1];
    if (slut && /^https?:/.test(slut) && new URL(slut).host !== new URL(url).host) {
      if (!(await robotsTillater(slut))) return { url, fel: `robots.txt förbjuder ${new URL(slut).host}` };
      r.slutUrl = slut;
    }
    if (!r.beskrivning) r.fel = /LANSFAST_API_BASE_URL|window\.location\.href\s*=/.test(html) && html.length < 20000 ? 'sidan skickar vidare med JavaScript (t.ex. Länsförsäkringars vitec-länk) – ingen text' : 'hittar ingen annonstext';
    return r;
  } catch (e) { return { url, fel: e instanceof Gone ? 'borta (404/410)' : e.message }; }
}

// ---------- (B) mäklarnas listor ----------
export function kandidat(a, F = CONF.filter) {
  if (a.rum != null && a.rum < (F.minRum || 2)) return false;
  if (a.utrop && a.utrop > F.maxUtrop) return false;
  if (a.lat != null && a.lon != null && F.mal && km([a.lat, a.lon], F.mal) > (F.maxKm || 22)) return false;
  const txt = norm(`${a.omrade} , ${a.adress} , ${a.kommun}`);
  if ((F.uteslutna || []).some(o => new RegExp(`(^|[^a-z0-9])${norm(o).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${o.length <= 4 ? '($|[^a-z0-9])' : ''}`).test(txt))) return false;
  return true;
}
const nara = (lat, lon, F) => lat != null && lon != null && km([+lat, +lon], F.mal) <= (F.maxKm || 22);
// Kommuner långt från Solna strand (förfilter innan bostadssidan hämtas när listan saknar koordinater)
const LANGT = /^(norrtalje|nynashamn|sodertalje|nykvarn|sigtuna|knivsta|uppsala|enkoping|strangnas|habo)/;
// Kommun-sluggar i mäklarnas adresser -> namn
const KOMMUN = { stockholm: 'Stockholm', solna: 'Solna', sundbyberg: 'Sundbyberg', nacka: 'Nacka', huddinge: 'Huddinge', lidingo: 'Lidingö', danderyd: 'Danderyd', taby: 'Täby',
  sollentuna: 'Sollentuna', jarfalla: 'Järfälla', 'upplands-vasby': 'Upplands Väsby', vallentuna: 'Vallentuna', osteraker: 'Österåker', varmdo: 'Värmdö', tyreso: 'Tyresö',
  haninge: 'Haninge', botkyrka: 'Botkyrka', salem: 'Salem', ekero: 'Ekerö', 'upplands-bro': 'Upplands-Bro', vaxholm: 'Vaxholm', sigtuna: 'Sigtuna', sodertalje: 'Södertälje',
  nynashamn: 'Nynäshamn', norrtalje: 'Norrtälje', nykvarn: 'Nykvarn' };

// Gemensamt: detaljhämtning med cache och tak
function detaljer(ctx, id) { return ctx.kanda.has(id) ? 'kand' : cacheGet(id) ? 'cache' : ctx.kvar > 0 ? 'hamta' : 'tak'; }

// Svensk Fastighetsförmedling
async function svenskfast(M, ctx) {
  const ut = []; let sidor = 0, kort = 0;
  for (let p = 1; p <= (ctx.sidor ?? M.sidor ?? 4); p++) {
    const url = p === 1 ? M.url : `${M.url}?p=${p}`;
    const html = await hamta(url); sidor++;
    const bitar = [...html.matchAll(/<a href="(\/[^"]+\/(\d+)\/)" class="search-hit__link"[\s\S]*?<\/article>/g)];
    if (!bitar.length) break;
    for (const [blk, href, id] of bitar) {
      kort++;
      const l = ldObjects(blk).find(o => o['@type'] === 'RealEstateListing') || {};
      const ab = l.about || {}, ad = ab.address || {};
      const etik = [...blk.matchAll(/search-hit__label[^"]*"[^>]*>([\s\S]*?)<\/span>/g)].map(m => strip(m[1]));
      const namn = String(l.name || '').split(',').map(s => s.trim());
      const pris = l.offers?.price ?? heltal(strip((blk.match(/sweden--price[^>]*>([^<]*)/) || [])[1]));
      const typ = href.split('/')[1], slug = href.split('/')[3] || '';
      if (typ !== 'bostadsratt') continue;
      // ld-namnet är "Kommun, Område, Gata" men ibland "Stadsdel, Gata": kommunen tas då från adressens slugg
      const kn = KOMMUN[slug] || namn[0];
      const a = {
        kalla: M.id, kod: id, url: 'https://www.svenskfast.se' + href, adress: (ad.streetAddress || namn.at(-1) || '').replace(/\s+/g, ' '),
        omrade: namn.length >= 3 ? namn[1] : norm(namn[0]) !== norm(kn) ? namn[0] : ad.addressLocality, kommun: kn,
        rum: ab.numberOfRooms, kvm: ab.floorSize?.value, vaning: ab.floorLevel != null ? String(ab.floorLevel) : null,
        utrop: pris || null, publicerad: l.datePosted, bilder: l.image ? [l.image] : [], typ: 'Lägenhet', upplatelse: 'Bostadsrätt', maklare: M.namn,
        maklarStatus: etik.filter(e => !/^visning/i.test(e)).join(', ') || null,
      };
      a.kommande = (!a.utrop || etik.some(e => /underhand|kommande|snart/i.test(e))) || undefined;
      if (LANGT.test(slug) || !kandidat(a, ctx.F)) continue;
      ut.push(a);
    }
    if (!html.includes(`?p=${p + 1}"`)) break;
  }
  // Bostadssidan: koordinater, avgift, hiss, våning, text
  for (const a of ut) {
    const id = `${a.kalla}-${a.kod}`, s = detaljer(ctx, id);
    if (s === 'cache') Object.assign(a, cacheGet(id));
    else if (s === 'hamta') {
      ctx.kvar--;
      try {
        const html = await hamta(a.url);
        const ll = html.match(/data-lat="([\d.]+)"\s+data-lng="([\d.]+)"/);
        const t = tolkaText(html, a.url);
        const d = rensa({ lat: ll ? +ll[1] : null, lon: ll ? +ll[2] : null, beskrivning: t.beskrivning, avgift: t.avgift, drift: t.drift, hiss: t.hiss, balkong: t.balkong, uteplats: t.uteplats, takterrass: t.takterrass, vattenutsikt: t.vattenutsikt, vaning: t.vaning, byggar: t.byggar, brf: t.brf, energiklass: t.energiklass, detaljHamtad: dag(Date.now()) });
        cacheSet(id, d); Object.assign(a, d);
      } catch (e) { ctx.log(`${id}: ${e.message}`); if (e instanceof Blocked) break; }
    }
  }
  // Utan koordinater (bostadssidan inte hämtad än, taket nått) går restiden inte att räkna: de tas nästa körning via cachen
  const utanLage = ut.filter(a => a.lat == null).length; if (utanLage) ctx.log(`${utanLage} kandidater väntar på bostadssidan (koordinater)`);
  return { annonser: ut.filter(a => a.lat != null && kandidat(a, ctx.F)), sidor, kort };
}

// Erik Olsson
async function erikolsson(M, ctx) {
  const ut = [], sedda = new Set(); let sidor = 0, kort = 0;
  // Sidan visar bara de första 16 träffarna (fler hämtas i webbläsaren från /api/, som robots.txt förbjuder; &page= ignoreras
  // av servern). Därför delas sökningen upp i boarea-intervall (living_space_min/max) tills varje del har högst 16 träffar.
  const max = ctx.sidor ?? M.sidor ?? 90;
  async function del(bas, lo, hi) {
    if (sidor >= max) { ctx.log(`taket ${max} sidor nått`); return []; }
    const html = await hamta(`${bas}&living_space_min=${lo}&living_space_max=${hi}`); sidor++;
    const t = nextF(html);
    const i = t.indexOf('"initialHomes":'); if (i < 0) { ctx.log('hittar inga initialHomes'); return []; }
    const hem = balanserad(t, t.indexOf('[', i)) || [];
    const antal = heltal(hem[0]?.count) || hem.length;
    if (antal > hem.length && hi - lo >= 2) { const mitt = Math.floor((lo + hi) / 2); return [...await del(bas, lo, mitt), ...await del(bas, mitt, hi)]; } // gränsen ingår i båda; dubbletter sållas bort
    if (antal > hem.length) ctx.log(`${antal} träffar för ${lo}–${hi} kvm, bara ${hem.length} syns`);
    const urlar = new Map([...html.matchAll(/https:\/\/www\.erikolsson\.se\/homes\/[A-Za-z0-9-]+-(\d+)/g)].map(m => [m[1], m[0]]));
    const hash = (html.match(/imagedelivery\.net\/([A-Za-z0-9_-]+)\//) || [])[1];
    return hem.map(h => ({ h, url: urlar.get(String(h.id)), hash }));
  }
  // Kommande ("Snart till salu") saknar pris och faller bort med price_max, så de läses med en egen sökning
  for (const bas of [M.kommandeUrl, M.url].filter(Boolean)) {
    // Färdiga boarea-intervall (färre anrop än att halvera 0–400); intervall med fler än 16 träffar delas vidare
    const GR = [0, 40, 45, 50, 55, 60, 65, 70, 75, 80, 90, 100, 120, 400], traffar = [];
    for (let i = 0; i < GR.length - 1; i++) traffar.push(...await del(bas, GR[i], GR[i + 1]));
    for (const { h, url, hash } of traffar) {
      kort++;
      if (sedda.has(String(h.id))) continue; sedda.add(String(h.id));
      const st = h.status?.name || '';
      const pris = h.is_price_hidden ? null : heltal(h.price);
      const a = {
        kalla: M.id, kod: String(h.id), url: url || `https://www.erikolsson.se/homes/${h.id}`,
        adress: h.street, omrade: h.area?.name, kommun: h.municipality, lat: h.latitude, lon: h.longitude,
        rum: tal(h.rooms), kvm: tal(h.living_space), biarea: tal(h.additional_space), avgift: heltal(h.monthly_fee), utrop: pris || null,
        visningar: (h.viewings || []).filter(v => v.is_visible !== false).map(v => v.start_time).filter(Boolean),
        bilder: hash ? (h.images || []).filter(x => x.cloudflare_image_id && !x.is_floor_plan && !x.is_hidden).slice(0, 6).map(x => `https://imagedelivery.net/${hash}/${x.cloudflare_image_id}/w=1200,fit=cover,format=auto,quality=85`) : [],
        budgivning: h.is_bidding_active || undefined, typ: 'Lägenhet', upplatelse: h.provider_type === 'HousingCooperative' ? 'Bostadsrätt' : h.provider_type,
        rubrik: h.title, maklare: M.namn, maklarStatus: h.status?.title, objektId: h.provider_id,
        kommande: (st !== 'for_sale' || !pris) || undefined,
      };
      if (kandidat(a, ctx.F)) ut.push(a);
    }
  }
  return { annonser: ut, sidor, kort };
}

// Bjurfors
function bjurforsKort(html, M, ctx) {
  const ut = [];
  for (const blk of html.split('class="c-object-card o-intrinsic"').slice(1)) {
    const href = (blk.match(/class="c-object-card__link" href="([^"]+)"/) || [])[1]; if (!href) continue;
    const meta_ = [...blk.matchAll(/<li class="c-object-card__meta">([^<]*)/g)].map(m => decode(m[1]).trim());
    const tags = [...blk.matchAll(/class="c-tag[^"]*">([^<]*)/g)].map(m => decode(m[1]).trim());
    const ca = strip((blk.match(/c-object-card__city-area">([\s\S]*?)<\/span>/) || [])[1]);
    const [omr, kommun] = ca.includes(',') ? [ca.slice(0, ca.lastIndexOf(',')).trim(), ca.slice(ca.lastIndexOf(',') + 1).trim()] : [ca, null];
    const del = href.replace(/^\/sv\/tillsalu\/stockholm\//, '').replace(/\/$/, '').split('/');
    const bild = (blk.match(/data-srcset="([^" ]+)/) || [])[1];
    const pris = heltal(meta_.find(s => /kr/.test(s)));
    const a = {
      kalla: M.id, kod: del.join('~'), url: 'https://www.bjurfors.se' + href, adress: strip((blk.match(/c-object-card__address">([\s\S]*?)<\/span>/) || [])[1]),
      omrade: omr, kommun, kvm: tal(meta_.find(s => /kvm/.test(s))), rum: tal(meta_.find(s => /rum/.test(s))), utrop: pris || null,
      bilder: bild ? ['https://www.bjurfors.se' + bild.replace(/\/cdn-cgi\/image\/[^/]+/, '')] : [], typ: 'Lägenhet', maklare: M.namn,
      maklarStatus: tags.join(', ') || null, kommande: (!pris || tags.some(t => /förhand|kommande|snart/i.test(t))) || undefined,
    };
    if (!LANGT.test(del[0] || '') && kandidat(a, ctx.F)) ut.push(a);
  }
  return ut;
}
async function bjurfors(M, ctx) {
  const fynd = new Map(); let sidor = 0, kort = 0;
  for (const [bas, max] of [[M.kommandeUrl, M.kommandeSidor ?? 20], [M.url, M.sidor ?? 3]]) {
    let mall = null;
    for (let p = 1; p <= (ctx.sidor ?? max); p++) {
      const url = p === 1 ? bas : mall.replace(/page=\d+/, `page=${p}`);
      const html = await hamta(url); sidor++;
      const k = bjurforsKort(html, M, ctx); kort += (html.match(/class="c-object-card o-intrinsic"/g) || []).length;
      for (const a of k) if (!fynd.has(a.kod)) fynd.set(a.kod, a);
      const dh = decode(html);
      if (p === 1) { const m = dh.match(/href="([^"]*[?&]page=2(?:&[^"]*)?)"/); if (!m) break; mall = 'https://www.bjurfors.se' + m[1]; }
      if (!new RegExp(`[?&]page=${p + 1}["&]`).test(dh)) break;
    }
  }
  const ut = [...fynd.values()];
  // Bostadssidan: koordinater (ld+json geo), datePosted, text. Kommande först.
  ut.sort((x, y) => (y.kommande ? 1 : 0) - (x.kommande ? 1 : 0) || (y.rum >= 3) - (x.rum >= 3));
  for (const a of ut) {
    const id = `${a.kalla}-${a.kod}`, s = detaljer(ctx, id);
    if (s === 'cache') Object.assign(a, cacheGet(id));
    else if (s === 'hamta') {
      ctx.kvar--;
      try {
        const html = await hamta(a.url);
        const l = ldObjects(html).find(o => o['@type'] === 'RealEstateListing') || {};
        const io = l.offers?.itemOffered || {};
        const t = tolkaText(html, a.url);
        const d = rensa({ lat: io.geo?.latitude, lon: io.geo?.longitude, publicerad: l.datePosted, beskrivning: t.beskrivning, avgift: t.avgift, hiss: t.hiss, balkong: t.balkong, uteplats: t.uteplats, takterrass: t.takterrass, vattenutsikt: t.vattenutsikt, vaning: t.vaning, byggar: t.byggar, brf: t.brf, typ: io['@type'] === 'Apartment' ? 'Lägenhet' : io['@type'], kommande: /PreOrder/.test(l.offers?.availability || '') || undefined, detaljHamtad: dag(Date.now()) });
        cacheSet(id, d); Object.assign(a, d);
      } catch (e) { ctx.log(`${id}: ${e.message}`); if (e instanceof Blocked) break; }
    }
  }
  // Utan koordinater (bostadssidan inte hämtad än, taket nått) går restiden inte att räkna: de tas nästa körning via cachen
  const utanLage = ut.filter(a => a.lat == null).length; if (utanLage) ctx.log(`${utanLage} kandidater väntar på bostadssidan (koordinater)`);
  return { annonser: ut.filter(a => a.lat != null && kandidat(a, ctx.F)), sidor, kort };
}

// Skandiamäklarna
async function skandia(M, ctx) {
  const karta = await hamta(M.kartUrl);
  const mj = JSON.parse((karta.match(/id="map-data"[^>]*>([\s\S]*?)<\/script>/) || [])[1] || '[]');
  const pos = new Map(mj.filter(x => !x.isSold).map(x => [String(x.shortId), x]));
  const naraIds = new Set([...pos.values()].filter(x => nara(x.latitude, x.longitude, ctx.F)).map(x => String(x.shortId)));
  const ut = []; let sidor = 1, kort = 0;
  for (let p = 0; p < (ctx.sidor ?? M.sidor ?? 25); p++) {
    const html = await hamta(`${M.url}&pageIndex=${p}`); sidor++;
    const items = html.split('class="estate-search-result-item').slice(1);
    if (!items.length) break;
    for (const blk of items) {
      kort++;
      const href = (blk.match(/<a href="([^"]+\/(\d+)\/)"/) || []); const id = href[2]; if (!id || !naraIds.has(id)) continue;
      const lab = decode((blk.match(/aria-label="([^"]*)"/) || [])[1] || '');
      const del = lab.split(/,\s*(?=Antal rum|Boarea)/)[0].split(',').map(s => s.trim()).filter((s, i) => i === 0 || !/^(våning|vån|\d+\s*tr\b)/i.test(s));
      const qf = [...blk.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map(m => decode(m[1]).trim());
      const statusar = strip((blk.match(/class="statuses">([\s\S]*?)<\/div>/) || [])[1]);
      const pris = heltal(qf.find(s => /kr/.test(s)));
      const x = pos.get(id);
      const a = {
        kalla: M.id, kod: id, url: href[1], adress: del[0], omrade: del.length >= 3 ? del[1] : null, kommun: titel(del.at(-1)),
        lat: x.latitude, lon: x.longitude, rum: tal((lab.match(/Antal rum: ([\d.,]+)/) || [])[1]), kvm: tal((lab.match(/Boarea: ([\d.,]+)/) || [])[1]),
        utrop: pris || null, bilder: [(blk.match(/<img src="([^"?]+)/) || [])[1]].filter(Boolean).map(u => u + '?width=1200'),
        typ: 'Lägenhet', upplatelse: /\/bostadsratt\//.test(href[1]) ? 'Bostadsrätt' : null, maklare: M.namn, maklarStatus: statusar || null,
        kommande: (x.isComingSoon || !pris) || undefined,
      };
      if (kandidat(a, ctx.F)) ut.push(a);
    }
    if (!/x-has-more|more-results/.test(html) && items.length < 100) break;
    if (items.length < 100) break;
  }
  // Bostadssidan (generella textläsaren): avgift, hiss, våning, balkong, text. Kommande först.
  ut.sort((x, y) => (y.kommande ? 1 : 0) - (x.kommande ? 1 : 0));
  for (const a of ut) {
    const id = `${a.kalla}-${a.kod}`, s = detaljer(ctx, id);
    if (s === 'cache') Object.assign(a, cacheGet(id));
    else if (s === 'hamta') {
      ctx.kvar--;
      const t = await lasText(a.url);
      if (t.fel) { ctx.log(`${id}: ${t.fel}`); if (/spärr|paus/.test(t.fel)) break; continue; }
      const d = rensa({ beskrivning: t.beskrivning, avgift: t.avgift, hiss: t.hiss, balkong: t.balkong, uteplats: t.uteplats, takterrass: t.takterrass, vattenutsikt: t.vattenutsikt, vaning: t.vaning, byggar: t.byggar, brf: t.brf, detaljHamtad: dag(Date.now()) });
      cacheSet(id, d); Object.assign(a, d);
    }
  }
  return { annonser: ut, sidor, kort, total: mj.length, nara: naraIds.size };
}

// HusmanHagberg
function hhAnnons(e, M, imgs = []) {
  const b = e.baseInformation || e, d = e.details || {}, ad = b.address || {};
  const pris = b.startingPrice || d.price?.startingPrice || null;
  const fe = d.floorAndElevator || {};
  const vy = (b.viewings || []).map(v => v.startTime || v.date).filter(Boolean);
  return rensa({
    kalla: M.id, kod: b.objectReference, url: `https://www.husmanhagberg.se/objekt/annons/${b.objectReference}`,
    adress: ad.streetAddress, omrade: ad.area, kommun: ad.municipality, lat: +ad.latitude || null, lon: +ad.longitude || null,
    rum: b.numberOfRooms ?? d.interior?.numberOfRooms, kvm: b.livingSpace, avgift: b.monthlyFee || d.baseInformation?.monthlyFee, utrop: pris,
    vaning: fe.floor != null ? (fe.totalFloors ? `${fe.floor} av ${fe.totalFloors}` : String(fe.floor)) : null,
    hiss: fe.elevator ? /yes|ja|true/i.test(String(fe.elevator)) : /med hiss/i.test(d.building?.buildingType || '') || undefined,
    balkong: d.balconyPatio?.balcony || undefined, uteplats: d.balconyPatio?.patio || undefined,
    byggar: +d.building?.buildingYear || null, brf: d.association?.name, visningar: vy, budgivning: b.bidding || undefined,
    bilder: (imgs.length ? imgs : [b.thumb]).map(x => (x?.sizes || x)?.full?.url || (x?.sizes || x)?.source?.url || x?.url).filter(Boolean).slice(0, 8),
    beskrivning: [d.description?.sellingHeading, d.description?.longSellingDescription].filter(Boolean).join('\n\n') || null,
    rubrik: d.description?.sellingHeading, typ: d.baseInformation?.propertyType || (b.estateType === 'HousingCooperative' ? 'Lägenhet' : b.estateType),
    upplatelse: d.baseInformation?.tenure, nyproduktion: b.newConstruction || undefined, maklare: M.namn, maklarStatus: b.statusId,
    kommande: (b.showAsComing || b.statusId === 'TakenIn' || !pris) || undefined,
  });
}
async function husmanhagberg(M, ctx) {
  const koord = async url => { const nd = nextData(await hamta(url)); return nd?.props?.pageProps?.estateCoordinatesData?.estates || []; };
  const alla = await koord(M.url), kom = new Set((await koord(M.kommandeUrl)).map(e => e.objectReference));
  const naraE = alla.filter(e => nara(e.address?.latitude, e.address?.longitude, ctx.F) && !(e.startingPrice > ctx.F.maxUtrop));
  naraE.sort((x, y) => kom.has(y.objectReference) - kom.has(x.objectReference));
  const ut = []; let vantar = 0, sidorHH = 0;
  for (const e of naraE) {
    const id = `${M.id}-${e.objectReference}`, s = detaljer(ctx, id);
    const bas = rensa({ kalla: M.id, kod: e.objectReference, url: `https://www.husmanhagberg.se/objekt/annons/${e.objectReference}`, lat: +e.address.latitude, lon: +e.address.longitude, utrop: e.startingPrice || null, kommande: (kom.has(e.objectReference) || !e.startingPrice) || undefined, maklare: M.namn });
    if (s === 'cache') { const a = { ...cacheGet(id), ...bas, kommande: bas.kommande }; if (kandidat(a, ctx.F) && a.adress) ut.push(a); continue; }
    if (s === 'kand') { ut.push(bas); continue; } // redan känd: bara pris/status
    if (s === 'tak') { vantar++; continue; }
    ctx.kvar--; sidorHH++;
    try {
      const nd = nextData(await hamta(bas.url));
      const ed = nd?.props?.pageProps?.estateDetails;
      if (!ed?.estate) { ctx.log(`${id}: ingen estateDetails`); continue; }
      const a = hhAnnons({ ...ed.estate, baseInformation: ed.estate.baseInformation }, M, ed.images || []);
      a.detaljHamtad = dag(Date.now()); if (kom.has(e.objectReference)) a.kommande = true;
      const { kalla, kod, url, ...spar } = a; cacheSet(id, spar);
      if (kandidat(a, ctx.F)) ut.push(a);
    } catch (err) { ctx.log(`${id}: ${err.message}`); if (err instanceof Blocked) break; }
  }
  if (vantar) ctx.log(`${vantar} nära kandidater väntar på bostadssidan (taket maxDetaljer nått, tas nästa körning)`);
  return { annonser: ut.filter(a => a.adress || ctx.kanda.has(`${a.kalla}-${a.kod}`)), sidor: sidorHH + 2, kort: alla.length, nara: naraE.length, kommande: kom.size };
}

const LASARE = { svenskfast, erikolsson, bjurfors, skandia, husmanhagberg };

function filterFranInst() {
  try {
    const inst = JSON.parse(readFileSync(path.join(HERE, 'installningar.json'), 'utf8')), U = inst.uteslutnaOmraden || {};
    return { ...CONF.filter, maxUtrop: inst.maxUtrop || CONF.filter.maxUtrop, minRum: inst.minRumTvaor || CONF.filter.minRum, maxKm: inst.forfilterKm || CONF.filter.maxKm,
      mal: inst.mal ? [inst.mal.lat, inst.mal.lon] : CONF.filter.mal, uteslutna: [...(U.sarskiltUtsatta || []), ...(U.utsatta || []), ...(U.egna || [])] };
  } catch { return CONF.filter; }
}

// En mäklare. opts: { kanda: Set("kalla-kod"), F (filter), maxDetaljer, sidor, log }
export async function sokMaklare(id, opts = {}) {
  const M = CONF.maklare.find(m => m.id === id); if (!M || !LASARE[id]) throw new Error(`okänd mäklare ${id}`);
  const ctx = { F: opts.F || filterFranInst(), kanda: opts.kanda || new Set(), kvar: opts.maxDetaljer ?? M.maxDetaljer ?? 30, sidor: opts.sidor, log: opts.log || (s => console.error(`[${id}] ${s}`)) };
  return LASARE[id](M, ctx);
}

// Alla aktiva mäklare -> inkorgsformat { annonser, borta, kallorLasta, logg }
export async function sokAlla({ bara, kanda = new Set(), F, maxDetaljer, sidor } = {}) {
  const res = { annonser: [], borta: [], kallorLasta: [], logg: [] };
  const log = s => { res.logg.push(s); console.error('[maklare] ' + s); };
  const valda = CONF.maklare.filter(m => LASARE[m.id] && (bara ? bara.includes(m.id) : m.aktiv));
  await Promise.all(valda.map(async M => { // olika sajter parallellt; varje sajt i sin egen lugna takt (fetch.mjs)
    const t0 = Date.now();
    try {
      const r = await sokMaklare(M.id, { kanda, F, maxDetaljer, sidor, log: s => log(`${M.id}: ${s}`) });
      const an = r.annonser.map(a => rensa(a));
      res.annonser.push(...an);
      res.kallorLasta.push({ kalla: M.id });
      log(`${M.id}: ${r.sidor} sidor, ${r.kort} poster${r.nara != null ? `, ${r.nara} nära` : ''}, ${an.length} kandidater (${an.filter(a => a.kommande).length} kommande) på ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (e) { log(`${M.id}: ${e.message} – hoppar över`); }
  }));
  cacheSpara();
  res.klar = new Date().toISOString();
  return res;
}

// ---------- CLI ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv.slice(2), val = k => { const i = arg.indexOf(k); return i >= 0 ? arg[i + 1] : undefined; };
  if (arg.includes('--text')) {
    const url = val('--text'); if (!url) { console.error('ange en URL: --text <url>'); process.exit(2); }
    const r = await lasText(url); console.log(JSON.stringify(r, null, 1)); process.exit(r.fel ? 1 : 0);
  } else if (arg.includes('--sok')) {
    let kanda = new Set(), F;
    if (val('--plan')) {
      const plan = JSON.parse(readFileSync(val('--plan'), 'utf8')); F = plan.filter ? { ...CONF.filter, ...plan.filter } : undefined;
      for (const k of plan.kanda || []) kanda.add(String(k));
    }
    // kända utan prefix ("475815") gäller alla mäklare
    const kandaAlla = new Set([...kanda].flatMap(k => /^[a-z]+-/.test(k) ? [k] : CONF.maklare.map(m => `${m.id}-${k}`)));
    const r = await sokAlla({ bara: val('--bara')?.split(','), kanda: kandaAlla, F, maxDetaljer: val('--max-detaljer') != null ? +val('--max-detaljer') : undefined, sidor: val('--sidor') != null ? +val('--sidor') : undefined });
    console.log(JSON.stringify(r, null, 1));
  } else {
    console.error('Användning: node boende/maklare.mjs --sok [--bara id,id] [--plan plan.json] [--max-detaljer N] [--sidor N]\n            node boende/maklare.mjs --text <mäklar-URL>');
    process.exit(2);
  }
}
