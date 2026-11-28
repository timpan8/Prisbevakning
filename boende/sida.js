// Fliken Boende (laddas av index.html efter huvudskriptet och använder dess hjälpare: $, esc, kr, dm, EXT, PASS,
// decrypt, encrypt, ghToken, REPO, stGal, stLeaflet, rsTid). Datan (data/boende.enc.json) skrivs av datorns inkorgsjobb
// (boende/merge.mjs); gillningar och ogillningar sparas krypterat i data/boende-val.enc.json via GitHub, som arkivet.
let BO = null, BOVAL = {};
const BO_F = { rum: '3', max: 40, pris: 0, kvm: 0, avgift: 0, manad: 0, vaning: 'alla', sort: 'poang', visa: 'alla', mast: new Set(), fler: false, ogilla: null, markerad: null };
// Filtren sparas i webbläsaren så att de finns kvar när sidan laddas om
const BO_SPARA = ['rum', 'max', 'pris', 'kvm', 'avgift', 'manad', 'vaning', 'sort', 'visa'];
try { const s = JSON.parse(localStorage.getItem('boendeFilter') || '{}'); for (const k of BO_SPARA) if (k in s) BO_F[k] = s[k]; if (Array.isArray(s.mast)) BO_F.mast = new Set(s.mast); } catch (e) {}
const boSparaF = () => { try { localStorage.setItem('boendeFilter', JSON.stringify({ ...Object.fromEntries(BO_SPARA.map(k => [k, BO_F[k]])), mast: [...BO_F.mast] })); } catch (e) {} };
// Kalkyl för månadskostnad. Egna värden sparas i webbläsaren; tom kontantinsats = insatsProcent av priset.
const BO_KALK_STD = { insats: null, insatsProcent: 15, ranta: 3.5, ranteavdrag: 30 };
let BO_KALK = { ...BO_KALK_STD };
try { Object.assign(BO_KALK, JSON.parse(localStorage.getItem('boendeKalkyl') || '{}')); } catch (e) {}
// Avgift + ränta efter ränteavdrag + amortering (2 % av lånet över 70 % belåning, 1 % över 50 %). null utan pris.
function boManad(a) {
  if (!a.utrop) return null;
  const insats = Math.min(a.utrop, BO_KALK.insats ?? a.utrop * BO_KALK.insatsProcent / 100), lan = Math.max(0, a.utrop - insats), grad = lan / a.utrop;
  const ranta = Math.round(lan * BO_KALK.ranta / 100 * (1 - BO_KALK.ranteavdrag / 100) / 12), amort = Math.round(lan * (grad > .7 ? .02 : grad > .5 ? .01 : 0) / 12);
  return { tot: (a.avgift || 0) + ranta + amort, avgift: a.avgift || 0, ranta, amort, lan, saknarAvgift: a.avgift == null };
}
// Våning som tal (0 = bottenvåning) eller null
const boVan = a => { const v = String(a.vaning ?? '').trim(); if (!v) return null; if (/^(vån\s*)?(bv|botten|0\b)/i.test(v)) return 0; const m = v.match(/\d+/); return m ? +m[0] : null; };
const BO_VANING = { alla: () => true, ejbv: a => boVan(a) !== 0, hiss: a => a.hiss === true || (boVan(a) != null && boVan(a) <= 2) };
// Jämförelse med området: kr/kvm mot sålda (helst) eller andra till salu i närheten. Räknas en gång per laddning.
function boJmf(a) {
  if (!BO.jmf) {
    const km = (p, q) => Math.hypot((p.lat - q.lat) * 111.2, (p.lon - q.lon) * 111.2 * Math.cos(p.lat * Math.PI / 180));
    const med = v => { const s = [...v].sort((x, y) => x - y), n = s.length; return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2; };
    const A = Object.values(BO.d.annonser || {}).filter(x => x.utrop && x.kvm && x.lat != null);
    const S = Object.values(BO.d.arkiv || {}).filter(x => x.status === 'sald' && x.slutpris && x.kvm && x.lat != null);
    BO.jmf = {};
    for (const x of A) {
      const egen = x.utrop / x.kvm, o = {};
      const s = S.filter(y => km(x, y) <= 1.5);
      if (s.length >= 4) { o.sald = { n: s.length, diff: Math.round((egen / med(s.map(y => y.slutpris / y.kvm)) - 1) * 100) };
        const u = s.filter(y => y.utrop); if (u.length >= 3) o.overUtrop = Math.round((med(u.map(y => y.slutpris / y.utrop)) - 1) * 100); }
      const t = A.filter(y => y !== x && km(x, y) <= 1);
      if (t.length >= 5) o.salu = { n: t.length, diff: Math.round((egen / med(t.map(y => y.utrop / y.kvm)) - 1) * 100) };
      BO.jmf[x.id] = o;
    }
  }
  return BO.jmf[a.id] || {};
}
function boJmfText(a) {
  const j = boJmf(a), d = v => v === 0 ? 'samma som' : `${Math.abs(v)} % ${v < 0 ? 'under' : 'över'}`;
  const delar = [];
  if (j.sald) delar.push(`<span class="${j.sald.diff <= -5 ? 'bra' : j.sald.diff >= 10 ? 'dyr' : ''}" title="Median av ${j.sald.n} sålda inom 1,5 km">kr/kvm ${d(j.sald.diff)} sålda i området</span>`);
  else if (j.salu) delar.push(`<span class="${j.salu.diff <= -5 ? 'bra' : j.salu.diff >= 10 ? 'dyr' : ''}" title="Median av ${j.salu.n} andra till salu inom 1 km (sålda räknas in när arkivet har minst 4 i närheten)">kr/kvm ${d(j.salu.diff)} andra till salu i närheten</span>`);
  if (j.overUtrop != null) delar.push(`<span title="Median för sålda inom 1,5 km">Brukar gå ${j.overUtrop >= 0 ? '+' : ''}${j.overUtrop} % mot utrop</span>`);
  return delar.join('');
}
// Filterknapparna "Måste ha": alla valda måste stämma
const BO_MAST = [
  ['takterrass', 'Takterrass', a => a.bonus?.includes('takterrass')],
  ['vattenutsikt', 'Vattenutsikt', a => a.bonus?.includes('vattenutsikt')],
  ['vatten', 'Nära vatten', a => a.bonus?.includes('vattenutsikt') || (a.vattenMeter != null && a.vattenMeter <= 400)],
  ['balkong', 'Balkong', a => a.bonus?.includes('balkong')],
  ['unikt', 'Unikt', a => a.bonus?.includes('unikt')],
  ['tbana', 'Nära T-bana', a => a.bonus?.includes('tbana')],
  ['spar', 'Nära spårtrafik', a => a.bonus?.includes('tbana') || a.bonus?.includes('spar')],
  ['centrum', 'Nära centrum', a => a.bonus?.includes('centrum')],
  ['avgift', 'Låg avgift', a => a.bonus?.includes('avgift')],
  ['stor2a', 'Stor tvåa', a => a.bonus?.includes('stor2a')],
  ['sankt', 'Prissänkt', a => (a.priser || []).some(p => p.typ === 'sankt')],
  ['budgivning', 'Budgivning', a => a.status === 'budgivning'],
];
const BO_VAL_FIL = 'data/boende-val.enc.json';
const BO_KALLA = { hemnet: 'Hemnet', booli: 'Booli' };
const BO_ORSAK = ['Område', 'Planlösning', 'Avgift', 'För liten', 'Våning/ljus', 'Utsikt', 'Skick', 'Pris', 'Restid', 'Annat'];
const BO_BONUS = { takterrass: 'Takterrass', vattenutsikt: 'Vattenutsikt', balkong: 'Balkong', grill: 'Grill på balkongen', unikt: 'Unikt', centrum: 'Nära centrum', avgift: 'Låg avgift', tbana: 'Nära T-bana', spar: 'Nära tåg/spårvagn', restid: 'Kort restid', stor2a: 'Stor tvåa' };

