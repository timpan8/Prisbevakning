// Status för pågående jobb (sammanslagning, restider, annonstexter, hämtningar i Chrome) som förloppsindikatorer.
//
//   import { jobb } from '../local/jobbstatus.mjs';  const j = jobb('sl', 'Restider från SL', 873);  j.steg(); … j.klar();
//   node local/jobbstatus.mjs [port]            visar http://localhost:8780 (uppdateras varje sekund)
//   node local/jobbstatus.mjs --satt id "Namn" klara totalt [text]    sätter ett jobb för hand (t.ex. Chrome-hämtningar)
// Statusen ligger i Automation/state/jobbstatus.json (inte i repot). Klara jobb visas i en timme.
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = (process.env.AUTOMATION_HOME || 'C:/Users/TimLi/Dev/Automation').replace(/\\/g, '/');
const FIL = path.join(HOME, 'state', 'jobbstatus.json');
const las = () => { try { return JSON.parse(readFileSync(FIL, 'utf8')); } catch { return {}; } };
function skriv(id, d) {
  const s = las(), nu = Date.now();
  s[id] = { ...(s[id] || {}), ...d, uppdaterad: nu };
  for (const [k, v] of Object.entries(s)) if (v.slut && nu - v.slut > 3600e3) delete s[k];
  mkdirSync(path.dirname(FIL), { recursive: true }); writeFileSync(FIL, JSON.stringify(s));
}

export function jobb(id, namn, totalt) {
  const start = Date.now(); let klara = 0, senast = 0;
  skriv(id, { namn, totalt, klara: 0, start, slut: null, text: '' });
  return {
    steg(n = 1, text) { klara += n; if (Date.now() - senast > 1000 || klara >= totalt) { senast = Date.now(); skriv(id, { klara, ...(text ? { text } : {}) }); } },
    text(text) { skriv(id, { text }); },
    klar(text) { skriv(id, { klara: Math.max(klara, totalt), slut: Date.now(), ...(text ? { text } : {}) }); },
  };
}

const SIDA = `<!doctype html><meta charset="utf-8"><title>Jobbstatus</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:24px;max-width:720px;color:#1c1f22}h1{font-size:20px}
.j{margin:14px 0}.r{display:flex;justify-content:space-between;gap:12px}.b{height:12px;background:#e6e8ea;border-radius:6px;overflow:hidden;margin-top:4px}
.b i{display:block;height:100%;background:#1b7a4c;transition:width .5s}.klar i{background:#8a9096}.m{color:#646a70;font-size:12.5px}</style>
<h1>Jobbstatus</h1><div id="j">Inga jobb just nu.</div>
<script>
const tid = s => s < 60 ? Math.round(s) + ' s' : s < 3600 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h';
async function upp() {
  const s = await (await fetch('/status.json?t=' + Date.now())).json(), nu = Date.now();
  const v = Object.entries(s).sort((a, b) => (a[1].slut ? 1 : 0) - (b[1].slut ? 1 : 0) || b[1].start - a[1].start);
  document.getElementById('j').innerHTML = v.length ? v.map(([id, j]) => {
    const p = j.totalt ? Math.min(100, 100 * j.klara / j.totalt) : 0, gatt = ((j.slut || nu) - j.start) / 1000;
    const kvar = !j.slut && j.klara ? gatt / j.klara * (j.totalt - j.klara) : null, tyst = !j.slut && nu - j.uppdaterad > 120e3;
    return '<div class="j' + (j.slut ? ' klar' : '') + '"><div class="r"><b>' + j.namn + '</b><span>' + j.klara + ' / ' + j.totalt + ' (' + Math.round(p) + ' %)</span></div>'
      + '<div class="b"><i style="width:' + p + '%"></i></div><div class="r m"><span>' + (j.text || '') + '</span><span>'
      + (j.slut ? 'klart på ' + tid(gatt) : 'pågått ' + tid(gatt) + (kvar != null ? ', ca ' + tid(kvar) + ' kvar' : '') + (tyst ? ' – ingen uppdatering på ' + tid((nu - j.uppdaterad) / 1000) : '')) + '</span></div></div>';
  }).join('') : 'Inga jobb just nu.';
}
upp(); setInterval(upp, 1000);
</script>`;

const arg = process.argv.slice(2);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (arg[0] === '--satt') {
    const [, id, namn, klara, totalt, ...text] = arg;
    const s = las()[id];
    skriv(id, { namn, klara: +klara, totalt: +totalt, start: s?.start || Date.now(), slut: +klara >= +totalt ? Date.now() : null, text: text.join(' ') });
  } else {
    const port = +(arg[0] || 8780);
    http.createServer((req, res) => {
      if (req.url.startsWith('/status.json')) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(existsSync(FIL) ? readFileSync(FIL) : '{}'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(SIDA);
    }).listen(port, '127.0.0.1', () => console.log('jobbstatus på http://localhost:' + port));
  }
}
