// Nazar sista minuten: serverns HTML har en rad per resa (datum, resmål, hotell, måltid, rum, reslängd, pris per vuxen).
// Standardlistan gäller avresa från Arlanda.
const txt = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const field = (blk, label) => { const m = blk.match(new RegExp('<span class="sr-only">' + label + '</span>([\\s\\S]*?)</div>')); return m ? txt(m[1]) : ''; };
const num = s => +String(s).replace(/[^\d]/g, '') || null;

export default async function nazar(src, { getText }) {
  const html = await getText(src.url);
  const fran = (html.match(/<option[^>]*value="([A-Z]{3})"[^>]*selected/) || [])[1] || 'ARN';
  const blocks = html.split('class="panel-heading').slice(1);
  const out = [];
  for (const b of blocks) {
    const blk = b.slice(0, 6000);
    // Första bilden i hotellets galleri (längre ner i samma block)
    const img = (b.match(/class="media-item-image"[\s\S]*?src="([^"]+)"/) || [])[1];
    const avresa = (field(blk, 'Datum').match(/\d{4}-\d{2}-\d{2}/) || [])[0];
    const ort = field(blk, 'Destination'), pris = num(field(blk, 'Vuxen Från'));
    if (!avresa || !ort || !pris) continue;
    out.push({
      kalla: src.id, kallaNamn: src.namn, typ: 'paket', fran, ort, avresa,
      dagar: num(field(blk, 'Reslängd')), hotell: field(blk, 'Hotell') || null, kost: field(blk, 'Måltid') || null,
      rum: field(blk, 'Rum') || null, standard: (blk.match(/aria-label="Hotellstandard ([^"]+)"/) || [])[1] || null,
      prisPerPerson: pris, url: src.url, bild: img ? new URL(img, src.url).href : null
    });
  }
  if (!out.length) throw new Error('hittade inga resor i sidan (formatet kan ha ändrats)');
  return { erbjudanden: out, full: true };
}