async function loadBoende() {
  if (!PASS) return;
  BO = { laddar: true };
  const get = p => fetch(p + '?t=' + Date.now(), { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
  try {
    const [box, vbox] = await Promise.all([get('data/boende.enc.json'), get(BO_VAL_FIL)]);
    BO = box ? { d: await decrypt(box, PASS) } : { tom: true };
    BOVAL = vbox ? await decrypt(vbox, PASS).catch(() => ({})) || {} : {};
  } catch (e) { BO = { fel: true }; }
  boendeKort();
  if (location.hash === '#/boende') renderBoende();
}
const boInst = () => BO?.d?.installningar || {};
const boM = m => m == null ? '' : m < 1000 ? `${m} m` : `${(m / 1000).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} km`;
const boDagar = d => d ? Math.max(0, Math.round((Date.now() - Date.parse(d + 'T12:00:00')) / 864e5)) : null;
const boKrKvm = a => a.avgift && a.kvm ? Math.round(a.avgift * 12 / a.kvm) : null;
const boVal = a => BOVAL[a.id]?.val;
const boNy = a => a.hittad && Date.now() - Date.parse(a.hittad) < 2 * 864e5;

function boLista() {
  const A = Object.values(BO.d.annonser || {});
  const ok = a => (BO_F.visa !== 'gillade' || boVal(a) === 'gilla') && (BO_F.visa !== 'nya' || boNy(a))
    && (a.restid?.solnaStrand ?? 99) <= BO_F.max && boVal(a) !== 'ogilla' && (!BO_F.pris || (a.utrop || 0) <= BO_F.pris) && (!BO_F.kvm || (a.kvm || 0) >= BO_F.kvm) && (!BO_F.avgift || (a.avgift != null && a.avgift <= BO_F.avgift))
    && (!BO_F.manad || ((boManad(a)?.tot ?? 1e9) <= BO_F.manad)) && (BO_VANING[BO_F.vaning] || BO_VANING.alla)(a)
    && BO_MAST.every(([k, , t]) => !BO_F.mast.has(k) || t(a));
  const P = a => a.utrop ?? 1e12; // kommande (utan pris) sist
  const sort = { poang: (a, b) => b.poang - a.poang || P(a) - P(b), manad: (a, b) => (boManad(a)?.tot ?? 1e12) - (boManad(b)?.tot ?? 1e12), nyast: (a, b) => (b.publicerad || '').localeCompare(a.publicerad || ''),
    pris: (a, b) => P(a) - P(b), restid: (a, b) => (a.restid?.solnaStrand ?? 99) - (b.restid?.solnaStrand ?? 99), kvm: (a, b) => (b.kvm || 0) - (a.kvm || 0), avgift: (a, b) => (a.avgift ?? 1e9) - (b.avgift ?? 1e9) }[BO_F.sort];
  return {
    huvud: A.filter(a => (a.kategori === 'huvud' || (BO_F.rum === 'alla' && a.kategori === 'tvaa')) && ok(a)).sort(sort),
    tvaor: BO_F.rum === 'alla' ? [] : A.filter(a => a.kategori === 'tvaa' && ok(a)).sort(sort),
    ovriga: A.filter(a => a.kategori === 'ovriga' && boVal(a) !== 'ogilla').sort((a, b) => b.poang - a.poang),
    ogillade: A.filter(a => boVal(a) === 'ogilla'),
  };
}

function boFakta(a) {
  const I = boInst(), on = b => a.bonus?.includes(b) ? ' class="on"' : '', r = a.restid || {}, ka = boKrKvm(a);
  return [
    r.solnaStrand != null && `<span${on('restid')} title="${esc((r.linjer || []).join(' → '))}${r.byten != null ? `, ${r.byten} byten` : ''} (vardag, framme ${esc(I.ankomst || '08:30')})">🚇 ${r.solnaStrand} min till ${esc(I.mal?.namn || 'Solna strand')}</span>`,
    r.tbanaNamn && `<span${on('tbana')} title="Ungefärlig gångväg till närmaste tunnelbana">T ${esc(r.tbanaNamn)} ${boM(r.tbanaMeter)}</span>`,
    a.spar && a.spar.meter <= 1500 && (!r.tbanaMeter || a.spar.meter < r.tbanaMeter) && `<span${on('spar')} title="Ungefärlig gångväg till närmaste ${a.spar.typ === 'tåg' ? 'tågstation' : 'spårvagnshållplats'}">${a.spar.typ === 'tåg' ? '🚆' : '🚋'} ${esc(a.spar.namn)} ${boM(a.spar.meter)}</span>`,
    r.centrum != null && `<span${on('centrum')} title="Restid till T-Centralen">City ${r.centrum} min</span>`,
    a.avgift && `<span${on('avgift')} title="${ka ? ka + ' kr/kvm och år' : ''}">Avgift ${kr(a.avgift)}${ka ? ` · ${ka} kr/kvm` : ''}</span>`,
    a.vaning && `<span>${esc(String(a.vaning).replace(/^vån\s*/i, 'Vån '))}</span>`,
    ...['stor2a', 'takterrass', 'vattenutsikt', 'balkong', 'grill', 'unikt'].filter(b => a.bonus?.includes(b)).map(b => `<span class="on"${b === 'unikt' && a.unikText ? ` title="${esc(a.unikText)}"` : ''}>${BO_BONUS[b]}</span>`),
    a.vattenMeter != null && !a.bonus?.includes('vattenutsikt') && a.vattenMeter <= 400 && `<span title="Närmaste vatten">Vatten ${boM(a.vattenMeter)}</span>`,
  ].filter(Boolean).join('');
}
function boHist(a) {
  const P = a.priser || [];
  const u = P.filter(x => ['utrop', 'sankt', 'hojt'].includes(x.typ)), bud = P.find(x => x.typ === 'budgivning');
  const delar = [];
  if (u.length > 1) delar.push(u.map(x => `${x.typ === 'utrop' ? 'Utrop' : x.typ === 'sankt' ? 'Sänkt' : 'Höjt'} ${dm(x.datum)} <b>${kr(x.pris)}</b>`).join(' → '));
  if (bud) delar.push(`Budgivning sedan ${dm(bud.datum)}${bud.pris ? `, högsta bud <b>${kr(bud.pris)}</b>` : ''}`);
  return delar.length ? `<div class="bo-hist">${delar.join(' · ')}</div>` : '';
}
function boVisning(a) {
  const v = (a.visningar || []).filter(x => Date.parse(x) > Date.now() - 2 * 3600e3).sort()[0];
  if (!v) return '';
  const d = new Date(v), heldag = d.getHours() === 0 && d.getMinutes() === 0;
  return `Visning ${d.toLocaleString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', ...(heldag ? {} : { hour: '2-digit', minute: '2-digit' }) })}`;
}
function boKort(a) {
  const v = boVal(a), I = boInst(), sankt = (a.priser || []).filter(x => x.typ === 'utrop' || x.typ === 'sankt' || x.typ === 'hojt'), forst = sankt[0]?.pris;
  const dagar = boDagar(a.publicerad), kvmp = a.utrop && a.kvm ? Math.round(a.utrop / a.kvm) : null;
  const mk = boManad(a), jt = boJmfText(a);
  const tags = [!a.utrop && '<span class="bo-tag kom" title="Priset är inte satt än">Kommande</span>', a.status === 'budgivning' && '<span class="bo-tag bud">Budgivning pågår</span>', boNy(a) && '<span class="bo-tag ny">Ny</span>',
    a.liknar?.length && '<span class="bo-tag likn">Liknar en du gillat</span>'].filter(Boolean).join('');
  const gal = stGal({ bilder: a.bilder, typ: `${a.rum ?? ''} rok`, ort: a.omrade || a.adress }, a.url).replace('<div class="st-gal">', `<div class="st-gal">${a.poang >= (I.notisPoang ?? 6) ? `<div class="st-tag"><span class="ok">${a.poang} poäng</span></div>` : ''}`);
  return `<article class="st-card bo-card${v === 'gilla' ? ' gillad' : ''}${BO_F.markerad === a.id ? ' markerad' : ''}" id="bo-${esc(a.id)}">${gal}
    <div class="st-body"><div class="st-top"><a href="${esc(a.url)}" ${EXT}><strong>${esc(a.adress || a.omrade)}</strong>
      <span class="sub">${[esc(a.omrade), esc((a.kommun || '').replace(/ kommun$/, '')), a.rum && `${String(a.rum).replace('.', ',')} rok`, a.kvm && `${String(a.kvm).replace('.', ',')} kvm`].filter(Boolean).join(' · ')}</span></a>
      <div class="bo-pris">${forst && forst !== a.utrop ? `<s>${kr(forst)}</s>` : ''}<b class="num">${a.utrop ? kr(a.utrop) : 'Pris ej satt'}</b><span>${kvmp ? kvmp.toLocaleString('sv-SE') + ' kr/kvm' : ''}</span>${mk ? `<span class="bo-manad" title="Avgift ${kr(mk.avgift)}${mk.saknarAvgift ? ' (saknas än)' : ''} + ränta ${kr(mk.ranta)} efter avdrag + amortering ${kr(mk.amort)} på lån ${kr(mk.lan)}">≈ ${kr(mk.tot)}/mån</span>` : ''}</div></div>
      ${tags ? `<div>${tags}</div>` : ''}
      <div class="st-fakta">${boFakta(a)}</div>
      ${boHist(a)}
      ${jt ? `<div class="bo-jmf">${jt}</div>` : ''}
      <div class="bo-meta">${dagar != null ? `<span>${dagar ? `Ute i ${dagar} ${dagar === 1 ? 'dag' : 'dagar'}` : 'Ute sedan i dag'}</span>` : ''}${boVisning(a) ? `<span>${boVisning(a)}</span>` : ''}${a.visad ? `<span>${a.visad.toLocaleString('sv-SE')} visningar på Hemnet</span>` : ''}${a.byggar ? `<span>Byggt ${a.byggar}</span>` : ''}<span>${[a, ...(a.ocksa || [])].map(x => `<a href="${esc(x.url)}" ${EXT}>${BO_KALLA[x.kalla] || esc(x.kalla)}</a>`).join(' · ')}</span>${(a.larda || []).map(t => `<span class="minus">− ${esc(t)}</span>`).join('')}</div>
      <div class="bo-val"><button type="button" class="g" data-bogilla="${esc(a.id)}" aria-pressed="${v === 'gilla'}">👍 Gilla</button><button type="button" class="o" data-boogilla="${esc(a.id)}" aria-pressed="${v === 'ogilla'}">👎 Ogilla</button>
        ${a.lat != null ? `<button type="button" class="karta" data-bokarta="${esc(a.id)}">Visa på kartan</button>` : ''}</div>
      ${BO_F.ogilla === a.id ? boOgillaForm(a) : ''}</div></article>`;
}
function boOgillaForm(a) {
  const f = BOVAL[a.id] || {};
  return `<div class="bo-ogilla"><p>Vad var det du inte gillade? (valfritt – det hjälper bevakningen att lära sig)</p>
    <div class="st-chk">${BO_ORSAK.map(o => `<button type="button" data-boorsak="${esc(o)}" aria-pressed="${(f.orsaker || []).includes(o)}">${esc(o)}</button>`).join('')}</div>
    <textarea id="bo-text" placeholder="T.ex. mörk bottenvåning, konstig planlösning, för långt till tunnelbanan">${esc(f.text || '')}</textarea>
    <div class="rad"><button type="button" data-bospara="${esc(a.id)}">Ogilla</button><button type="button" class="av" data-boavbryt>Avbryt</button></div></div>`;
}
function boKompakt(a, varfor) {
  return `<li><div class="rs-nm"><a href="${esc(a.url)}" ${EXT}><strong>${esc(a.adress || a.omrade)}</strong></a><div class="sub">${[esc(a.omrade), a.rum && a.rum + ' rok', a.kvm && a.kvm + ' kvm', a.restid?.solnaStrand != null && a.restid.solnaStrand + ' min'].filter(Boolean).join(' · ')}</div>
    <div class="st-miss">${esc(varfor)}</div></div><div class="rs-pr sm"><b class="num">${kr(a.utrop)}</b>${boVal(a) === 'ogilla' ? `<button type="button" class="linkbtn" data-boangra="${esc(a.id)}">Ångra</button>` : ''}</div></li>`;
}
function boSalda() {
  const S = Object.values(BO.d.arkiv || {}).sort((a, b) => (b.datum || '').localeCompare(a.datum || ''));
  if (!S.length) return '';
  const rad = s => { const d = s.slutpris && s.utrop ? Math.round((s.slutpris / s.utrop - 1) * 100) : null;
    return `<tr><td><a href="${esc(s.url)}" ${EXT}>${esc(s.adress || s.omrade)}</a><div class="mute">${[esc(s.omrade), s.rum && s.rum + ' rok', s.kvm && s.kvm + ' kvm', BOVAL[s.id]?.val === 'gilla' && '👍'].filter(Boolean).join(' · ')}</div></td>
      <td class="r num">${kr(s.utrop)}</td><td class="r num">${s.slutpris ? kr(s.slutpris) : s.status === 'borttagen' ? '<span class="mute">borttagen</span>' : '<span class="mute">okänt</span>'}</td>
      <td class="r num ${d > 0 ? 'upp' : d < 0 ? 'ner' : ''}">${d != null ? (d > 0 ? '+' : '') + d + ' %' : ''}</td><td class="r num">${s.dagar ?? ''}</td><td class="r">${dm(s.datum)}</td></tr>`; };
  return `<details class="rs-ov"><summary>Sålda och borttagna <span class="mute">(${S.length}, sparas med priser)</span></summary>
    <table class="bo-sald"><tr><th>Bostad</th><th class="r">Utrop</th><th class="r">Slutpris</th><th class="r">±</th><th class="r">Dagar ute</th><th class="r">När</th></tr>${S.slice(0, 200).map(rad).join('')}</table></details>`;
}
// Reglagen: [nyckel, rubrik, min, max, steg, värdet som betyder "ingen gräns", text för värdet]
const BO_REGLAGE = [
  ['max', 'Restid till mål', 10, 40, 5, 40, v => `högst ${v} min`],
  ['kvm', 'Storlek', 0, 100, 5, 0, v => v ? `minst ${v} kvm` : 'alla'],
  ['avgift', 'Avgift', 2000, 8000, 250, 8000, v => v >= 8000 ? 'alla' : `högst ${kr(v)}/mån`],
  ['pris', 'Utropspris', 1500000, 4000000, 100000, 4000000, v => v >= 4000000 ? 'alla' : `högst ${(v / 1e6).toLocaleString('sv-SE')} mkr`],
  ['manad', 'Kostnad per månad', 6000, 30000, 500, 30000, v => v >= 30000 ? 'alla' : `högst ${kr(v)}`],
];
// BO_F har 0 för "ingen gräns" på kvm, avgift och pris; reglaget står då i sitt gränslösa läge
const boRegVarde = ([k, , , , , fri]) => BO_F[k] || fri;
const boRegSatt = (k, v) => { const r = BO_REGLAGE.find(x => x[0] === k); BO_F[k] = k === 'max' ? v : v === r[5] ? 0 : v; };
function boFilter() {
  // Antal bland treor och tvåor (inte ogillade), så knappar utan träff syns som tomma
  const A = Object.values(BO.d.annonser || {}).filter(a => (a.kategori === 'huvud' || a.kategori === 'tvaa') && boVal(a) !== 'ogilla');
  const chips = BO_MAST.map(([k, n, t]) => { const c = A.filter(t).length, p = BO_F.mast.has(k);
    return `<button type="button" data-bomast="${k}" aria-pressed="${p}"${!c && !p ? ' disabled' : ''}>${n} <span class="mute">${c}</span></button>`; }).join('');
  const val = (key, lbl, vals) => `<label class="bo-sel"><span>${lbl}</span><select data-bosel="${key}">${vals.map(([v, n]) => `<option value="${v}"${String(BO_F[key]) === String(v) ? ' selected' : ''}>${n}</option>`).join('')}</select></label>`;
  const reg = r => { const [k, lbl, min, max, steg, , txt] = r, v = boRegVarde(r);
    return `<label class="bo-reg"><span>${k === 'max' ? `Till ${esc(boInst().mal?.namn || 'Solna strand')}` : lbl} <b data-boregtxt="${k}">${txt(v)}</b></span><input type="range" data-boreg="${k}" min="${min}" max="${max}" step="${steg}" value="${v}"></label>`; };
  const andrat = BO_REGLAGE.some(r => boRegVarde(r) !== r[5]);
  return `<div class="bo-filt">
    <div class="bo-sels">${val('rum', 'Rum', [['3', '3 rum eller fler'], ['alla', 'Även tvåor']])}${val('sort', 'Sortera', [['poang', 'Bäst matchning'], ['nyast', 'Nyast'], ['pris', 'Lägst pris'], ['restid', 'Kortast restid'], ['kvm', 'Störst'], ['avgift', 'Lägst avgift'], ['manad', 'Lägst månadskostnad']])}${val('visa', 'Visa', [['alla', 'Alla'], ['nya', 'Nya senaste 2 dagarna'], ['gillade', 'Gillade']])}${val('vaning', 'Våning', [['alla', 'Alla'], ['ejbv', 'Inte bottenvåning'], ['hiss', 'Hiss eller högst 2 tr']])}</div>
    <div class="bo-regs">${BO_REGLAGE.map(reg).join('')}${andrat ? '<button type="button" class="linkbtn" data-boregrensa>Återställ</button>' : ''}</div>
    <div class="bo-kalk">Kostnad per månad räknas som avgift + ränta efter ${BO_KALK.ranteavdrag} % ränteavdrag + amortering (2 % över 70 % belåning, 1 % över 50 %).
      <label>Kontantinsats <input type="number" inputmode="numeric" min="0" step="10000" data-bokalk="insats" value="${BO_KALK.insats ?? ''}" placeholder="${BO_KALK.insatsProcent} % av priset"> kr</label>
      <label>Ränta <input type="number" inputmode="decimal" min="0" max="15" step="0.05" data-bokalk="ranta" value="${BO_KALK.ranta}"> %</label></div>
    <div class="bo-mast"><span>Måste ha</span><div class="bo-chips" role="group" aria-label="Måste ha">${chips}${BO_F.mast.size ? '<button type="button" class="linkbtn" data-bomastrensa>Rensa</button>' : ''}</div></div></div>`;
}
// Reglage: texten följer med medan man drar, listan ritas om när man släpper; rullistor ritas om direkt
document.addEventListener('input', e => {
  const r = e.target.closest?.('#v-boende input[data-boreg]'); if (!r) return;
  const R = BO_REGLAGE.find(x => x[0] === r.dataset.boreg), t = document.querySelector(`[data-boregtxt="${R[0]}"]`); if (t) t.textContent = R[6](+r.value);
});
document.addEventListener('change', e => {
  const t = e.target; if (!t.closest?.('#v-boende')) return;
  if (t.dataset.boreg) { boRegSatt(t.dataset.boreg, +t.value); renderBoende(); document.querySelector(`[data-boreg="${t.dataset.boreg}"]`)?.focus(); }
  else if (t.dataset.bokalk) {
    const k = t.dataset.bokalk, v = t.value === '' ? null : +String(t.value).replace(',', '.');
    BO_KALK[k] = k === 'ranta' ? (v ?? BO_KALK_STD.ranta) : v;
    try { localStorage.setItem('boendeKalkyl', JSON.stringify({ insats: BO_KALK.insats, ranta: BO_KALK.ranta })); } catch (e) {}
    renderBoende(); document.querySelector(`[data-bokalk="${k}"]`)?.focus();
  }
  else if (t.dataset.bosel) { BO_F[t.dataset.bosel] = t.value; renderBoende(); document.querySelector(`[data-bosel="${t.dataset.bosel}"]`)?.focus(); }
});

function renderBoende() {
  const el = $('boende'); if (!el) return;
  if (!BO) { loadBoende(); el.innerHTML = '<p class="rs-empty" style="margin-top:18px">Laddar bostäder …</p>'; return; }
  if (BO.laddar) { el.innerHTML = '<p class="rs-empty" style="margin-top:18px">Laddar bostäder …</p>'; return; }
  if (BO.fel) { el.innerHTML = '<p class="rs-empty" style="margin-top:18px">Bostäderna kunde inte laddas just nu.</p>'; return; }
  if (BO.tom) { el.innerHTML = '<p class="st-intro">Inga bostäder hämtade än. AI-rutinen läser Hemnet morgon och kväll (RUTIN.md, avsnitt 5d).</p>'; return; }
  boSparaF();
  const I = boInst(), L = boLista(), visa = BO_F.fler ? L.huvud : L.huvud.slice(0, 30);
  const ut = I.uteslutnaOmraden || {};
  el.innerHTML = `<p class="st-intro">Bostadsrätter med helst <b>${I.minRum ?? 3} rum</b>, utropspris högst <b>${kr(I.maxUtrop)}</b>, högst <b>${I.maxMinuter ?? 40} min</b> kollektivt till ${esc(I.mal?.namn)} (vardag, framme ${esc(I.ankomst || '08:30')}). Inte i Polisens utsatta områden (${[...(ut.sarskiltUtsatta || []), ...(ut.utsatta || []), ...(ut.egna || [])].length} st). Bonus för takterrass, vattenutsikt, balkong, nära centrum, låg avgift, unikt och gångavstånd till tunnelbana, pendeltåg eller spårvagn. Tvåor på minst ${I.bonus?.stor2a?.minKvm ?? 55} kvm (plats för arbetsplats) kommer först bland tvåorna. Gilla och ogilla så lär sig bevakningen.</p>`
    + boFilter()
    + `<div id="bo-karta" role="region" aria-label="Karta över bostäderna"></div>
      <p class="bo-forkl"><span><i style="background:#1b7a4c"></i>Hög poäng</span><span><i style="background:#4f8f6c"></i>Trea</span><span><i style="background:#8a9096"></i>Tvåa</span><span><i style="background:#34539e"></i>Gillad</span><span><i style="background:#e8742c"></i>Markerad</span><span><i style="background:#f0b15a;box-shadow:0 0 0 2px #1c1f22"></i>${esc(I.mal?.namn || 'Solna strand')}</span></p>`
    + `<section class="rs-sec"><div class="rs-h"><h2>${BO_F.rum === 'alla' ? 'Bostäder' : 'Treor och större'}</h2><span class="mal">${L.huvud.length} st · ${L.huvud.filter(a => boVal(a) === 'gilla').length} gillade</span></div>
       ${visa.length ? `<div class="st-grid">${visa.map(boKort).join('')}</div>` : '<div class="rs-empty">Inget passar filtret just nu.</div>'}
       ${L.huvud.length > 30 ? `<p class="rs-more"><button class="linkbtn" data-bofler>${BO_F.fler ? 'Visa färre' : `Visa alla (${L.huvud.length - 30} till)`}</button></p>` : ''}</section>`
    + (L.tvaor.length ? `<details class="rs-ov"><summary>Tvåor <span class="mute">(${L.tvaor.length} som klarar resten av kraven, ${L.tvaor.filter(a => a.bonus?.includes('stor2a')).length} stora med plats för arbetsplats)</span></summary><div class="st-grid">${L.tvaor.slice(0, 40).map(boKort).join('')}</div></details>` : '')
    + (L.ovriga.length ? `<details class="rs-ov"><summary>Annat vi hittat <span class="mute">(${L.ovriga.length} som inte klarar kraven)</span></summary><ul class="rs-list st-list">${L.ovriga.slice(0, 60).map(a => boKompakt(a, (a.kravMiss || []).join(', '))).join('')}</ul></details>` : '')
    + (L.ogillade.length ? `<details class="rs-ov"><summary>Ogillade <span class="mute">(${L.ogillade.length})</span></summary><ul class="rs-list st-list">${L.ogillade.map(a => boKompakt(a, [...(BOVAL[a.id]?.orsaker || []), BOVAL[a.id]?.text].filter(Boolean).join(', ') || 'ingen orsak angiven')).join('')}</ul></details>` : '')
    + boSalda()
    + `<div class="bo-msg" id="bo-msg" role="status"></div>${ghToken() ? '' : `<div class="bo-tok"><input id="bo-token" type="password" autocomplete="off" placeholder="GitHub-nyckel (github_pat_…)" aria-label="GitHub-nyckel"><button type="button" class="ark-btn" data-botoken>Spara nyckel</button><span class="hint">Behövs för att spara gilla/ogilla (samma nyckel som arkivet).</span></div>`}`
    + `<div class="rs-fot"><div>Uppdaterad ${rsTid(BO.d.uppdaterad)}. Från Hemnet och Booli (läses i webbläsaren av AI-rutinen morgon och kväll; samma bostad på båda visas en gång). Restiden kommer från SL:s reseplanerare; gångavståndet till tunnelbanan är ungefärligt.</div></div>`;
  boKarta([...L.huvud, ...L.tvaor]);
}

// Kartan: Leaflet via Stugors laddare (stLeaflet). Grön = klarar kraven med hög poäng, blå = gillad, grå = övriga.
let BO_MAP = null, BO_MARK = {}, BO_MARKAD = null;
// Markera ett korts punkt på kartan: större, mörk ring, överst. Med visa=true scrollas kartan fram och popupen öppnas.
function boMarkera(id, visa) {
  const ny = BO_MARK[id];
  if (BO_MARKAD && BO_MARKAD !== ny) BO_MARKAD.setStyle(BO_MARKAD.options.vanlig).setRadius(BO_MARKAD.options.vanligR);
  BO_MARKAD = ny || null; if (!ny) return;
  ny.setStyle({ color: '#1c1f22', weight: 4, fillColor: '#e8742c' }).setRadius(12).bringToFront();
  if (visa) { $('bo-karta').scrollIntoView({ behavior: 'smooth', block: 'center' }); BO_MAP.setView(ny.getLatLng(), Math.max(BO_MAP.getZoom(), 14)); ny.openPopup(); }
}
async function boKarta(lista) {
  const box = $('bo-karta'); if (!box) return;
  try { await stLeaflet(); } catch (e) { box.innerHTML = '<p class="rs-empty" style="padding:14px">Kartan kunde inte laddas.</p>'; return; }
  if (!box.isConnected) return; // sidan hann ritas om medan Leaflet laddades
  if (BO_MAP) { BO_MAP.remove(); BO_MAP = null; }
  const I = boInst(), map = BO_MAP = L.map(box, { scrollWheelZoom: false }).setView([I.mal.lat, I.mal.lon], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
  L.circleMarker([I.mal.lat, I.mal.lon], { radius: 9, color: '#1c1f22', weight: 3, fillColor: '#f0b15a', fillOpacity: 1 }).addTo(map).bindTooltip(I.mal.namn, { permanent: true, direction: 'right' });
  const pts = []; BO_MARK = {}; BO_MARKAD = null;
  for (const a of lista) {
    if (a.lat == null) continue;
    const g = boVal(a) === 'gilla', hog = a.poang >= (I.notisPoang ?? 6);
    const vanlig = { color: '#fff', weight: 2, fillColor: g ? '#34539e' : hog ? '#1b7a4c' : a.kategori === 'tvaa' ? '#8a9096' : '#4f8f6c' };
    const m = BO_MARK[a.id] = L.circleMarker([a.lat, a.lon], { ...vanlig, radius: g ? 9 : 7, fillOpacity: .95, vanlig, vanligR: g ? 9 : 7 }).addTo(map);
    m.bindPopup(`<div class="bo-pop">${a.bilder?.[0] ? `<img src="${esc(a.bilder[0])}" alt="" referrerpolicy="no-referrer">` : ''}<b>${kr(a.utrop)}</b><br>${esc(a.adress || '')}<br><span style="color:#646a70">${[a.rum && a.rum + ' rok', a.kvm && a.kvm + ' kvm', a.restid?.solnaStrand != null && a.restid.solnaStrand + ' min'].filter(Boolean).join(' · ')}</span><br><button type="button" data-boga="${esc(a.id)}">Visa kortet</button></div>`);
    pts.push([a.lat, a.lon]);
  }
  const passa = () => { if (map !== BO_MAP || !map.getContainer().isConnected) return; map.invalidateSize(); if (pts.length) map.fitBounds(L.latLngBounds([...pts, [I.mal.lat, I.mal.lon]]), { padding: [24, 24], maxZoom: 13, animate: false }); };
  passa(); requestAnimationFrame(passa); setTimeout(passa, 300);
}

async function boSparaVal(id, post) {
  const t = ghToken(); if (!t) throw Object.assign(new Error('Ingen GitHub-nyckel'), { noToken: true });
  const api = `https://api.github.com/repos/${REPO}/contents/${BO_VAL_FIL}`, head = { Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json' };
  for (let i = 0; i < 3; i++) {
    const r = await fetch(api + '?ref=main&t=' + Date.now(), { headers: head, cache: 'no-store' });
    if (r.status === 401 || r.status === 403) throw new Error('GitHub-nyckeln saknar behörighet till ' + REPO + '.');
    const cur = r.ok ? await r.json() : null;
    const data = cur?.content ? await decrypt(JSON.parse(atob(cur.content.replace(/\n/g, ''))), PASS) || {} : {};
    if (post) data[id] = post; else delete data[id];
    const body = { message: 'Boende: gilla/ogilla från sidan', branch: 'main', content: btoa(JSON.stringify(await encrypt(data, PASS)) + '\n'), ...(cur?.sha ? { sha: cur.sha } : {}) };
    const w = await fetch(api, { method: 'PUT', headers: { ...head, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (w.ok) return data;
    if (w.status !== 409 && w.status !== 422) throw new Error('GitHub svarade ' + w.status + '.');
  }
  throw new Error('Kunde inte spara, försök igen.');
}
async function boSatt(id, post) {
  const was = BOVAL[id];
  if (post) BOVAL[id] = post; else delete BOVAL[id];
  BO_F.ogilla = null; renderBoende();
  try { BOVAL = await boSparaVal(id, post); boendeKort(); }
  catch (e) {
    if (was) BOVAL[id] = was; else delete BOVAL[id];
    renderBoende();
    const m = $('bo-msg'); if (m) m.textContent = e.noToken ? 'Lägg in en GitHub-nyckel nedan för att kunna spara. Inget har ändrats.' : 'Kunde inte spara: ' + e.message;
  }
}
const boSnap = a => ({ adress: a.adress, omrade: a.omrade, lat: a.lat, lon: a.lon, rum: a.rum, kvm: a.kvm, utrop: a.utrop, avgift: a.avgift, vaning: a.vaning, bonus: a.bonus, restid: a.restid?.solnaStrand });
const BO_ORSAK_VALDA = new Set();
document.addEventListener('click', e => {
  if (!e.target.closest('#v-boende')) return;
  const nav = e.target.closest('button[data-stnav]');
  if (nav) { const s = nav.parentElement.querySelector('.st-strip'); s?.scrollBy({ left: +nav.dataset.stnav * s.clientWidth, behavior: 'smooth' }); return; }
  const b = e.target.closest('button'); if (!b) return;
  const D = b.dataset, A = BO?.d?.annonser || {};
  if ('boregrensa' in D) { Object.assign(BO_F, { max: 40, kvm: 0, avgift: 0, pris: 0, manad: 0 }); renderBoende(); }
  else if (D.bomast) { BO_F.mast.has(D.bomast) ? BO_F.mast.delete(D.bomast) : BO_F.mast.add(D.bomast); renderBoende(); }
  else if ('bomastrensa' in D) { BO_F.mast.clear(); renderBoende(); }
  else if ('bofler' in D) { BO_F.fler = !BO_F.fler; renderBoende(); }
  else if (D.bogilla) { const a = A[D.bogilla]; boSatt(D.bogilla, boVal(a) === 'gilla' ? null : { val: 'gilla', datum: new Date().toISOString().slice(0, 10), snap: boSnap(a) }); }
  else if (D.boogilla) {
    if (boVal(A[D.boogilla]) === 'ogilla') { boSatt(D.boogilla, null); return; }
    BO_F.ogilla = D.boogilla; BO_ORSAK_VALDA.clear(); renderBoende(); document.getElementById('bo-text')?.focus();
  }
  else if (D.boorsak) { const p = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', p); p ? BO_ORSAK_VALDA.add(D.boorsak) : BO_ORSAK_VALDA.delete(D.boorsak); }
  else if (D.bospara) { const a = A[D.bospara]; boSatt(D.bospara, { val: 'ogilla', datum: new Date().toISOString().slice(0, 10), orsaker: [...BO_ORSAK_VALDA], text: ($('bo-text')?.value || '').trim(), snap: boSnap(a) }); }
  else if ('boavbryt' in D) { BO_F.ogilla = null; renderBoende(); }
  else if (D.boangra) boSatt(D.boangra, null);
  else if (D.bokarta) { const a = A[D.bokarta]; if (BO_MAP && a) { $('bo-karta').scrollIntoView({ behavior: 'smooth', block: 'center' }); boMarkera(a.id, true); } }
  else if (D.boga) { BO_F.markerad = D.boga; boMarkera(D.boga); const k = $('bo-' + D.boga); document.querySelectorAll('.bo-card.markerad').forEach(x => x.classList.remove('markerad')); if (k) { k.classList.add('markerad'); k.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }
  else if ('botoken' in D) { const v = ($('bo-token')?.value || '').trim(); if (v) { try { localStorage.setItem('pb-gh-token', v); } catch (err) {} renderBoende(); } }
});
// Bildräknaren följer svepningen (som i Stugor)
document.addEventListener('scroll', e => {
  const s = e.target; if (!s.classList?.contains('st-strip') || !s.closest('#v-boende')) return;
  const c = s.parentElement.querySelector('.st-cnt'); if (c) c.textContent = `${Math.round(s.scrollLeft / s.clientWidth) + 1}/${s.children.length}`;
}, true);

// Översiktskortet och antalet i fliken
function boendeKort() {
  const el = $('ov-boende'); if (!el) return;
  if (!BO) { loadBoende(); el.innerHTML = '<h3>Boende<span>laddar …</span></h3>'; return; }
  if (BO.laddar) { el.innerHTML = '<h3>Boende<span>laddar …</span></h3>'; return; }
  if (BO.fel || BO.tom) { el.innerHTML = `<h3>Boende<span>→</span></h3><div class="row"><span>${BO.tom ? 'Inga bostäder hämtade än' : 'Kunde inte laddas just nu'}</span></div>`; return; }
  const A = Object.values(BO.d.annonser || {}), h = A.filter(a => a.kategori === 'huvud' && boVal(a) !== 'ogilla');
  const I = boInst(), bast = [...h].sort((a, b) => b.poang - a.poang)[0];
  $('n-boende').textContent = h.length || '';
  el.innerHTML = `<h3>Boende<span>${h.length} treor+ →</span></h3>
    <div class="big num">${bast ? kr(bast.utrop) : '–'}</div>
    <div class="row"><span>${bast ? `Bäst just nu: ${esc(bast.omrade || bast.adress)}, ${bast.restid?.solnaStrand ?? '?'} min` : 'Inget som klarar kraven än'}</span></div>
    <div class="row"><span>Nya senaste 2 dagarna</span><b>${h.filter(boNy).length || '–'}</b></div>
    <div class="row"><span>Gillade</span><b>${A.filter(a => boVal(a) === 'gilla').length || '–'}</b></div>
    <div class="row"><span>Budgivning pågår</span><b>${h.filter(a => a.status === 'budgivning').length || '–'}</b></div>`;
}

// Pekare över ett kort markerar dess punkt på kartan
document.addEventListener('mouseover', e => {
  if (!BO_MAP) return;
  const k = e.target.closest?.('#v-boende .bo-card'); if (!k) return;
  const id = k.id.replace(/^bo-/, ''); if (BO_MARK[id] !== BO_MARKAD) boMarkera(id);
});
