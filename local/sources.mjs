// Hämtar priser direkt från Prisjakt, Tradera och Blocket, utan webbläsare och utan AI.
// Samma tolkning och filter som collector/*.js (som fortfarande går att köra i Chrome som reserv).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const HEAD = { 'User-Agent': UA, 'Accept-Language': 'sv-SE,sv;q=0.9' };
const BS = '\\';
const g = (b, re) => (b.match(re) || [])[1];
const pause = ms => new Promise(r => setTimeout(r, ms));

// Snäll hämtning: en förfrågan i taget per sajt, minst MIN_GAP ms mellan dem (plus lite slump),
// längre väntan vid 429/5xx, och stopp om sajten visar en botspärr. Vi försöker aldrig ta oss runt en spärr.
const MIN_GAP = +(process.env.FETCH_MIN_GAP_MS || 4000);
const lastHit = new Map();
const queue = new Map();
function throttled(host, fn) {
  const prev = queue.get(host) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const wait = (lastHit.get(host) || 0) + MIN_GAP + Math.random() * 1500 - Date.now();
    if (wait > 0) await pause(wait);
    try { return await fn(); } finally { lastHit.set(host, Date.now()); }
  });
  queue.set(host, next);
  return next;
}
// Körs jobbet av jobbköraren (AUTOMATION_HOME satt) används det gemensamma hämtbiblioteket: då gäller takten per sajt
// för alla jobb tillsammans, och Blocket-sökningar delas via cachen. Annars hämtar modulen själv som nedan.
const SHARED = process.env.AUTOMATION_HOME ? await import('file:///' + process.env.AUTOMATION_HOME.replace(/\\/g, '/') + '/lib/fetch.mjs') : null;
const SHARED_BLOCKET = process.env.AUTOMATION_HOME ? await import('file:///' + process.env.AUTOMATION_HOME.replace(/\\/g, '/') + '/lib/blocket.mjs') : null;
export const Blocked = SHARED ? SHARED.Blocked : class Blocked extends Error {};
export const usesShared = !!SHARED;

// Anmäl projektets Blocket-sökord till det gemensamma Blocket-jobbet (ingen effekt utan jobbköraren)
export async function blocketNeeds(project, queries) { if (SHARED_BLOCKET) await SHARED_BLOCKET.needs(project, queries); }

async function get(url, opts = {}) {
  if (SHARED) { const t = await SHARED.getText(url, opts); return { ok: true, text: async () => t, json: async () => JSON.parse(t) }; }
  const host = new URL(url).host;
  for (let i = 0; i < 3; i++) {
    const r = await throttled(host, () => fetch(url, { ...opts, headers: { ...HEAD, ...(opts.headers || {}) }, signal: AbortSignal.timeout(30000) }))
      .catch(e => ({ ok: false, status: 0, err: e }));
    if (r.ok) {
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('html')) {
        const t = await r.text();
        if (/<title>[^<]*(Client Challenge|Just a moment|Attention Required)/i.test(t) || /captcha/i.test(t.slice(0, 4000)))
          throw new Blocked(`${host} visar en botspärr – hoppar över källan`);
        return { ok: true, text: async () => t, json: async () => JSON.parse(t) };
      }
      return r;
    }
    if (r.status && r.status < 500 && r.status !== 429) throw new Error(`${url} svarade ${r.status}`);
    if (i < 2) await pause(15000 * (i + 1)); // backa av ordentligt vid 429/5xx/nätverksfel
  }
  throw new Error(`${url} svarade inte`);
}

// ---------- Prisjakt ----------

export async function pjFind(q) {
  const s = await (await get('https://www.prisjakt.nu/search?query=' + encodeURIComponent(q))).text();
  const raw = s.split(BS + '"').join('"');
  const ids = [...new Set([...raw.matchAll(/produkt\.php\?p=(\d+)/g)].map(m => m[1]))].slice(0, 6);
  const out = [];
  for (const id of ids) {
    const h = await (await get('https://www.prisjakt.nu/produkt.php?p=' + id)).text();
    out.push({ id: +id, title: (h.match(/<title>([^<]+)/) || [])[1] || '' });
  }
  return out;
}

