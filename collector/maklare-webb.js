// Mäklare i webbläsaren – Notar, Länsförsäkringar Fastighetsförmedling och Mäklarhuset för fliken Boende. De tre gick inte
// att läsa från node (boende/maklare.mjs), så skriptet körs i en flik på mäklarens egen sajt (Claude in Chrome eller konsolen).
// En flik per sajt; skriptet väljer mäklare utifrån location.hostname. Klistra in hela filen och kör:
//
//   PRIS_KOD=... node boende/merge.mjs --plan maklare    (skriver ut { kanda: ["notar-OBJ...", "lansfast-OBJ...", ...] })
//   mwKor(PLAN)                                          PLAN = den utskrivna JSON:en. Tar några minuter: kör den utan await
//                                                        och kolla window.__maklareWebb.klar / .logg tills den är klar.
//   mwKor(PLAN, { bara: ['notar', 'lansfast'], maxDetaljer: 40, download: true, sidor: 40 })
//
// Startsidor (en flik per sajt):
//   Notar:            https://www.notar.se/kopa-bostad
//   Länsförsäkringar: https://www.lansfast.se/till-salu/
//   Mäklarhuset:      https://www.maklarhuset.se/bostad/sverige/stockholms-lan
//
// Skriptet bara läser: ingen inloggning, inga formulär, inga bevakningar eller intresseanmälningar, ingen kontakt med mäklare,
// inga cookies godkänns. 3–6 sekunders paus mellan sidorna/anropen; avbryter vid spärr eller kontroll. Resultatet sparas som
// boende-<mäklare>-ÅÅÅÅMMDD-HHMM.json i Hämtade filer (flytta den till inbox\) och finns i window.__maklareWebb:
// { annonser, borta: [], kallorLasta: [{ kalla }], logg, klar }.
//
// Hur respektive sajt läses (robots.txt kontrollerad 2026-11-28):
//  * Notar (robots.txt: Allow /). Listan hämtas av sidans egen JS från data.notar.se med ett inbäddat inloggningshuvud – det
//    används INTE. I stället laddar skriptet sidans egen söksida (/kopa-bostad?type=HousingCooperative&areaId=01&...) i en
//    dold iframe på samma sajt, låter sidan själv hämta och rita korten, läser korten ur DOM och bläddrar genom att klicka på
//    sidans egen "nästa sida"-pil (och fliken "Kommande" för kommande försäljningar). Koordinater, avgift, våning, hiss,
//    balkong och text från bostadssidan /kopa-bostad/objekt/<id> (serverrenderad __NUXT_DATA__), högst maxDetaljer per körning.
//  * Länsförsäkringar (robots.txt på www förbjuder bara /umbraco/ utom delivery-API:t; API-värden app-lansfast-api.azurewebsites.net
//    har ingen robots.txt). Läser samma öppna anrop som sidan /till-salu/ själv gör, utan nyckel: /api/Estates/GetForFilter
//    (18 per sida, senast inkomna först, med koordinater, avgift, pris, status "Försprång" = kommande) och /api/Estates/GetForFilterMap
//    (alla träffars id och koordinater i ett anrop, så att kända annonser räknas som sedda). Text, våning, hiss och balkong från
//    /api/Estates/GetEstate (samma anrop som bostadssidan) för nya kandidater.
//  * Mäklarhuset (robots.txt: Disallow /*? och /objekt/; /bostad/sverige/... tillåtet). Bara adresser utan "?": listsidorna
//    /bostad/sverige/stockholms-lan/<kommun>-kommun och /kommande/bostad/sverige/stockholms-lan/<kommun>-kommun (de 23 senast
//    inlagda per sida, alla bostadstyper; fler sidor nås bara med ?page=, som är förbjudet) och bostadssidan
//    /bostad/sverige/<län>/<ort>/<gata>/<nr> (ld+json: koordinater, rum, kvm, våning, text; faktarutan: avgift, hiss).
//    Eftersom bara de nyaste syns skickas ingen kallorLasta för Mäklarhuset (annars skulle merge tro att äldre annonser
//    försvunnit). Kända annonser i planens "kolla" ({ kalla: 'maklarhuset', kod, url }) kollas på bostadssidan (404 = borttagen).
// Fastighetsbyrån läses inte (förbjudet i robots.txt och villkoren).
(function () {
  const pause = (a, b) => new Promise(r => setTimeout(r, a + Math.random() * (b - a)));
  const vanta = ms => new Promise(r => setTimeout(r, ms));
  const SPARR = /Just a moment|Attention Required|captcha|Verify you are human|verifiera att du är en människa|cf-challenge|Access denied|Too Many Requests/i;
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const RAD = Math.PI / 180;
  const km = (a, b) => { const dLat = (b[0] - a[0]) * RAD, dLon = (b[1] - a[1]) * RAD; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2; return 6371 * 2 * Math.asin(Math.sqrt(h)); };
  const heltal = s => { if (s == null) return null; if (typeof s === 'number') return s; const d = String(s).replace(/[^\d]/g, ''); return d ? +d : null; };
  const tal = s => { if (s == null) return null; if (typeof s === 'number') return s; const m = String(s).replace(/\s| /g, '').match(/\d+(?:[.,]\d+)?/); return m ? +m[0].replace(',', '.') : null; };
  const rensa = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length) && !Number.isNaN(v)));
  const dag = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const titel = s => s ? String(s).toLowerCase().replace(/(^|[\s-])\p{L}/gu, c => c.toUpperCase()) : s;
  const ja = v => v === true || /^(yes|ja|true|finns)$/i.test(String(v ?? ''));
  // "2026-12-06 11:30:00" (svensk lokal tid) -> ISO
  const lokalIso = s => { if (!s) return null; const d = new Date(String(s).replace(' ', 'T')); return Number.isNaN(+d) ? null : d.toISOString(); };
  const STD = { maxUtrop: 4000000, minRum: 2, maxKm: 22, mal: [59.353499, 17.974382] };
  // Kommuner långt från Solna strand (förfilter när listan saknar koordinater)
  const LANGT = /^(norrtalje|nynashamn|sodertalje|nykvarn|sigtuna|knivsta|uppsala|enkoping|strangnas|habo|vaddo|grisslehamn|rimbo|hallstavik|marsta|gnesta|trosa)/;

  function kandidat(a, F) {
    if (a.rum != null && a.rum < (F.minRum || 2)) return false;
    if (a.utrop && a.utrop > F.maxUtrop) return false;
    if (a.lat != null && a.lon != null && F.mal && km([+a.lat, +a.lon], F.mal) > (F.maxKm || 22)) return false;
    if (a.lat == null && LANGT.test(norm(a.kommun).replace(/\s+/g, '-'))) return false;
    const txt = norm(`${a.omrade} , ${a.adress} , ${a.kommun}`);
    if ((F.uteslutna || []).some(o => new RegExp(`(^|[^a-z0-9])${norm(o).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${o.length <= 4 ? '($|[^a-z0-9])' : ''}`).test(txt))) return false;
    return true;
  }
  // Treor, stora tvåor och kommande först, så att de bästa får detaljer om taket nås
  const vikt = a => (a.kommande ? 4 : 0) + (a.rum >= 3 ? 2 : 0) + (a.kvm >= 55 ? 1 : 0);

  async function hamta(url, typ = 'text') {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (r.status === 403 || r.status === 429 || r.status === 503) throw new Error(`spärr (${r.status}) på ${new URL(url).host} – avbryter`);
    if (r.status === 404 || r.status === 410) return { status: r.status, url: r.url, data: null };
    if (!r.ok) throw new Error(`${new URL(url).host} svarade ${r.status}`);
    if (typ === 'json') return { status: r.status, url: r.url, data: await r.json() };
    const html = await r.text();
    if (SPARR.test(html.slice(0, 5000)) && !/<meta[^>]+og:/i.test(html.slice(0, 20000))) throw new Error(`spärr eller kontroll på ${new URL(url).host} – avbryter`);
    return { status: r.status, url: r.url, data: html };
  }

  // ---------------- Notar ----------------
  // Nuxt-sidans serverrenderade data (devalue-format): en platt array där objekt pekar på index
  function nuxtData(html) {
    const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/); if (!m) return null;
    let arr; try { arr = JSON.parse(m[1]); } catch (e) { return null; }
    const memo = new Map(), OMSLAG = new Set(['Reactive', 'ShallowReactive', 'Ref', 'ShallowRef', 'EmptyRef', 'EmptyShallowRef']);
    function h(i) {
      if (typeof i !== 'number') return i;
      if (i < 0) return i === -3 ? NaN : undefined;
      if (memo.has(i)) return memo.get(i);
      const v = arr[i];
      if (v === null || typeof v !== 'object') { memo.set(i, v); return v; }
      if (Array.isArray(v)) {
        if (typeof v[0] === 'string' && OMSLAG.has(v[0])) { const r = h(v[1]); memo.set(i, r); return r; }
        if (v[0] === 'Date') { memo.set(i, v[1]); return v[1]; }
        if (typeof v[0] === 'string' && /^(Set|Map|null|undefined|RegExp|BigInt|NuxtError|Island)$/.test(v[0])) { memo.set(i, null); return null; }
        const out = []; memo.set(i, out); for (const x of v) out.push(h(x)); return out;
      }
      const o = {}; memo.set(i, o); for (const [k, x] of Object.entries(v)) o[k] = h(x); return o;
    }
    try { return h(0); } catch (e) { return null; }
  }
  // Ett kort i Notars lista (DOM) -> annons
  function notarKort(a, kommande) {
    const href = a.getAttribute('href') || ''; const kod = (href.match(/\/objekt\/([A-Za-z0-9]+)/) || [])[1]; if (!kod) return null;
    const sub = [...a.querySelectorAll('.v-card-subtitle span')].map(s => s.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const status = sub[0] || '';
    const kommunTxt = sub.find(s => / kommun$/i.test(s));
    const li = [...a.querySelectorAll('li')].map(s => s.textContent.replace(/\s+/g, ' ').trim());
    const pris = heltal(a.querySelector('.price span')?.textContent);
    const vis = [...a.querySelectorAll('.tags div')].map(d => d.textContent.trim()).find(t => /^Visning/i.test(t));
    return rensa({
      kalla: 'notar', kod, url: 'https://www.notar.se' + href, adress: a.querySelector('.v-card-title')?.textContent.trim(),
      omrade: sub.find((s, i) => i > 0 && s !== kommunTxt), kommun: kommunTxt ? kommunTxt.replace(/ kommun$/i, '') : null,
      rum: tal(li.find(s => /rok|rum/i.test(s))), kvm: tal(li.find(s => /kvm/.test(s) && !/tomt/i.test(s))),
      avgift: heltal(li.find(s => /kr\/mån/.test(s))), utrop: pris || null, typ: 'Lägenhet', upplatelse: 'Bostadsrätt', maklare: 'Notar',
      maklarStatus: status || null, visningText: vis || null,
      kommande: (kommande || /kommande/i.test(status) || !pris) || undefined,
    });
  }
  // Bostadssidan /kopa-bostad/objekt/<id> -> detaljer (eller { borta })
  function notarDetalj(html, kod) {
    const d = nuxtData(html), o = d?.data?.[`object-${kod}`];
    if (!o) return null;
    if (/^såld/i.test(o.assignmentStatus || '')) return { borta: { kalla: 'notar', kod, status: 'sald', slutpris: o.price?.finalPrice || null, datum: null } };
    const r = o.residence || {}, as = o.association || {}, b = as.building || {}, fl = r.floors || {};
    const bild = f => f && o.customerId ? `https://notar-media.b-cdn.net/objects/${o.id || kod}/images/${o.customerId}/JPG/1920/${String(f).replace(/\.\w+$/, '')}.webp` : null;
    const ds = o.descriptions || {};
    const besk = [ds.heading || ds.title, ds.long || ds.short].filter(Boolean).join('\n\n');
    return rensa({
      lat: o.latitude != null ? +o.latitude : null, lon: o.longitude != null ? +o.longitude : null,
      adress: o.address, omrade: o.area || r.area, kommun: o.municipality || r.municipality,
      rum: o.numberOfRooms ?? r.numberOfRooms, kvm: o.livingSpaceArea ?? r.livingSpaceArea?.livingSpaceArea,
      avgift: r.monthlyFee?.monthlyFee || null, utrop: o.objectSettings?.showPrice === false ? null : (o.price?.startingPrice || null),
      vaning: fl.floor != null ? (fl.totalNumberOfFloors ? `${fl.floor} av ${fl.totalNumberOfFloors}` : String(fl.floor)) : null,
      hiss: b.elevator != null ? ja(b.elevator) : undefined, balkong: r.balconyPatio?.balcony != null ? !!r.balconyPatio.balcony : undefined,
      uteplats: r.balconyPatio?.patio || undefined, byggar: +b.buildingYear || null, brf: as.name || null,
      energiklass: r.energyDeclaration?.class || null,
      visningar: (o.viewings || []).map(v => lokalIso(v.start)).filter(Boolean),
      bilder: (o.images || []).filter(i => !/planlösning/i.test(i.category || '')).sort((x, y) => (x.order || 0) - (y.order || 0)).map(i => bild(i.file)).filter(Boolean).slice(0, 8),
      beskrivning: besk ? besk.replace(/\r/g, '').slice(0, 6000) : null,
      kommande: (o.assignmentStatus === 'Kommande' || o.objectSettings?.showAsComing || o.objectSettings?.showAsSoonForSale) || undefined,
      maklarStatus: o.assignmentStatus, detaljHamtad: dag(Date.now()),
    });
  }
  // Laddar sidans egen söksida i en dold iframe och väntar på att sidan själv ritat korten
  function notarRam(url) {
    return new Promise((klar, fel) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-3000px;top:0;width:1280px;height:2400px;border:0;visibility:hidden';
      const t = setTimeout(() => fel(new Error('söksidan laddades inte (timeout)')), 45000);
      f.onload = () => { clearTimeout(t); klar(f); };
      f.src = url; document.body.appendChild(f);
    });
  }
  const notarKortI = doc => [...doc.querySelectorAll('a.v-card[href*="/kopa-bostad/objekt/"]')];
  // Väntar tills listan ritats om (första kortet byts eller sidan säger att den är tom)
  async function notarVanta(doc, forra, maxMs = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      await vanta(500);
      if (SPARR.test(doc.title || '') || SPARR.test((doc.body?.innerText || '').slice(0, 3000))) throw new Error('Notar visar en spärr eller kontroll – avbryter');
      const k = notarKortI(doc), forst = k[0]?.getAttribute('href') || null;
      if (k.length && forst !== forra) { await vanta(800); return notarKortI(doc); }
      if (!k.length && /Visar 0 objekt|Inga objekt|hittade inga/i.test(doc.body?.innerText || '') && Date.now() - t0 > 3000) return [];
    }
    return null;
  }
  async function notar(plan, o, ctx) {
    const F = ctx.F, bas = 'https://www.notar.se/kopa-bostad?sortBy=date&sortOrder=desc&type=HousingCooperative&areaId=01&numberOfRoomsMin=2';
    const fynd = new Map(); let sidor = 0, kort = 0, helt = true;
    // Till salu med prisgräns; kommande (saknar ofta pris) utan prisgräns, via sidans flik "Kommande"
    for (const [url, kom] of [[`${bas}&priceMax=${F.maxUtrop}`, false], [bas, true]]) {
      if (ctx.stopp) break;
      let ram;
      try {
        ram = await notarRam(url); const doc = ram.contentDocument;
        let k = await notarVanta(doc, null);
        if (k == null) { ctx.log(`${kom ? 'kommande' : 'till salu'}: hittar inga kort på söksidan`); helt = false; continue; }
        if (kom) {
          const flik = [...doc.querySelectorAll('button.v-btn')].find(b => b.textContent.trim() === 'Kommande');
          if (!flik) { ctx.log('hittar inte fliken Kommande'); helt = false; continue; }
          await pause(3000, 6000);
          const forra = k[0]?.getAttribute('href'); flik.click();
          k = await notarVanta(doc, forra);
          if (k == null) { ctx.log('kommande: listan ritades inte om'); helt = false; continue; }
        }
        const total = +((doc.body.innerText.match(/Visar (\d+) objekt/) || [])[1] || 0);
        for (let p = 1; p <= ctx.sidor; p++) {
          sidor++;
          for (const a of k) { const x = notarKort(a, kom); if (!x) continue; kort++; if (kandidat(x, F) && !fynd.has(x.kod)) fynd.set(x.kod, x); }
          // Sidans egen "nästa sida"-pil (den högra i pagineringen)
          const pilar = [...doc.querySelectorAll('.pagination-dots .pagination-side')];
          const nasta = pilar[pilar.length - 1]?.querySelector('.pagination-arrow');
          if (!nasta || nasta.classList.contains('disabled') || pilar.length < 2) break;
          if (p === ctx.sidor) { helt = false; ctx.log(`${kom ? 'kommande' : 'till salu'}: taket ${ctx.sidor} sidor nått`); break; }
          await pause(3000, 6000);
          const forra = k[0]?.getAttribute('href'); nasta.click();
          k = await notarVanta(doc, forra);
          if (k == null) { ctx.log(`${kom ? 'kommande' : 'till salu'} sida ${p + 1}: listan ritades inte om – slutar`); helt = false; break; }
          if (!k.length) break;
        }
        ctx.log(`${kom ? 'kommande' : 'till salu'}: ${total || '?'} träffar enligt sidan, ${sidor} sidor lästa hittills, ${fynd.size} kandidater`);
      } catch (e) { ctx.log(e.message); helt = false; if (/spärr/.test(e.message)) ctx.stopp = true; }
      finally { ram?.remove(); }
      await pause(3000, 6000);
    }
    // Bostadssidor för nya kandidater (koordinater m.m.); kända skickas med listdatan
    const ut = [], ordning = [...fynd.values()].sort((x, y) => vikt(y) - vikt(x));
    let n = 0, vantar = 0;
    for (const a of ordning) {
      if (ctx.kand(a)) { ut.push(a); continue; }
      if (ctx.stopp || n >= ctx.maxDetaljer) { vantar++; continue; }
      await pause(3000, 6000); n++;
      try {
        const { data: html, status } = await hamta(a.url);
        if (status === 404 || !html) { ctx.res.borta.push({ kalla: 'notar', kod: a.kod, status: 'borttagen' }); continue; }
        const d = notarDetalj(html, a.kod);
        if (!d) { ctx.log(`notar-${a.kod}: hittar ingen objektdata på bostadssidan`); continue; }
        if (d.borta) { ctx.res.borta.push(d.borta); continue; }
        const x = { ...a, ...d }; delete x.visningText;
        if (kandidat(x, F)) ut.push(x);
      } catch (e) { ctx.log(`notar-${a.kod}: ${e.message}`); if (/spärr/.test(e.message)) ctx.stopp = true; }
    }
    if (vantar) ctx.log(`${vantar} nya kandidater väntar på bostadssidan (koordinater) – tas nästa körning`);
    ctx.log(`detaljer: ${n} bostadssidor`);
    return { annonser: ut.filter(a => a.lat != null || ctx.kand(a)).map(a => { const { visningText, ...r } = a; return r; }), sidor, kort, helt };
  }

  // ---------------- Länsförsäkringar ----------------
  const LF_API = 'https://app-lansfast-api.azurewebsites.net/api/Estates/';
  const lfQuery = (o = {}) => new URLSearchParams({ county: 'Stockholm', estateType: 'Bostadsrätt', showSold: 'false', showOnlyHeadStart: 'false', showDiscreet: 'false', ...o }).toString();
  function lfKort(e) {
    const st = e.status || '';
    const vis = [e.nextViewing, e.nextNextViewing].filter(Boolean).map(v => new Date(v).toISOString());
    return rensa({
      kalla: 'lansfast', kod: e.id, url: e.url ? 'https://www.lansfast.se' + e.url : null, adress: e.streetAddress, omrade: e.area,
      kommun: e.municipality, lat: e.coordinates?.latitud, lon: e.coordinates?.longitud, rum: e.numberOfRooms || null, kvm: e.livingspace || null,
      biarea: e.otherSpace || null, avgift: e.monthlyCost || null, utrop: e.startPrice || null, publicerad: e.publishDate ? dag(e.publishDate) : null,
      visningar: vis, bilder: e.headerImage ? [e.headerImage] : [], budgivning: e.hasBids || undefined, energiklass: e.energyClass || null,
      typ: e.propertyType === 'Lägenhet' || e.estateType === 'Bostadsrätt' ? 'Lägenhet' : e.propertyType, upplatelse: 'Bostadsrätt',
      maklare: 'Länsförsäkringar Fastighetsförmedling', maklarStatus: st || null,
      kommande: (/försprång|kommande/i.test(st) || !e.startPrice) || undefined, nyproduktion: e.isProjectEstate || undefined,
    });
  }
  function lfDetalj(j) {
    const bi = j.buildingInfo || {}, ai = j.associationInfo || {}, bp = j.balconyPatio || {}, ad = j.addressInfo || {};
    const besk = [j.descriptions?.sellingHeading, j.descriptions?.longSellingDescription].filter(Boolean).join('\n\n');
    const vis = (j.viewings || []).flatMap(v => (v.timeSlots || []).map(t => t.startsAt).filter(Boolean).length ? v.timeSlots.map(t => t.startsAt) : [v.startTime]).filter(Boolean).map(s => lokalIso(s));
    return rensa({
      lat: ad.latitude != null ? +ad.latitude : null, lon: ad.longitude != null ? +ad.longitude : null,
      vaning: bi.floor != null && bi.floor !== '' ? (bi.totalNumberOfFloors ? `${bi.floor} av ${bi.totalNumberOfFloors}` : String(bi.floor)) : null,
      hiss: bi.elevator != null ? ja(bi.elevator) : undefined, balkong: bp.balcony != null ? !!bp.balcony : undefined, uteplats: bp.patio || undefined,
      avgift: +j.operation?.monthlyFee || null, byggar: +(bi.buildingYear || ai.buildingYear) || null, brf: ai.name || null,
      energiklass: j.energyDeclaration?.energyClass || null, visningar: vis.filter(Boolean),
      bilder: (j.images || []).map(i => i.path).filter(Boolean).slice(0, 8),
      beskrivning: besk ? besk.replace(/\r/g, '').slice(0, 6000) : null, rubrik: j.descriptions?.sellingHeading,
      publicerad: j.dates?.publishedDate ? dag(j.dates.publishedDate) : null, detaljHamtad: dag(Date.now()),
    });
  }
  async function lansfast(plan, o, ctx) {
    const F = ctx.F, fynd = new Map(); let sidor = 0, kort = 0, helt = true, total = null;
    // 1. Listan senast inkomna först (sortOrder=1), bostadsrätter i Stockholms län, minst 2 rum, högst maxUtrop (kommande utan
    //    pris ingår). Slutar när en sida nästan bara har kända annonser (kommit ikapp), om inte { allaSidor: true }.
    for (let p = 1; p <= ctx.sidor; p++) {
      if (ctx.stopp) break;
      let j;
      try { ({ data: j } = await hamta(LF_API + 'GetForFilter?' + lfQuery({ page: p, priceMax: F.maxUtrop, roomsMin: F.minRum || 2, sortOrder: 1 }), 'json')); }
      catch (e) { ctx.log(e.message); helt = false; if (/spärr/.test(e.message)) ctx.stopp = true; break; }
      sidor++; total = j?.totalLength ?? total;
      const es = j?.estates || []; if (!es.length) break;
      let nya = 0;
      for (const e of es) { kort++; const a = lfKort(e); if (!ctx.kand(a)) nya++; if (kandidat(a, F) && !fynd.has(a.kod)) fynd.set(a.kod, a); }
      if (p * 18 >= (total || 0)) break;
      if (!o.allaSidor && p > 1 && nya <= 2) { helt = false; break; }
      if (p === ctx.sidor) { helt = false; ctx.log(`taket ${ctx.sidor} sidor nått (${total} träffar)`); }
      await pause(3000, 6000);
    }
    ctx.log(`listan: ${sidor} sidor, ${kort} poster av ${total ?? '?'}, ${fynd.size} kandidater nära`);
    // 2. Kartan: alla träffars id + koordinater, så att kända annonser som inte syntes i listan räknas som sedda
    let karta = null;
    if (!ctx.stopp) {
      await pause(3000, 6000);
      try { ({ data: karta } = await hamta(LF_API + 'GetForFilterMap?' + lfQuery({ priceMax: F.maxUtrop, roomsMin: F.minRum || 2 }), 'json')); }
      catch (e) { ctx.log(`kartan: ${e.message}`); if (/spärr/.test(e.message)) ctx.stopp = true; }
    }
    const ut = [];
    if (karta?.estates) {
      let sedda = 0;
      for (const e of karta.estates) {
        const a = { kalla: 'lansfast', kod: e.id, lat: e.coordinates?.latitud, lon: e.coordinates?.longitud };
        if (!fynd.has(e.id) && ctx.kand(a)) { ut.push(rensa(a)); sedda++; }
      }
      ctx.log(`kartan: ${karta.estates.length} träffar, ${sedda} kända utanför de lästa listsidorna markeras som sedda`);
    } else helt = false;
    // 3. Detaljer (GetEstate) för nya kandidater
    let n = 0, ej = 0;
    for (const a of [...fynd.values()].sort((x, y) => vikt(y) - vikt(x))) {
      if (ctx.kand(a) || ctx.stopp || n >= ctx.maxDetaljer) { if (!ctx.kand(a) && !ctx.stopp && n >= ctx.maxDetaljer) ej++; ut.push(a); continue; }
      await pause(3000, 6000); n++;
      try {
        const { data: j, status } = await hamta(LF_API + 'GetEstate?' + new URLSearchParams({ estateId: a.kod.toLowerCase(), intake: 'false', valuation: 'false', isDiscreet: 'false', estateType: 'Bostadsrätt' }), 'json');
        ut.push(status === 404 || !j ? a : { ...a, ...lfDetalj(j), lat: a.lat ?? j.addressInfo?.latitude, lon: a.lon ?? j.addressInfo?.longitude });
      } catch (e) { ctx.log(`lansfast-${a.kod}: ${e.message}`); if (/spärr/.test(e.message)) ctx.stopp = true; ut.push(a); }
    }
    if (ej) ctx.log(`${ej} nya kandidater fick ingen detaljhämtning (taket ${ctx.maxDetaljer}); de har ändå koordinater från listan`);
    ctx.log(`detaljer: ${n} anrop`);
    // Kartan täcker alla träffar: källan räknas som läst om kartan kom fram
    return { annonser: ut.filter(a => a.lat != null || ctx.kand(a)), sidor: sidor + (karta ? 1 : 0) + n, kort, helt: !!karta?.estates };
  }

  // ---------------- Mäklarhuset ----------------
  // Bara adresser som robots.txt tillåter: inga "?" och inte /objekt/, /object/ m.fl.
  const MH_FORBJUDET = /^\/(min-sida|fel|content|customer|default|development|error|humanresources|object|objekt|site)(\/|$)/i;
  function mhTillaten(url) {
    const u = new URL(url, location.origin);
    if (u.host !== 'www.maklarhuset.se' || u.search || url.includes('?')) return false;
    if (MH_FORBJUDET.test(u.pathname) || /^\/bostad(\/sverige)?$/.test(u.pathname)) return false;
    return true;
  }
  async function mhHamta(url) { if (!mhTillaten(url)) throw new Error(`robots.txt förbjuder ${url}`); return hamta(url); }
  // Kommuner i Stockholms län inom ungefär 22 km från Solna strand (sidorna visar även bostäder i grannkommunerna)
  const MH_KOMMUNER = ['stockholm', 'solna', 'sundbyberg', 'danderyd', 'lidingo', 'sollentuna', 'jarfalla', 'taby', 'upplands-vasby',
    'nacka', 'huddinge', 'ekero', 'botkyrka', 'tyreso', 'vallentuna', 'salem', 'upplands-bro', 'osteraker', 'vaxholm', 'varmdo'];
  function mhKort(el, kommande) {
    const a = el.querySelector('a.mh-card[href]') || el.querySelector('a[href*="/bostad/sverige/"]'); if (!a) return null;
    const href = a.getAttribute('href'), kod = (href.match(/\/(\d+)\/?$/) || [])[1]; if (!kod) return null;
    const txt = e => (e?.textContent || '').replace(/\s+/g, ' ').trim();
    // Kortet: <small>Solna</small><small> — Haga Norra</small>, .mh-card-title-small = gata, .mh-card-subtitle-small = "3 Rum", "80,6 kvm", "Lägenhet"
    const hdr = [...el.querySelectorAll('.mh-card-header-title small')].map(txt);
    const kommunDel = hdr[0] || null, omradeDel = (hdr[1] || '').replace(/^[—–-]\s*/, '') || null;
    const L = [...el.querySelectorAll('.mh-card-subtitle-small span, .mh-card-subtitle-small div')].map(txt).filter(Boolean);
    const allt = [...el.querySelectorAll('div,span,small,p')].filter(e => !e.children.length).map(txt).filter(Boolean);
    const pris = heltal(allt.find(s => /\d\s*kr$/i.test(s) && !/kr\/mån/i.test(s)));
    const typ = L.find(s => /^(Lägenhet|Villa|Radhus|Fritidshus|Tomt|Gård|Parhus|Kedjehus|Övrigt)$/i.test(s));
    const badge = [...el.querySelectorAll('.uk-badge')].map(txt).filter(Boolean);
    const del = href.split('/'); // /bostad/sverige/<län>/<ort>/<gata>/<nr>
    return rensa({
      kalla: 'maklarhuset', kod, url: 'https://www.maklarhuset.se' + href, adress: txt(el.querySelector('.mh-card-title-small')) || null,
      omrade: omradeDel, kommun: kommunDel || titel(del[4]),
      rum: tal(L.find(s => /^\d+([.,]\d)?\s*rum$/i.test(s))), kvm: tal(L.find(s => /^\d+([.,]\d+)?(\s*\+\s*\d+)?\s*kvm$/i.test(s))),
      utrop: pris || null, typ: typ ? titel(typ) : null, maklare: 'Mäklarhuset', maklarStatus: badge.join(', ').toLowerCase() || null,
      budgivning: badge.some(b => /budgivning/i.test(b)) || undefined,
      // Många kort till salu visar inget pris (bara på bostadssidan), så pris saknas räknas inte som kommande här
      kommande: (kommande || badge.some(b => /kommande|förberedd/i.test(b))) || undefined, ortSlug: del[4],
    });
  }
  function mhDetalj(html) {
    const lds = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map(m => { try { return JSON.parse(m[1]); } catch (e) { return null; } }).filter(Boolean);
    const graf = lds.flatMap(x => x['@graph'] || [x]);
    const ap = graf.find(x => /Apartment|House|Residence|SingleFamilyResidence|Accommodation/.test([].concat(x['@type']).join(','))) || {};
    const of = graf.find(x => [].concat(x['@type']).includes('Offer')) || {};
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,noscript,nav,footer,header,form').forEach(e => e.remove());
    const L = (doc.body?.textContent || '').split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const efter = re => { const i = L.findIndex(s => re.test(s)); return i >= 0 ? L[i + 1] : null; };
    const avg = efter(/^Avgift$/i), van = efter(/^Våning$/i);
    const vm = (van || '').match(/(-?\d+(?:[.,]5)?)(?:\s*av\s*(\d+))?/);
    const vis = L.filter((s, i) => /^(Måndag|Tisdag|Onsdag|Torsdag|Fredag|Lördag|Söndag) \d{1,2} \w+/i.test(s) && /^\d{1,2}:\d\d/.test(L[i + 1] || ''))
      .map(s => { const i = L.indexOf(s), m = s.match(/(\d{1,2}) (\w+)/), t = (L[i + 1] || '').match(/^(\d{1,2}):(\d\d)/); const MON = { januari: 0, februari: 1, mars: 2, april: 3, maj: 4, juni: 5, juli: 6, augusti: 7, september: 8, oktober: 9, november: 10, december: 11 }; const mo = MON[(m?.[2] || '').toLowerCase()]; if (mo == null) return null; const nu = new Date(); let d = new Date(nu.getFullYear(), mo, +m[1], +t[1], +t[2]); if (d < nu - 30 * 864e5) d.setFullYear(d.getFullYear() + 1); return d.toISOString(); }).filter(Boolean);
    const besk = [ap.name, ap.description].filter(Boolean).join('\n\n');
    return rensa({
      lat: ap.geo?.latitude != null ? +ap.geo.latitude : null, lon: ap.geo?.longitude != null ? +ap.geo.longitude : null,
      adress: ap.address?.streetAddress, rum: ap.numberOfRooms ?? null, kvm: ap.floorSize?.value ?? null,
      vaning: vm ? (vm[2] ? `${vm[1]} av ${vm[2]}` : vm[1]) : (ap.floorLevel != null ? String(ap.floorLevel) : null),
      hiss: /hiss finns/i.test(van || '') ? true : /ingen hiss|hiss saknas|ej hiss/i.test(van || '') ? false : undefined,
      balkong: (ap.amenityFeature || []).some(f => /balkong/i.test(f.name || f)) || /balkong/i.test(ap.name || '') || undefined,
      avgift: avg && /kr/i.test(avg) ? heltal(avg.split(/kr/i)[0]) : null, utrop: of.price || null,
      publicerad: of.availabilityStarts || null, visningar: vis,
      bilder: [].concat(ap.image || []).filter(Boolean).slice(0, 8), beskrivning: besk ? besk.slice(0, 6000) : null, rubrik: ap.name,
      typ: /Apartment/.test([].concat(ap['@type']).join(',')) ? 'Lägenhet' : null, detaljHamtad: dag(Date.now()),
    });
  }
  async function maklarhuset(plan, o, ctx) {
    const F = ctx.F, fynd = new Map(), lasta = new Set(); let sidor = 0, kort = 0;
    const kommuner = o.kommuner || MH_KOMMUNER;
    const listor = [...kommuner.map(k => [`https://www.maklarhuset.se/kommande/bostad/sverige/stockholms-lan/${k}-kommun`, true]),
      ...kommuner.map(k => [`https://www.maklarhuset.se/bostad/sverige/stockholms-lan/${k}-kommun`, false])];
    for (const [url, kom] of listor) {
      if (ctx.stopp || sidor >= ctx.sidor) break;
      try {
        const { data: html, status, url: slut } = await mhHamta(url); sidor++;
        if (status === 404 || !html) { ctx.log(`${url}: finns inte`); await pause(3000, 6000); continue; }
        if (lasta.has(slut)) { await pause(3000, 6000); continue; } lasta.add(slut);
        if (!mhTillaten(slut)) { ctx.log(`${url} skickades vidare till en förbjuden adress – hoppar över`); continue; }
        const doc = new DOMParser().parseFromString(html, 'text/html');
        for (const el of doc.querySelectorAll('.mh-object')) {
          const a = mhKort(el, kom); if (!a) continue; kort++;
          if (a.typ && a.typ !== 'Lägenhet') continue;
          if (!fynd.has(a.kod)) { if (kandidat(a, F)) fynd.set(a.kod, a); } else if (kom) fynd.get(a.kod).kommande = true;
        }
      } catch (e) { ctx.log(`${url}: ${e.message}`); if (/spärr/.test(e.message)) { ctx.stopp = true; break; } }
      await pause(3000, 6000);
    }
    ctx.log(`listor: ${sidor} sidor, ${kort} kort, ${fynd.size} lägenheter som kandidater`);
    // Bostadssidor för nya kandidater (koordinater, avgift, våning, text) och planens "kolla"
    const ut = []; let n = 0, vantar = 0;
    for (const a of [...fynd.values()].sort((x, y) => vikt(y) - vikt(x))) {
      const { ortSlug, ...b } = a;
      if (ctx.kand(a)) { ut.push(b); continue; }
      if (ctx.stopp || n >= ctx.maxDetaljer) { vantar++; continue; }
      await pause(3000, 6000); n++;
      try {
        const { data: html, status } = await mhHamta(a.url);
        if (status === 404 || !html) continue;
        const x = { ...b, ...mhDetalj(html) };
        if (kandidat(x, F)) ut.push(x);
      } catch (e) { ctx.log(`maklarhuset-${a.kod}: ${e.message}`); if (/spärr/.test(e.message)) ctx.stopp = true; }
    }
    let k = 0;
    for (const x of (plan.kolla || []).filter(x => (x.kalla || 'maklarhuset') === 'maklarhuset' && x.url && !fynd.has(String(x.kod)))) {
      if (ctx.stopp || n + k >= ctx.maxDetaljer) break;
      await pause(3000, 6000); k++;
      try {
        const { data: html, status, url: slut } = await mhHamta(x.url);
        if (status === 404 || status === 410 || !html || !new RegExp(`/${x.kod}/?$`).test(new URL(slut).pathname)) ctx.res.borta.push({ kalla: 'maklarhuset', kod: String(x.kod), status: 'borttagen' });
        else ut.push({ kalla: 'maklarhuset', kod: String(x.kod), url: x.url, ...mhDetalj(html) });
      } catch (e) { ctx.log(`maklarhuset-${x.kod}: ${e.message}`); if (/spärr/.test(e.message)) ctx.stopp = true; }
    }
    if (vantar) ctx.log(`${vantar} nya kandidater väntar på bostadssidan (koordinater) – tas nästa körning`);
    ctx.log(`detaljer: ${n} nya, ${k} kollade`);
    ctx.log('kallorLasta skickas inte för Mäklarhuset: bara de 23 nyaste per listsida syns (fler sidor kräver ?page=, som robots.txt förbjuder)');
    return { annonser: ut.filter(a => a.lat != null || ctx.kand(a)), sidor: sidor + n + k, kort, helt: false };
  }

  const LASARE = {
    notar: { host: /(^|\.)notar\.se$/, fn: notar, sidor: 40 },
    lansfast: { host: /(^|\.)lansfast\.se$/, fn: lansfast, sidor: 100 },
    maklarhuset: { host: /(^|\.)maklarhuset\.se$/, fn: maklarhuset, sidor: 60 },
  };

  window.mwKor = async function (plan = {}, o = {}) {
    const { bara, maxDetaljer = 40, download = true } = o;
    const namn = Object.keys(LASARE).find(k => LASARE[k].host.test(location.hostname));
    if (!namn) throw new Error('Kör skriptet på www.notar.se, www.lansfast.se eller www.maklarhuset.se (en flik per sajt)');
    if (bara && !bara.includes(namn)) throw new Error(`${namn} är inte med i bara: ${bara.join(', ')}`);
    if (namn === 'maklarhuset' && location.search) throw new Error('Starta från en adress utan "?" (robots.txt), t.ex. https://www.maklarhuset.se/bostad/sverige/stockholms-lan');
    const res = { annonser: [], borta: [], kallorLasta: [], logg: [], klar: null };
    window.__maklareWebb = res;
    const log = s => { res.logg.push(s); console.log(`[${namn}]`, s); };
    const kanda = new Set((plan.kanda || []).map(String));
    const F = { ...STD, ...(plan.filter || {}) };
    const ctx = {
      F, res, log, stopp: false, maxDetaljer, sidor: o.sidor ?? LASARE[namn].sidor,
      kand: a => kanda.has(`${a.kalla}-${a.kod}`) || kanda.has(String(a.kod)),
    };
    const t0 = Date.now();
    try {
      const r = await LASARE[namn].fn(plan, o, ctx);
      res.annonser = r.annonser.map(rensa);
      // Räknas som läst bara när hela källan gick att se utan spärr (annars kan merge tro att annonser försvunnit)
      if (r.helt && !ctx.stopp) res.kallorLasta.push({ kalla: namn });
      log(`${r.sidor} sidor/anrop, ${r.kort} poster, ${res.annonser.length} annonser (${res.annonser.filter(a => a.kommande).length} kommande, ${res.annonser.filter(a => !ctx.kand(a)).length} nya), ${res.borta.length} borta på ${Math.round((Date.now() - t0) / 1000)} s${r.helt ? '' : ' – källan inte helt läst, ingen kallorLasta'}`);
    } catch (e) { log(`${e.message} – avbryter`); }
    res.klar = new Date().toISOString();
    if (download) {
      const ts = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }).replace(/[-: ]/g, '').slice(0, 12).replace(/^(\d{8})/, '$1-');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(res, null, 1)], { type: 'application/json' }));
      a.download = `boende-${namn}-${ts}.json`; document.body.appendChild(a); a.click(); a.remove();
    }
    return { mäklare: namn, annonser: res.annonser.length, borta: res.borta.length, kallorLasta: res.kallorLasta.length, logg: res.logg };
  };
  window.mwTest = { nuxtData, notarDetalj, notarKort, lfKort, lfDetalj, mhKort, mhDetalj, mhTillaten, kandidat };
})();
