// Delar upp felaktiga sammanslagningar: bostäder från olika källor som slogs ihop fast adresserna skiljer
// (annat husnummer, eller annan gata längre bort än 15 m). Den felkopplade källan tas bort ur "ocksa" och skrivs ut i
// inkorgsformat (från rådatan i data/boende-ra), så att en vanlig sammanslagning lägger in den som en egen bostad.
//
//   PRIS_KOD=... node boende/dela.mjs > boende-delade.json      och sedan   node boende/merge.mjs boende-delade.json
import { loadAll, saveDb, lasRa, norm } from './lib.mjs';
import { meter } from './sl.mjs';

const pass = process.env.PRIS_KOD;
const { db } = await loadAll(pass);
const gata = s => norm(String(s || '').split(',')[0]).replace(/\s*\d.*$/, '').replace(/[^a-z]/g, '');
const nr = s => (norm(String(s || '').split(',')[0]).match(/\d+\s*[a-z]?\b/) || [''])[0].replace(/\s/g, '');
const ra = {}, ut = [];
let delade = 0;
for (const a of Object.values(db.annonser)) {
  if (!a.ocksa?.length || !a.adress) continue;
  const kvar = [];
  for (const x of a.ocksa) {
    ra[x.kalla] ||= await lasRa(x.kalla);
    const o = ra[x.kalla][x.kod]?.falt;
    const fel = o?.adress && ((nr(a.adress) && nr(o.adress) && nr(a.adress) !== nr(o.adress))
      || (gata(a.adress) !== gata(o.adress) && !(o.lat != null && a.lat != null && meter([a.lat, a.lon], [+o.lat, +o.lon]) <= 15)));
    if (fel) { ut.push(o); delete db.alias?.[`${x.kalla}-${x.kod}`]; delade++; console.error(`${a.adress} (${a.id}) ≠ ${o.adress} (${x.kalla}-${x.kod})`); }
    else kvar.push(x);
  }
  if (kvar.length !== a.ocksa.length) { a.ocksa = kvar; if (!kvar.length) delete a.ocksa; }
}
if (delade) await saveDb(db, pass);
console.error(`${delade} felkopplade källor delade`);
console.log(JSON.stringify({ annonser: ut }));
