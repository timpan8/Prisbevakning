// Prisbevakningens lokala jobb: hämtar priser utan AI, kontrollerar dem, uppdaterar databasen och publicerar.
// Körs av den gemensamma jobbköraren (se Automation-mappen), men går också att köra för hand:
//
//   PRIS_KOD=... node local/run.mjs            hämta, uppdatera, committa och pusha
//   PRIS_KOD=... node local/run.mjs --no-push  hämta och uppdatera, men committa/pusha inte
//
// Tradera har botspärr mot annat än webbläsare och hämtas därför inte här (Claude-rutinen tar det i Chrome).
// Butiker utanför Prisjakt (collector/extra-shops.json) kollas också av Claude-rutinen.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { decryptJson } from '../tools/crypt.mjs';
import { pjCollect, pjCompact, blSearch, Blocked } from './sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = path.join(ROOT, 'data', 'data.enc.json');
const OUT_DIR = process.env.JOB_OUT_DIR || path.join(os.tmpdir(), 'prisbevakning-runs');
const push = !process.argv.includes('--no-push');
const pass = process.env.PRIS_KOD;
if (!pass) { console.error('PRIS_KOD saknas (sätts av jobbköraren från hemligheten PRIS_KOD)'); process.exit(2); }

const log = (...a) => console.log(new Date().toLocaleTimeString('sv-SE'), ...a);
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
const total = o => o[1] + (o[2] ?? 49);

// 0. Senaste versionen (Claude-rutinen kan ha lagt till varor eller extra-priser)
if (push) { git('pull', '--rebase', '--autostash', '-q'); log('git pull klart'); }

const db = await decryptJson(JSON.parse(await readFile(DB_FILE, 'utf8')), pass);
log(`${db.products.length} varor i bevakningen`);

// 1. Hämta. En sajt i taget per vara; sources.mjs håller pausen mellan förfrågningar till samma sajt.
const run = { prisjakt: {}, blocket: {} };
const problems = [], notes = [];
for (const p of db.products) {
  const prev = db.latest[p.key] || {};
  const history = (prev.histFetched || '') !== today();
  try {
    const v = pjCompact(await pjCollect(p.prisjaktId, history));
    // Rimlighetskoll mot förra körningen innan något publiceras
    const before = (prev.offers || []).filter(o => o.src !== 'extra');
    if (!v.offers.length && before.length >= 3) {
      problems.push(`${p.name}: Prisjakt gav 0 butiker (förra gången ${before.length}) – behåller gamla priser`);
    } else {
      if (before.length) {
        const was = Math.min(...before.map(o => o.price + (o.ship ?? 49)));
        const now = v.offers.length ? total(v.offers[0]) : null;
        if (now && (now < was * 0.5 || now > was * 1.6)) notes.push(`${p.name}: billigaste pris ändrades kraftigt ${was} → ${now} kr – granska`);
      }
      if (v.name && prev.name && v.name !== prev.name) notes.push(`${p.name}: Prisjakt-namnet är nu "${v.name}" – kontrollera att det är rätt produkt`);
      run.prisjakt[p.key] = v;
    }
  } catch (e) {
    problems.push(`${p.name}: Prisjakt – ${e.message}`);
    if (e instanceof Blocked) break; // spärrad: sluta fråga Prisjakt den här körningen
  }
  if (p.blocket) {
    try { run.blocket[p.key] = (await blSearch(p.blocket.q, p.blocket.must, p.blocket.min)).best; }
    catch (e) { problems.push(`${p.name}: Blocket – ${e.message}`); }
  }
}

const got = Object.keys(run.prisjakt).length;
log(`Prisjakt: ${got}/${db.products.length} varor, Blocket: ${Object.keys(run.blocket).length}`);
problems.forEach(x => log('PROBLEM', x));
notes.forEach(x => log('GRANSKA', x));

// 2. Spara körningen (för felsökning och för Claude-rutinens granskning)
await mkdir(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
const runFile = path.join(OUT_DIR, `run-${stamp}.json`);
await writeFile(runFile, JSON.stringify(run));
await writeFile(path.join(OUT_DIR, 'senaste-kontroll.json'), JSON.stringify({ tid: new Date().toISOString(), varor: db.products.length, prisjakt: got, problem: problems, granska: notes }, null, 2));

// Publicera inte om mer än hälften av varorna saknas – då är något trasigt
if (db.products.length && got < Math.ceil(db.products.length / 2)) {
  log('Stoppar: för få varor hämtades, publicerar inget');
  process.exit(1);
}

// 3. Uppdatera databasen med samma verktyg som tidigare
const summary = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'update.mjs'), runFile], { cwd: ROOT, env: process.env, encoding: 'utf8' });
log('Uppdaterat:\n' + summary.trim());

// 4. Committa och pusha
if (!push) { log('--no-push: committar inte'); process.exit(problems.length ? 3 : 0); }
git('add', 'data/data.enc.json');
if (!git('status', '--porcelain', 'data/data.enc.json')) { log('Ingen ändring att publicera'); process.exit(0); }
const when = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }).slice(0, 16);
git('commit', '-q', '-m', `Prisuppdatering ${when} (automatisk)`);
try { git('push', '-q'); }
catch (e) { log('Push nekades, hämtar och försöker igen'); git('pull', '--rebase', '-q'); git('push', '-q'); }
log('Publicerat');
process.exit(problems.length ? 3 : 0); // 3 = klart men med varningar
