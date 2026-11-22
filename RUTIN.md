# Claude-rutinen för prisbevakningen

Rutinen "Prisbevakning – inköpslistan" körs 08:15 och 20:15. Priserna från Prisjakt och Blocket hämtas
**inte** här – det gör Tims dator själv utan AI (07:45, 11:45, 19:45, `local/run.mjs` via jobbköraren i
`C:\Users\TimLi\Dev\Automation`). Rutinen gör det som kräver omdöme eller en riktig webbläsare.

Gemensamt: skriv på svenska. Köp aldrig något, kontakta aldrig säljare, ändra inget hos butiker och ändra inte
Todoist-uppgifternas innehåll.

**Arbetsmapp:** `C:\Users\TimLi\Dev\Prisbevakning`. Börja med `git pull --rebase --autostash`.
**Koden** till databasen läses ur Tims krypterade hemlighet och ska aldrig skrivas ut. Sätt den direkt i kommandot, t.ex.
`PRIS_KOD="$(pwsh -NoProfile -File C:/Users/TimLi/Dev/Automation/get-secret.ps1 PRIS_KOD)" node tools/update.mjs --dump`
(i PowerShell: `$env:PRIS_KOD = pwsh -NoProfile -File C:\Users\TimLi\Dev\Automation\get-secret.ps1 PRIS_KOD`).

**Rutinen committar och pushar aldrig själv.** Allt du vill ändra läggs som filer i **inkorgen**
`C:\Users\TimLi\Dev\Prisbevakning\inbox\`. Datorns jobb "prisbevakning-inkorg" tillämpar inkorgen inom 15 minuter,
uppdaterar databasen och publicerar. Ändra inte `data/data.enc.json` eller andra filer i repot direkt.
Inkorgens filer (alla måste vara giltig JSON):
- `products.json` – hela den nya produktlistan (samma format som `products` i `--dump`)
- `extra-shops.json` – hela den uppdaterade `collector/extra-shops.json`
- `run-ÅÅÅÅMMDD-HHMM.json` – `{"tradera": ..., "extra": ..., "prisjakt": ...}` (ta bara med det du hämtat)
Tillämpade filer flyttas till `inbox\done\`; en fil som inte gick att tillämpa döps om till `fel-…` och står i loggen.

## 1. Läget efter datorns körningar
- Läs `C:\Users\TimLi\Dev\Automation\output\prisbevakning\senaste-kontroll.json` och dagens loggar i
  `C:\Users\TimLi\Dev\Automation\logs\prisbevakning\` och `...\logs\prisbevakning-inkorg\` om du har åtkomst
  (be om mappåtkomst till `C:\Users\TimLi\Dev\Automation\output` och `...\logs` om den saknas).
- `problem` = något som inte kunde hämtas; `granska` = kraftiga prishopp eller nytt produktnamn på Prisjakt.
- Har datorn inte publicerat på över 6 timmar (se `updated` i `node tools/update.mjs --dump` eller git-loggen):
  hämta Prisjakt i Chrome som reserv enligt avsnitt 6 och nämn det i rapporten.

## 2. Synka med Todoist
- Öppna uppgifter i projekten "🛒 Handla", "🔌 Teknik shopping" och "🛍️ Övriga inköp".
- Bevaka bara varor med tillverkare och modell (t.ex. "Kärcher SC 3 EasyFix"), inte generiska saker.
- Nuvarande lista: `node tools/update.mjs --dump` (fältet `products`).
- Ny vara: hitta Prisjakt-id med `node -e "import('./local/sources.mjs').then(async m=>console.log(await m.pjFind('SÖKORD')))"`
  (eller pjFind i Chrome). Välj exakt rätt variant och set, inte refill eller tillbehör. Skapa en post i samma format
  som de befintliga: `key, name, list, todoistId, prisjaktId, tradera{q,must,min}, blocket{q,must,min}`;
  `min` ≈ 50–60 % av nypriset. Lägg också till varan under `varor` i `collector/extra-shops.json` med passande kategorier.
- Avbockad eller borttagen uppgift: ta bort posten. Har listan ändrats: lägg hela listan som `inbox\products.json`
  (och `inbox\extra-shops.json` om du lade till varor där).
- Osäker på produkten: hoppa över och nämn det i rapporten.

## 3. Granska datan
För varje vara i `--dump`:
- Är Prisjakt-produkten fortfarande rätt (namn, variant)? Är det rimligt antal butiker?
- Är billigaste priset rimligt jämfört med prisloggen och Prisjakts historik? Följ upp det som står under `granska`.
- Är begagnatträffarna (Tradera, Blocket) samma modell och kompletta? Justera `must`/`min` om filtren släpper igenom fel saker.
- Är extra-erbjudanden (`latest[key].extra`) äldre än 3 dagar, eller ser fel ut?
Rätta det som går (produktposter, filter) och skriv vad du ändrade i rapporten.

## 4. Tradera (i Chrome)
Tradera spärrar annat än webbläsare, så det hämtas här. Ny flik på https://www.tradera.com/, klistra in
`collector/tradera.js` och kör `await trCollectAll([{key, ...tradera}])` för alla varor. Resultatet är `window.__s`;
hämta det i bitar (`__s.slice(0,900)` osv.). Skriv aldrig backslash-u i javascript_tool. Stäng fliken.

## 5. Butiker utanför Prisjakt (bara 08:15)
Följ `collector/extra-shops.md` och `collector/extra-shops.json`. Högst 25 butiker per körning; börja med
`prisjakt: false`, ta resten efter hand. Fyll i `prisjakt: true/false` där det är okänt (lägg då hela filen som
`inbox\extra-shops.json`). Resultatet läggs under `"extra"`.

## 6. Lämna resultatet i inkorgen
- Skriv `{"tradera": ..., "extra": ...}` (och `"prisjakt"` bara om du hämtade som reserv) som
  `inbox\run-ÅÅÅÅMMDD-HHMM.json`. Du kan provköra `node tools/update.mjs fil.json` i din egen klon för att se att filen fungerar,
  men pusha inte.
- Nästa rutinkörning: kontrollera att förra körningens filer ligger i `inbox\done\` och att inget heter `fel-…`.
- Reserv för Prisjakt i Chrome: ny flik på https://www.prisjakt.nu/, klistra in `collector/prisjakt.js` och kör
  `await pjCollectAll(LISTA)` med `LISTA` från `node tools/update.mjs --plan`.

## 7. Rapport
Skicka en pushnotis bara när något hänt:
- nytt lägsta pris vi sett, eller ett pris som sjunkit sedan i går
- butiken har märkt det billigaste erbjudandet som rea (fältet `was` i erbjudandet)
- begagnatfynd under 70 % av nypriset, eller en Tradera-auktion som slutar inom 12 timmar
- vara tillagd eller borttagen, något du rättat, eller problem i datorns körningar

20:15 skickas alltid en kort kvällssammanfattning med "billigast totalt" för de valda varorna.
Håll notisen kort: vara, pris, butik och länken https://timpan8.github.io/Prisbevakning/.
