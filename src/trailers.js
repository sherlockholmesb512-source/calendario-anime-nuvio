'use strict';

/**
 * Trailer per la scheda (meta.trailers).
 *
 * Stremio/Nuvio mostrano il pulsante "Trailer" solo se il meta contiene
 * l'array `trailers: [{ source: <id YouTube>, type: 'Trailer' }]`.
 *
 * Per avere i trailer SOTTOTITOLATI IN ITALIANO la fonte affidabile sono i
 * canali italiani che li pubblicano (Crunchyroll Italia, Yamato Video, Dynit,
 * Anime Factory, ...): si cerca su YouTube "<titolo> trailer italiano" e si
 * scelgono i risultati di quei canali / con keyword italiane. Come ultima
 * riserva si usa il trailer che AnimeWorld incorpora nella propria pagina
 * (di norma il PV giapponese, senza sottotitoli ITA).
 *
 * Tutto "best effort": qualunque errore/timeout restituisce semplicemente i
 * trailer disponibili (anche nessuno) senza bloccare la scheda.
 */

const config = require('./config');

// Canali italiani di anime: un trailer pubblicato qui e' (quasi sempre) con
// sottotitoli o doppiaggio in italiano. Sono canali "di fiducia": i loro video
// vengono accettati anche se il titolo italiano e' diverso da quello cercato
// (es. "The Apothecary Diaries" -> "Il monologo della Speziale").
const TRUSTED_CHANNELS = [
  'crunchyroll italia',
  'yamato video',
  'dynit',
  'anime factory',
  'star comics',
  'vvvvid',
  'panini video',
  'animeclick',
  'anime generation',
];

const NEG_RE = /episodio\s*\d|ep\.?\s*\d|\bamv\b|recension|reaction|\breact\b|opening|\bending\b|\bop\b|\bed\b|episodio completo|full episode|sigla|riassunto|concept|fan ?made|live ?action|parodia/i;
const TRAILER_RE = /trailer|anteprima|teaser|\bpv\b|official/i;
const IT_RE = /\bitalian[oa]\b|sub ?ita|sottotitol|\bita\b/i;

const cache = new Map(); // chiave -> { at, data }
const inflight = new Map();
const failMark = new Map();
const NEG_TTL = 30 * 60 * 1000;

const fresh = (hit, ttl) => Boolean(hit) && Date.now() - hit.at < ttl;

