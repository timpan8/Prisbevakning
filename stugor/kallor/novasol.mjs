// Novasol: samma öppna sök-API som sajten använder (/api/search/properties/list). En sökning per helg:
// fredag + 2 nätter, 4 gäster, filtret "Badtunna / Bubbelbadkar" (ent_hottubspabathnov), alla träffar på en sida.
// Priset är totalt för hela vistelsen. Detaljsidan (/semesterhus/<kod>) läses en gång per hus (sparas 30 dagar) och avgör
// om det är badtunna/bubbelpool eller bara bubbelbadkar, bastu, avstånd till vatten, restaurang och grannar.
const API = 'https://www.novasol.se/api/search/properties/list';
const HDR = { 'x-awaze-locale': 'sv-SE' };
const DETALJ_DAGAR = 30, DETALJ_MAX = 45;
const dmy = d => d.split('-').reverse().join('-');
const img = (kod, file, size = 600) => `https://image.novasol.com/pic/${size}/${kod.slice(0, 3).toLowerCase()}/${file}`;
const meter = (els, re) => { for (const e of els) { const m = String(e).match(re); if (m) return { m: +m[1], namn: m[2] || null }; } return null; };

export function novasolUrl(kod, helg, natter, gaster) {
  return `https://www.novasol.se/semesterhus/${kod.toLowerCase()}` + (helg ? `?start=${dmy(helg)}&nights=${natter}&adult=${gaster}` : '');
}

// Detaljer ur annonssidans __NEXT_DATA__
export function parseDetalj(html, inst) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('detaljsidan saknar data');
  const s = JSON.parse(m[1]).props?.pageProps?.service;
  if (!s) throw new Error('detaljsidan saknar husdata');
  const feats = (s.features || []).map(f => f.displayValue || f.name || '').filter(Boolean);
  const lc = feats.map(f => f.toLowerCase());
  const jaOrd = (inst.bubbelpoolOrd || ['badtunna', 'bubbelpool', 'spabad']).map(x => x.toLowerCase());
  const nejOrd = (inst.ejBubbelpoolOrd || ['bubbelbadkar']).map(x => x.toLowerCase());
  const ja = feats.find((f, i) => jaOrd.some(o => lc[i].includes(o)) && !nejOrd.some(o => lc[i].includes(o)));
  const nej = feats.find((f, i) => nejOrd.some(o => lc[i].includes(o)));
  const near = (s.extraData?.nearby?.elements || []).map(e => e.value);
  const vatten = meter(near, /vatten\/bad:\s*(\d+)\s*m(?:\s*\(([^)]+)\))?/i);
  const ort = meter(near, /Närmaste ort:\s*(\d+)\s*m(?:\s*\(([^)]+)\))?/i);
  const kvm = (feats.find(f => /:\s*\d+\s*m2/.test(f)) || '').match(/(\d+)\s*m2/);
  return {
    typ: s.propertyType || s.pim?.type || null,
    lat: s.mapDetail?.latitude ?? null, lon: s.mapDetail?.longitude ?? null,
    baddar: s.bookingRules?.totalCapacity ?? s.capacity?.adults ?? undefined, // saknas: behåll sökningens antal
    bubbelpool: ja ? true : nej ? false : null,
    bubbelpoolText: ja || nej || null,
    bastu: lc.some(f => /bastu|sauna/.test(f)),
    sjotomt: lc.some(f => /strandtomt|sjötomt|havstomt|egen strand|vid stranden/.test(f)) || undefined,
    vattenMeter: vatten?.m ?? null, vattenNamn: vatten?.namn ?? null,
    restaurangMeter: meter(near, /Närmaste restaurang:\s*(\d+)\s*m/i)?.m ?? null,
    ortMeter: ort?.m ?? null, ortNamn: ort?.namn ?? null,
    grannarMeter: meter(near, /Närmaste bebyggelse:\s*(\d+)\s*m/i)?.m ?? null,
    kvm: kvm ? +kvm[1] : null,
    bilder: (s.pim?.images || []).map(i => i.url).filter(Boolean).slice(0, 6),
    detaljHamtad: new Date().toISOString().slice(0, 10),
  };
}