export async function pjCollect(id, withHistory) {
  const html = await (await get('https://www.prisjakt.nu/produkt.php?p=' + id)).text();

  // Namn och lägsta pris ur sidans ld+json
  let ld = {};
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try { const j = JSON.parse(m[1]); if (/Product/.test(j['@type'])) { ld = j; break; } } catch (e) {}
  }
  const aggOffers = [].concat(ld.offers || [], ...(ld.hasVariant || []).map(v => v.offers || []));
  const agg = aggOffers.find(o => o.lowPrice) || {};

  // Butikserbjudanden ur sidans serverdata
  const raw = html.split(BS + '"').join('"');
  const seen = new Set();
  const offers = [];
  for (const b of raw.split('{"index":').slice(1)) {
    if (!/^\d+,"shopId"/.test(b)) continue;
    const blk = b.slice(0, 4000);
    const sid = g(blk, /"shopId":(\d+)/), oid = g(blk, /"shopOfferId":"([^"]*)"/);
    if (seen.has(sid + '/' + oid)) continue;
    seen.add(sid + '/' + oid);
    const shipPart = (blk.split('"shipping":')[1] || '').split('"shop":')[0];
    const ships = [...shipPart.matchAll(/"amount":([\d.]+)/g)].map(m => +m[1]);
    const price = +g(blk, /"price":\{"amount":([\d.]+)/);
    const orig = +g(blk, /"originalPrice":\{"amount":([\d.]+)/) || 0;
    const sale = g(blk, /"priceType":"(\w+)"/) === 'SalePrice' && orig > price;
    offers.push({
      shop: (g(blk, /"shop":\{"name":"([^"]+)"/) || '').split(BS + 'u0026').join('&'),
      price,
      was: sale ? orig : null,
      promo: g(blk, /"promotion":\{"id":"[^"]*","title":"([^"]{1,80})"/) || null,
      ship: ships.length ? Math.min(...ships) : null,
      cond: g(blk, /"condition":"(\w+)"/),
      stock: g(blk, /"stockStatus":"(\w+)"/),
      go: g(blk, /"clickoutUrl":"https:\/\/www\.prisjakt\.nu\/go-to-shop\/([^"?]+)/) || null
    });
  }

  const out = { name: ld.name, lowNow: agg.lowPrice ? +agg.lowPrice : null, offers };

  if (withHistory) {
    const r = await get('https://www.prisjakt.nu/api/price-history', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: +id, timeRange: 'ALL', shopIds: [], variantIds: [] })
    });
    const it = (await r.json()).priceHistory?.historyItems || [];
    const ps = it.map(x => x.price).sort((a, b) => a - b);
    const med = ps[ps.length >> 1] || 0;
    const ok = it.filter(x => x.price >= med * 0.5); // bort med felkopplade poster (t.ex. fodral)
    const lowest = since => ok.filter(x => !since || x.date >= since).reduce((a, b) => (!a || b.price < a.price ? b : a), null);
    const ago = days => new Date(Date.now() - days * 864e5).toISOString();
    const fmt = x => x && { price: x.price / 100, shop: x.shopName, date: x.date.slice(0, 10) };
    out.hist = { low: fmt(lowest()), lowYear: fmt(lowest(ago(365))), low3m: fmt(lowest(ago(90))), from: it[0]?.date?.slice(0, 10) || null };
  }
  return out;
}

// Samma kompakta format som pjCollectAll i collector/prisjakt.js: billigaste nya erbjudandet per butik.
export function pjCompact(v) {
  const by = {};
  for (const o of v.offers) {
    if (o.cond !== 'New' || ['OutOfStock', 'PreOrder', 'NotInStock'].includes(o.stock) || !o.price) continue;
    const t = o.price + (o.ship ?? 49);
    if (!by[o.shop] || t < by[o.shop].t) by[o.shop] = { t, row: [o.shop, o.price, o.ship, o.stock === 'InStock' ? 1 : 0, o.go, o.was, o.promo] };
  }
  const res = { name: v.name, lowNow: v.lowNow, offers: Object.values(by).sort((a, b) => a.t - b.t).map(x => x.row) };
  if (v.hist) res.hist = v.hist;
  return res;
}

