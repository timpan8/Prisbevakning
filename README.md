# Prisbevakning

Prisbevakning av inköpslistan (Todoist): bästa pris per vara, bästa butikspaket, flest varor i en butik, prishistorik och begagnat.

**Sida:** https://timpan8.github.io/Prisbevakning/ (låst med kod)

## Så fungerar det
- `collector/*.js` – skript som körs i Chrome (Claude in Chrome) på Prisjakt, Tradera och Blocket. De hämtar data direkt (Prisjakts pris-API och sökresultat) i stället för att klicka runt.
- `tools/update.mjs` – slår ihop en insamling i databasen, håller koll på bästa pris vi sett och en daglig prislogg. Prishistorik från Prisjakt hämtas max en gång per dag och produkt.
- `data/data.enc.json` – databasen, krypterad med AES-GCM (nyckel från koden via PBKDF2). Sidan dekrypterar i webbläsaren.
- Ett schemalagt jobb i Claude kör insamlingen 07:45, 11:45 och 19:45.

Koden är ett enkelt lås, inte stark säkerhet – en kort kod går att gissa.
