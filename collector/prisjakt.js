// Körs i en flik på https://www.prisjakt.nu (Claude in Chrome, javascript_tool).
// Klistra in hela filen och avsluta med t.ex.:
//   await pjCollectAll([{key:'airpods-pro-3', prisjaktId:15415649, history:true}, ...])
// Returnerar { [key]: { name, lowNow, offers:[...], hist? } }

window.pjFind = async function (q) {
  const BS = String.fromCharCode(92);
  const s = await (await fetch('/search?query=' + encodeURIComponent(q))).text();
  const raw = s.split(BS + '"').join('"');
  const ids = [...new Set([...raw.matchAll(/produkt\.php\?p=(\d+)/g)].map(m => m[1]))].slice(0, 6);
  return Promise.all(ids.map(async id => {
    const h = await (await fetch('/produkt.php?p=' + id)).text();
    return { id: +id, title: (h.match(/<title>([^<]+)/) || [])[1] || '' };
  }));
};

window.pjCollect = async function (id, withHistory) {
  const BS = String.fromCharCode(92);
  const g = (b, re) => (b.match(re) || [])[1];
  const html = await (await fetch('/produkt.php?p=' + id)).text();
  const d = new DOMParser().parseFromString(html, 'text/html');
  const ld = [...d.querySelectorAll('script[type="application/ld+json"]')]
    .map(s => { try { return JSON.parse(s.textContent); } catch (e) { return {}; } })
    .find(x => /Product/.test(x['@type'])) || {};
  const aggOffers = [].concat(ld.offers || [], ...(ld.hasVariant || []).map(v => v.offers || []));
  const agg = aggOffers.find(o => o.lowPrice) || {};

  // Butikserbjudanden (pris, frakt, lager) ur sidans serverdata
  const raw = html.split(BS + '"').join('"');
  const seen = new Set();
  const offers = [];
  for (const b of raw.split('{"index":').slice(1)) {
    if (!/^\d+,"shopId"/.test(b)) continue;
    const blk = b.slice(0, 4000);
    const sid = g(blk, /"shopId":(\d+)/);
    const oid = g(blk, /"shopOfferId":"([^"]*)"/);
    if (seen.has(sid + '/' + oid)) continue;
    seen.add(sid + '/' + oid);
    const shipPart = (blk.split('"shipping":')[1] || '').split('"shop":')[0];
    const ships = [...shipPart.matchAll(/"amount":([\d.]+)/g)].map(m => +m[1]);
    const price = +g(blk, /"price":\{"amount":([\d.]+)/);
    // Butikens egen märkning: rea med ordinarie pris, och ev. kampanjnamn (t.ex. "Black Week")
    const orig = +g(blk, /"originalPrice":\{"amount":([\d.]+)/) || 0;
    const sale = g(blk, /"priceType":"(\w+)"/) === 'SalePrice' && orig > price;
    offers.push({
      shop: g(blk, /"shop":\{"name":"([^"]+)"/),
      price,
      was: sale ? orig : null,
      promo: (g(blk, /"promotion":\{"id":"[^"]*","title":"([^"]{1,80})"/) || null),
      ship: ships.length ? Math.min(...ships) : null,
      cond: g(blk, /"condition":"(\w+)"/),
      stock: g(blk, /"stockStatus":"(\w+)"/),
      // Länk till butikens sida via Prisjakt, sparad kort: "33479/offer/HPAP12VD"
      go: (g(blk, /"clickoutUrl":"https:\/\/www\.prisjakt\.nu\/go-to-shop\/([^"?]+)/) || null),
      name: (g(blk, /"name":"([^"]*)","condition"/) || '').slice(0, 80)
    });
  }

  const out = { name: ld.name, lowNow: agg.lowPrice ? +agg.lowPrice : null, offers };

  if (withHistory) {
    const r = await fetch('/api/price-history', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: +id, timeRange: 'ALL', shopIds: [], variantIds: [] })
    });
    const it = r.ok ? ((await r.json()).priceHistory?.historyItems || []) : [];
    const ps = it.map(x => x.price).sort((a, b) => a - b);
    const med = ps[ps.length >> 1] || 0;
    const ok = it.filter(x => x.price >= med * 0.5); // bort med felkopplade poster (t.ex. fodral)
    const low = ok.reduce((a, b) => (!a || b.price < a.price ? b : a), null);
    const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString();
    const lowYear = ok.filter(x => x.date >= yearAgo).reduce((a, b) => (!a || b.price < a.price ? b : a), null);
    const q3Ago = new Date(Date.now() - 90 * 864e5).toISOString();
    const low3m = ok.filter(x => x.date >= q3Ago).reduce((a, b) => (!a || b.price < a.price ? b : a), null);
    // Datum i svensk tid (Prisjakt anger UTC, t.ex. 2026-11-26T23:00Z = 27 nov)
    const sthlm = t => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
    const fmt = x => x && { price: x.price / 100, shop: x.shopName, date: sthlm(x.date) };
    // Kurva för det senaste året (365 dagar): lägsta pris per dag (svensk tid). Prisjakt anger bara dagar då lägsta
    // priset ändrades, så dagarna emellan får senast kända pris. Priserna är Prisjakts, utan frakt.
    const byDay = {};
    for (const x of ok) { const dd = sthlm(x.date); byDay[dd] = Math.min(byDay[dd] ?? Infinity, x.price / 100); }
    const pts = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]));
    const idag = sthlm(Date.now()), start = new Date(Date.parse(idag + 'T12:00:00Z') - 364 * 864e5).toISOString().slice(0, 10), serie = [];
    let i = 0, last = null;
    for (let t = Date.parse(start + 'T12:00:00Z'), n = 0; n < 400; t += 864e5, n++) {
      const dag = new Date(t).toISOString().slice(0, 10);
      while (i < pts.length && pts[i][0] <= dag) last = pts[i++][1];
      serie.push(last == null ? null : Math.round(last));
      if (dag >= idag) break;
    }
    out.hist = { low: fmt(low), lowYear: fmt(lowYear), low3m: fmt(low3m), from: it[0]?.date?.slice(0, 10) || null,
      d: { from: start, p: serie } };
  }
  return out;
};

// Kompakt resultat: billigaste erbjudandet per butik som
// [butik, pris, frakt|null, iLager 1/0, butikslänk, ordinarie pris om butiken har rea|null, kampanj|null].
// Verktygssvaren kapas runt 1 000 tecken, så resultatet läggs i window.__s och hämtas
// i bitar: __s.length, sedan __s.slice(0,900), __s.slice(900,1800) ...
window.pjCollectAll = async function (list) {
  const BS = String.fromCharCode(92);
  const res = {};
  for (const p of list) {
    try {
      const v = await window.pjCollect(p.prisjaktId, p.history);
      const by = {};
      for (const o of v.offers) {
        if (o.cond !== 'New' || ['OutOfStock', 'PreOrder', 'NotInStock'].includes(o.stock) || !o.price) continue;
        const shop = (o.shop || '').split(BS + 'u0026').join('&');
        const t = o.price + (o.ship ?? 49);
        if (!by[shop] || t < by[shop].t) by[shop] = { t, row: [shop, o.price, o.ship, o.stock === 'InStock' ? 1 : 0, o.go, o.was, o.promo] };
      }
      res[p.key] = { name: v.name, lowNow: v.lowNow, offers: Object.values(by).sort((a, b) => a.t - b.t).map(x => x.row) };
      if (v.hist) res[p.key].hist = v.hist;
    } catch (e) { res[p.key] = { error: String(e) }; }
  }
  window.__s = JSON.stringify(res);
  return window.__s.length;
};