export default async function novasol(src, { getJson, getText, inst, db, helger, log }) {
  const N = inst.natter || 2, G = inst.gaster || 4;
  const hus = {}, erb = [], sokta = [], fel = [];
  for (const helg of helger) {
    const q = new URLSearchParams({ adult: G, child: 0, pets: 0, range: 0, nights: N, start: dmy(helg),
      accommodationType: 'novasol_cottages', placesId: 20, regionName: 'Sverige', destinationCategory: 752, index: 'search',
      features: 'ent_hottubspabathnov', page: 1, size: 100, sort: 'priceAsc', salesMarket: 752, brand: 'novasol' });
    let d;
    try { d = await getJson(`${API}?${q}`, { headers: HDR }); }
    catch (e) { fel.push(`${helg}: ${e.message}`); if (e.constructor?.name === 'Blocked') break; continue; }
    sokta.push(helg);
    for (const p of d.properties || []) {
      if (p.startDate !== helg || p.lengthOfStay !== N || !p.price) continue; // bara exakt den helgen
      const kod = p.code, id = `novasol-${kod.toLowerCase()}`;
      hus[id] ||= {
        id, kalla: src.id, kallaNamn: src.namn, kod, namn: p.displayName, ort: p.displayName,
        lat: +p.coordinate?.lat || null, lon: +p.coordinate?.lon || null,
        baddar: p.property?.sleeps ?? null, sovrum: p.property?.bedrooms ?? null, badrum: p.property?.bathrooms ?? null,
        betyg: p.averageReviewScore ?? null, url: novasolUrl(kod),
        bilderSok: (p.images || []).slice(0, 6).map(i => img(kod, i.assetId.split('/').pop())),
      };
      erb.push({ hus: id, kalla: src.id, helg, natter: N, pris: Math.round(p.price), ordPris: p.wasPrice ? Math.round(p.wasPrice) : null,
        url: novasolUrl(kod, helg, N, G) });
    }
    if (log && sokta.length % 6 === 0) log(`Novasol: ${sokta.length}/${helger.length} helger, ${Object.keys(hus).length} hus`);
  }
  if (!sokta.length) throw new Error('ingen helg gick att söka' + (fel[0] ? ': ' + fel[0] : ''));

  // Detaljer: hus som saknar dem eller har äldre än 30 dagar, billigaste först
  const billigast = {};
  for (const o of erb) billigast[o.hus] = Math.min(billigast[o.hus] ?? Infinity, o.pris);
  const att = Object.keys(hus).filter(id => {
    const g = db.hus[id]?.detaljHamtad;
    return !g || (Date.now() - Date.parse(g)) / 864e5 > DETALJ_DAGAR;
  }).sort((a, b) => billigast[a] - billigast[b]);
  let n = 0;
  for (const id of att.slice(0, DETALJ_MAX)) {
    try { Object.assign(hus[id], parseDetalj(await getText(novasolUrl(hus[id].kod)), inst)); n++; }
    catch (e) { fel.push(`detalj ${hus[id].kod}: ${e.message}`); if (e.constructor?.name === 'Blocked') break; }
  }
  for (const h of Object.values(hus)) {
    const bilder = h.bilder?.length ? h.bilder : db.hus[h.id]?.bilder?.length ? db.hus[h.id].bilder : h.bilderSok;
    h.bilder = bilder; delete h.bilderSok;
  }
  return { hus: Object.values(hus), erbjudanden: erb, full: true, helger: sokta,
    info: `${sokta.length} helger, ${Object.keys(hus).length} hus, ${n} detaljsidor${att.length > DETALJ_MAX ? ` (${att.length - DETALJ_MAX} kvar till nästa körning)` : ''}`,
    fel };
}
