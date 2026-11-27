// Prisbevakningens lokala jobb: hämtar priser utan AI, kontrollerar dem, uppdaterar databasen och publicerar.
// Körs av den gemensamma jobbköraren (se Automation-mappen), men går också att köra för hand:
//
//   PRIS_KOD=... node local/run.mjs            hämta, uppdatera, committa och pusha
//   PRIS_KOD=... node local/run.mjs --no-push  hämta och uppdatera, men committa/pusha inte
//
// Tradera har botspärr mot annat än webbläsare och hämtas därför inte här (Claude-rutinen tar det i Chrome).
// Butiker utanför Prisjakt (collector/extra-shops.json) kollas också av Claude-rutinen.

import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { decryptJson } from '../tools/crypt.mjs';
import { readArkiv } from '../tools/arkiv.mjs';
import { pjCollect, pjCompact, blSearch, Blocked, blocketNeeds } from './sources.mjs';

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

// 0. Senaste versionen
if (push) { git('pull', '--rebase', '--autostash', '-q'); log('git pull klart'); }

// Inkorg från Claude-rutinen (PRIS_INBOX). Rutinen pushar aldrig själv; den lägger sina resultat här
// och det här jobbet tillämpar dem och publicerar:
//   products.json      ny produktlista (från Todoist-synken)          -> update.mjs --set-products
//   extra-shops.json   uppdaterad butikslista                         -> collector/extra-shops.json
//   run-*.json         {"tradera":..., "extra":..., "prisjakt"?:...}  -> update.mjs
// Tillämpade filer flyttas till inkorgens done\-mapp.
const INBOX = process.env.PRIS_INBOX;
async function applyInbox() {
  if (!INBOX) return [];
  await mkdir(INBOX, { recursive: true });
  const names = (await readdir(INBOX)).filter(f => /^(products|extra-shops)\.json$|^(run|resor|stugor)-.*\.json$/.test(f)).sort();
  const applied = [];
  const doneDir = path.join(INBOX, 'done'); await mkdir(doneDir, { recursive: true });
  const order = ['products.json', 'extra-shops.json', ...names.filter(f => f.startsWith('run-')), ...names.filter(f => f.startsWith('resor-')), ...names.filter(f => f.startsWith('stugor-'))].filter(f => names.includes(f));
  for (const f of order) {
    const src = path.join(INBOX, f);
    try {
      const txt = await readFile(src, 'utf8'); JSON.parse(txt); // måste vara giltig JSON
      if (f === 'products.json') execFileSync(process.execPath, [path.join(ROOT, 'tools', 'update.mjs'), '--set-products', src], { cwd: ROOT, env: process.env, encoding: 'utf8' });
      else if (f === 'extra-shops.json') await writeFile(path.join(ROOT, 'collector', 'extra-shops.json'), txt);
      else if (f.startsWith('resor-') || f.startsWith('stugor-')) {
        // Resebevakningen (resor/merge.mjs: AI-rutinens fynd och Reseguiden-skriptets filer) och stugbevakningen (stugor/merge.mjs)
        const del = f.startsWith('resor-') ? 'resor' : 'stugor';
        const r = execFileSync(process.execPath, [path.join(ROOT, del, 'merge.mjs'), src], { cwd: ROOT, env: process.env, encoding: 'utf8' }).trim();
        log(r.split('\n').filter(l => !l.startsWith('NOTIS ')).join('\n'));
        (del === 'resor' ? RESNOTIS : STUGNOTIS).push(...r.split('\n').filter(l => l.startsWith('NOTIS ')).map(l => l.slice(6)));
      }
      else log('Från rutinen:\n' + execFileSync(process.execPath, [path.join(ROOT, 'tools', 'update.mjs'), src], { cwd: ROOT, env: process.env, encoding: 'utf8' }).trim());
      await rename(src, path.join(doneDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${f}`));
      applied.push(f);
    } catch (e) {
      log(`PROBLEM inkorg ${f}: ${e.message.split('\n')[0]} – lämnas kvar`);
      await rename(src, path.join(INBOX, `fel-${f}`)).catch(() => {});
    }
  }
  if (applied.length) log('Tillämpat från inkorgen: ' + applied.join(', '));
  return applied;
}
const RESNOTIS = [], STUGNOTIS = [];
async function publish(msg) {
  const FILER = ['data/data.enc.json', 'collector/extra-shops.json', 'data/resor.json', 'resor/klimat.json', 'resor/kallor.json', 'data/stugor.json', 'stugor/kallor.json', 'data/stugor-roster.json'];
  git('add', ...FILER);
  if (!git('status', '--porcelain', ...FILER)) { log('Ingen ändring att publicera'); return; }
  git('commit', '-q', '-m', msg);
  try { git('push', '-q'); }
  catch (e) { log('Push nekades, hämtar och försöker igen'); git('pull', '--rebase', '-q'); git('push', '-q'); }
  log('Publicerat');
}
// Nya "Missa inte"-köplägen (tools/update.mjs skriver koplagen.json i jobbets utmapp) går som pushnotis via Homey
// (Automation/lib/notify.mjs). Bara köplägen från den här körningen, och bara när sidan är publicerad.
const START = new Date().toISOString();
async function pushDeals() {
  // Rese- och stugfynd från inkorgen (resor/merge.mjs, stugor/merge.mjs) skickas i egna notiser
  for (const [lista, vy, vad] of [[RESNOTIS, 'resor', 'Resenotis'], [STUGNOTIS, 'stugor', 'Stugnotis']]) if (lista.length) try {
    const home = process.env.AUTOMATION_HOME || 'C:/Users/TimLi/Dev/Automation';
    const { notify } = await import('file:///' + home.replace(/\\/g, '/') + '/lib/notify.mjs');
    if (await notify('prisbevakning', lista.join('\n') + '\nhttps://timpan8.github.io/Prisbevakning/#/' + vy)) log(vad + ' skickad via Homey:\n' + lista.join('\n'));
    lista.length = 0;
  } catch (e) { log('PROBLEM ' + vad.toLowerCase() + ' via Homey: ' + e.message); }
  let k; try { k = JSON.parse(await readFile(path.join(OUT_DIR, 'koplagen.json'), 'utf8')); } catch { return; }
  if (!k.notis || k.tid < START) return;
  try {
    const home = process.env.AUTOMATION_HOME || 'C:/Users/TimLi/Dev/Automation';
    const { notify } = await import('file:///' + home.replace(/\\/g, '/') + '/lib/notify.mjs');
    if (await notify('prisbevakning', k.notis + '\nhttps://timpan8.github.io/Prisbevakning/')) log('Pushnotis skickad via Homey:\n' + k.notis);
  } catch (e) { log('PROBLEM pushnotis via Homey: ' + e.message); }
}
const fromInbox = await applyInbox();
// Nedröstningar på fliken Stugor (stugor/roster.mjs): ntfy behåller dem 12 h, här sparas de i repot
let nyaRoster = 0;
try { const { syncRoster } = await import('../stugor/roster.mjs'); nyaRoster = await syncRoster(); if (nyaRoster) log(`Stugor: ${nyaRoster} nya röster`); }
catch (e) { log('PROBLEM röster (ntfy): ' + e.message); }
if (process.argv.includes('--inbox-only')) {
  if ((fromInbox.length || nyaRoster) && push) { await publish(`Granskning ${new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }).slice(0, 16)} (från Claude-rutinen)`); await pushDeals(); }
  process.exit(0);
}

const db = await decryptJson(JSON.parse(await readFile(DB_FILE, 'utf8')), pass);
// Arkiverade varor (köpta eller som Tim slutat bevaka på sidan) hämtas inte
const ARK = await readArkiv(pass);
const nArk = db.products.filter(p => ARK[p.key]).length;
db.products = db.products.filter(p => !ARK[p.key]);
log(`${db.products.length} varor i bevakningen${nArk ? `, ${nArk} i arkivet` : ''}`);
// Anmäl Blocket-sökorden till det gemensamma Blocket-jobbet (som hämtar dem i förväg, en gång för alla projekt)
// Sökprofilen (sokprofil, satt av AI:n när varan kartlades) styr källorna: Prisjakt bara om varan finns där,
// Blocket bara om varan ska sökas begagnad. Varor utan sokprofil behandlas som förut.
const onPj = p => !!p.prisjaktId && p.sokprofil?.prisjakt !== false;
const onUsed = p => !!p.blocket && p.sokprofil?.begagnat !== false;
const pjProducts = db.products.filter(onPj);
await blocketNeeds('prisbevakning', db.products.filter(onUsed).map(p => p.blocket.q));

// 1. Hämta. En sajt i taget per vara; sources.mjs håller pausen mellan förfrågningar till samma sajt.
const run = { prisjakt: {}, blocket: {} };
const problems = [], notes = [];
for (const p of db.products) {
  const prev = db.latest[p.key] || {};
  const history = (prev.histFetched || '') !== today();
  if (onPj(p)) try {
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
  if (onUsed(p)) {
    try { run.blocket[p.key] = (await blSearch(p.blocket.q, p.blocket.must, p.blocket.min)).best; }
    catch (e) { problems.push(`${p.name}: Blocket – ${e.message}`); }
  }
}

const got = Object.keys(run.prisjakt).length;
log(`Prisjakt: ${got}/${pjProducts.length} varor (${db.products.length - pjProducts.length} finns inte där), Blocket: ${Object.keys(run.blocket).length}`);
problems.forEach(x => log('PROBLEM', x));
notes.forEach(x => log('GRANSKA', x));

// 2. Spara körningen (för felsökning och för Claude-rutinens granskning)
await mkdir(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
const runFile = path.join(OUT_DIR, `run-${stamp}.json`);
await writeFile(runFile, JSON.stringify(run));
await writeFile(path.join(OUT_DIR, 'senaste-kontroll.json'), JSON.stringify({ tid: new Date().toISOString(), varor: db.products.length, prisjakt: got, problem: problems, granska: notes }, null, 2));

// Publicera inte om mer än hälften av varorna saknas – då är något trasigt
if (pjProducts.length && got < Math.ceil(pjProducts.length / 2)) {
  log('Stoppar: för få varor hämtades, publicerar inget');
  process.exit(1);
}

// 3. Uppdatera databasen med samma verktyg som tidigare
const summary = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'update.mjs'), runFile], { cwd: ROOT, env: process.env, encoding: 'utf8' });
log('Uppdaterat:\n' + summary.trim());

// 4. Committa och pusha
if (!push) { log('--no-push: committar inte'); process.exit(problems.length ? 3 : 0); }
const when = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }).slice(0, 16);
await publish(`Prisuppdatering ${when} (automatisk)`);
await pushDeals();
process.exit(problems.length ? 3 : 0); // 3 = klart men med varningar