function memoTtl(key, ttl, producer) {
  const hit = cache.get(key);
  if (fresh(hit, ttl)) return Promise.resolve(hit.data);
  if (inflight.has(key)) return inflight.get(key);
  const failed = failMark.get(key);
  if (failed && Date.now() - failed < NEG_TTL) return Promise.resolve(null);

  const task = (async () => {
    try {
      const data = await producer();
      if (data && data.length) {
        failMark.delete(key);
        cache.set(key, { at: Date.now(), data });
        if (cache.size > 500) {
          const first = cache.keys().next().value;
          if (first !== undefined) cache.delete(first);
        }
        return data;
      }
      failMark.set(key, Date.now());
      return null;
    } catch (err) {
      failMark.set(key, Date.now());
      console.warn(`[trailer] ${key}: ${err.message}`);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

// ---------------------------------------------------------------------------
// Parsing dei risultati di ricerca YouTube
// ---------------------------------------------------------------------------

/** Decodifica le sequenze JSON (\u0026, \", ...) di una stringa HTML. */
function decode(str) {
  try {
    return JSON.parse(`"${str}"`);
  } catch {
    return str;
  }
}

/** Durata in secondi da "1:30" / "1:02:03"; null se non disponibile. */
function lengthToSeconds(chunk) {
  const i = chunk.indexOf('"lengthText"');
  if (i < 0) return null;
  const m = /"simpleText":"(\d+):(\d+)(?::(\d+))?"/.exec(chunk.slice(i, i + 300));
  if (!m) return null;
  return m[3] ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
}

function parseVideoRenderers(html) {
  const out = [];
  const chunks = html.split('"videoRenderer":{');
  for (let i = 1; i < chunks.length; i += 1) {
    const c = chunks[i];
    const id = /"videoId":"([A-Za-z0-9_-]{11})"/.exec(c);
    if (!id) continue;
    const title =
      (/"title":\{"runs":\[\{"text":"(.*?)"\}/.exec(c) || [])[1] ||
      (/"title":\{"simpleText":"(.*?)"\}/.exec(c) || [])[1] ||
      '';
    const channel =
      (/"ownerText":\{"runs":\[\{"text":"(.*?)"/.exec(c) || [])[1] ||
      (/"longBylineText":\{"runs":\[\{"text":"(.*?)"/.exec(c) || [])[1] ||
      '';
    out.push({
      id: id[1],
      title: decode(title),
      channel: decode(channel),
      seconds: lengthToSeconds(c),
    });
  }
  return out;
}

// Parole troppo comuni: non aiutano a capire se il video parla dello stesso anime.
const STOP = new Set([
  'the', 'and', 'of', 'to', 'in', 'il', 'lo', 'la', 'gli', 'le', 'di', 'da',
  'con', 'su', 'per', 'tra', 'fra', 'una', 'uno', 'stagione', 'season', 'part',
  'parte', 'cour', 'arc', 'film', 'movie', 'ita', 'sub', 'subs', 'official',
  'trailer', 'teaser', 'anteprima', 'ufficiale', 'nuovo', 'nuova', 'anime',
]);

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 4 && !STOP.has(w));
}

/** Il titolo del video parla (con buona probabilita') dello stesso anime? */
function sameShow(queryTokens, videoTitle, channel) {
  const ch = channel.toLowerCase();
  if (TRUSTED_CHANNELS.some((c) => ch.includes(c))) return true;
  if (!queryTokens.length) return true;
  const vt = new Set(tokens(videoTitle));
  const matched = queryTokens.filter((w) => vt.has(w)).length;
  return matched >= Math.min(2, queryTokens.length);
}

/** Punteggio: alto = probabile trailer ufficiale sottotitolato in italiano. */
function score(v) {
  const ch = v.channel.toLowerCase();
  const t = v.title.toLowerCase();
  let s = 0;
  if (TRUSTED_CHANNELS.some((c) => ch.includes(c))) s += 10;
  if (IT_RE.test(t)) s += 6;
  if (/anteprima|trailer|teaser|\bpv\b/.test(t)) s += 4;
  else if (/official/.test(t)) s += 2;
  if (/dub ?ita|doppiagg/.test(t)) s += 1;
  if (NEG_RE.test(t)) s -= 12;
  // Un trailer dura pochi minuti: escludiamo episodi/completi lunghi.
  if (v.seconds && v.seconds > 12 * 60) s -= 12;
  return s;
}

async function searchYouTube(query) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.trailersTimeoutMs);
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=it&gl=IT`;
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'accept-language': 'it-IT,it;q=0.9,en;q=0.6',
        accept: 'text/html,application/xhtml+xml',
        cookie: 'CONSENT=YES+cb; PREF=hl=it&gl=IT',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseVideoRenderers(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// API pubblica
// ---------------------------------------------------------------------------

/**
 * Trailer per una scheda.
 * @param {{ title?: string, year?: string|number, awTrailer?: string|null }} page
 * @returns {Promise<Array<{source:string,type:string}>>}
 */
async function getTrailers(page = {}) {
  if (!config.trailersEnabled) return [];

  const title = (page.title || '').trim();
  const awTrailer = /^[A-Za-z0-9_-]{11}$/.test(page.awTrailer || '') ? page.awTrailer : null;

  const found = title
    ? await memoTtl(`yt:${title.toLowerCase()}`, config.trailersCacheMs, async () => {
        const results = await searchYouTube(`${title} trailer italiano`);
        const queryTokens = tokens(title);
        const ranked = results
          .map((v) => ({ ...v, s: score(v) }))
          .filter(
            (v) =>
              v.s >= 6 &&
              TRAILER_RE.test(v.title) &&
              sameShow(queryTokens, v.title, v.channel),
          )
          .sort((a, b) => b.s - a.s);

        const picked = [];
        const seen = new Set();
        for (const v of ranked) {
          if (seen.has(v.id)) continue;
          seen.add(v.id);
          picked.push({ source: v.id, type: 'Trailer' });
          if (picked.length >= config.trailersMax) break;
        }
        return picked;
      })
    : null;

  const out = found ? found.slice() : [];

  // Riserva: il trailer della pagina AnimeWorld (PV giapponese), solo se non
  // abbiamo trovato nulla di italiano.
  if (!out.length && awTrailer) {
    out.push({ source: awTrailer, type: 'Trailer' });
  }

  return out.slice(0, Math.max(1, config.trailersMax));
}

const stats = () => ({ cached: cache.size, inflight: inflight.size, failed: failMark.size });

module.exports = { getTrailers, stats };
