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
    offers.push({
      shop: g(blk, /"shop":\{"name":"([^"]+)"/),
      price: +g(blk, /"price":\{"amount":([\d.]+)/),
      ship: ships.length ? Math.min(...ships) : null,
      cond: g(blk, /"condition":"(\w+)"/),
      stock: g(blk, /"stockStatus":"(\w+)"/),
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
    const fmt = x => x && { price: x.price / 100, shop: x.shopName, date: x.date.slice(0, 10) };
    out.hist = { low: fmt(low), lowYear: fmt(lowYear), from: it[0]?.date?.slice(0, 10) || null };
  }
  return out;
};

// Kompakt resultat: billigaste erbjudandet per butik som [butik, pris, frakt|null, iLager 1/0].
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
        if (!by[shop] || t < by[shop].t) by[shop] = { t, row: [shop, o.price, o.ship, o.stock === 'InStock' ? 1 : 0] };
      }
      res[p.key] = { name: v.name, lowNow: v.lowNow, offers: Object.values(by).sort((a, b) => a.t - b.t).map(x => x.row) };
      if (v.hist) res[p.key].hist = v.hist;
    } catch (e) { res[p.key] = { error: String(e) }; }
  }
  window.__s = JSON.stringify(res);
  return window.__s.length;
};
