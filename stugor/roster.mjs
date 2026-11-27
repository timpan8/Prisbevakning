// Röster (gilla och nedröstningar) på fliken Stugor. Sidan skickar varje röst till ett ntfy.sh-ämne (stugor/installningar.json, roster.ntfy)
// som {hus, namn, rost: 1 (gilla) | -1 (ner) | 0 (ångrad)}. ntfy behåller meddelanden i 12 h, så datorns inkorgsjobb (var 15:e minut)
// hämtar nya röster och sparar dem i data/stugor-roster.json, som sidan läser tillsammans med det senaste från ntfy.
//
//   node stugor/roster.mjs      hämta nya röster och spara (utan commit)
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIL = path.join(ROOT, 'data', 'stugor-roster.json');

export async function syncRoster() {
  const inst = JSON.parse(await readFile(path.join(ROOT, 'stugor', 'installningar.json'), 'utf8'));
  const url = inst.roster?.ntfy; if (!url) return 0;
  const db = existsSync(FIL) ? JSON.parse(await readFile(FIL, 'utf8')) : { senast: 0, roster: [] };
  const since = db.senast ? String(db.senast) : 'all';
  const r = await fetch(`${url}/json?poll=1&since=${since}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`ntfy svarade ${r.status}`);
  const kanda = new Set(db.roster.map(x => x.id));
  let nya = 0;
  for (const rad of (await r.text()).split('\n')) {
    if (!rad.trim()) continue;
    let m; try { m = JSON.parse(rad); } catch { continue; }
    if (m.event !== 'message' || kanda.has(m.id)) continue;
    let v; try { v = JSON.parse(m.message); } catch { continue; }
    const hus = String(v.hus || '').slice(0, 120), namn = String(v.namn || '').trim().slice(0, 40);
    if (!hus || !namn || ![-1, 0, 1].includes(v.rost)) continue;
    db.roster.push({ id: m.id, t: m.time, hus, namn, rost: v.rost });
    kanda.add(m.id); nya++;
    db.senast = Math.max(db.senast || 0, m.time);
  }
  if (nya) { db.roster.sort((a, b) => a.t - b.t); await writeFile(FIL, JSON.stringify(db, null, 1) + '\n'); }
  return nya;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Röster: ${await syncRoster()} nya`);
}
