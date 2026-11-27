// Stugbevakningens dagliga jobb (utan AI): hämtar källorna med hamtning "dator" i stugor/kallor.json,
// bedömer husen (bubbelpool, bäddar, restid, bonus), sparar data/stugor.json, publicerar och skickar pushnotis
// för hus som klarar kraven under målpriset. Sajter som kräver webbläsare läser AI-rutinen (RUTIN.md, 5c).
//
//   node stugor/run.mjs                hämta, spara, committa och pusha, skicka notiser
//   node stugor/run.mjs --no-push      hämta och spara lokalt, ingen commit och inga notiser
//   node stugor/run.mjs --helger=2     bara de två närmaste helgerna (för test)
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, PATHS, PAGE, loadAll, writeJson, helger, mergeHus, mergeErbjudanden, bedomAlla, pickNotices } from './lib.mjs';

const push = !process.argv.includes('--no-push');
const antal = +(process.argv.find(a => a.startsWith('--helger=')) || '').slice(9) || null;
const HOME = (process.env.AUTOMATION_HOME || 'C:/Users/TimLi/Dev/Automation').replace(/\\/g, '/');
const fetchLib = await import('file:///' + HOME + '/lib/fetch.mjs');
const log = (...a) => console.log(new Date().toLocaleTimeString('sv-SE'), ...a);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

if (push) { git('pull', '--rebase', '--autostash', '-q'); log('git pull klart'); }
const { db, inst, kallor } = await loadAll();
const H = helger(inst).slice(0, antal || undefined);
const ctx = { getText: fetchLib.getText, getJson: fetchLib.getJson, inst, db, helger: H, log };
const problems = [];

for (const src of kallor.kallor.filter(k => k.aktiv && k.hamtning === 'dator')) {
  const file = path.join(ROOT, 'stugor', 'kallor', `${src.parser}.mjs`);
  if (!existsSync(file)) { problems.push(`${src.namn}: parsern ${src.parser}.mjs saknas`); continue; }
  try {
    const res = await (await import('file:///' + file.replace(/\\/g, '/'))).default(src, ctx);
    mergeHus(db, res.hus || [], inst);
    mergeErbjudanden(db, src.id, res.erbjudanden || [], { full: !!res.full && !antal, helger: res.helger });
    if (res.fel?.length) { problems.push(`${src.namn}: ${res.fel.length} fel, t.ex. ${res.fel[0]}`); db.kallstatus[src.id].varning = res.fel.slice(0, 3).join('; '); }
    else delete db.kallstatus[src.id].varning;
    log(`${src.namn}: ${res.info || (res.erbjudanden || []).length + ' erbjudanden'}`);
  } catch (e) {
    problems.push(`${src.namn}: ${e.message}`);
    db.kallstatus[src.id] = { ...(db.kallstatus[src.id] || {}), fel: e.message, felTid: new Date().toISOString() };
  }
}

bedomAlla(db, inst);
const forra = JSON.stringify(db.notiserade || {});
const notices = pickNotices(db, inst);
if (!push) db.notiserade = JSON.parse(forra); // provkörning: inget skickas, så inget räknas som notifierat
db.uppdaterad = new Date().toISOString();
db.installningar = inst;
await writeJson(PATHS.data, db);

const hus = Object.values(db.hus), ok = hus.filter(h => h.kravOk);
const aktiva = db.erbjudanden.filter(o => !o.borta);
log(`Sparat: ${hus.length} hus (${ok.length} klarar kraven), ${aktiva.length} helgpriser, ${aktiva.filter(o => db.hus[o.hus]?.kravOk && o.pris <= inst.mal).length} under målet`);
problems.forEach(p => log('PROBLEM', p));
notices.forEach(n => log('NOTIS', n));

if (!push) { log('--no-push: committar inte och skickar inga notiser'); process.exit(problems.length ? 3 : 0); }
git('add', 'data/stugor.json');
if (git('status', '--porcelain', 'data/stugor.json')) {
  git('commit', '-q', '-m', `Stugor ${new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }).slice(0, 16)} (automatisk)`);
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
