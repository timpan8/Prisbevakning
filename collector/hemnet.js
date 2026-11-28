// Hemnet – läser bostadsrätter i webbläsaren (Claude in Chrome eller konsolen) för fliken Boende. Klistra in hela filen
// på en sida på www.hemnet.se och kör hnKor med planen från datorn:
//
//   PRIS_KOD=... node boende/merge.mjs --plan          (skriver ut planen som JSON)
//   hnKor(PLAN)                                        PLAN = den utskrivna JSON:en. Tar några minuter: kör den utan
//                                                      await och kolla window.__boende.klar / .logg tills den är klar.
//
// Skriptet bara läser: ingen inloggning, inga sparade sökningar, inga formulär, ingen kontakt med mäklare, inga
// visningsanmälningar. Det läser samma data som sidan själv visar (sidans inbäddade data i self.__next_f) med en paus på
// 3–6 sekunder mellan sidorna, och avbryter om Hemnet visar en spärr eller kontroll. Resultatet sparas som
// boende-hemnet-ÅÅÅÅMMDD-HHMM.json i Hämtade filer (flytta den till inbox\) och finns i window.__boende.
//
// Steg: 1) sökningen nyaste först: sidorna fran–till (de nyaste stannar när de kommit ikapp; "djup" = stegvis genomsökning av äldre);
// 2) detaljsidan för nya kandidater (högst maxDetaljer); 3) detaljsidan för planens "kolla" (pris, budgivning, såld).
(function () {
  const pause = (a, b) => new Promise(r => setTimeout(r, a + Math.random() * (b - a)));
  const num = s => { if (s == null) return null; if (typeof s === 'number') return s; const m = String(s).replace(/\s| /g, '').match(/\d+(?:[.,]\d+)?/); return m ? +m[0].replace(',', '.') : null; };
  const SPARR = /Just a moment|Attention Required|captcha|Verify you are human|verifiera att du är en människa/i;
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const RAD = Math.PI / 180;
  const km = (a, b) => { const dLat = (b[0] - a[0]) * RAD, dLon = (b[1] - a[1]) * RAD; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2; return 6371 * 2 * Math.asin(Math.sqrt(h)); };

  // Sidans inbäddade data: alla self.__next_f.push([1,"..."])-strängar ihopslagna
  function chunks(html) {
    const out = [], re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g; let m;
    while ((m = re.exec(html))) { try { out.push(JSON.parse(m[1])); } catch (e) {} }
    return out.join('');
  }
  // Hela JSON-objektet som börjar närmast före position i
  function objAt(t, i) {
    const s = t.lastIndexOf('{', i); let d = 0, inS = false, esc = false;
    for (let k = s; k < t.length; k++) {
      const c = t[k];
      if (inS) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inS = false; continue; }
      if (c === '"') inS = true; else if (c === '{') d++; else if (c === '}' && !--d) { try { return JSON.parse(t.slice(s, k + 1)); } catch (e) { return null; } }
    }
    return null;
  }
  const allOf = (t, typ) => { const out = [], key = `"__typename":"${typ}"`; let i = -1; while ((i = t.indexOf(key, i + 1)) >= 0) { const o = objAt(t, i); if (o?.__typename === typ) out.push(o); } return out; };
  // Text som sidan lagt i en egen bit ("$65" -> raden 65:T<längd i byte>,<text>)
  function ref(t, v) {
    if (typeof v !== 'string' || !/^\$[0-9a-f]+$/.test(v)) return v;
    const m = new RegExp(`(?:^|\\n)${v.slice(1)}:T([0-9a-f]+),`).exec(t); if (!m) return null;
    let bytes = parseInt(m[1], 16), i = m.index + m[0].length, j = i;
    while (bytes > 0 && j < t.length) { const c = t.codePointAt(j); bytes -= c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; j += c >= 0x10000 ? 2 : 1; }
    return t.slice(i, j);
  }
  async function hamta(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    const html = await r.text();
    if (r.status === 403 || r.status === 429 || SPARR.test(html.slice(0, 5000))) throw new Error(`Hemnet visar en spärr (${r.status}) – avbryter`);
    return { status: r.status, url: r.url, html };
  }

  // "Sön 29 nov kl 12:15" -> ISO (år: i år, eller nästa år om datumet redan passerat med mer än en månad)
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, maj: 4, jun: 5, jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11 };
  function visning(s) {
    const m = /(\d{1,2})\s+([a-zåä]{3})[a-zåä]*\.?(?:\s+kl\s+(\d{1,2})[:.](\d{2}))?/i.exec(s || ''); if (!m || MON[m[2].toLowerCase()] == null) return null;
    const now = new Date(); let d = new Date(now.getFullYear(), MON[m[2].toLowerCase()], +m[1], +(m[3] || 12), +(m[4] || 0));
    if (d < now - 30 * 864e5) d = new Date(now.getFullYear() + 1, d.getMonth(), d.getDate(), d.getHours(), d.getMinutes());
    return d.toISOString();
  }
  const datum = unix => unix ? new Date(+unix * 1000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' }) : null;
  const harLabel = (labels, re) => (labels || []).some(l => re.test(`${l.identifier || ''} ${l.text || ''}`));

  // Ett sökkort -> annons
  function franKort(c) {
    const [omrade, kommun] = String(c.locationDescription || '').split(/,\s*(?=[^,]*$)/);
    return {
      kalla: 'hemnet', kod: String(c.id), url: c.slug ? `https://www.hemnet.se/bostad/${c.slug}` : null,
      adress: c.streetAddress, omrade: omrade?.trim(), kommun: kommun?.trim(), lat: c.coordinates?.lat, lon: c.coordinates?.long,
      rum: num(c.rooms), kvm: num(c.livingAndSupplementalAreas), vaning: c.floor || null, avgift: num(c.fee), utrop: num(c.askingPrice),
      publicerad: datum(c.publishedAt), visningar: (c.showings || []).map(visning).filter(Boolean),
      bilder: (c.thumbnails || []).slice(0, 6), beskrivning: c.description || null,
      balkong: harLabel(c.labels, /BALCONY|balkong/i) || undefined, uteplats: harLabel(c.labels, /PATIO|uteplats/i) || undefined,
      hiss: harLabel(c.labels, /ELEVATOR|hiss/i) || undefined, budgivning: harLabel(c.labels, /BIDDING|budgivning/i),
      typ: c.housingForm?.name, nyproduktion: !!c.newConstruction,
    };
  }
  // En detaljsida -> annons (eller { borta })
  function franDetalj(t, kod, sidUrl) {
    const o = allOf(t, 'ActivePropertyListing').find(x => String(x.id) === String(kod)) || allOf(t, 'ActivePropertyListing')[0];
    if (!o) {
      const typer = [...new Set((t.match(/"__typename":"[A-Za-z]*(?:Sold|Deactivated|Removed|Inactive)[A-Za-z]*"/g) || []))];
      const sald = typer.find(x => /Sold/.test(x)) || /\/salda\//.test(sidUrl);
      const sp = /"sellingPrice":\{[^}]*"amount":(\d+)/.exec(t);
      const da = /"soldAt":"?(\d{9,})/.exec(t);
      return { borta: { kalla: 'hemnet', kod: String(kod), status: sald ? 'sald' : 'borttagen', slutpris: sp ? +sp[1] : null, datum: da ? datum(da[1]) : null } };
    }
    const am = (o.relevantAmenities || []).reduce((m, a) => (m[a.kind] = a.isAvailable, m), {});
    const vis = (o.upcomingOpenHouses || []).map(v => v.start ? new Date(+v.start * 1000).toISOString() : null).filter(Boolean);
    const vatten = [o.closestWaterDistanceMeters, o.coastlineDistanceMeters].filter(x => x != null).map(Number);
    return {
      kalla: 'hemnet', kod: String(o.id), url: o.listingHemnetUrl, adress: o.streetAddress, omrade: o.area, kommun: o.municipality?.fullName,
      lat: o.coordinates?.lat, lon: o.coordinates?.long, rum: o.numberOfRooms, kvm: num(o.livingArea), biarea: num(o.supplementalArea),
      vaning: o.formattedFloor, hiss: am.ELEVATOR, balkong: am.BALCONY, uteplats: am.PATIO, avgift: o.fee?.amount, drift: o.runningCosts?.amount,
      utrop: o.askingPrice?.amount, byggar: num(o.legacyConstructionYear), brf: o.brf?.name, energiklass: o.energyClassification?.classification,
      publicerad: datum(o.publishedAt), visningar: vis, bilder: (o.images?.images || []).map(i => i.url).filter(Boolean).slice(0, 8),
      beskrivning: ref(t, o.description), vattenMeter: vatten.length ? Math.min(...vatten) : null,
      budgivning: !!o.biddingStarted || harLabel(o.labels, /BIDDING|budgivning/i), dagarHemnet: o.daysOnHemnet, visad: o.timesViewed,
      typ: o.housingForm?.name, upplatelse: o.tenure?.name, detaljHamtad: new Date().toISOString().slice(0, 10),
    };
  }

  function sorterad(url) {
    const u = new URL(url, location.origin); u.searchParams.set('by', 'published_at'); u.searchParams.set('order', 'desc'); return u;
  }
  function kandidat(a, F) {
    if (a.rum != null && a.rum < (F.minRum || 2)) return false;
    if (a.utrop && a.utrop > F.maxUtrop) return false;
    if (a.lat != null && F.mal && km([a.lat, a.lon], F.mal) > (F.maxKm || 22)) return false;
    const txt = norm(`${a.omrade} , ${a.adress} , ${a.kommun}`);
    if ((F.uteslutna || []).some(o => new RegExp(`(^|[^a-z0-9])${norm(o)}${o.length <= 4 ? '($|[^a-z0-9])' : ''}`).test(txt))) return false;
    return true;
  }

  window.hnKor = async function (plan, { maxDetaljer = 40, download = true } = {}) {
    if (!/hemnet\.se$/.test(location.hostname)) throw new Error('Kör skriptet på en sida på www.hemnet.se');
    const F = plan.filter || {}, kanda = new Set(plan.kanda || []), res = { annonser: [], borta: [], kallorLasta: [], logg: [] };
    const fynd = new Map(), log = s => { res.logg.push(s); console.log('[hemnet]', s); };
    window.__boende = res;
    // 1. Sökningen
    for (const s of plan.sok || []) {
      const u = sorterad(s.url); let slut = false, sidor = 0, kort = 0, sista = 0;
      for (let p = s.fran || 1; p <= (s.till || 3); p++) {
        u.searchParams.set('page', p);
        const { html } = await hamta(u.toString()); sidor++; sista = p;
        const cards = allOf(chunks(html), 'ListingCard').filter(c => !c.teaser);
        if (!cards.length) { slut = true; break; }
        let nyaHar = 0;
        for (const c of cards) { const a = franKort(c); kort++; if (!kanda.has(a.kod)) nyaHar++; if (kandidat(a, F) && !fynd.has(a.kod)) fynd.set(a.kod, a); }
        // Nyast först: en sida med nästan bara kända annonser betyder att vi kommit ikapp (gäller inte den stegvisa genomsökningen)
        if (!s.djup && p > 1 && nyaHar <= 2) break;
        await pause(3000, 6000);
      }
      res.kallorLasta.push({ kalla: s.kalla || 'hemnet', ...(s.djup ? { djupTill: sista, svept: slut } : {}) });
      log(`sökning ${s.fran || 1}–${sista}: ${sidor} sidor, ${kort} kort, ${fynd.size} kandidater${slut ? ' (hela sökningen läst)' : ''}`);
    }
    // 2. Detaljsidor för nya kandidater
    let n = 0;
    // Treor och stora tvåor (minst 55 kvm) först, så att de bästa får detaljer om taket nås
    const ordning = [...fynd.values()].sort((x, y) => ((y.rum >= 3) * 2 + (y.kvm >= 55)) - ((x.rum >= 3) * 2 + (x.kvm >= 55)));
    for (const a of ordning) {
      if (kanda.has(a.kod) || !a.url || n >= maxDetaljer) { res.annonser.push(a); continue; }
      await pause(3000, 6000); n++;
      try { const { html, url } = await hamta(a.url); const d = franDetalj(chunks(html), a.kod, url); d.borta ? res.borta.push(d.borta) : res.annonser.push({ ...a, ...strip(d) }); }
      catch (e) { if (/spärr/.test(e.message)) { log(e.message); break; } res.annonser.push(a); }
    }
    // 3. Kända annonser att kolla (pris, budgivning, visningar, såld)
    let k = 0;
    for (const x of plan.kolla || []) {
      if (fynd.has(x.kod) && res.annonser.some(a => a.kod === x.kod && a.detaljHamtad)) continue;
      await pause(3000, 6000);
      try { const { html, url, status } = await hamta(x.url); const d = status === 404 ? { borta: { kalla: 'hemnet', kod: x.kod, status: 'borttagen' } } : franDetalj(chunks(html), x.kod, url); d.borta ? res.borta.push(d.borta) : res.annonser.push(strip(d)); k++; }
      catch (e) { log(`${x.kod}: ${e.message}`); if (/spärr/.test(e.message)) break; }
    }
    log(`detaljer: ${n} nya, ${k} kollade, ${res.borta.length} sålda/borttagna`);
    res.klar = new Date().toISOString();
    if (download) {
      const ts = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }).replace(/[-: ]/g, '').slice(0, 12).replace(/^(\d{8})/, '$1-');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(res, null, 1)], { type: 'application/json' }));
      a.download = `boende-hemnet-${ts}.json`; document.body.appendChild(a); a.click(); a.remove();
    }
    return { annonser: res.annonser.length, borta: res.borta.length, logg: res.logg };
  };
  const strip = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  window.hnTest = { chunks, allOf, franKort, franDetalj, ref, visning };
})();
