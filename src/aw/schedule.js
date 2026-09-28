'use strict';

const config = require('../config');
const { getHtml } = require('./http');
const { toText, all, absolute, parseItalianShortDate } = require('./parse');

// Ordine dei giorni come li stampa AnimeWorld.
const DAY_INDEX = {
  'LUNED': 0,
  'MARTED': 1,
  'MERCOLED': 2,
  'GIOVED': 3,
  'VENERD': 4,
  'SABATO': 5,
  'DOMENICA': 6,
};

const INDETERMINATE = 'INDETERMINATE';

/** Data (YYYY-MM-DD) del giorno `offset` rispetto al lunedi' della settimana AW. */
function addDaysISO(isoDate, offset) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + offset * 86400000;
  const dt = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** Oggi nel fuso di AnimeWorld, come YYYY-MM-DD. */
function todayInItaly(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.scheduleTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now);
}

/**
 * Pagina /schedule di AnimeWorld.
 * Ritorna i 7 giorni della settimana corrente piu' il blocco "uscite indeterminate".
 */
async function getSchedule(now = new Date()) {
  const res = await getHtml(`${config.awBase}/schedule`);
  const html = res.body;

  const rangeMatch = /(\d{1,2}\s+[a-z\u00e0-\u00ff]+)\s*-\s*(\d{1,2}\s+[a-z\u00e0-\u00ff]+)/i.exec(
    html,
  );
  if (!rangeMatch) throw new Error('Intervallo settimane non trovato in /schedule');

  const start = parseItalianShortDate(rangeMatch[1]);
  if (!start) throw new Error(`Data inizio settimana non interpretabile: "${rangeMatch[1]}"`);

  // La pagina mostra sempre la settimana corrente: prendiamo l'anno corrente,
  // con fallback sull'anno precedente se la settimana e' gia' passata.
  let year = now.getUTCFullYear();
  let weekStart = `${year}-${pad(start.month + 1)}-${pad(start.day)}`;
  if (addDaysISO(weekStart, 7) < todayInItaly(now)) {
    weekStart = `${year - 1}-${pad(start.month + 1)}-${pad(start.day)}`;
  }

  // Dividi per intestazioni di giorno.
  const sections = [];
  const headerRe = /<div class="costr">[\s\S]*?<span class="day-header">([\s\S]*?)<\/span>/g;
  let hm;
  while ((hm = headerRe.exec(html)) !== null) {
    sections.push({ label: toText(hm[1]).toUpperCase(), index: hm.index, bodyIndex: hm.index + hm[0].length });
  }
  if (!sections.length) throw new Error('Nessuna intestazione di giorno in /schedule');

  const days = [];
  const indeterminate = [];

  for (let i = 0; i < sections.length; i += 1) {
    const startIdx = sections[i].bodyIndex;
    const endIdx = i + 1 < sections.length ? sections[i + 1].index : html.length;
    const body = html.slice(startIdx, endIdx);
    const label = sections[i].label;
    const dayOffset = DAY_INDEX[label.replace(/[^A-Z]/g, '')];

    const items = parseScheduleItems(body);
    if (dayOffset === undefined) {
      if (label.includes(INDETERMINATE)) indeterminate.push(...items);
    } else {
      days.push({
        label,
        date: addDaysISO(weekStart, dayOffset),
        items,
      });
    }
  }

  return { weekStart, today: todayInItaly(now), days, indeterminate };
}

const pad = (n) => String(n).padStart(2, '0');

function parseScheduleItems(body) {
  const items = [];

  // Slicing per indici: ogni item parte da un <div class="widget boxcalendario"
  // e finisce all'inizio del successivo. Niente lookahead, quindi l'ultimo
  // elemento di ogni sezione non viene perso.
  const boxRe = /<div class="widget boxcalendario/g;
  const starts = [];
  let m;
  while ((m = boxRe.exec(body)) !== null) starts.push(m.index);

  for (let i = 0; i < starts.length; i += 1) {
    const stop = i + 1 < starts.length ? starts[i + 1] : body.length;
    const chunk = body.slice(starts[i], stop);

    const link = /<a[^>]*href="\/play\/([^"/]+)(?:\/([^"/]+))?"[^>]*title="([^"]*)"/i.exec(chunk);
    if (!link) continue;
    const slug = link[1];
    const epId = link[2] || null;
    const title = toText(link[3]) || toText(chunk);

    const bg = /background:\s*url\(([^)]+)\)/i.exec(chunk);
    const poster = bg ? absolute(bg[1].replace(/["']/g, '')) : null;

    const epMatch = /<div class="episodio-calendario[^"]*">([\s\S]*?)<\/div>/i.exec(chunk);
    const epText = epMatch ? toText(epMatch[1]) : '';
    const epNumber = Number((epText.match(/\d+/) || [])[0]) || null;

    const hourMatch = /<span class="hour">([\s\S]*?)<\/span>/i.exec(chunk);
    const hourText = hourMatch ? toText(hourMatch[1]) : '';
    const time = (hourText.match(/\d{1,2}:\d{2}/) || [])[0] || null;

    const tip = /data-tip="api\/tooltip\/(\d+)"/i.exec(chunk);

    items.push({
      epId,
      slug,
      animeKey: slug.slice(slug.lastIndexOf('.') + 1),
      numId: tip ? Number(tip[1]) : null,
      title,
      poster,
      epNumber,
      time,
      timeLabel: time ? `alle ${time}` : 'ora non definita',
      url: `${config.awBase}/play/${slug}`,
    });
  }
  return items;
}

module.exports = { getSchedule, todayInItaly, addDaysISO, all };
