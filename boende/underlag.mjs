// Arkivera redan hämtade annonsuppgifter innan listan förkortar eller slår ihop dem.
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { decryptJson, encryptJson } from '../tools/crypt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const directory = process.env.BOENDE_UNDERLAG || path.join(root, 'data', 'boende-underlag');

async function exists(file) {
  try { await access(file); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

async function writeAtomic(file, data) {
  await mkdir(directory, { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try { await writeFile(temp, data, { flag: 'wx' }); await rename(temp, file); }
  finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}

export async function initArchive(pass) {
  const dest = path.join(directory, 'bas.enc.json');
  if (await exists(dest)) return false;
  const source = process.env.BOENDE_DATA || path.join(root, 'data', 'boende.enc.json');
  let data;
  try { data = await readFile(source); }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  // Tidigare insamlingar finns antingen kvar i Hämtade filer eller har flyttats till inkorgens done.
  const folders = [process.env.BOENDE_HISTORIK || path.join(os.homedir(), 'Downloads')];
  if (process.env.PRIS_INBOX) folders.push(path.join(process.env.PRIS_INBOX, 'done'));
  for (const folder of folders) {
    const names = await readdir(folder).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    for (const name of names.filter(n => /(?:^|Z-)boende-[^/]+\.json$/i.test(n)).sort()) {
      const file = path.join(folder, name);
      const input = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
      await archiveBatch(input, pass, (await stat(file)).mtime.toISOString(), name);
    }
  }
  await writeAtomic(dest, data);
  return true;
}

export async function archiveBatch(input, pass, observed, source) {
  if (!input.annonser?.length && !input.borta?.length) return false;
  const raw = JSON.stringify(input);
  const id = createHash('sha256').update(raw).digest('hex');
  const file = path.join(directory, id + '.enc.json');
  if (await exists(file)) return false;
  const payload = { version: 1, observed, source, gzip: gzipSync(raw).toString('base64') };
  await writeAtomic(file, JSON.stringify(await encryptJson(payload, pass)) + '\n');
  return true;
}

async function search(pass, query) {
  const term = query.toLocaleLowerCase('sv');
  for (const name of (await readdir(directory)).filter(n => n.endsWith('.enc.json')).sort()) {
    const box = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
    const data = await decryptJson(box, pass);
    const baseline = name === 'bas.enc.json';
    const batch = baseline ? data : JSON.parse(gunzipSync(Buffer.from(data.gzip, 'base64')).toString());
    const groups = baseline ? [['annonser', Object.values(batch.annonser || {})], ['arkiv', Object.values(batch.arkiv || {})]] : [['annonser', batch.annonser || []], ['borta', batch.borta || []]];
    for (const [group, records] of groups) for (const row of records) {
      const id = row.id || [row.kalla, row.kod].join('-');
      if ((id + ' ' + JSON.stringify(row)).toLocaleLowerCase('sv').includes(term))
        console.log(JSON.stringify({ id, grupp: group, tid: baseline ? batch.uppdaterad : data.observed, fil: baseline ? name : data.source, uppgifter: row }));
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pass = process.env.PRIS_KOD;
  if (!pass) throw new Error('PRIS_KOD saknas');
  const [command, ...args] = process.argv.slice(2);
  if (command === 'sok' && args.length) await search(pass, args.join(' '));
  else if (command === 'importera' && args.length) {
    for (const file of args) {
      const raw = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
      await archiveBatch(raw, pass, raw.hamtad || raw.tid || null, path.basename(file));
    }
  } else throw new Error('Använd sok <adress, id eller ord> eller importera <insamlad jsonfil ...>');
}
