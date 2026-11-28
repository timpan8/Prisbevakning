// Slutpriser från Booli – läser sålda bostadsrätter (lägenheter, minst 2 rum, Stockholms län, senaste ~12 månaderna) i
// webbläsaren, så att fliken Boende kan jämföra kr/kvm med sålda i närheten direkt (boJmf i boende/sida.js).
// Booli spärrar serveranrop (Cloudflare), så skriptet körs på en sida på www.booli.se i Claude in Chrome (inte i
// webbläsarpanelen: den sparar inga nedladdningar). Klistra in hela filen och kör:
//
//   spKor(PLAN)                     PLAN = { kanda: [kända Booli-id:n], aldsta: "ÅÅÅÅ-MM-DD" (äldsta datum vi redan har),
//                                   fran: "ÅÅÅÅ-MM-DD" (äldsta datum att hämta; standard ett år tillbaka) }. Allt är valfritt:
//                                   spKor({}) börjar från början. Kör utan await och kolla window.__slutpriser.klar / .logg.
//   spKor(PLAN, { maxSidor: 150 })  högst så många söksidor per körning (35 poster per sida; standard 150 ≈ 12 minuter)
//
// Skriptet bara läser: ingen inloggning, inga sparade sökningar, inga formulär, inga cookies godkänns. Det läser samma data
// som sidan själv visar (sidans Apollo-data i self.__next_f: "initialApolloState", nyckeln searchSoldV2) med en paus på
// 3–6 sekunder mellan sidorna, och avbryter om Booli visar en spärr eller kontroll. Resultatet sparas som
// boende-slutpriser-ÅÅÅÅMMDD-HHMM.json i Hämtade filer och finns i window.__slutpriser.
//
// Två steg:
//  1) Nya (bara när plan.kanda finns): sorterat på när Booli fick in posten (sort=created, nyast först), så att sena
//     rapporter med äldre säljdatum också kommer med. Stannar när en sida nästan bara har kända id:n.
//  2) Äldre: säljdatum plan.aldsta (eller i dag) och bakåt (sort=soldDate, maxSoldDate=aldsta) tills fönstret ner till
//     plan.fran är slut eller maxSidor nås. Nästa körning fortsätter från det nya "aldsta" i filen. Hoppas över när
//     aldsta redan är fran (hela året läst).
//
// Fil: { salda: [{ kalla: "booli", kod, adress, omrade, kommun, lat, lon, rum, kvm, avgift, utrop, slutpris, datum, url,
//          sistaBud }], logg, klar, aldsta, nyast, svept, sidor }
//   utrop räknas fram ur sökkortets prisutveckling ("+7%"), avrundat till tusental, och saknas när Booli inte visar den.
//   avgift visas sällan på sålda kort och saknas då. sistaBud = true när Booli bara har sista budet (inte bekräftat slutpris).
//   aldsta = äldsta säljdatum som lästes i steg 2 (eller i steg 1 första gången), svept = true när hela fönstret ner till
//   fran är läst.
(function () {
  const pause = (a, b) => new Promise(r => setTimeout(r, a + Math.random() * (b - a)));
  const num = s => { if (s == null) return null; if (typeof s === 'number') return s; const m = String(s).replace(/\s| /g, '').match(/\d+(?:[.,]\d+)?/); return m ? +m[0].replace(',', '.') : null; };
  const SPARR = /Just a moment|Attention Required|captcha|Verify you are human|verifiera att du är en människa|cf-challenge/i;
  const BAS = 'https://www.booli.se';
  // Bostadsrätter (lägenheter) med minst 2 rum i Stockholms län (areaIds=2)
  const SOK = '/sok/slutpriser?areaIds=2&objectType=L%C3%A4genhet&tenure=Bostadsr%C3%A4tt&minRooms=2';
  const dag = d => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });

  // Sidans inbäddade data: alla self.__next_f.push([1,"..."])-strängar ihopslagna
  function chunks(html) {
    const out = [], re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g; let m;
    while ((m = re.exec(html))) { try { out.push(JSON.parse(m[1])); } catch (e) {} }
    return out.join('');
  }
  function objFrom(t, s) {
    let d = 0, inS = false, esc = false;
    for (let k = s; k < t.length; k++) {
      const c = t[k];
      if (inS) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inS = false; continue; }
      if (c === '"') inS = true; else if (c === '{') d++; else if (c === '}' && !--d) { try { return JSON.parse(t.slice(s, k + 1)); } catch (e) { return null; } }
    }
    return null;
  }
  function apollo(t) { const i = t.indexOf('"initialApolloState":'); return i < 0 ? null : objFrom(t, t.indexOf('{', i)); }
  // Slutpriskorten på sidan (null = ingen sökdata alls, t.ex. en annan sida än väntat)
  function kortPaSidan(st) {
    const rq = st?.ROOT_QUERY || {};
    const k = Object.keys(rq).find(x => /^searchSoldV2\(/.test(x)); if (!k) return null;
    const ik = Object.keys(rq[k] || {}).find(x => /^items/.test(x));
    return { total: rq[k].totalCount, kort: (rq[k][ik] || []).map(r => st[r.__ref] || r).filter(c => c?.listingId) };
  }

  async function hamta(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    const html = await r.text();
    if (r.status === 403 || r.status === 429 || r.status === 503 || SPARR.test(html.slice(0, 5000))) throw new Error(`Booli visar en spärr (${r.status}) – avbryter`);
    return { status: r.status, html };
  }

  // "+7%", "–2,1%", "+/-0%" -> procent (null om okänt)
  function procent(s) {
    s = String(s || '').replace(/\s/g, ''); if (!s) return null;
    if (/^\+\/-0/.test(s) || /^±0/.test(s)) return 0;
    const m = /^([+\-–−])?(\d+(?:[.,]\d+)?)%$/.exec(s); if (!m) return null;
    return (/[-–−]/.test(m[1] || '') ? -1 : 1) * +m[2].replace(',', '.');
  }
  // Ett slutpriskort (ListableProperty, saleType "sold") -> post
  function franKort(c) {
    if (c.saleType && c.saleType !== 'sold') return null;
    const slutpris = /kr/.test(c.displayPrice || '') ? num(c.displayPrice) : null;
    const datum = /^\d{4}-\d\d-\d\d/.test(c.displayDate || '') ? c.displayDate.slice(0, 10) : null;
    if (!slutpris || !datum) return null;
    const dp = Object.fromEntries((c.displayAttributes?.dataPoints || []).map(d => [d.key, d.value?.plainText]));
    const del = String(c.subtitle || '').split(/\s*·\s*/); // "Lägenhet · Vasastan · Stockholm"
    const pct = procent(c.priceRemark?.label);
    return strip({
      kalla: 'booli', kod: String(c.listingId), adress: c.title || null,
      omrade: del.length >= 3 ? del[1] : null, kommun: c.tracking?.properties?.municipality || (del.length >= 2 ? del[del.length - 1] : null),
      lat: c.position?.latitude ?? null, lon: c.position?.longitude ?? null,
      rum: num(dp.rooms), kvm: num(dp.livingArea),
      avgift: /kr\/mån/.test(dp.rentOrPlotAreaText || '') ? num(dp.rentOrPlotAreaText) : null,
      utrop: pct != null && pct > -60 ? Math.round(slutpris / (1 + pct / 100) / 1000) * 1000 : null,
      slutpris, datum, url: c.url ? BAS + c.url : null,
      sistaBud: c.primaryStatus?.key === 'soldViabid' || undefined,
    });
  }
  const strip = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

  window.spKor = async function (plan = {}, { maxSidor = 150, download = true } = {}) {
    if (!/booli\.se$/.test(location.hostname)) throw new Error('Kör skriptet på en sida på www.booli.se');
    const kanda = new Set((plan.kanda || []).map(String));
    const fran = plan.fran || dag(new Date(Date.now() - 365 * 864e5));
    const res = { salda: [], logg: [], klar: null, aldsta: plan.aldsta || null, nyast: null, svept: false, sidor: 0, fran };
    const sett = new Set(), log = s => { res.logg.push(s); console.log('[slutpriser]', s); };
    window.__slutpriser = res;
    let stopp = false;

    // Läser sidor ur en sökning tills villkoret stoppar; returnerar { slut: true } när sökningen tog slut
    async function sok(params, { ikapp }) {
      const u = new URL(SOK, BAS);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      let lasta = 0, minDatum = null;
      for (let p = 1; ; p++) {
        if (res.sidor >= maxSidor) { log(`taket på ${maxSidor} sidor nått`); return { slut: false, minDatum }; }
        u.searchParams.set('page', p);
        if (res.sidor) await pause(3000, 6000);
        let html; try { ({ html } = await hamta(u.pathname + u.search)); } catch (e) { log(e.message); stopp = true; return { slut: false, minDatum }; }
        res.sidor++; lasta++;
        const s = kortPaSidan(apollo(chunks(html)));
        if (s == null) { log(`sida ${p}: hittar ingen slutprisdata – avbryter`); stopp = true; return { slut: false, minDatum }; }
        if (p === 1) log(`${params.sort === 'created' ? 'nya' : `säljdatum ${params.maxSoldDate || 'i dag'} och bakåt`}: ${s.total} träffar`);
        if (!s.kort.length) return { slut: true, minDatum };
        let nyaHar = 0;
        for (const c of s.kort) {
          const o = franKort(c); if (!o) continue;
          if (!minDatum || o.datum < minDatum) minDatum = o.datum;
          if (!res.nyast || o.datum > res.nyast) res.nyast = o.datum;
          if (kanda.has(o.kod) || sett.has(o.kod)) continue;
          nyaHar++; sett.add(o.kod); res.salda.push(o);
        }
        window.__slutpriser.senaste = `sida ${p}, ${res.salda.length} nya hittills`;
        if (ikapp && kanda.size && nyaHar <= 2) { log(`ikapp efter ${lasta} sidor`); return { slut: false, ikapp: true, minDatum }; }
      }
    }

    // 1. Nya (efter när Booli fick in dem) – bara när det finns kända id:n att komma ikapp till
    if (kanda.size) await sok({ minSoldDate: fran, sort: 'created' }, { ikapp: true });
    // 2. Äldre efter säljdatum, nyast först: från aldsta och bakåt (samma dag läses om, kända id:n hoppas över).
    //    Första körningen (ingen aldsta) börjar från i dag.
    if (res.aldsta && res.aldsta <= fran) res.svept = true;
    else if (!stopp && res.sidor < maxSidor) {
      const p = { minSoldDate: fran, sort: 'soldDate' }; if (res.aldsta) p.maxSoldDate = res.aldsta;
      const b = await sok(p, { ikapp: false });
      if (b.slut) { res.aldsta = fran; res.svept = true; } else if (b.minDatum) res.aldsta = b.minDatum;
    }

    log(`${res.sidor} sidor, ${res.salda.length} nya slutpriser${res.aldsta ? `, äldsta läst ${res.aldsta}` : ''}${res.svept ? ' (hela året läst)' : ''}`);
    res.klar = new Date().toISOString();
    if (download) {
      const ts = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }).replace(/[-: ]/g, '').slice(0, 12).replace(/^(\d{8})/, '$1-');
      const el = document.createElement('a');
      el.href = URL.createObjectURL(new Blob([JSON.stringify(res, null, 1)], { type: 'application/json' }));
      el.download = `boende-slutpriser-${ts}.json`; document.body.appendChild(el); el.click(); el.remove();
    }
    return { salda: res.salda.length, sidor: res.sidor, aldsta: res.aldsta, svept: res.svept, logg: res.logg };
  };
  window.spTest = { chunks, apollo, kortPaSidan, franKort, procent };
})();
