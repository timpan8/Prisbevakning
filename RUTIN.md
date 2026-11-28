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
- `boende-*.json` – bostadsfynd från Hemnet-skriptet eller ditt omdöme (avsnitt 5d)
Tillämpade filer flyttas till `inbox\done\`; en fil som inte gick att tillämpa döps om till `fel-…` och står i loggen.

## 1. Läget efter datorns körningar
- Läs `C:\Users\TimLi\Dev\Automation\output\prisbevakning\senaste-kontroll.json` och dagens loggar i
  `C:\Users\TimLi\Dev\Automation\logs\prisbevakning\` och `...\logs\prisbevakning-inkorg\` om du har åtkomst
  (be om mappåtkomst till `C:\Users\TimLi\Dev\Automation\output` och `...\logs` om den saknas).
- `problem` = något som inte kunde hämtas; `granska` = kraftiga prishopp eller nytt produktnamn på Prisjakt.
- Har datorn inte publicerat på över 6 timmar (se `updated` i `node tools/update.mjs --dump` eller git-loggen):
  hämta Prisjakt i Chrome som reserv enligt avsnitt 6 och nämn det i rapporten.

## 2. Synka med Todoist
- **Arkivet:** varor Tim markerat som "Köpt" eller "Sluta bevaka" på sidan står under `arkiv` i `--dump`
  (filen `data/arkiv.enc.json`, som sidan skriver). Behåll dem i `products.json` så länge Todoist-uppgiften finns,
  men gör inget mer med dem: ingen kartläggning, inga butiker, Tradera, Marketplace, grupper eller notiser.
  Datorns jobb hoppar redan över dem. Ändra inte Todoist för dem; Tim bockar av uppgiften själv.
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

## 5b. Resor (bara 08:15)
Fliken **Resor** letar riktigt billiga resor för **två personer** från Arlanda, Skavsta, Västerås och Bromma, 12 månader fram.
Mål och gränser står i `resor/installningar.json` (belopp totalt för två; Malaga per person tur och retur):
weekend 2–4 nätter över helg ~2 000 kr (visas upp till 4 000, helst varmt), vecka i värmen ~3 000 kr (max 6 000,
minst ca 25 °C den månaden), långresa ≥ 2 veckor till Asien/USA m.fl. ~6 000 kr (max 13 000), Malaga-flyg under 1 000 kr.
Datorns jobb `resor` (06:40) hämtar redan Nazar och Ryanair (Malaga-kalendern) – det gör du inte.
Sajterna står i `resor/kallor.json`; läs alla aktiva med `"hamtning": "webblasare"` i Chrome, få sidor i lugn takt.
Avbryt en sajt vid spärr, captcha eller inloggning. Boka, köp eller fyll aldrig i något.

**Reseguiden** (viktigast): klistra in `collector/reseguiden.js` på varje sida (efter varje navigering) och kör funktionerna.
Allt styrs av adressen: `https://www.reseguiden.se/charter/fran-stockholm?departure_id=2673730&product_type=package_spec`
`&date_from=ÅÅÅÅ-MM-DD&length_interval=N&max_price=PER_PERSON&lower_left=LON,LAT&upper_right=LON,LAT&interactive_map=1`.
Reseguidens pris gäller en person när två delar rum. Listan gäller bara kartans område. Datumrutan har en priskalender:
billigaste pris per avresedag som klarar filtren.
| Sökning | length_interval | max_price | område (lower_left / upper_right) |
|---|---|---|---|
| Weekend | 1 (2–3 dgr) och 2 (4–5 dgr) | 2000 | hela världen `-180,-85` / `180,85` |
| Vecka | 3 (6–8 dgr) | 3000 | hela världen |
| Långresa | 5 (13–15 dgr) och 6 (16+) | 6500 | Asien `60,-12` / `150,45`, Amerika `-125,-40` / `-30,50`, Afrika `-30,-35` / `55,20` |
För varje sökning: öppna adressen med dagens datum, kör `await rgKalender({ manader: 12 })` (sparar kalendern), välj
sedan de 3–5 billigaste avresedagarna (för weekend: torsdag–lördag), öppna `date_from=` den dagen och kör
`await rgRead({ maxMore: 1 })`. Ta också `/sista-minuten/fran-stockholm?departure_id=2673730&max_price=3000` med `rgRead`.
Filerna hamnar i Hämtade filer som `resor-reseguiden-*.json`; flytta dem till `inbox\` (inkorgsjobbet läser dem direkt).
Ger kalendern inga dagar under maxpriset är det svaret för den sökningen – skriv det i rapporten.

**Övriga sajter** (Ving, Apollo, TUI, Detur, sistaminuten.se, Fly4free, Secret Flying): läs sista minuten-/fyndsidorna
och ta med resor som klarar maxgränserna ovan (räkna om pris per person till två). Ving/Apollo/TUI anger pris per person
i dubbelrum. Flygfynd (Fly4free, Secret Flying) till fjärran mål blir **sammansatta resor**: slå upp billigaste rimliga
hotell (minst 3 stjärnor eller bra betyg) för hela vistelsen och ange `typ: "sammansatt"`, `prisTva` = flyg för två + hotell,
`not` med flyg- och hotellpris var för sig. Gör inga sammansatta resor över maxgränsen.
Norwegian/Google Flights: bara för att bekräfta ett Malaga- eller flygfynd när det behövs.

**Lämna i inkorgen** som `inbox\resor-ÅÅÅÅMMDD-HHMM.json` (format i `resor/merge.mjs`):
`{"erbjudanden": [{kalla, typ, fran, ort, land, avresa, hem, prisPerPerson eller prisTva, hotell, kost, url, not}],`
`"kallorLasta": ["ving", ...], "klimat": {...}, "nyaKallor": [...]}`.
- **Värme:** resmål som saknas i `resor/klimat.json` läggs under `"klimat"` med ungefärlig medelhögsta temperatur per månad
  (12 tal), land och region (europa, medelhavet, kanarieoarna, nara, fjarran). Sidan och notiserna använder det.
- **Nya sajter:** när Tim ber om en ny resesajt, eller du hittar en tillförlitlig som saknas, lägg den under `"nyaKallor"`
  (`hamtning: "webblasare"`). Datorn hämtar bara sajter med en parser i `resor/kallor/`.
- **Notiser** skickar datorn själv (Homey) för nya fynd under målet – långresor ända upp till max – och Malaga under 1 000 kr.
  Skicka inte samma fynd igen; nämn dem kort i rapporten.

## 5c. Stugor (bara 08:15)
Fliken **Stugor** letar weekendboende i Sverige för ett kompisgäng: **hela hus/stugor** (inte lägenhet, rum, hotell,
vandrarhem, glamping) med **bubbelpool/badtunna/utomhusspa som hör till huset**, minst 4 bäddar (helst 6+),
fredag–söndag (2 nätter), högst ca 3 h bil från Stockholm, Göteborg eller Jönköping. Pris = **totalt för hela boendet
hela helgen** inkl. obligatoriska avgifter: mål 6 000 kr (notis), max 8 000 kr. Bonus: bastu, sjö-/havstomt,
restaurang/bar nära, avskilt läge. Allt står i `stugor/installningar.json`.
Datorns jobb `stugor` (06:55) hämtar redan **Novasol** för alla helger 6 månader fram – det gör du inte.
Sajterna står i `stugor/kallor.json`; läs de aktiva med `"hamtning": "webblasare"` i Chrome, i lugn takt.
Avbryt en sajt vid spärr, captcha eller inloggning. Boka, logga in, kontakta värdar eller fyll aldrig i något.

**Airbnb och Booking – skripten, alla helger varje morgon** (fredagar från i morgon och 6 månader fram, ca 26 st).
Skripten hämtar bara sökresultatsidor från sajten själv i lugn takt, bokar och loggar inte in, och sparar en fil i Hämtade filer.
- **Airbnb** (~15 min): öppna `https://www.airbnb.se/`, klistra in hela `collector/stugor-airbnb.js` och kör
  `await abStugor()` (5 sidor á 18 per helg). Filen heter `stugor-airbnb-ÅÅÅÅMMDD-HHMM.json`.
