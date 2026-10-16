'use strict';

const config = require('../config');
const { getHtml } = require('./http');
const { toText, attr, absolute } = require('./parse');

/**
 * Pagina /schedule di AnimeWorld ("CALENDARIO ANIME").
 *
 * La pagina e' costruita con sezioni <section class="sch-day">, una per ogni
 * giorno della settimana corrente. Ogni sezione dichiara l'intervallo reale in
 * millisecondi (mezzanotte italiana -> mezzanotte italiana):
 *
 *   <section class="sch-day is-today is-sel" data-day="fri" data-start="..."
 *            data-end="..." data-name="Venerd&igrave;" data-label="16 ott">
 *     <ul class="sch-tl">
 *       <li class="sch-row is-done" data-at="1791810000000" data-time="15:00">
 *         <a class="sch-item" href="https://www.animeworld.ac/play/<slug>">
 *           <span class="sch-po"><img src="https://img.animeworld.ac/locandine/x.jpg"></span>
 *           <span class="sch-cb">
 *             <span class="sch-ct" data-jtitle="<titolo originale>">Titolo italiano</span>
 *             <span class="sch-cm">
 *               <span class="sch-ep">Episodio 2</span>
 *               <span class="sch-st sch-ok" data-st>Uscito</span>
 *             </span>
 *           </span>
 *         </a>
 *       </li>
 *   ...
 *   <section class="sch-unk">   <- "Senza data fissa"
 *
 * L'intervallo in millisecondi e' fondamentale: il marker "Oggi" e' generato
 * lato server ed e' soggetto alla cache CDN, mentre i timestamp sono esatti.
 * Il giorno di oggi viene quindi scelto confrontando "ora" con [start, end).
 */

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** epoch ms -> YYYY-MM-DD nel fuso del calendario AnimeWorld. */
function isoInItaly(ms) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: config.scheduleTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** epoch ms -> "HH:MM" nel fuso del calendario AnimeWorld. */
function timeInItaly(ms) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: config.scheduleTz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return null;
  }
}

const MESI = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];
const GIORNI = [
  'domenica', 'luned&igrave;', 'marted&igrave;', 'mercoled&igrave;',
  'gioved&igrave;', 'venerd&igrave;', 'sabato',
];

/** YYYY-MM-DD -> "venerdì 17 ottobre" (fuso AnimeWorld). */
function italianDayLabel(iso, ms) {
  const when = ms != null ? new Date(ms) : new Date(`${iso}T12:00:00Z`);
  const day = GIORNI[when.getUTCDay()] || '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${day} ${d} ${MESI[(m || 1) - 1]}`;
}

/** Estrae il valore di un attributo da un tag gia' isolato. */
const tagAttr = (tag, name) => attr(tag || '', name);

/** Numero da testi come "Episodio 12" / "Ep. 941". */
function episodeNumber(text) {
  const m = /(\d+)/.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Parsing delle righe di un giorno: ritorna gli episodi in uscita.
 * Ogni riga ha l'orario assoluto (data-at), l'orario locale (data-time), lo
 * slug, la copertina, il titolo, il numero di episodio e lo stato.
 */
function parseRows(body) {
  const rows = [];
  const rowRe = /<li class="sch-row[^"]*"([^>]*)>([\s\S]*?)(?=<li class="sch-row|<\/ul>)/g;
  let m;
  while ((m = rowRe.exec(body)) !== null) {
    const attrs = m[1] || '';
    const chunk = m[2] || '';

    const linkTag = /<a\b[^>]*class="[^"]*sch-item[^"]*"[^>]*>/i.exec(chunk)
      || /<a\b[^>]*href="[^"]*\/play\/[^"]*"[^>]*>/i.exec(chunk);
    const href = linkTag ? tagAttr(linkTag[0], 'href') : null;
    const slug = slugFromHref(href);
    if (!slug) continue;

    const at = Number(/data-at="(\d+)"/.exec(attrs)?.[1] || /data-at="(\d+)"/.exec(chunk)?.[1]) || null;
    const timeText = (/data-time="(\d{1,2}:\d{2})"/.exec(attrs) || /data-time="(\d{1,2}:\d{2})"/.exec(chunk) || [])[1] || null;

    const imgTag = /<img\b[^>]*>/i.exec(chunk);
    const poster = imgTag ? absolute(tagAttr(imgTag[0], 'src') || tagAttr(imgTag[0], 'data-src')) : null;

    const ctTag = /<span\b[^>]*class="[^"]*sch-ct[^"]*"[^>]*>/i.exec(chunk);
    const title = ctTag ? toText(chunk.slice(ctTag.index).split('</span>')[0]) : '';
    const jtitle = ctTag ? tagAttr(ctTag[0], 'data-jtitle') : null;

    const epTag = /<span\b[^>]*class="[^"]*sch-ep[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk);
    const epText = epTag ? toText(epTag[1]) : '';
    const epNumber = episodeNumber(epText);

    const stTag = /<span\b[^>]*class="[^"]*sch-st([^"]*)"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk);
    const stClasses = stTag ? stTag[1] : '';
    const stText = stTag ? toText(stTag[2]) : '';
    const released = /sch-ok/i.test(stClasses) || /^uscito/i.test(stText);

    rows.push({
      epId: null,
      slug,
      animeKey: slug.slice(slug.lastIndexOf('.') + 1),
      title: title || jtitle || slug,
      jtitle: jtitle || null,
      poster,
      epNumber,
      epText: epText || null,
      at,
      time: timeText || (at ? timeInItaly(at) : null),
      released,
      statusLabel: stText || (released ? 'Uscito' : 'In arrivo'),
      url: `${config.awBase}/play/${slug}`,
    });
  }
  return rows;
}

