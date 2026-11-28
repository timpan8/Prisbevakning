# Prisbevakning

Prisbevakning av inköpslistan (Todoist): bästa pris per vara, bästa butikspaket, flest varor i en butik, prishistorik och begagnat.

**Sida:** https://timpan8.github.io/Prisbevakning/ (låst med kod)

## Så fungerar det
- `collector/*.js` – skript som körs i Chrome (Claude in Chrome) på Prisjakt, Tradera och Blocket. De hämtar data direkt (Prisjakts pris-API och sökresultat) i stället för att klicka runt.
- `collector/extra-shops.json` – vilka butikskategorier varje vara hör till. Butikerna finns i det gemensamma registret `C:\Users\TimLi\Dev\Automation\registry\butiker.json`; se `collector/extra-shops.md`.
- `tools/update.mjs` – slår ihop en insamling i databasen, håller koll på bästa pris vi sett och en daglig prislogg. Prishistorik från Prisjakt hämtas max en gång per dag och produkt.
- `data/data.enc.json` – databasen, krypterad med AES-GCM (nyckel från koden via PBKDF2). Sidan dekrypterar i webbläsaren.
- `local/` – insamlingen som körs på Tims dator utan AI (07:45, 11:45, 19:45) via den gemensamma jobbköraren i `C:\Users\TimLi\Dev\Automation` (jobbfil `jobs\prisbevakning.json`). Hämtar Prisjakt och Blocket med paus mellan förfrågningarna, kontrollerar resultatet, uppdaterar databasen och pushar. Kontrollfilen `senaste-kontroll.json` hamnar i `Automation\output\prisbevakning\`.
- Claude-rutinen "Prisbevakning – inköpslistan" (08:15 och 20:15) synkar varor från Todoist, granskar datan, hämtar Tradera (har botspärr mot annat än webbläsare) och butikerna utanför Prisjakt enligt butiksregistret, och skickar notiser. Rutinen pushar aldrig själv: den lägger sina resultat i `inbox/` (ignoreras av git) och jobbet `prisbevakning-inkorg` på datorn tillämpar och publicerar dem inom 15 minuter. Se `RUTIN.md`.

## Resor (fliken Resor)
Letar riktigt billiga resor för två från Stockholm: weekend, vecka i värmen, långresa och billigaste Malaga-flyg.
- `resor/installningar.json` – mål och maxpriser per kategori (totalt för två; Malaga per person).
- `resor/kallor.json` – **listan över resesajter**, fyll gärna på. `hamtning`: `dator` (parser i `resor/kallor/`), `rss` eller `webblasare` (AI-rutinen i Chrome).
- `resor/klimat.json` – ungefärlig temperatur per resmål och månad, avgör "varmt" (≥ 25 °C).
- `resor/run.mjs` – datorns dagliga jobb (06:40, `Automation\jobs\resor.json`): Nazar och Ryanair (Malaga-kalendern), sparar `data/resor.json`, publicerar och skickar pushnotis via Homey för nya fynd under målet.
- `collector/reseguiden.js` – skript för Reseguiden i Chrome: priskalender (`rgKalender`) och resor i listan (`rgRead`). Sökningen styrs av adressen; se RUTIN.md, avsnitt 5b.
- `resor/merge.mjs` – inkorgsjobbet slår ihop AI-rutinens `inbox/resor-*.json` (och Reseguiden-filerna).

## Stugor (fliken Stugor)
Letar weekendstugor i Sverige (fre–sön) för gänget: hela hus med bubbelpool/badtunna, minst 4 bäddar, högst ca 3 h från Stockholm, Göteborg eller Jönköping, under 8 000 kr för hela helgen (notis under 6 000). Bonus för bastu, sjötomt, restaurang nära och avskilt läge. Bilder från annonserna visas på sidan.
- `stugor/installningar.json` – krav, bonuspoäng, utgångspunkter och priser.
- `stugor/kallor.json` – **sajtlistan**, fyll gärna på (`dator` med parser i `stugor/kallor/`, annars `webblasare` för AI-rutinen).
- `stugor/run.mjs` – datorns dagliga jobb (06:55, `Automation\jobs\stugor.json`): Novasols öppna sök-API för alla helger 6 månader fram, detaljsidorna en gång per hus (badtunna eller bubbelbadkar, bastu, avstånd), sparar `data/stugor.json`, publicerar och skickar notis.
- `stugor/merge.mjs` – inkorgsjobbet slår ihop AI-rutinens `inbox/stugor-*.json` (Airbnb, Booking m.fl.). Se RUTIN.md, avsnitt 5c.

## Boende (fliken Boende, bakom koden)
Letar bostadsrätt åt Tim: helst 3 rum, utropspris högst 4 mkr, högst 40 min kollektivt till Solna strand, inte i Polisens utsatta områden. Bonus för takterrass, vattenutsikt, balkong, grill, nära centrum, låg avgift, unikt, nära tunnelbana, nära pendeltåg/lokalbana/spårväg (när T-banan inte redan gett bonus), kort restid och stor tvåa (≥ 55 kvm, plats för arbetsplats – sorteras först bland tvåorna och ger notis). Bilder, karta med förklaring (kortet markeras på kartan, "Visa på kartan" öppnar punkten), dagar ute, prisändringar/budgivning, märket Kommande för annonser utan pris, kr/kvm mot sålda (eller andra till salu) i närheten, sålda med slutpris i ett arkiv. Gilla/ogilla på sidan.
- Filter på sidan: rullistor Rum, Sortera, Visa och Våning, reglage för restid, storlek, avgift, utropspris och kostnad per månad, knappar "Måste ha". Kostnad per månad = avgift + ränta efter ränteavdrag + amortering; egen kontantinsats och ränta anges på sidan. Filter och kalkyl sparas i webbläsaren.
- `boende/installningar.json` – krav, bonuspoäng, nyckelord, uteslutna områden och inlärda regler (`larda`). `boende/spar.json` – stationer för pendeltåg, lokalbanor och spårväg (OpenStreetMap).
- `boende/kallor.json` – sajterna (Hemnet och Booli). Båda spärrar serveranrop, så AI-rutinen läser dem i Chrome med `collector/hemnet.js` och `collector/booli.js` (RUTIN.md, avsnitt 5d). Samma bostad på båda visas en gång.
- `boende/merge.mjs` – inkorgsjobbet slår ihop `inbox/boende-*.json`, räknar restid med SL:s öppna reseplanerare (`boende/sl.mjs`, tunnelbanestationerna i `boende/tbana.json`), bedömer, arkiverar sålda och skickar notiser. `--plan` ger rutinen vad som ska hämtas.
- `data/boende.enc.json` – databasen, krypterad med koden. `data/boende-val.enc.json` – gillningar/ogillningar, skrivs av sidan via GitHub (samma nyckel som arkivet).

Koden är ett enkelt lås, inte stark säkerhet – en kort kod går att gissa. `data/resor.json` och `data/stugor.json` är inte krypterade (bara offentliga erbjudanden).
