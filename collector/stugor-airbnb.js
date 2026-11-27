// Stugor – Airbnb. Läser hela hus med bubbelpool i södra/mellersta Sverige för alla helger (fre–sön) i webbläsaren
// (Claude in Chrome eller konsolen). Klistra in hela filen på en sida på www.airbnb.se (vilken som helst, t.ex. startsidan)
// och kör funktionen. Skriptet bara läser: det hämtar sökresultatsidor från samma sajt med fetch() i lugn takt (3,5–5 s
// mellan hämtningarna), bokar inget, loggar inte in, fyller inte i något och skickar ingen data någonstans – resultatet
// sparas som en fil i Hämtade filer (stugor-airbnb-ÅÅÅÅMMDD-HHMM.json) och returneras som en kort sammanfattning.
// Avbryter om sajten slutar skicka data (spärr/kontroll) och sparar det som hunnit läsas.
//
//   await abStugor()                                alla fredagar från i morgon och 6 månader fram, 5 sidor (á 18) per helg
//   await abStugor({ helger: ['2026-12-04'], sidor: 5 })   bara vissa helger (fredagens datum)
//   stugHelger({ manader: 6 })                      listan med fredagar som används som standard
//   stugOmgangar(3)                                 standardhelgerna delade i 3 omgångar (för flera flikar), t.ex.
//                                                   await abStugor({ helger: stugOmgangar(2)[0], del: 1 })
//   window.__st                                     framsteg medan den kör; window.__stStopp = true avbryter snyggt
//
// Filen följer formatet i stugor/merge.mjs. Den har INGEN kallorLasta för Airbnb (bara de första sidorna läses, sorterat
// på relevans) – gamla Airbnb-priser försvinner i stället efter några dagar. Tar ~15 min för 26 helger.
(function () {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const pad = n => String(n).padStart(2, '0');
  const isoDag = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const plusDagar = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoDag(d); };
  const num = s => +String(s || '').replace(/[^0-9]/g, '') || null;

  // Pauser via en Web Worker: i dolda flikar bromsar webbläsaren setTimeout till en gång i minuten
  let worker = null;
  function sov(ms) {
    try {
      if (!worker && typeof Worker !== 'undefined') worker = new Worker(URL.createObjectURL(new Blob(['onmessage=e=>setTimeout(()=>postMessage(0),e.data)'])));
    } catch (e) { worker = false; }
    if (!worker) return new Promise(r => setTimeout(r, ms));
    return new Promise(r => { const w = worker; const f = () => { w.removeEventListener('message', f); r(); }; w.addEventListener('message', f); w.postMessage(ms); });
  }
  const pause = (a, b) => sov(a + Math.random() * (b - a));

  // Fredagar från i morgon och `manader` fram (samma som stugor/lib.mjs)
  W.stugHelger = W.stugHelger || function ({ manader = 6 } = {}) {
    const idag = isoDag(new Date()), slut = plusDagar(idag, Math.round(manader * 30.5)), out = [];
    let d = plusDagar(idag, 1);
    while (new Date(d + 'T12:00:00').getDay() !== 5) d = plusDagar(d, 1);
    for (; d <= slut; d = plusDagar(d, 7)) out.push(d);
    return out;
  };
  // Delar helgerna i n lika stora omgångar i följd (omgång 1 = de närmaste helgerna)
  W.stugOmgangar = W.stugOmgangar || function (n = 2, helger = W.stugHelger()) {
    const st = Math.ceil(helger.length / n), out = [];
    for (let i = 0; i < n; i++) out.push(helger.slice(i * st, (i + 1) * st));
    return out.filter(x => x.length);
  };

  // Restid som stugor/lib.mjs: fågelväg × 1,25 / 85 km/h till närmaste av Stockholm, Göteborg, Jönköping
  const UTG = [[59.3293, 18.0686], [57.7089, 11.9746], [57.7826, 14.1618]];
  function timmar(lat, lon) {
    if (lat == null || lon == null) return null;
    const R = Math.PI / 180;
    return Math.min(...UTG.map(([a, b]) => {
      const h = Math.sin((lat - a) * R / 2) ** 2 + Math.cos(a * R) * Math.cos(lat * R) * Math.sin((lon - b) * R / 2) ** 2;
      return 6371 * 2 * Math.asin(Math.sqrt(h)) * 1.25 / 85;
    }));
  }
  const MAX_TIMMAR = 3.3, MAX_PRIS = 8000;
  const NEKADE = /lägenhet|hotell|vandrarhem|pensionat|b&b|bed and breakfast|camping|tält|båt(?!hus)|resort|motell|husbil|husvagn|glamping|rum i /i;

  function sokUrl(helg, sida) {
    const p = new URLSearchParams({ checkin: helg, checkout: plusDagar(helg, 2), adults: '4', 'room_types[]': 'Entire home/apt', 'amenities[]': '25',
      ne_lat: '61.6', ne_lng: '19.6', sw_lat: '55.3', sw_lng: '11.0', search_by_map: 'true', price_max: '4000' });
    if (sida > 0) p.set('cursor', btoa(JSON.stringify({ section_offset: 0, items_offset: sida * 18, version: 1 })));
    return 'https://www.airbnb.se/s/Sverige/homes?' + p.toString();
  }

  // Tolkar en sökresultatsida (HTML-text). Ger null om sidan saknar sökdata (spärr/kontroll/annat innehåll).
  // { sidor, antal (råa träffar), erbjudanden: [...] (filtrerade) }
  W.abParse = function (html, helg) {
    const m = String(html).match(/<script[^>]*id="data-deferred-state-0"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    let res;
    try {
      const d = JSON.parse(m[1]);
      const ent = (d.niobeClientData || []).map(x => x && x[1]).find(x => x?.data?.presentation?.staysSearch) || d.niobeClientData?.[0]?.[1];
      res = ent.data.presentation.staysSearch.results;
    } catch (e) { return null; }
    if (!res || !Array.isArray(res.searchResults)) return null;
    const son = plusDagar(helg, 2), erbjudanden = [];
    for (const r of res.searchResults) {
      const L = r?.demandStayListing; if (!L?.id) continue;
      let kod; try { kod = atob(L.id).split(':')[1]; } catch (e) { continue; }
      if (!kod) continue;
      const pl = r.structuredDisplayPrice?.primaryLine || {};
      const pris = num(pl.discountedPrice || pl.price);
      const lat = L.location?.coordinate?.latitude ?? null, lon = L.location?.coordinate?.longitude ?? null;
      const titel = String(r.title || '');
      const [typRaw, ...ortDel] = titel.split(' i ');
      const typ = typRaw ? typRaw.trim().toLowerCase() : null;
      if (!pris || pris > MAX_PRIS) continue;
      if (NEKADE.test(titel)) continue;
      const t = timmar(lat, lon); if (t != null && t > MAX_TIMMAR) continue;
      const info = (r.structuredContent?.mapPrimaryLine || []).map(x => x?.body).filter(Boolean);
      const sovrum = num((info.join(' ').match(/(\d+)\s*sovrum/i) || [])[1]);
      const bilder = (r.contextualPictures || []).map(x => x?.picture).filter(Boolean).slice(0, 4).map(u => u + (u.includes('?') ? '&' : '?') + 'im_w=720');
      const betyg = parseFloat((String(r.avgRatingLocalized || '').match(/\d+[.,]\d+|\d+/) || [''])[0].replace(',', '.')) || null;
      erbjudanden.push({
        kalla: 'airbnb', kod, namn: r.nameLocalized?.localizedStringWithTranslationPreference || titel || null,
        typ, ort: ortDel.join(' i ').trim() || null, lat, lon, sovrum, bilder,
        url: `https://www.airbnb.se/rooms/${kod}`, betyg,
        bubbelpool: true, bubbelpoolText: 'Bubbelpool (Airbnbs filter)',
        helg, natter: 2, pris, prisUrl: `https://www.airbnb.se/rooms/${kod}?check_in=${helg}&check_out=${son}&adults=4`
      });
    }
    return { sidor: res.paginationInfo?.pageCursors?.length || 1, antal: res.searchResults.length, erbjudanden };
  };

  function spara(res, del) {
    const n = new Date(), ts = `${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}-${pad(n.getHours())}${pad(n.getMinutes())}`;
    const blob = new Blob([JSON.stringify(res, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `stugor-airbnb-${ts}${del ? '-del' + del : ''}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  W.abStugor = async function ({ helger = W.stugHelger(), sidor = 5, del = null, download = true, maxFel = 3 } = {}) {
    if (typeof location !== 'undefined' && !/airbnb\./.test(location.hostname)) throw new Error('Kör skriptet på en sida på www.airbnb.se');
    W.__stStopp = false;
    const st = W.__st = { kalla: 'airbnb', startad: new Date().toISOString(), helger: helger.length, klaraHelger: 0, helg: null, sida: 0,
      hamtningar: 0, fel: 0, erbjudanden: 0, status: 'kör' };
    const basta = new Map(); // kod|helg -> billigaste
    let fel = 0, avbrott = null;
    yttre: for (const helg of helger) {
      st.helg = helg;
      for (let s = 0, antalSidor = sidor; s < Math.min(sidor, antalSidor); s++) {
        if (W.__stStopp) { avbrott = 'stoppad'; break yttre; }
        st.sida = s + 1;
        let p = null;
        try {
          const r = await fetch(sokUrl(helg, s), { credentials: 'include' });
          st.hamtningar++;
          if (r.ok) p = W.abParse(await r.text(), helg);
        } catch (e) { p = null; }
        if (!p) {
          fel++; st.fel++;
          if (fel >= maxFel) { avbrott = `ingen sökdata ${fel} gånger i rad – spärr eller kontroll?`; break yttre; }
          await pause(12000, 20000); s--; continue;
        }
        fel = 0;
        antalSidor = p.sidor;
        for (const o of p.erbjudanden) { const k = o.kod + '|' + o.helg, g = basta.get(k); if (!g || o.pris < g.pris) basta.set(k, o); }
        st.erbjudanden = basta.size;
        if (!p.antal) break;
        await pause(3500, 5000);
      }
      if (!avbrott) st.klaraHelger++;
    }
    const erbjudanden = [...basta.values()];
    const res = { kalla: 'airbnb', hamtad: new Date().toISOString(), helger, sidorPerHelg: sidor, avbrott, erbjudanden };
    st.status = avbrott ? 'avbruten: ' + avbrott : 'klar';
    if (download && erbjudanden.length) spara(res, del);
    const perHelg = {};
    for (const o of erbjudanden) perHelg[o.helg] = (perHelg[o.helg] || 0) + 1;
    return { antal: erbjudanden.length, helger: st.klaraHelger + '/' + helger.length, hamtningar: st.hamtningar, avbrott, perHelg,
      billigast: erbjudanden.slice().sort((a, b) => a.pris - b.pris).slice(0, 5).map(o => `${o.helg} ${o.pris} kr ${o.namn} (${o.ort})`) };
  };
})();
