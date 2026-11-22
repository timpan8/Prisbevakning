// Körs i en flik på https://www.tradera.com (Claude in Chrome, javascript_tool).
// Avsluta med: await trCollectAll([{key, q, must:'regex', min:1500}, ...])
// Returnerar { [key]: { buyNow:{titel,pris,url}|null, auction:{titel,bud,antalBud,slutar,url}|null } }

window.trSearch = async function (q, must, minPrice) {
  const BS = String.fromCharCode(92);
  const h = await (await fetch('/search?q=' + encodeURIComponent(q) + '&sortBy=PriceAscending')).text();
  const raw = h.split(BS + '"').join('"').split(BS + 'u0026').join('&');
  const g = (b, re) => (b.match(re) || [])[1];
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
  const bad = /fodral|skal|case|etui|kartong|låda|lada|endast|tom |vänster|höger|left|right|refill|tips|örontopp|reservdel|defekt|trasig|attrapp|kopia|replika|köpes/i;
  const ok = items.filter(x => mustRe.test(x.t) && !bad.test(x.t));
  const bn = ok.filter(x => x.type !== 'Auction')
    .map(x => ({ ...x, p: x.type === 'AuctionBin' ? x.bin : x.price }))
    .filter(x => x.p >= minPrice).sort((a, b) => a.p - b.p)[0];
  const au = ok.filter(x => /^Auction/.test(x.type) && x.price >= minPrice * 0.6).sort((a, b) => a.price - b.price)[0];
  return {
    buyNow: bn ? { titel: bn.t, pris: bn.p, url: bn.url } : null,
    auction: au ? { titel: au.t, bud: au.price, antalBud: au.bids, slutar: au.end, url: au.url } : null
  };
};

window.trCollectAll = async function (list) {
  const res = {};
  for (const p of list) {
    try { res[p.key] = await window.trSearch(p.q, p.must, p.min); }
    catch (e) { res[p.key] = { error: String(e) }; }
  }
  window.__s = JSON.stringify(res); // hämtas i bitar om över ~900 tecken
  return window.__s.length;
};
