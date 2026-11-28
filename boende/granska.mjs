// Granskning av bostäderna mot rådatan och taggdefinitionerna (boende/GRANSKNING.md beskriver arbetet).
//
//   PRIS_KOD=... node boende/granska.mjs --paket [--antal 25] [--bara huvud|tvaa|alla] [--ut katalog]
//       Skriver granskningspaket (JSON) för agenter: bostäder som inte granskats än (huvudlistan först, högst poäng först),
//       med nuvarande värden och taggar, och allt rådata från varje källa (hela annonstexten).
//   node boende/granska.mjs --las fil.json [fil2.json …]
//       Läser agenternas svar ({ granskning: { "<id>": { taggar, falt, kommentar } } }) och lägger in dem i
//       data/boende-granskning.json. Datorns inkorgsjobb gör samma sak för inbox/boende-granskning-*.json via merge.mjs.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PATHS, loadAll, lasRa, lasGranskning, lasTaggar, writeJson } from './lib.mjs';

const arg = process.argv.slice(2), val = k => { const i = arg.indexOf(k); return i >= 0 ? arg[i + 1] : null; };

// Lägger in granskade rättelser (används också av merge.mjs)
export async function laggInGranskning(svar, av = 'agent') {
  const G = await lasGranskning(), idag = new Date().toISOString().slice(0, 10);
  let n = 0;
  for (const [id, g] of Object.entries(svar || {})) {
    if (!g || typeof g !== 'object') continue;
    const ut = G[id] ||= {};
    for (const del of ['taggar', 'falt']) for (const [k, r] of Object.entries(g[del] || {})) {
      if (!r || typeof r !== 'object' || !('varde' in r)) continue;
      (ut[del] ||= {})[k] = { ...r, granskad: r.granskad || idag, av: r.av || av };
    }
    if (g.kommentar) ut.kommentar = String(g.kommentar).slice(0, 1000);
    ut.granskad = idag; n++;
  }
  await writeJson(PATHS.granskning, Object.fromEntries(Object.entries(G).sort(([a], [b]) => a.localeCompare(b))));
  return n;
}

if (arg.includes('--las')) {
  let n = 0;
  for (const f of arg.slice(arg.indexOf('--las') + 1).filter(x => !x.startsWith('--'))) n += await laggInGranskning(JSON.parse(await readFile(f, 'utf8')).granskning);
  console.log(`${n} granskade bostäder inlagda i ${PATHS.granskning}`);
}

if (arg.includes('--paket')) {
  const { db } = await loadAll(process.env.PRIS_KOD), G = await lasGranskning(), T = await lasTaggar();
  const antal = +(val('--antal') || 25), bara = val('--bara') || 'huvud', ut = val('--ut') || path.join(PATHS.ra, '..', '..', 'granskning-paket');
  const textTaggar = T.taggar.filter(t => t.granskas === 'text').map(t => t.id);
  const ra = {};
  const lista = Object.values(db.annonser)
    .filter(a => !G[a.id] && (bara === 'alla' ? a.kategori !== 'ovriga' : a.kategori === bara))
    .sort((a, b) => (b.poang || 0) - (a.poang || 0));
  await mkdir(ut, { recursive: true });
  let nr = 0;
  for (let i = 0; i < lista.length; i += antal) {
    const paket = [];
    for (const a of lista.slice(i, i + antal)) {
      const kallor = {};
      for (const k of [{ kalla: a.kalla, kod: a.kod, url: a.url }, ...(a.ocksa || [])]) {
        ra[k.kalla] ||= await lasRa(k.kalla);
        kallor[k.kalla] = { url: k.url, ...(ra[k.kalla][k.kod]?.falt || {}) };
        delete kallor[k.kalla].bilder;
      }
      paket.push({ id: a.id, adress: a.adress, omrade: a.omrade, kommun: a.kommun,
        nu: { rum: a.rum, kvm: a.kvm, avgift: a.avgift, utrop: a.utrop ?? null, vaning: a.vaning ?? null, status: a.status, kommande: !!a.kommande,
          taggar: Object.fromEntries(textTaggar.map(id => [id, (a.bonus || []).includes(id)])) },
        kallor });
    }
    await writeFile(path.join(ut, `paket-${String(++nr).padStart(3, '0')}.json`), JSON.stringify({ taggar: T.taggar.filter(t => t.granskas === 'text'), falt: T.falt, bostader: paket }, null, 1));
  }
  console.log(`${lista.length} bostäder (${bara}) i ${nr} paket à ${antal} i ${ut}`);
}