/** "https://www.animeworld.ac/play/<slug>" -> "<slug>" */
function slugFromHref(href) {
  if (!href) return null;
  const m = /\/play\/([^"?/#]+)/.exec(href);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Sezione "Senza data fissa": serie in corso senza giorno stabilito. */
function parseIndeterminate(html) {
  const start = html.indexOf('class="sch-unk"');
  if (start < 0) return [];
  const from = html.lastIndexOf('<section', start);
  const region = html.slice(from < 0 ? start : from);

  const items = [];
  const seen = new Set();
  const re = /<a\b[^>]*class="[^"]*sch-u\b[^"]*"[^>]*href="([^"]+)"[^>]*>|<a\b[^>]*href="([^"]+)"[^>]*class="[^"]*sch-u\b[^"]*"[^>]*>/g;
  let m;
  while ((m = re.exec(region)) !== null) {
    const slug = slugFromHref(m[1] || m[2]);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const chunk = region.slice(m.index, m.index + 1200);
    const imgTag = /<img\b[^>]*>/i.exec(chunk);
    const utTag = /<span\b[^>]*class="[^"]*sch-ut[^"]*"[^>]*>/i.exec(chunk);
    const uepTag = /<span\b[^>]*class="[^"]*sch-uep[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk);
    items.push({
      epId: null,
      slug,
      animeKey: slug.slice(slug.lastIndexOf('.') + 1),
      title: utTag ? toText(chunk.slice(utTag.index).split('</span>')[0]) : slug,
      jtitle: utTag ? tagAttr(utTag[0], 'data-jtitle') : null,
      poster: imgTag ? absolute(tagAttr(imgTag[0], 'src') || tagAttr(imgTag[0], 'data-src')) : null,
      epNumber: uepTag ? episodeNumber(toText(uepTag[1])) : null,
      at: null,
      time: null,
      released: false,
      statusLabel: 'Senza data fissa',
      indeterminate: true,
      url: `${config.awBase}/play/${slug}`,
    });
  }
  return items;
}

/** "Prossima uscita" in testa alla pagina: utile come promemoria. */
function parseHero(html) {
  const m = /<section class="sch-hero[^"]*"[^>]*data-at="(\d+)"[^>]*>([\s\S]*?)<\/section>/i.exec(html);
  if (!m) return null;
  const at = Number(m[1]) || null;
  const chunk = m[2];
  const linkTag = /<a\b[^>]*class="[^"]*sch-ht[^"]*"[^>]*>/i.exec(chunk);
  const slug = slugFromHref(linkTag ? tagAttr(linkTag[0], 'href') : null);
  const epTag = /<span\b[^>]*class="[^"]*sch-ep[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk);
  const whenTag = /<span\b[^>]*class="[^"]*sch-hwt[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk);
  return {
    at,
    slug,
    title: linkTag ? toText(chunk.slice(linkTag.index).split('</span>')[0]) : null,
    jtitle: linkTag ? tagAttr(linkTag[0], 'data-jtitle') : null,
    epNumber: epTag ? episodeNumber(toText(epTag[1])) : null,
    whenText: whenTag ? toText(whenTag[1]) : null,
    iso: at ? isoInItaly(at) : null,
    time: at ? timeInItaly(at) : null,
  };
}

/** Scarica e interpreta /schedule. Ritorna i giorni, le indeterminate e l'hero. */
async function getSchedule(now = new Date()) {
  // Cache-buster "leggero": la pagina e' dinamica (marker "Oggi", countdown)
  // e Cloudflare puo' servire un render vecchio di giorni. Un parametro che
  // cambia ogni 10 minuti bypassa la cache senza martellare l'origine.
  const bucket = Math.floor(Date.now() / (config.refreshMs || 300000));
  const res = await getHtml(`${config.awBase}/schedule?w=${bucket}`);
  const html = res.body;

  const sectionRe = /<section class="sch-day[^"]*"[^>]*>/g;
  const heads = [...html.matchAll(sectionRe)];
  if (!heads.length) throw new Error('Nessuna sezione giorno in /schedule (pagina cambiata?)');

  const days = [];
  for (let i = 0; i < heads.length; i += 1) {
    const tag = heads[i][0];
    const bodyStart = heads[i].index + tag.length;
    const bodyEnd = i + 1 < heads.length ? heads[i + 1].index : html.length;
    const body = html.slice(bodyStart, Math.max(bodyStart, bodyEnd));

    const start = Number(tagAttr(tag, 'data-start')) || null;
    const end = Number(tagAttr(tag, 'data-end')) || null;
    const key = tagAttr(tag, 'data-day');
    const items = parseRows(body);

    days.push({
      key: DAY_KEYS.includes(key) ? key : key,
      name: tagAttr(tag, 'data-name'),
      label: tagAttr(tag, 'data-label'),
      isToday: /is-today/i.test(tagAttr(tag, 'class') || ''),
      start,
      end,
      date: start ? isoInItaly(start) : null,
      items,
    });
  }

  // I giorni arrivano gia' in ordine lun->dom; li riordina comunque per
  // sicurezza e mantieni solo quelli con timestamp valido.
  days.sort((a, b) => (a.start || 0) - (b.start || 0));

  return {
    weekStart: days[0] && days[0].date ? days[0].date : null,
    days: days.filter((d) => d.start && d.end),
    indeterminate: parseIndeterminate(html),
    hero: parseHero(html),
    fetchedAt: Date.now(),
  };
}

module.exports = {
  getSchedule,
  parseRows,
  parseIndeterminate,
  parseHero,
  isoInItaly,
  timeInItaly,
  italianDayLabel,
  episodeNumber,
};
