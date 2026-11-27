// Ryanair: öppna pris-API:t (farfnd) i SEK.
// 1. Malaga: billigaste pris per dag, 12 månader fram, ut från Arlanda/Västerås och hem samma väg. Därur räknas
//    billigaste tur och retur per månad (2–14 dagar) och billigaste helgresa (ut tors–lör, 2–4 nätter). Pris per person.
// 2. Billigaste enkelresa till alla mål från Arlanda och Västerås de närmaste 90 dagarna (underlag för weekend och fynd).
// Ungefär 55 anrop per körning; den gemensamma hämtningen håller takten mot ryanair.com.
const API = 'https://www.ryanair.com/api/farfnd/v4';
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const monthStart = (d, n) => { const x = new Date(d.slice(0, 7) + '-01T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
export const bookUrl = (fran, till, ut, hem, adults = 1) => `https://www.ryanair.com/se/sv/trip/flights/select?adults=${adults}&teens=0&children=0&infants=0&dateOut=${ut}&dateIn=${hem}&isConnectedFlight=false&discount=0&isReturn=true&promoCode=&originIata=${fran}&destinationIata=${till}`;

async function calendar(getJson, from, to, months, start) {
  const days = {};
  for (let i = 0; i < months; i++) {
    const m = monthStart(start, i);
    try {
      const j = await getJson(`${API}/oneWayFares/${from}/${to}/cheapestPerDay?outboundMonthOfDate=${m}&currency=SEK`);
      for (const f of j?.outbound?.fares || []) if (f.price && !f.soldOut && !f.unavailable) days[f.day] = Math.round(f.price.value);
    } catch (e) { if (e.constructor?.name === 'Blocked') throw e; }
  }
  return days;
}

export default async function ryanair(src, { getJson, inst, today }) {
  const M = inst.malaga || {}, months = inst.manaderFram || 12, d0 = today();
  const [minD, maxD] = M.dagar || [2, 14];
  const malaga = { uppdaterad: new Date().toISOString(), manader: {}, basta: null, helg: null, flygplatser: [] };
  for (const fran of M.fran || ['ARN']) for (const till of M.till || ['AGP']) {
    const ut = await calendar(getJson, fran, till, months, d0);
    if (!Object.keys(ut).length) continue;
    const hem = await calendar(getJson, till, fran, months + 1, d0);
    malaga.flygplatser.push(fran);
    for (const [dag, p] of Object.entries(ut)) {
      if (dag < d0) continue;
      const wd = new Date(dag + 'T12:00:00Z').getUTCDay(), man = dag.slice(0, 7);
      for (let k = minD; k <= maxD; k++) {
        const back = addDays(dag, k), q = hem[back]; if (q == null) continue;
        const r = { fran, till, ut: dag, hem: back, dagar: k + 1, pris: p + q, utPris: p, hemPris: q, url: bookUrl(fran, till, dag, back) };
        const cur = malaga.manader[man];
        if (!cur || r.pris < cur.pris) malaga.manader[man] = r;
        if (!malaga.basta || r.pris < malaga.basta.pris) malaga.basta = r;
        if ([4, 5, 6].includes(wd) && k >= 2 && k <= 4) {
          const h = malaga.manader[man + ':helg'];
          if (!h || r.pris < h.pris) malaga.manader[man + ':helg'] = r;
          if (!malaga.helg || r.pris < malaga.helg.pris) malaga.helg = r;
        }
      }
    }
  }
  // Billigaste enkel till alla mål från Arlanda och Västerås (en fråga per flygplats)
  const flygFran = {};
  for (const fran of ['ARN', 'VST']) {
    try {
      const j = await getJson(`${API}/oneWayFares?departureAirportIataCode=${fran}&outboundDepartureDateFrom=${d0}&outboundDepartureDateTo=${addDays(d0, 90)}&currency=SEK&market=sv-se&adultPaxCount=1`);
      flygFran[fran] = (j.fares || []).map(f => ({
        till: f.outbound?.arrivalAirport?.iataCode, ort: f.outbound?.arrivalAirport?.city?.name || f.outbound?.arrivalAirport?.name,
        land: f.outbound?.arrivalAirport?.countryName, datum: (f.outbound?.departureDate || '').slice(0, 10),
        pris: Math.round(f.summary?.price?.value ?? f.outbound?.price?.value)
      })).filter(x => x.till && x.pris > 0).sort((a, b) => a.pris - b.pris);
    } catch (e) { if (e.constructor?.name === 'Blocked') throw e; }
  }
  if (!malaga.basta && !Object.keys(flygFran).length) throw new Error('fick inga priser från Ryanair');
  return { erbjudanden: [], malaga, flygFran, full: false };
}
