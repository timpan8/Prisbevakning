// Booli – läser bostadsrätter i webbläsaren (Claude in Chrome, den inbyggda webbläsaren eller konsolen) för fliken Boende.
// Booli spärrar serveranrop (Cloudflare), så skriptet måste köras på en sida på www.booli.se. Klistra in hela filen och kör
// bKor med planen från datorn (samma planformat som hnKor i hemnet.js):
//
//   PRIS_KOD=... node boende/merge.mjs --plan          (skriver ut planen som JSON)
//   bKor(PLAN)                                         PLAN = den utskrivna JSON:en (plan.sok med Booli-sökningen, plan.kanda =
//                                                      kända Booli-id:n). Tar några minuter: kör den utan await och kolla
//                                                      window.__boende.klar / .logg tills den är klar.
//
// Skriptet bara läser: ingen inloggning, inga sparade sökningar, inga formulär, ingen kontakt med mäklare, inga
// visningsanmälningar, inga cookies godkänns. Det läser samma data som sidan själv visar (sidans inbäddade Apollo-data i
// self.__next_f: "initialApolloState" på söksidan, objektet Listing/SoldProperty på bostadssidan) med en paus på 3–6 sekunder
// mellan sidorna, och avbryter om Booli visar en spärr eller kontroll. Resultatet sparas som boende-booli-ÅÅÅÅMMDD-HHMM.json
// i Hämtade filer (flytta den till inbox\) och finns i window.__boende.
//
// Sökadress (boende/kallor.json): https://www.booli.se/sok/till-salu?areaIds=2&objectType=L%C3%A4genhet&maxListPrice=4000000&minRooms=2
// (skriptet lägger själv till sort=published = nyast först, och page=N; 35 annonser per sida).
//
// Id: kod = Boolis annons-id (booliId/listingId). Adressen är /bostad/<residenceId>, som är bostadens id och följer med när
// bostaden säljs (sidan visar då SoldProperty med slutpris). Booli har ingen egen annonstext, så beskrivning saknas.
//
// Steg: 1) sökningen nyaste först: sidorna fran–till (de nyaste stannar när de kommit ikapp; "djup" = stegvis genomsökning av äldre);
// 2) bostadssidan för nya kandidater (högst maxDetaljer); 3) bostadssidan för planens "kolla" (pris, budgivning, såld).
(function () {
  const pause = (a, b) => new Promise(r => setTimeout(r, a + Math.random() * (b - a)));
  const num = s => { if (s == null) return null; if (typeof s === 'number') return s; const m = String(s).replace(/\s| /g, '').match(/\d+(?:[.,]\d+)?/); return m ? +m[0].replace(',', '.') : null; };
  const SPARR = /Just a moment|Attention Required|captcha|Verify you are human|verifiera att du är en människa|cf-challenge/i;
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const RAD = Math.PI / 180;
  const km = (a, b) => { const dLat = (b[0] - a[0]) * RAD, dLon = (b[1] - a[1]) * RAD; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2; return 6371 * 2 * Math.asin(Math.sqrt(h)); };
  const BAS = 'https://www.booli.se';
  const bild = id => id ? `https://bcdn.se/images/cache/${id}_1440x0.jpg` : null;

  // Sidans inbäddade data: alla self.__next_f.push([1,"..."])-strängar ihopslagna
  function chunks(html) {
    const out = [], re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g; let m;
    while ((m = re.exec(html))) { try { out.push(JSON.parse(m[1])); } catch (e) {} }
    return out.join('');
  }
  // Hela JSON-objektet som börjar vid position s (eller närmast före position i med objAt)
  function objFrom(t, s) {
    let d = 0, inS = false, esc = false;
    for (let k = s; k < t.length; k++) {
      const c = t[k];
      if (inS) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inS = false; continue; }
      if (c === '"') inS = true; else if (c === '{') d++; else if (c === '}' && !--d) { try { return JSON.parse(t.slice(s, k + 1)); } catch (e) { return null; } }
    }
    return null;
  }
  const objAt = (t, i) => objFrom(t, t.lastIndexOf('{', i));
  const allOf = (t, typ) => { const out = [], key = `"__typename":"${typ}"`; let i = -1; while ((i = t.indexOf(key, i + 1)) >= 0) { const o = objAt(t, i); if (o?.__typename === typ) out.push(o); } return out; };
  // Söksidans Apollo-cache
  function apollo(t) { const i = t.indexOf('"initialApolloState":'); return i < 0 ? null : objFrom(t, t.indexOf('{', i)); }

  async function hamta(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    const html = await r.text();
    if (r.status === 403 || r.status === 429 || r.status === 503 || SPARR.test(html.slice(0, 5000))) throw new Error(`Booli visar en spärr (${r.status}) – avbryter`);
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
  const dag = d => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
  // Sökkortets "Idag" / "Igår" / "5 dagar" / "En vecka" / "2 månader" -> ungefärligt publiceringsdatum
  function dagarSedan(s) {
    s = String(s || '').toLowerCase().trim(); if (!s) return null;
    if (/^\d{4}-\d\d-\d\d/.test(s)) return s.slice(0, 10);
    if (s === 'idag') return dag(new Date());
    if (s === 'igår') return dag(new Date(Date.now() - 864e5));
    const m = /^(en|ett|\d+)\s+(dag|dagar|vecka|veckor|månad|månader|år)$/.exec(s); if (!m) return null;
    const n = /^\d+$/.test(m[1]) ? +m[1] : 1, f = /^dag/.test(m[2]) ? 1 : /^veck/.test(m[2]) ? 7 : /^mån/.test(m[2]) ? 30 : 365;
    return dag(new Date(Date.now() - n * f * 864e5));
  }
  const tagg = (o, re) => [o.primaryStatus, o.secondaryStatus, ...(o.labels || []), ...(o.statuses || [])].some(l => l && re.test(`${l.key || ''} ${l.label || ''}`));

  // Ett sökkort (ListableProperty i Apollo-cachen) -> annons
  function franKort(c, st) {
    const dp = Object.fromEntries((c.displayAttributes?.dataPoints || []).map(d => [d.key, d.value?.plainText]));
    const del = String(c.subtitle || '').split(/\s*·\s*/); // "Lägenhet · Stäket · Järfälla"
    const am = new Set((c.amenities || []).map(a => (st[a.__ref] || a).key));
    const imgKey = Object.keys(c).find(k => /^images/.test(k));
    const vis = c.secondaryStatus?.key === 'showing' ? visning(c.secondaryStatus.label) : null;
    return {
      kalla: 'booli', kod: String(c.listingId), url: c.url ? BAS + c.url : null,
      adress: c.title, omrade: del.length >= 3 ? del[1] : null, kommun: c.tracking?.properties?.municipality || del[del.length - 1] || null,
      lat: c.position?.latitude, lon: c.position?.longitude,
      rum: num(dp.rooms), kvm: num(dp.livingArea), vaning: dp.floor ? dp.floor.replace(/^vån\s*/, '') : null,
      avgift: /kr\/mån/.test(dp.rentOrPlotAreaText || '') ? num(dp.rentOrPlotAreaText) : null, utrop: num(c.displayPrice),
      publicerad: dagarSedan(c.displayDate), visningar: vis ? [vis] : [],
      bilder: (imgKey ? c[imgKey] : []).map(r => bild((st[r.__ref] || r).id)).filter(Boolean).slice(0, 6),
      balkong: am.has('balcony') || undefined, uteplats: am.has('patio') || undefined, hiss: am.has('elevator') || undefined,
      budgivning: tagg(c, /bid(?!.*sold)|budgivning/i) && !/^sold/.test(c.primaryStatus?.key || ''),
      prisAndrad: /prisändr/i.test(c.priceRemark?.label || '') || undefined,
      kommande: c.primaryStatus?.key === 'upcomingSale' || undefined,
      typ: c.objectType, nyproduktion: c.saleType === 'newConstruction', maklare: c.presenter?.name,
    };
  }
  // Text i bostadssidans infoPoints ("Bostaden har **153** sidvisningar på Booli")
  const info = (o, key) => { for (const s of o.infoSections || []) for (const p of s.content?.infoPoints || []) if (p.key === key) return p.displayText?.markdown || ''; return null; };
  // En bostadssida (/bostad/<residenceId>) -> annons (eller { borta })
  function franDetalj(t, kod) {
    const L = allOf(t, 'Listing').filter(x => x.propertyType === 'active' || x.listPrice);
    const o = L.find(x => String(x.id) === String(kod)) || (kod == null ? L[0] : null);
    if (!o) {
      // Inte längre till salu (eller ny annons på samma bostad): såld om sidan har en SoldProperty för annonsen
      const S = allOf(t, 'SoldProperty').filter(x => x.soldPrice || x.propertyType);
      const s = S.find(x => String(x.id) === String(kod)) || S.find(x => x.soldPrice && x.propertyType === 'sold');
      const sald = !!(s && s.soldPrice && (String(s.id) === String(kod) || !L.length));
      const dm = s && (info(s, 'soldDate') || JSON.stringify(s.infoSections || '')).match(/\d{4}-\d\d-\d\d/);
      return { borta: { kalla: 'booli', kod: String(kod), status: sald ? 'sald' : 'borttagen', slutpris: sald ? s.soldPrice?.raw ?? null : null, datum: sald && dm ? dm[0] : null } };
    }
    const am = new Set((o.amenities || []).map(a => a.key));
    const fl = o.floor?.raw;
    const vy = num((info(o, 'pageviews') || '').replace(/\*/g, ''));
    return {
      kalla: 'booli', kod: String(o.id), url: o.url ? BAS + o.url : null, adress: o.streetAddress,
      omrade: o.descriptiveAreaName || o.location?.namedAreas?.[0], kommun: o.location?.region?.municipalityName || o.primaryArea?.name,
      lat: o.latitude, lon: o.longitude, rum: o.rooms?.raw ?? num(o.rooms?.value), kvm: o.livingArea?.raw ?? num(o.livingArea?.value),
      biarea: o.additionalArea?.raw ?? num(o.additionalArea?.value),
      vaning: fl != null ? (o.buildingFloors ? `${fl} av ${o.buildingFloors}` : String(fl)) : null,
      hiss: am.has('elevator') || undefined, balkong: am.has('balcony') || undefined, uteplats: am.has('patio') || undefined,
      avgift: o.rent?.raw, drift: o.operatingCost?.raw, utrop: o.listPrice?.raw, byggar: o.constructionYear || null,
      brf: (o.breadcrumbs || []).map(b => b.label).find(l => /^brf|bostadsrättsförening/i.test(l || '')),
      publicerad: o.published ? String(o.published).slice(0, 10) : null,
      visningar: (o.showingsV2 || []).map(v => v.startTime).filter(Boolean),
      bilder: (o.images || []).map(i => bild(i.id)).filter(Boolean).slice(0, 8),
      beskrivning: null,
      budgivning: !!o.biddingOpen || tagg(o, /bid(?!.*sold)|budgivning/i),
      prisAndrad: o.listPriceChange ? true : undefined, prisAndring: o.listPriceChange?.raw ?? o.listPriceChange?.value ?? undefined,
      visad: vy, typ: o.objectType, upplatelse: o.tenureForm, nyproduktion: !!o.isNewConstruction, maklare: o.agency?.name,
      maklarUrl: o.listingUrl, bostadId: o.residenceId, detaljHamtad: new Date().toISOString().slice(0, 10),
    };
  }

  function sorterad(url) {
    const u = new URL(url, BAS); u.searchParams.set('sort', 'published'); u.searchParams.delete('ascending'); return u;
  }
  function kandidat(a, F) {
    if (a.rum != null && a.rum < (F.minRum || 2)) return false;
    if (a.utrop && a.utrop > F.maxUtrop) return false;
    if (a.lat != null && F.mal && km([a.lat, a.lon], F.mal) > (F.maxKm || 22)) return false;
    const txt = norm(`${a.omrade} , ${a.adress} , ${a.kommun}`);
    if ((F.uteslutna || []).some(o => new RegExp(`(^|[^a-z0-9])${norm(o)}${o.length <= 4 ? '($|[^a-z0-9])' : ''}`).test(txt))) return false;
    return true;
  }
  // Huvudlistan på en söksida (inte nyproduktionskarusellen, inte projekt eller slutpriser)
  function kortPaSidan(st) {
    const rq = st?.ROOT_QUERY || {};
    const k = Object.keys(rq).find(x => /^searchForSaleV2\(/.test(x) && !/forceNewConstruction/.test(x)); if (!k) return null;
    const ik = Object.keys(rq[k] || {}).find(x => /^items/.test(x));
    return (rq[k][ik] || []).map(r => st[r.__ref] || r).filter(c => c?.listingId && c.saleType !== 'project' && c.saleType !== 'sold');
  }

  window.bKor = async function (plan, { maxDetaljer = 40, download = true } = {}) {
    if (!/booli\.se$/.test(location.hostname)) throw new Error('Kör skriptet på en sida på www.booli.se');
    const F = plan.filter || {}, kanda = new Set(plan.kanda || []), res = { annonser: [], borta: [], kallorLasta: [], logg: [] };
    const fynd = new Map(), log = s => { res.logg.push(s); console.log('[booli]', s); };
    window.__boende = res;
    let stopp = false;
    // 1. Sökningen
    for (const s of plan.sok || []) {
      if (stopp) break;
      const u = sorterad(s.url); let slut = false, sidor = 0, kort = 0, sista = 0;
      for (let p = s.fran || 1; p <= (s.till || 3); p++) {
        u.searchParams.set('page', p);
        let html; try { ({ html } = await hamta(u.toString())); } catch (e) { log(e.message); stopp = true; break; }
        sidor++; sista = p;
        const st = apollo(chunks(html)), cards = kortPaSidan(st);
        if (cards == null) { log(`sida ${p}: hittar ingen sökdata – avbryter sökningen`); break; }
        if (!cards.length) { slut = true; break; }
        let nyaHar = 0;
        for (const c of cards) { const a = franKort(c, st); kort++; if (!kanda.has(a.kod)) nyaHar++; if (kandidat(a, F) && !fynd.has(a.kod)) fynd.set(a.kod, a); }
        // Nyast först: en sida med nästan bara kända annonser betyder att vi kommit ikapp (gäller inte den stegvisa genomsökningen)
        if (!s.djup && p > 1 && nyaHar <= 2) break;
        await pause(3000, 6000);
      }
      res.kallorLasta.push({ kalla: s.kalla || 'booli', ...(s.djup ? { djupTill: sista, svept: slut } : {}) });
      log(`sökning ${s.fran || 1}–${sista}: ${sidor} sidor, ${kort} kort, ${fynd.size} kandidater${slut ? ' (hela sökningen läst)' : ''}`);
    }
    // 2. Bostadssidor för nya kandidater
    let n = 0;
    for (const a of fynd.values()) {
      if (stopp || kanda.has(a.kod) || !a.url || n >= maxDetaljer) { res.annonser.push(a); continue; }
      await pause(3000, 6000); n++;
      try { const { html, status } = await hamta(a.url); const d = status === 404 ? { borta: { kalla: 'booli', kod: a.kod, status: 'borttagen' } } : franDetalj(chunks(html), a.kod); d.borta ? res.borta.push(d.borta) : res.annonser.push({ ...a, ...strip(d) }); }
      catch (e) { log(`${a.kod}: ${e.message}`); if (/spärr/.test(e.message)) stopp = true; res.annonser.push(a); }
    }
    // 3. Kända annonser att kolla (pris, budgivning, visningar, såld)
    let k = 0;
    for (const x of stopp ? [] : plan.kolla || []) {
      if (fynd.has(x.kod) && res.annonser.some(a => a.kod === x.kod && a.detaljHamtad)) continue;
      await pause(3000, 6000);
      try { const { html, status } = await hamta(x.url); const d = status === 404 ? { borta: { kalla: 'booli', kod: x.kod, status: 'borttagen' } } : franDetalj(chunks(html), x.kod); d.borta ? res.borta.push(d.borta) : res.annonser.push(strip(d)); k++; }
      catch (e) { log(`${x.kod}: ${e.message}`); if (/spärr/.test(e.message)) break; }
    }
    log(`detaljer: ${n} nya, ${k} kollade, ${res.borta.length} sålda/borttagna`);
    res.annonser = res.annonser.map(strip);
    res.klar = new Date().toISOString();
    if (download) {
      const ts = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }).replace(/[-: ]/g, '').slice(0, 12).replace(/^(\d{8})/, '$1-');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(res, null, 1)], { type: 'application/json' }));
      a.download = `boende-booli-${ts}.json`; document.body.appendChild(a); a.click(); a.remove();
    }
    return { annonser: res.annonser.length, borta: res.borta.length, logg: res.logg };
  };
  const strip = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  window.bTest = { chunks, apollo, allOf, kortPaSidan, franKort, franDetalj, visning, dagarSedan, bild };
})();
