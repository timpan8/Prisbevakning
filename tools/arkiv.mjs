// Arkivet: varor Tim markerat som köpta eller inte vill bevaka mer (knapparna på sidan).
// Sidan skriver data/arkiv.enc.json (krypterad med samma kod som databasen) via GitHub.
// Format: { "<key>": { status: "kopt" | "slutat", datum: "ÅÅÅÅ-MM-DD", namn, lista, pris } }
// Arkiverade varor ligger kvar i produktlistan (Todoist styr den) men hämtas inte, får inga köplägen och visas i arkivet.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { decryptJson } from './crypt.mjs';

const FILE = new URL('../data/arkiv.enc.json', import.meta.url);

export async function readArkiv(pass) {
  if (!existsSync(FILE)) return {};
  try { return await decryptJson(JSON.parse(await readFile(FILE, 'utf8')), pass) || {}; }
  catch (e) { console.error('Kunde inte läsa arkivet (data/arkiv.enc.json): ' + e.message); return {}; }
}
