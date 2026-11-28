// Resebevakningens dagliga jobb (utan AI): hämtar källorna med hamtning "dator" i resor/kallor.json,
// kategoriserar, sparar data/resor.json, publicerar och skickar pushnotis för nya fynd under målet.
// Källor som kräver webbläsare läser AI-rutinen (RUTIN.md, avsnittet Resor) och lägger i inkorgen.
//
//   node resor/run.mjs              hämta, spara, committa och pusha, skicka notiser
//   node resor/run.mjs --no-push    hämta och spara lokalt, ingen commit och inga notiser
//   node resor/run.mjs --bara=nazar bara en källa
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, PATHS, loadAll, writeJson, classify, finish, mergeSource, pickNotices, today, PAGE } from './lib.mjs';

const push = !process.argv.includes('--no-push');
const bara = (process.argv.find(a => a.startsWith('--bara=')) || '').slice(7);
const HOME = (process.env.AUTOMATION_HOME || 'C:/Users/TimLi/Dev/Automation').replace(/\\/g, '/');
const fetchLib = await import('file:///' + HOME + '/lib/fetch.mjs');
const log = (...a) => console.log(new Date().toLocaleTimeString('sv-SE'), ...a);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

if (push) { git('pull', '--rebase', '--autostash', '-q'); log('git pull klart'); }
const { db, inst, kallor, klimat } = await loadAll();
const ctx = { getText: fetchLib.getText, getJson: fetchLib.getJson, inst, today };
const problems = [];

for (const src of kallor.kallor.filter(k => k.aktiv && k.hamtning === 'dator' && (!bara || k.id === bara))) {
  const file = path.join(ROOT, 'resor', 'kallor', `${src.parser}.mjs`);
  if (!existsSync(file)) { problems.push(`${src.namn}: parsern ${src.parser}.mjs saknas`); continue; }
  try {
    // Tidsgräns per källa: en källa som väntar in sajtens timtak får inte stoppa resten (jobbet avbryts efter 15 min)
    const mod = await import('file:///' + file.replace(/\\/g, '/'));
    let timer;
    const res = await Promise.race([
      mod.default(src, ctx),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('tog över 6 min (troligen sajtens timtak), hoppar över')), 6 * 60e3); })
    ]).finally(() => clearTimeout(timer));
    const list = (res.erbjudanden || []).map(o => classify(finish({ kallaNamn: src.namn, ...o }, inst), inst, klimat));
    if (list.length || res.full) mergeSource(db, src.id, list, { full: !!res.full });
    if (res.malaga) {
      const prev = db.malaga || {}, b = res.malaga.basta;
      const lagsta = prev.lagsta && (!b || prev.lagsta.pris <= b.pris) ? prev.lagsta : b ? { ...b, sedd: today() } : null;
      const historik = (prev.historik || []).filter(h => h[0] !== today());
      if (b) historik.push([today(), b.pris]);
      db.malaga = { ...res.malaga, lagsta, historik: historik.slice(-400) };
      db.kallstatus[src.id] = { senast: new Date().toISOString(), antal: Object.keys(res.malaga.manader).length };
    }
    if (res.flygFran) db.flygFran = res.flygFran;
    log(`${src.namn}: ${list.length} erbjudanden${res.malaga?.basta ? `, Malaga billigast ${res.malaga.basta.pris} kr T/R per person (${res.malaga.basta.fran} ${res.malaga.basta.ut}–${res.malaga.basta.hem})` : ''}`);
  } catch (e) {
    problems.push(`${src.namn}: ${e.message}`);
    db.kallstatus[src.id] = { ...(db.kallstatus[src.id] || {}), fel: e.message, felTid: new Date().toISOString() };
  }
}

// Klimattabellen kan ha fyllts på av AI:n: kategorisera om allt som finns
db.erbjudanden = db.erbjudanden.map(o => classify(o, inst, klimat));
const notices = pickNotices(db, inst);
db.uppdaterad = new Date().toISOString();
db.installningar = inst;
await writeJson(PATHS.data, db);

const byCat = c => db.erbjudanden.filter(o => o.kategori === c && !o.borta).length;
log(`Sparat: weekend ${byCat('weekend')}, vecka ${byCat('vecka')}, långresa ${byCat('lang')}, totalt ${db.erbjudanden.length}`);
problems.forEach(p => log('PROBLEM', p));
notices.forEach(n => log('NOTIS', n));

if (!push) { log('--no-push: committar inte och skickar inga notiser'); process.exit(problems.length ? 3 : 0); }
git('add', 'data/resor.json');
if (git('status', '--porcelain', 'data/resor.json')) {
  git('commit', '-q', '-m', `Resor ${new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }).slice(0, 16)} (automatisk)`);
  try { git('push', '-q'); } catch { git('pull', '--rebase', '-q'); git('push', '-q'); }
  log('Publicerat');
}
if (notices.length) {
  try {
    const { notify } = await import('file:///' + HOME + '/lib/notify.mjs');
    if (await notify('prisbevakning', notices.join('\n') + '\n' + PAGE)) log('Pushnotis skickad via Homey');
  } catch (e) { log('PROBLEM pushnotis: ' + e.message); }
}
process.exit(problems.length ? 3 : 0);
