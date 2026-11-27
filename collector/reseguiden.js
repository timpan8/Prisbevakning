// Reseguiden – läser charter/paketresor i webbläsaren (Claude in Chrome eller konsolen). Klistra in hela filen på en
// resultatsida på reseguiden.se och kör sedan en av funktionerna. Skriptet bara läser: inga bokningar, inga formulär,
// ingen inloggning, och det skickar ingen data någonstans – resultatet sparas som en fil i Hämtade filer och returneras.
// Avbryter om sidan visar en spärr eller kontroll.
//
// Sökningen styrs helt av adressen (se RUTIN.md, avsnittet Resor):
//   /charter/fran-stockholm?departure_id=2673730          Stockholm
//     &date_from=ÅÅÅÅ-MM-DD                                 avresedatum (listan visar den dagens resor, billigast först)
//     &length_interval=N                                    1 = 2–3 dgr, 2 = 4–5, 3 = 6–8 (1 v), 4 = 9–12, 5 = 13–15 (2 v), 6 = 16+
//     &max_price=N                                          högsta pris PER PERSON (två delar rum)
//     &lower_left=LON,LAT&upper_right=LON,LAT&interactive_map=1   kartans område (listan gäller bara det området)
//   Hela världen: lower_left=-180,-85&upper_right=180,85. Asien: 60,-12 / 150,45.
//   Sista minuten: /sista-minuten/fran-stockholm med samma parametrar.
// Priset på Reseguiden "avser flyg och hotell för en person när två personer delar boende".
//
//   await rgKalender({ manader: 12 })   billigaste pris per avresedag för sökningen, 12 månader framåt
//   await rgRead({ maxMore: 2 })        resorna i listan (klickar "Visa fler resor" upp till 2 gånger i lugn takt)
(function () {
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, maj: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 };
  const MONLONG = { januari: 1, februari: 2, mars: 3, april: 4, maj: 5, juni: 6, juli: 7, augusti: 8, september: 9, oktober: 10, november: 11, december: 12 };
  const LANGD = { 1: '2-3', 2: '4-5', 3: '6-8', 4: '9-12', 5: '13-15', 6: '16+' };
  const pad = n => String(n).padStart(2, '0');
  const pause = (a, b) => new Promise(r => setTimeout(r, a + Math.random() * (b - a)));
  const num = s => +String(s || '').replace(/[^0-9]/g, '') || null;
  const blocked = () => /Just a moment|Attention Required|captcha|verifiera att du är en människa/i.test(document.title + ' ' + document.body.innerText.slice(0, 2000));
  const guard = () => { if (blocked()) throw new Error('Sidan visar en spärr eller kontroll – avbryter'); };

  // Sökningen som sidan visar, ur adressen
  function sokning() {
    const p = new URLSearchParams(location.search);
    const li = p.get('length_interval');
    return { sida: location.pathname, datum: p.get('date_from'), langd: li ? LANGD[li] || li : 'alla', maxPerPerson: num(p.get('max_price')),
      omrade: p.get('lower_left') ? `${p.get('lower_left')} / ${p.get('upper_right')}` : null, url: location.href };
  }
  function save(kind, res) {
    const slug = (location.pathname.replace(/^\/|\/$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'start') + '-' + kind;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([JSON.stringify(res, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `resor-reseguiden-${slug}-${ts}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // "tor 14 jan - sön 17 jan" -> ["2027-01-14", "2027-01-17"]; året väljs så att avresan inte ligger bakåt i tiden
  function dates(s) {
    const m = [...String(s).toLowerCase().matchAll(/(\d{1,2})\s+([a-zåäö]{3})/g)].map(x => [+x[1], MON[x[2]]]).filter(x => x[1]);
    if (!m.length) return [null, null];
    const now = new Date(), today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    let y = now.getFullYear();
    const iso = (d, mo, yy) => `${yy}-${pad(mo)}-${pad(d)}`;
    let ut = iso(m[0][0], m[0][1], y);
    if (ut < today) { y++; ut = iso(m[0][0], m[0][1], y); }
    const hem = m[1] ? iso(m[1][0], m[1][1], m[1][1] < m[0][1] ? y + 1 : y) : null;
    return [ut, hem];
  }

  function readTiles() {
    const hooks = [...document.querySelectorAll('[data-hook^="tile_"]')];
    const ids = [...new Set(hooks.map(h => h.dataset.hook.split('__')[0]))];
    return ids.map(id => {
      const mine = hooks.filter(h => h.dataset.hook.startsWith(id + '__'));
      const get = k => mine.filter(h => h.dataset.hook === `${id}__${k}` || h.dataset.hook.startsWith(`${id}__${k}__`)).map(h => h.innerText.replace(/\s+/g, ' ').trim());
      const title = get('title')[0], dest = (get('destination')[0] || '').replace(/,\s*$/, ''), geo = get('geo')[0] || '';
      const price = num(get('large-price')[0] || get('price')[0]);
      if (!title || !price) return null;
      const lengthRow = get('date__length')[0] || get('date').find(r => /dgr|dagar/i.test(r)) || '';
      const span = get('date__item')[0] || get('date').find(r => /\d{1,2}\s+[a-zåäö]{3}.*-/i.test(r)) || '';
      const [avresa, hem] = dates(span);
      // Kortets ram: det största elementet som bara innehåller det här kortets fält
      let tile = mine[0];
      while (tile.parentElement && [...tile.parentElement.querySelectorAll('[data-hook^="tile_"]')].every(h => h.dataset.hook.startsWith(id + '__'))) tile = tile.parentElement;
      const a = tile.closest('a[href]') || tile.querySelector('a[href]');
      const logo = tile.querySelector('img[class*="CompanyLogo"]');
      const text = tile.innerText;
      // Hotellbilden: första bilden i kortets bildspel (ligger utanför textdelen, i kortets yttre ram)
      let card = tile; for (let i = 0; i < 4 && card && !card.querySelector('img.image-gallery-image__img[src]'); i++) card = card.parentElement;
      const pic = card && [...card.querySelectorAll('img.image-gallery-image__img')].map(x => x.currentSrc || x.src).find(Boolean);
      return {
        kalla: 'reseguiden', kallaNamn: 'Reseguiden', typ: 'paket',
        fran: (lengthRow.match(/Från\s+([A-Za-zåäöÅÄÖ]+)/) || [])[1] || null,
        ort: dest || title, land: geo.split(',').map(s => s.trim()).filter(Boolean).pop() || null, omrade: geo || null,
        hotell: title, avresa, hem, dagar: num((lengthRow.match(/(\d+)\s*(dgr|dagar)/i) || [])[1]),
        prisPerPerson: price, stjarnor: tile.querySelectorAll('.icon-star').length || null,
        arrangor: logo ? logo.alt : null, direktflyg: /Direktflyg/i.test(text), ombokningsbar: /Ombokningsbar/i.test(text),
        url: a ? new URL(a.getAttribute('href'), location.origin).href : location.href,
        bild: pic || null
      };
    }).filter(Boolean);
  }

  window.rgRead = async function ({ maxMore = 2, download = true } = {}) {
    guard();
    let clicks = 0, last = -1;
    for (; clicks < maxMore; clicks++) {
      const n = new Set([...document.querySelectorAll('[data-hook^="tile_"]')].map(h => h.dataset.hook.split('__')[0])).size;
      if (n === last) break;
      last = n;
      const btn = [...document.querySelectorAll('button')].find(b => /visa fler resor/i.test(b.innerText));
      if (!btn || btn.disabled) break;
      btn.scrollIntoView({ block: 'center' });
      await pause(1200, 2500); btn.click(); await pause(2500, 4500); guard();
    }
    const erbjudanden = readTiles();
    const antal = (document.body.innerText.match(/Hittade ([^\n]*)/) || [])[1] || null;
    const res = { kalla: 'reseguiden', typ: 'lista', hamtad: new Date().toISOString(), sokning: sokning(), traffar: antal, erbjudanden };
    if (download) save('lista', res);
    return { antal: erbjudanden.length, traffar: antal, billigast: erbjudanden.slice().sort((a, b) => a.prisPerPerson - b.prisPerPerson).slice(0, 3) };
  };

  // Priskalendern i datumväljaren: billigaste pris per person per avresedag för sökningens reslängd, filter och område.
  window.rgKalender = async function ({ manader = 12, download = true } = {}) {
    guard();
    // Datumrutan i sökfältet ("10 dec 2026, 13-15 dagar"); ibland en knapp, ibland en klickbar div – ta det innersta elementet
    const opener = [...document.querySelectorAll('button, [role="button"], div, span')]
      .filter(b => /^\d{1,2}\s+[a-zåäö]{3}\s+20\d\d,\s.*(dagar|reslängder)$/i.test((b.innerText || '').trim()))
      .sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0];
    if (!opener) throw new Error('hittade inte datumväljaren');
    opener.click(); await pause(1500, 2500);
    const dagar = {};
    const read = () => {
      for (const b of document.querySelectorAll('button[aria-label^="Choose"]')) {
        const lab = (b.getAttribute('aria-label') || '').match(/(\d{1,2}) ([a-zåäö]+) (20\d\d)/i); if (!lab) continue;
        const last = b.innerText.split('\n').map(s => s.trim()).filter(Boolean).pop() || '';
        if (!/kr/.test(last)) continue;
        const mo = MONLONG[lab[2].toLowerCase()]; if (!mo) continue;
        dagar[`${lab[3]}-${pad(mo)}-${pad(+lab[1])}`] = num(last);
      }
    };
    read();
    for (let i = 0; i < manader; i++) {
      const next = [...document.querySelectorAll('[aria-label*="next month"], [aria-label*="Move forward"]')][0];
      if (!next) break;
      next.click(); await pause(700, 1300); read(); guard();
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const lista = Object.entries(dagar).sort((a, b) => a[0].localeCompare(b[0]));
    const res = { kalla: 'reseguiden', typ: 'kalender', hamtad: new Date().toISOString(), sokning: sokning(), dagar: Object.fromEntries(lista) };
    if (download) save('kalender', res);
    const billigast = lista.slice().sort((a, b) => a[1] - b[1]).slice(0, 8);
    return { dagar: lista.length, forsta: lista[0]?.[0], sista: lista[lista.length - 1]?.[0], billigast };
  };
})();
