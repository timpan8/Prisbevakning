# Prisbevakning

Prisbevakning av inköpslistan (Todoist): bästa pris per vara, bästa butikspaket, flest varor i en butik, prishistorik och begagnat.

**Sida:** https://timpan8.github.io/Prisbevakning/ (låst med kod)

## Så fungerar det
- `collector/*.js` – skript som körs i Chrome (Claude in Chrome) på Prisjakt, Tradera och Blocket. De hämtar data direkt (Prisjakts pris-API och sökresultat) i stället för att klicka runt.
- `collector/extra-shops.json` – vilka butikskategorier varje vara hör till. Butikerna finns i det gemensamma registret `C:UsersTimLiDevAutomationegistryutiker.json`; se `collector/extra-shops.md`.
- `tools/update.mjs` – slår ihop en insamling i databasen, håller koll på bästa pris vi sett och en daglig prislogg. Prishistorik från Prisjakt hämtas max en gång per dag och produkt.
- `data/data.enc.json` – databasen, krypterad med AES-GCM (nyckel från koden via PBKDF2). Sidan dekrypterar i webbläsaren.
- `local/` – insamlingen som körs på Tims dator utan AI (07:45, 11:45, 19:45) via den gemensamma jobbköraren i `C:\Users\TimLi\Dev\Automation` (jobbfil `jobs\prisbevakning.json`). Hämtar Prisjakt och Blocket med paus mellan förfrågningarna, kontrollerar resultatet, uppdaterar databasen och pushar. Kontrollfilen `senaste-kontroll.json` hamnar i `Automation\output\prisbevakning\`.
- Claude-rutinen "Prisbevakning – inköpslistan" (08:15 och 20:15) synkar varor från Todoist, granskar datan, hämtar Tradera (har botspärr mot annat än webbläsare) och butikerna utanför Prisjakt enligt butiksregistret, och skickar notiser. Rutinen pushar aldrig själv: den lägger sina resultat i `inbox/` (ignoreras av git) och jobbet `prisbevakning-inkorg` på datorn tillämpar och publicerar dem inom 15 minuter. Se `RUTIN.md`.

Koden är ett enkelt lås, inte stark säkerhet – en kort kod går att gissa.
