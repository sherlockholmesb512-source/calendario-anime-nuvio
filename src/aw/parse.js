'use strict';

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  '#x2F': '/',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
};

function decodeEntities(input) {
  if (!input) return '';
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(ENTITIES, name)) return ENTITIES[name];
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
    }
    return match;
  });
}

/** HTML -> testo semplice, con spazi normalizzati. */
function toText(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag || '');
  if (!m) return null;
  const raw = m[2] ?? m[3] ?? m[4] ?? '';
  return decodeEntities(raw).trim();
}

function attrNumber(tag, name) {
  const v = attr(tag, name);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Estrae tutte le occorrenze di una regex come array di stringhe. */
function all(re, html) {
  const out = [];
  let m;
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  while ((m = rx.exec(html)) !== null) {
    out.push(m);
    if (m.index === rx.lastIndex) rx.lastIndex += 1;
  }
  return out;
}

/** Limita al massimo `n` match, per non perdere tempo su pagine enormi. */
function allLimit(re, html, n) {
  const out = [];
  let m;
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  while (out.length < n && (m = rx.exec(html)) !== null) {
    out.push(m);
    if (m.index === rx.lastIndex) rx.lastIndex += 1;
  }
  return out;
}

const absolute = (url) => {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `https://www.animeworld.ac${url.startsWith('/') ? '' : '/'}${url}`;
};

const IT_MONTHS = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

const MONTH_INDEX = IT_MONTHS.reduce((acc, name, i) => {
  acc[name] = i;
  return acc;
}, {});

/** "28 settembre" -> { day: 28, month: 8 } (mese 0-based) */
function parseItalianShortDate(text) {
  const m = /(\d{1,2})\s+([a-z\u00e0-\u00ff]+)/i.exec(String(text || '').toLowerCase());
  if (!m) return null;
  const month = MONTH_INDEX[m[2]];
  if (month === undefined) return null;
  return { day: Number(m[1]), month };
}

module.exports = {
  decodeEntities,
  toText,
  attr,
  attrNumber,
  all,
  allLimit,
  absolute,
  parseItalianShortDate,
  IT_MONTHS,
};
