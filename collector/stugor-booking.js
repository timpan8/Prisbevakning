// Stugor – Booking.com. Läser hela boenden (privacy_type=3) med bubbelbad (hotelfacility=63) i Sverige för alla helger
// (fre–sön) i webbläsaren (Claude in Chrome eller konsolen). Klistra in hela filen på en sida på www.booking.com (vilken som
// helst, t.ex. startsidan) och kör funktionen. Skriptet bara läser: det hämtar sökresultatsidor från samma sajt med fetch()
// i lugn takt (3,5–5 s mellan hämtningarna), bokar inget, loggar inte in, fyller inte i något och skickar ingen data
// någonstans – resultatet sparas som en fil i Hämtade filer (stugor-booking-ÅÅÅÅMMDD-HHMM.json) och returneras som en kort
// sammanfattning. Avbryter om sajten slutar skicka data (spärr/kontroll) och sparar det som hunnit läsas.
//
// Listan sorteras på pris. offset ignoreras vid direkt hämtning, så skriptet stegar med prisfiltret (price=SEK-<från>-4000-1,
// per natt): nästa "från" = högsta totalpris på sidan / 2. Högst 16 hämtningar per helg.
//
//   await bkStugor()                                alla fredagar från i morgon och 6 månader fram
//   await bkStugor({ helger: ['2026-12-04'] })      bara vissa helger (fredagens datum)
//   stugHelger({ manader: 6 })                      listan med fredagar som används som standard
//   stugOmgangar(3)                                 standardhelgerna delade i 3 omgångar – en per flik, t.ex. i flik 2:
//                                                   await bkStugor({ helger: stugOmgangar(3)[1], del: 2 })
//   window.__st                                     framsteg medan den kör; window.__stStopp = true avbryter snyggt
//
// Filen följer formatet i stugor/merge.mjs, med kallorLasta för de helger som lästes klart (Booking-hus som inte syns
// där markeras som borta). Tar ~35 min för 26 helger i en flik.
(function () {
  const W = typeof window !== 'undefined' ? window : globalThis;
  const pad = n => String(n).padStart(2, '0');
  const isoDag = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const plusDagar = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoDag(d); };

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
  const MAX_TIMMAR = 3.3, MAX_PRIS = 8000, PRIS_MAX_NATT = 4000;
  const TYPER = { 201: 'Lägenhet', 203: 'Vandrarhem', 204: 'Hotell', 205: 'Motell', 206: 'Resort', 208: 'B&B', 210: 'Lantgård',
    212: 'Semesterpark', 213: 'Villa', 214: 'Camping', 215: 'Båt', 216: 'Pensionat', 219: 'Lägenhetshotell', 220: 'Semesterbostad',
    221: 'Stuga', 222: 'Värdfamilj', 223: 'Lantligt boende', 224: 'Lyxtält', 228: 'Chalet' };
  const NEKADE = /lägenhet|hotell|vandrarhem|pensionat|b&b|camping|tält|båt|resort|motell|värdfamilj/i;

  function sokUrl(helg, lo) {
    const nflt = `privacy_type=3;hotelfacility=63;price=SEK-${lo}-${PRIS_MAX_NATT}-1`;
    return `https://www.booking.com/searchresults.sv.html?ss=Sverige&checkin=${helg}&checkout=${plusDagar(helg, 2)}&group_adults=4&no_rooms=1` +
      `&group_children=0&nflt=${encodeURIComponent(nflt)}&order=price&selected_currency=SEK`;
  }

  // Första arrayen (djupt i apollo-datan) vars element har basicPropertyData
  function hittaResultat(x, djup = 0) {
    if (!x || typeof x !== 'object' || djup > 40) return null;
    if (Array.isArray(x)) {
      if (x.length && x.some(e => e && e.basicPropertyData)) return x;
      for (const e of x) { const r = hittaResultat(e, djup + 1); if (r) return r; }
      return null;
    }
    for (const k in x) { const r = hittaResultat(x[k], djup + 1); if (r) return r; }
    return null;
  }

  // Tolkar en sökresultatsida (HTML-text). Ger null om sidan saknar sökdata (spärr/kontroll/annat innehåll).
  // { antal (råa träffar), ids (alla id på sidan), maxPris (högsta totalpris på sidan), erbjudanden: [...] (filtrerade) }
  W.bkParse = function (html, helg) {
    const m = String(html).match(/<script[^>]*data-capla-store-data="apollo"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    let lista;
    try { lista = hittaResultat(JSON.parse(m[1])); } catch (e) { return null; }
    if (!lista) {
      // Sidan har apollo-data men inga träffar (t.ex. prisfiltret ovanför alla priser) – en giltig, tom sida
      return { antal: 0, ids: [], maxPris: 0, erbjudanden: [] };
    }
    const son = plusDagar(helg, 2), erbjudanden = [], ids = [];
    let maxPris = 0;
    for (const r of lista) {
      const b = r?.basicPropertyData; if (!b?.id) continue;
      const kod = String(b.id); ids.push(kod);
      const pris = Math.round(+r.priceDisplayInfoIrene?.displayPrice?.amountPerStay?.amountUnformatted || 0) || null;
      if (pris > maxPris) maxPris = pris;
      const typ = TYPER[b.accommodationTypeId] || 'Boende';
      const lat = b.location?.latitude ?? null, lon = b.location?.longitude ?? null;
      if (!pris || pris > MAX_PRIS) continue;
      if (NEKADE.test(typ)) continue;
      const t = timmar(lat, lon); if (t != null && t > MAX_TIMMAR) continue;
      const foto = b.photos?.main?.highResUrl?.relativeUrl || b.photos?.main?.lowResUrl?.relativeUrl;
      const url = b.pageName ? `https://www.booking.com/hotel/se/${b.pageName}.sv.html` : null;
      const sovrum = +r.matchingUnitConfigurations?.commonConfiguration?.nbBedrooms || null;
      const betyg = b.reviewScore?.totalScore ? Math.round(b.reviewScore.totalScore / 2 * 100) / 100 : null;
      erbjudanden.push({
        kalla: 'booking', kod, namn: r.displayName?.text || null, typ: typ.toLowerCase(), ort: b.location?.city || null,
        lat, lon, sovrum, bilder: foto ? ['https://cf.bstatic.com' + foto.replace(/square\d+/, 'max800')] : [],
        url, betyg, bubbelpool: true, bubbelpoolText: 'Bubbelbad (Bookings filter)',
        helg, natter: 2, pris,
        prisUrl: url ? `${url}?checkin=${helg}&checkout=${son}&group_adults=4&no_rooms=1&selected_currency=SEK` : null
      });
    }
    return { antal: lista.length, ids, maxPris, erbjudanden };
  };

  function spara(res, del) {
    const n = new Date(), ts = `${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}-${pad(n.getHours())}${pad(n.getMinutes())}`;
    const blob = new Blob([JSON.stringify(res, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `stugor-booking-${ts}${del ? '-del' + del : ''}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  W.bkStugor = async function ({ helger = W.stugHelger(), del = null, download = true, maxHamtningar = 16, maxFel = 3 } = {}) {
    if (typeof location !== 'undefined' && !/booking\.com$/.test(location.hostname)) throw new Error('Kör skriptet på en sida på www.booking.com');
    W.__stStopp = false;
    const st = W.__st = { kalla: 'booking', startad: new Date().toISOString(), helger: helger.length, klaraHelger: 0, helg: null, fran: 0,
      hamtningar: 0, fel: 0, erbjudanden: 0, status: 'kör' };
    const basta = new Map(), lasta = [];
    let fel = 0, avbrott = null;
    yttre: for (const helg of helger) {
      st.helg = helg;
      const sett = new Set();
      let lo = 0;
      for (let h = 0; h < maxHamtningar && lo < PRIS_MAX_NATT;) {
        if (W.__stStopp) { avbrott = 'stoppad'; break yttre; }
        st.fran = lo;
        let p = null;
        try {
          const r = await fetch(sokUrl(helg, lo), { credentials: 'include' });
          st.hamtningar++;
          if (r.ok) p = W.bkParse(await r.text(), helg);
        } catch (e) { p = null; }
        // Utan prisgräns ska det alltid finnas träffar – en tom första sida räknas som fel (annars markeras allt som borta)
        if (p && lo === 0 && !p.antal) p = null;
        if (!p) {
          fel++; st.fel++;
          if (fel >= maxFel) { avbrott = `ingen sökdata ${fel} gånger i rad – spärr eller kontroll?`; break yttre; }
          await pause(12000, 20000); continue;
        }
        fel = 0; h++;
        const nya = p.ids.filter(id => !sett.has(id)).length;
        p.ids.forEach(id => sett.add(id));
        for (const o of p.erbjudanden) { const k = o.kod + '|' + o.helg, g = basta.get(k); if (!g || o.pris < g.pris) basta.set(k, o); }
        st.erbjudanden = basta.size;
        if (p.antal < 15) break;
        lo = nya ? Math.max(Math.floor(p.maxPris / 2), lo + 1) : lo + 50;
        await pause(3500, 5000);
      }
      lasta.push(helg); st.klaraHelger++;
      await pause(3500, 5000);
    }
    const erbjudanden = [...basta.values()];
    const res = { kalla: 'booking', hamtad: new Date().toISOString(), helger, avbrott, erbjudanden,
      kallorLasta: lasta.length ? [{ kalla: 'booking', helger: lasta }] : [] };
    st.status = avbrott ? 'avbruten: ' + avbrott : 'klar';
    if (download && (erbjudanden.length || lasta.length)) spara(res, del);
    const perHelg = {};
    for (const o of erbjudanden) perHelg[o.helg] = (perHelg[o.helg] || 0) + 1;
    return { antal: erbjudanden.length, helger: lasta.length + '/' + helger.length, hamtningar: st.hamtningar, avbrott, perHelg,
      billigast: erbjudanden.slice().sort((a, b) => a.pris - b.pris).slice(0, 5).map(o => `${o.helg} ${o.pris} kr ${o.namn} (${o.ort})`) };
  };
})();