// ---------- Tradera ----------

const TR_BAD = /fodral|skal|case|etui|kartong|låda|lada|endast|tom |vänster|höger|left|right|refill|tips|örontopp|reservdel|defekt|trasig|attrapp|kopia|replika|köpes/i;

export async function trSearch(q, must, minPrice) {
  const h = await (await get('https://www.tradera.com/search?q=' + encodeURIComponent(q) + '&sortBy=PriceAscending')).text();
  const raw = h.split(BS + '"').join('"').split(BS + 'u0026').join('&');
  const items = raw.split('{"itemId":').slice(1).map(b => ({
    t: g(b, /"shortDescription":"([^"]*)"/) || '',
    price: +g(b, /^\d+,"price":(\d+)/),
    bin: +(g(b, /"buyNowPrice":(\d+)/) || 0),
    type: g(b, /"itemType":"(\w+)"/),
    bids: +(g(b, /"totalBids":(\d+)/) || 0),
    end: new Date(g(b, /"endDate":"([^"]+)"/)).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }).slice(0, 16),
    url: g(b, /"itemUrl":"([^"]+)"/)
  })).filter(x => x.url && x.price);
  const mustRe = new RegExp(must, 'i');
  const ok = items.filter(x => mustRe.test(x.t) && !TR_BAD.test(x.t));
  const bn = ok.filter(x => x.type !== 'Auction')
    .map(x => ({ ...x, p: x.type === 'AuctionBin' ? x.bin : x.price }))
    .filter(x => x.p >= minPrice).sort((a, b) => a.p - b.p)[0];
  const au = ok.filter(x => /^Auction/.test(x.type) && x.price >= minPrice * 0.6).sort((a, b) => a.price - b.price)[0];
  const abs = u => u && (u.startsWith('http') ? u : 'https://www.tradera.com' + u);
  return {
    buyNow: bn ? { titel: bn.t, pris: bn.p, url: abs(bn.url) } : null,
    auction: au ? { titel: au.t, bud: au.price, antalBud: au.bids, slutar: au.end, url: abs(au.url) } : null,
    _seen: items.length
  };
}

// ---------- Blocket ----------

const BL_BAD = /fodral|skal|case|etui|kartong|låda|endast|vänster|höger|refill|tips|reservdel|defekt|trasig|köpes|sökes/i;

export async function blSearch(q, must, minPrice) {
  let items;
  if (SHARED_BLOCKET) items = (await SHARED_BLOCKET.search(q, { maxAgeH: 3 })).items; // delad cache, en hämtning för alla projekt
  else {
    const h = await (await get('https://www.blocket.se/recommerce/forsale/search?q=' + encodeURIComponent(q))).text();
    // Sökresultaten finns som schema.org-data (ItemList) i sidan
    const s = h.match(/<script[^>]*id="seoStructuredData"[^>]*>([\s\S]*?)<\/script>/);
    if (!s) throw new Error('Blocket: hittade inga sökresultat i sidan (sidans format kan ha ändrats)');
    items = (JSON.parse(s[1]).mainEntity?.itemListElement || []).map(x => x.item || {}).map(it => ({
      titel: (it.name || '').trim(),
      pris: +(it.offers?.price || 0),
      url: it.url || ''
    })).filter(x => x.url && x.pris);
  }
  const mustRe = new RegExp(must, 'i');
  const best = items.filter(x => mustRe.test(x.titel) && !BL_BAD.test(x.titel) && x.pris >= minPrice)
    .sort((a, b) => a.pris - b.pris)[0] || null;
  return { best, seen: items.length };
}