- **Booking** (~35 min i en flik): öppna `https://www.booking.com/`, klistra in `collector/stugor-booking.js` och kör
  `await bkStugor()`. Går fortare i 2–3 flikar samtidigt: i flik N kör `await bkStugor({ helger: stugOmgangar(3)[N-1], del: N })`
  (filerna får `-delN` i namnet). Booking-filen har `kallorLasta` för de helger som lästes klart.
- Medan de kör: `window.__st` visar framstegen (helg, hämtningar, fel). `window.__stStopp = true` avbryter och sparar det som
  hunnits läsas. Skripten avbryter själva och sparar om sajten slutar skicka sökdata (spärr) – skriv det i rapporten och
  försök inte igen samma morgon.
- Flytta filerna `stugor-airbnb-*.json` / `stugor-booking-*.json` från Hämtade filer till `inbox\` (inkorgsjobbet läser dem).
  Skripten filtrerar redan bort fel typer, pris > 8 000 kr och hus > ca 3,3 h bort; de sätter `bubbelpool: true` enligt sajtens
  filter (Bookings "bubbelbad" kan vara jacuzzi inomhus) – kontrollera gärna de billigaste i annonsen och rätta i en egen fil.

**Övriga sajter** (de aktiva i `kallor.json` utom Novasol, Airbnb och Booking, t.ex. Vrbo och Campanyon):
- **Takt:** 4–6 helger per körning och sajt, rullande (börja där förra körningen slutade enligt `kallstatus` /
  `inbox\done\stugor-*`), så att alla helger täcks på ungefär en vecka. De närmaste 4 helgerna varje gång.
- **Sök** med datum (fre → sön), 4 gäster och sajtens filter för bubbelpool/badtunna och hela boenden.
- **Kontrollera i annonsen** innan du tar med den: att badtunnan/bubbelpoolen hör till boendet (inte "spa i närheten"
  eller delad på en anläggning) och att det är hela huset. Bubbelbadkar inomhus räknas **inte** (`bubbelpool: false`).
- Ta med boenden med totalpris ≤ 8 000 kr. Räkna in städavgift och andra obligatoriska avgifter i `pris`.
- **Bilder:** spara 3–4 bildadresser direkt från annonsen (sajtens bildserver, helst utsikt/badtunna först) i `bilder`.
- **Bonusfälten** så gott annonsen säger: `bastu`, `vattenMeter` eller `sjotomt: true`, `restaurangMeter` (närmaste
  restaurang/bar, uppskatta via kartan om det behövs), `grannarMeter` eller `avskilt: true`, `lat`/`lon` (kartan i annonsen
  eller ortens koordinater – behövs för restiden), `baddar`, `sovrum`, `typ`, `betyg`.
- Samma hus på flera sajter: ta bara med det billigaste.

**Lämna i inkorgen** (övriga sajter och rättelser) som `inbox\stugor-ÅÅÅÅMMDD-HHMM.json` (format i `stugor/merge.mjs`):
`{"erbjudanden": [{kalla, kod, namn, typ, ort, lat, lon, baddar, sovrum, bilder, url, betyg, bubbelpool, bubbelpoolText,`
`bastu, sjotomt, vattenMeter, restaurangMeter, grannarMeter, avskilt, not, helg, natter, pris, prisUrl}],`
`"kallorLasta": [{"kalla": "vrbo", "helger": ["ÅÅÅÅ-MM-DD", ...]}], "nyaKallor": [...]}`.
En rad per hus och helg (`helg` = fredagens datum). `kallorLasta` = de helger du sökte igenom helt på sajten
(det som saknas där markeras som borta) – aldrig för Airbnb, där bara de första sidorna läses. **Notiser** skickar datorn själv för stugor under 6 000 kr; nämn dem kort i rapporten.

## 5d. Boende (08:15 och 20:15)
Fliken **Boende** letar bostadsrätt åt Tim: helst **3 rum** (arbetsrum; tvåor visas separat), **utropspris högst 4 000 000 kr**,
högst **40 min kollektivt till Solna strand** (vardag, framme 08:30), **inte i Polisens utsatta områden**. Bonus: takterrass,
vattenutsikt, balkong, grill på balkongen, nära centrum, låg avgift, unikt boende, nära tunnelbana, nära pendeltåg/lokalbana/spårväg
(`boende/spar.json`, bara när T-banan inte gett bonus), kort restid och **stor tvåa** (≥ 55 kvm, plats för arbetsplats; först bland
tvåorna och ger notis). Allt i `boende/installningar.json`. Filtren, månadskostnaden (avgift + ränta efter avdrag + amortering),
jämförelsen av kr/kvm med området och märket Kommande (inget pris än) sköts av sidan – inget för dig att göra.
Datan är **krypterad** (`data/boende.enc.json`, samma kod som databasen) och syns bara bakom koden.
Hemnet och Booli spärrar serveranrop, så du läser dem i Chrome; datorn räknar sedan restiden med SL och bedömer.
Logga aldrig in, spara inga sökningar, kontakta aldrig mäklare, anmäl dig inte till visningar och fyll aldrig i något.
Avbryt vid spärr eller captcha och skriv det i rapporten.
1. **Plan:** `PRIS_KOD="..." node boende/merge.mjs --plan` (JSON: sökningen, kända annonser, vilka som ska kollas igen, filtret).
2. **Hemnet:** ny flik på https://www.hemnet.se/, klistra in `collector/hemnet.js` och starta `hnKor(PLAN)` med planen **utan await** (det tar längre än
   verktygets tidsgräns); kolla `window.__boende.logg` och `window.__boende.klar` med någon minuts mellanrum tills den är klar.
   Skriptet läser sökningen nyast först (stannar när det kommit ikapp), detaljsidan för nya kandidater (högst 40, treor och
   stora tvåor först) och planens `kolla` (pris, budgivning, visningar, såld/borttagen; gillade först, sedan de som saknar
   detaljer). Det tar några minuter i lugn takt. Filen `boende-hemnet-*.json` hamnar i Hämtade filer – flytta den till `inbox\`. Stäng fliken.
   **Booli** på samma sätt: planen med `node boende/merge.mjs --plan booli`, ny flik på https://www.booli.se/, klistra in
   `collector/booli.js` och starta `bKor(PLAN)` utan await; filen heter `boende-booli-*.json`. Booli har ingen annonstext.
   Samma bostad på Hemnet och Booli känns igen av datorn (läge, adress, rum, kvm) och visas en gång.
3. **Omdöme** (valfritt, när tid finns): titta på de nya i huvudlistan (`--dump`, `annonser` med `kategori: "huvud"`) och lägg
   en egen fil `inbox\boende-ÅÅÅÅMMDD-HHMM.json` med `{"annonser": [{"kalla": "hemnet", "kod": "...", "unikt": true, "unikText": "…"}]}`
   för boenden som verkligen är unika (takvåning, loft, sekelskiftesdetaljer, ovanlig planlösning), eller `"vattenutsikt": true`/
   `"takterrass": true`/`"grill": true` när bilderna eller beskrivningen visar det men nyckelorden missade det.
   Sålda med slutpris som skriptet inte hittade: `{"borta": [{"kalla": "hemnet", "kod": "...", "status": "sald", "slutpris": 3650000}]}`.
4. **Notiser** skickar datorn själv (Homey): nya bra matchningar bland treor och stora tvåor (poäng ≥ `notisPoang` eller liknar en Tim gillat), och för gillade:
   prissänkning, ny visning, såld. Nämn dem kort i rapporten.

**Gilla/ogilla:** Tim gillar och ogillar på sidan (sparas krypterat i `data/boende-val.enc.json`; `--dump` visar `val`).
Gillade bevakas extra (kollas varje körning, liknande annonser lyfts). **Genomgång av ogillade** när Tim ber om det:
sammanfatta de ogillade (orsaker, fritext, område, våning, avgift, planlösning, pris/kvm), hitta mönster och föreslå regler.
Bara regler Tim godkänner läggs i `boende/installningar.json` under `"larda"`, t.ex.
`{"falt": "krKvmAr", "op": ">", "varde": 900, "poang": -2, "varfor": "ogillar hög avgift"}` (op: `<`, `<=`, `>`, `>=`, `==`, `ord`
som matchar text i beskrivning/område; falt kan vara annonsens fält, `krKvmAr`, `kvmPris` eller `restid.solnaStrand`).
Nya områden Tim inte vill bo i läggs i `uteslutnaOmraden.egna`. Inget lärs in tyst.

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
