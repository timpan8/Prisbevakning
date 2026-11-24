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
- `extra-shops.json` – hela den uppdaterade `collector/extra-shops.json` (varornas kategorier; butiksfakta skrivs i registret)
- `run-ÅÅÅÅMMDD-HHMM.json` – `{"tradera": ..., "extra": ..., "saknas": ..., "prisjakt": ...}` (ta bara med det du hämtat)
Tillämpade filer flyttas till `inbox\done\`; en fil som inte gick att tillämpa döps om till `fel-…` och står i loggen.

## 1. Läget efter datorns körningar
- Läs `C:\Users\TimLi\Dev\Automation\output\prisbevakning\senaste-kontroll.json` och dagens loggar i
  `C:\Users\TimLi\Dev\Automation\logs\prisbevakning\` och `...\logs\prisbevakning-inkorg\` om du har åtkomst
  (be om mappåtkomst till `C:\Users\TimLi\Dev\Automation\output` och `...\logs` om den saknas).
- `problem` = något som inte kunde hämtas; `granska` = kraftiga prishopp eller nytt produktnamn på Prisjakt.
- Har datorn inte publicerat på över 6 timmar (se `updated` i `node tools/update.mjs --dump` eller git-loggen):
  hämta Prisjakt i Chrome som reserv enligt avsnitt 6 och nämn det i rapporten.

## 2. Synka med Todoist
- Öppna uppgifter i projekten "🛒 Handla", "🔌 Teknik shopping" och "🛍️ Övriga inköp" – inklusive sektionen
  "✨ Önskelista" i Övriga inköp (saker Tim köper bara om priset är rätt). Önskelistevaror får `"onskelista": true` och,
  om beskrivningen nämner ett önskat pris, `"malpris": <kr>`; nämn i notisen när ett pris (nytt eller begagnat) når målpriset.
  Utgångna modeller ("utgått", "leta begagnat") bevakas ändå – då är begagnat (Marketplace, grupper, Blocket, Tradera) viktigast.
- Bevaka bara varor med tillverkare och modell (t.ex. "Kärcher SC 3 EasyFix"), inte generiska saker.
- Nuvarande lista: `node tools/update.mjs --dump` (fältet `products`).
- **Ny vara: kartlägg den först** enligt "Kartlägga en ny vara" i `C:\Users\TimLi\Dev\Automation\registry\README.md`,
  med klasserna i `registry\varuklasser.json`. Kort:
  1. Klass och standardvärden; Tims markering i Todoist (`kina-ok`, `ej-kina`, `begagnat`, `ej-begagnat`, `bara-ny`, som
     etikett eller ord i beskrivningen) går alltid före. Ex: AirPods/ångtvätt = ingen Kina; sensorer och smått = Kina.
  2. Prisjakt: hitta exakt variant med `node -e "import('./local/sources.mjs').then(async m=>console.log(await m.pjFind('SÖKORD')))"`
     (eller pjFind i Chrome). Finns den: `prisjaktId` – datorn söker den vid varje körning. Finns den inte: inget id och
     `sokprofil.prisjakt: false` – då söks den inte på Prisjakt dagligen; sök igen när `prisjaktKollad` är 14 dagar gammal.
  3. Butiker utanför Prisjakt i registret (Kinabutiker bara om `kina: true`) + **webbsökning efter fler tillförlitliga
     butiker**; nya butiker som klarar kraven läggs in i registret.
  4. Begagnat bara om `begagnat: true`: `tradera{q,must,min}`, `blocket{q,must,min}` (`min` ≈ 50–60 % av nypriset) och en
     Marketplace-sökning i `Automation\bestallningar\marketplace.json` (grupper som passar får den i `passar`).
  5. Spara allt i varans `sokprofil` (klass, prisjakt, kina, begagnat, kategorier, butiker, variant, motivering, datum)
     i samma post som `key, name, list, todoistId, prisjaktId, tradera, blocket`. Skicka en notis med en mening per ny
     vara om vad du bestämde, så att Tim kan rätta.
- Varor utan `sokprofil` (äldre): kartlägg dem en i taget när du har tid över, högst två per körning.
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

## 3b. Facebook Marketplace och köp/sälj-grupper
Du styr **vad** som söks; planen styr när och hur:
- Beställningsfil: `C:\Users\TimLi\Dev\Automation\bestallningar\marketplace.json` (sökningar med `"projekt": "prisbevakning"`).
  Lägg till en sökning (med `must`) för varje ny vara från Todoist – även önskelistan – och sätt `"aktiv": false` när den
  bockats av. Kontrollera vid varje körning att alla bevakade varor har en sökning.
  Grupperna finns i `bestallningar\fb-grupper.json`. Regler i `bestallningar\README.md`.
- Kör dagens Chrome-plan enligt avsnittet "Marketplace och grupper i Chrome" i `bestallningar\README.md` (plan → Chrome →
  import). Den tar bara det som inte redan körts i dag, så det är ofarligt om Ergostolar-uppgiften redan gjort den.
- Resultat: `C:\Users\TimLi\Dev\Automation\output\marketplace\senaste.json` (dagens nya, prisändringar, sålda) och
  `...\archive\marketplace\annonser.json` (alla annonser med historik). Bedöm de nya: rätt modell (använd varans `must`),
  rimligt pris (under `min` är oftast kopior/bluff), ort/leverans.
- Bästa relevanta annons per vara läggs i run-filen under `"marketplace": { "<key>": { "titel", "pris", "url", "ort" } | null }`
  (visas under Begagnat). Nämn fynd under 70 % av nypriset i notisen.

## 4. Tradera (i Chrome)
Tradera spärrar annat än webbläsare, så det hämtas här. Ny flik på https://www.tradera.com/, klistra in
`collector/tradera.js` och kör `await trCollectAll([{key, ...tradera}])` för varorna med `sokprofil.begagnat` true (eller utan sokprofil). Resultatet är `window.__s`;
hämta det i bitar (`__s.slice(0,900)` osv.). Skriv aldrig backslash-u i javascript_tool. Stäng fliken.

## 5. Butiker utanför Prisjakt (bara 08:15)
Butikerna finns i det gemensamma registret `C:\Users\TimLi\Dev\Automation\registry\butiker.json` (läs `registry\README.md`);
projektets regler i `collector/extra-shops.json`, arbetsgången i `collector/extra-shops.md`. Vilka butiker som gäller en vara
står i dess `sokprofil` (`butiker` först, sedan registrets butiker i `kategorier`; äldre varor utan sokprofil: `varor` i
extra-shops.json). Takt per vara, efter datumen i `sokprofil`:
- svenska/EU-butiker när `butikerKollad` är minst 3 dagar gammal,
- Kinabutiker (bara `kina: true`) när `kinaKollad` är minst 7 dagar gammal – lägg `"kina": true` på de erbjudandena,
- Prisjakt igen för varor med `prisjakt: false` när `prisjaktKollad` är minst 14 dagar gammal,
- webbsökning efter nya tillförlitliga butiker när `nyaButikerKollad` är minst 30 dagar gammal.
Uppdatera datumen i `sokprofil` (via `inbox\products.json`) när du kollat. Högst 25 butiker per körning.
Ett erbjudande gäller 4 dagar (Kina 8) från när det kollades; en butik som inte längre har varan anges som
`{"shop": "...", "gone": true}`. Det du lär dig om en butik skriver du **direkt i registret** enligt dess README.
Resultatet läggs under `"extra"`.

**Varor utan pris.** Har en vara inget erbjudande i lager efter Prisjakt och butikskollen, skriv varför under
`"saknas"`, så att sidan visar orsaken i stället för ett streck:
`"saknas": {"ecoflow-river-3": {"orsak": "bara-butik", "text": "Clas Ohlson har den i butik, slut online"}}`
- `orsak` är en av: `utgangen` (tillverkaren eller butikerna har slutat sälja den), `ej-lanserad` (inte ute i Sverige än),
  `ej-i-sverige` (säljs bara utomlands), `bara-butik` (finns i fysisk butik men inte online), `slut` (tillfälligt slut överallt),
  `ingen-butik` (ingen tillförlitlig butik hittad).
- `text` är en kort mening om läget (t.ex. "lanserades i november, inte i butik än" eller "säljs bara i USA").
  Leta inte upp något pris för varan, orsaken räcker.
- Kolla orsaken igen med butikskollen (var 3:e dag). När varan får ett erbjudande döljs orsaken av sig själv;
  ta bort den med `"saknas": {"nyckel": null}` om den inte längre stämmer.
- Utan `saknas` visar sidan "Slut i lager" (varan finns på Prisjakt) eller "Ingen butik hittad".

## 6. Lämna resultatet i inkorgen
- Skriv `{"tradera": ..., "extra": ..., "saknas": ...}` (och `"prisjakt"` bara om du hämtade som reserv) som
  `inbox\run-ÅÅÅÅMMDD-HHMM.json`. Du kan provköra `node tools/update.mjs fil.json` i din egen klon för att se att filen fungerar,
  men pusha inte.
- Nästa rutinkörning: kontrollera att förra körningens filer ligger i `inbox\done\` och att inget heter `fel-…`.
- Reserv för Prisjakt i Chrome: ny flik på https://www.prisjakt.nu/, klistra in `collector/prisjakt.js` och kör
  `await pjCollectAll(LISTA)` med `LISTA` från `node tools/update.mjs --plan`.

## 7. Rapport
Önskelistan (`onskelista: true`) hålls isär från det Tim faktiskt ska köpa: den räknas inte in i totalen, paketen eller
"billigast totalt". Sidan har en översikt (köplägen för båda listorna) och en flik per lista.

**Köplägen** räknar datorn ut vid varje prisuppdatering för alla varor (`latest[key].fynd`, sammanfattat i `koplagen`):
under målpris, rekordlågt/lägsta på 3 mån, rea ≥ 15 %, begagnat under målpris eller 65 % av nypris. Nivå `missa`
("Missa inte" = under målpris eller rekordlågt) eller `bra`.
- **"Missa inte"** skickar datorn själv som pushnotis via Homey (flödet "NOTIS | Prisbevakning | Köpläge", loggrad
  "Pushnotis skickad via Homey"). Skicka **inte** samma sak igen. Kontrollera i stället att köpläget är äkta (rätt modell,
  i lager, begagnat komplett och inte bluff). Är det fel: rätta filtren/produkten och skicka en kort notis att förra var fel.
- **"Bra pris"** på önskelistan som är nytt sedan förra rutinkörningen (`fynd.nytt`): ta med i rutinens notis.
- Föreslå gärna ett målpris i rapporten för önskelistevaror som saknar ett.

Skicka en pushnotis bara när något hänt:
- nytt lägsta pris vi sett, eller ett pris som sjunkit sedan i går
- butiken har märkt det billigaste erbjudandet som rea (fältet `was` i erbjudandet)
- begagnatfynd under 70 % av nypriset, eller en Tradera-auktion som slutar inom 12 timmar
- vara tillagd eller borttagen, något du rättat, eller problem i datorns körningar

20:15 skickas alltid en kort kvällssammanfattning med "billigast totalt" för de valda varorna (inte önskelistan), plus en
rad om önskelistevaror som just nu har bra pris.
Håll notisen kort: vara, pris, butik och länken https://timpan8.github.io/Prisbevakning/.
