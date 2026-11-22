// Körs i en flik på https://www.blocket.se (Claude in Chrome, javascript_tool).
// Avsluta med: await blCollectAll([{key, q, must:'regex', min:1500}, ...])
// Returnerar { [key]: { titel, pris, url } | null }

window.blSearch = async function (q, must, minPrice) {
  const h = await (await fetch('/recommerce/forsale/search?q=' + encodeURIComponent(q))).text();
  const d = new DOMParser().parseFromString(h, 'text/html');
  const mustRe = new RegExp(must, 'i');
  const bad = /fodral|skal|case|etui|kartong|låda|endast|vänster|höger|refill|tips|reservdel|defekt|trasig|köpes|sökes/i;
  const items = [...d.querySelectorAll('article')].map(a => {
    const l = a.querySelector('a[href*="/item/"]');
    const txt = a.textContent.replace(/\s+/g, ' ');
    const pm = txt.match(/(\d[\d\s]*)\s?kr/);
    return {
      titel: ((a.querySelector('h2,h3') || l || {}).textContent || '').trim().split('\n')[0],
      pris: pm ? +pm[1].replace(/\D/g, '') : null,
      url: l ? new URL(l.getAttribute('href'), location.origin).href : ''
    };
  }).filter(x => x.url && x.pris);
  return items.filter(x => mustRe.test(x.titel) && !bad.test(x.titel) && x.pris >= minPrice)
    .sort((a, b) => a.pris - b.pris)[0] || null;
};

window.blCollectAll = async function (list) {
  const res = {};
  for (const p of list) {
    try { res[p.key] = await window.blSearch(p.q, p.must, p.min); }
    catch (e) { res[p.key] = { error: String(e) }; }
  }
  window.__s = JSON.stringify(res); // hämtas i bitar om över ~900 tecken
  return window.__s.length;
};
