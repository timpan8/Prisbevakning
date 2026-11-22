# Butiker utanför Prisjakt

Prisjakt indexerar inte alla butiker. `extra-shops.json` innehåller en lista med butiker per kategori och vilka kategorier varje bevakad vara hör till. Insamlingen kollar de butiker som kan ha varan och som Prisjakt inte redan täcker.

## Vilka butiker som kollas för en vara
1. Slå upp varans kategorier under `varor` (t.ex. Kärcher → `bygg`, `hem`).
2. Ta alla butiker i de kategorierna.
3. Hoppa över butiker med `prisjakt: true`; deras pris finns redan via Prisjakt.
4. Är `prisjakt` `null`: sök på butikens namn på Prisjakt en gång. Listas den som säljare, skriv `true`, annars `false`, och spara filen. Då behöver det bara göras en gång per butik.

Undantag:
- **Begagnat:** alla butiker där kollas, även de som finns på Prisjakt (Prisjakt ger bara nya erbjudanden). Tradera och Blocket hoppas över eftersom de hämtas av egna skript. Facebook Marketplace kräver att du är inloggad på Facebook i Chrome; AI:n läser bara annonser och skriver aldrig till säljare. `bara` begränsar en butik till vissa kategorier (t.ex. Back Market bara för elektronik).
- **Tillverkare:** bara märket som står i varans namn kollas (Kärcher för Kärcher osv.).
- **Kina:** bara butiker vars `fokus` passar varan, och butiker med `marke` bara för det märket. `auto: false` (komponenter, kretskort, grossist) kollas inte automatiskt. Märkesvaror räknas bara från märkets officiella butik eller auktoriserad återförsäljare; kopior hoppas över. Priset ska vara levererat till Sverige: inkl. moms och frakt, och över 150 euro även tull och PostNords avgift. Leveranstiden skrivs i `note`.

## Så kollas en butik
1. Öppna butikens svenska webbutik (Claude in Chrome) och sök på varans namn och modellnummer.
2. Kontrollera att det är exakt samma modell som på Prisjakt.
3. Läs av pris, frakt för en vara, om den går att beställa nu och länken till produktsidan.
4. Lägg in resultatet i run.json under `extra`:

```json
"extra": {
  "karcher-sc3-easyfix": [
    { "shop": "Jula", "price": 1599, "ship": 0, "url": "https://...", "stock": "InStock" }
  ],
  "airpods-pro-3": [
    { "shop": "Back Market", "price": 1790, "url": "https://...", "used": true }
  ],
  "vileda-h2pro-flat": []
}
```

- En vara som saknas i `extra` lämnas orörd; senaste kontrollen ligger kvar i upp till 3 dagar.
- En tom lista betyder "kollat, ingen extra-butik hade den" och tar bort tidigare extra-erbjudanden för varan.
- `stock` är `InStock` eller `Limited`. Slutsålt tas inte med.
- `used: true` (renoverat/begagnat) visas under Begagnat och räknas inte som nytt erbjudande.

Extra-erbjudandena slås ihop med Prisjakts och räknas med i billigaste pris, paket och prislogg. På sidan står "utanför Prisjakt" vid dem.

## Hur ofta
En gång per dag räcker (morgonkörningen); priserna där ändras sällan. Med många butiker per kategori: börja med de som har `prisjakt: false` och ta resten efter hand.

## Nya varor
Lägg till varans nyckel under `varor` med de kategorier som passar (`bygg`, `hem`, `elektronik`, `sport`, `barn`, `tradgard`, `fordon`, `skonhet`, `varuhus`, `apotek`, `tillverkare`, `kina`, `begagnat`). `begagnat` passar nästan alltid.
