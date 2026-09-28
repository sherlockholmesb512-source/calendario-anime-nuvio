'use strict';

/**
 * Arricchimento dei metadati tramite l'addon di terze parti Kitsu
 * (https://anime-kitsu.strem.fun/manifest.json).
 *
 * Le pagine AnimeWorld espongono gia' i link a MyAnimeList e AniList, quindi il
 * match primario usa quegli id (`anilist:<id>` / `mal:<id>`): e' veloce e senza
 * ambiguita'. Quando gli id mancano si cade sulla ricerca per titolo
 * (/catalog/anime/kitsu-anime-list/search=...), con veto su anno e controllo sul
 * tipo (serie/film) per non confondere opere omonime odi remake (es. Liar Game).
 *
 * L'addon Kitsu e' un servizio di terze parti: ogni errore o timeout viene
 * assorbito e i dati AnimeWorld restano il fallback (KITSU_ENABLED=false per
 * disattivarlo del tutto). Le risposte vengono ridotte a un riassunto compatto:
 * il meta grezzo di una serie lunga supera gli 800 KB (i video di tutte le
 * stagioni non servono, gli episodi vengono comunque da AnimeWorld).
 */

const config = require('./config');

const BASE = config.kitsuBase;
const TTL = config.kitsuCacheMs;
const TIMEOUT = config.kitsuTimeoutMs;
const SEARCH_CAP = 800;
const META_CAP = 1500;
const SLUG_CAP = 2500;
const MIN_SCORE = 4;

// ---------------------------------------------------------------------------
// Cache compatte
// ---------------------------------------------------------------------------

const searchCache = new Map(); // titolo normalizzato -> { at, hits }
const metaCache = new Map(); // id richiesto | id canonico -> { at, summary }
const slugInfo = new Map(); // slug AnimeWorld -> { at, info }
const inflight = new Map(); // id richiesto -> Promise

const trim = (map, cap) => {
  while (map.size > cap) {
    const first = map.keys().next().value;
    map.delete(first);
  }
};

const fresh = (entry, now = Date.now()) => Boolean(entry) && now - entry.at < TTL;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Titolo normalizzato: minuscolo, senza accenti, senza (ITA)/(SUB)/(DUB)… */
const normalizeTitle = (title) =>
  String(title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const yearOf = (v) => {
  const m = /(\d{4})/.exec(String(v || ''));
  return m ? Number(m[1]) : null;
};

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Riduce il meta Kitsu ai campi che ci servono (via video, li teniamo noi). */
function summarizeMeta(m) {
  let totalEpisodes = null;
  const vids = Array.isArray(m.videos) ? m.videos : [];
  if (m.type === 'movie') {
    totalEpisodes = vids.length || 1;
  } else if (vids.length) {
    // Serie singola stagione: le stagioni multiple (es. One Piece) non danno un
    // totale affidabile -> resta null e si usa quello di AnimeWorld.
    const s1 = vids.filter((v) => (v.season || 1) === 1 && Number.isFinite(Number(v.episode)));
    if (s1.length && s1.length === vids.length) {
      totalEpisodes = Math.max(...s1.map((v) => Number(v.episode)));
    }
  }
  const rating = Number.parseFloat(String(m.imdbRating || '').replace(',', '.'));
  // Miniatura del singolo episodio (source metahub/IMDb via addon Kitsu), in
  // ordine di episodio. Fallback per la scheda: copertina dell'anime.
  const episodeThumbs = {};
  let thumbIndex = 0;
  for (const v of vids) {
    if (!v || typeof v.thumbnail !== 'string' || !/^https?:\/\//i.test(v.thumbnail)) continue;
    thumbIndex += 1;
    episodeThumbs[thumbIndex] = v.thumbnail;
    if (thumbIndex >= 1000) break;
  }
  return {
    kitsuId: m.id || null,
    name: m.name || null,
    aliases: Array.isArray(m.aliases) ? m.aliases : [],
    description: String(m.description || '')
      .replace(/\s+/g, ' ')
      .trim(),
    genres: Array.isArray(m.genres) ? m.genres.filter((g) => g && typeof g === 'string') : [],
    year: yearOf(m.year || m.releaseInfo),
    status: m.status || null,
    runtime: m.runtime || null,
    rating: Number.isFinite(rating) ? rating : null,
    totalEpisodes,
    poster: m.poster || null,
    background: m.background || null,
    logo: m.logo || null,
    episodeThumbs: Object.keys(episodeThumbs).length ? episodeThumbs : null,
  };
}

function getMetaById(id) {
  const cached = metaCache.get(id);
  if (fresh(cached)) return Promise.resolve(cached.summary);
  if (inflight.has(id)) return inflight.get(id);

  const task = (async () => {
    const body = await fetchJson(`${BASE}/meta/anime/${id}.json`);
    const m = body && body.meta;
    if (!m) return null;
    const summary = summarizeMeta(m);
    const now = Date.now();
    metaCache.set(id, { at: now, summary });
    if (m.id && m.id !== id) metaCache.set(m.id, { at: now, summary });
    trim(metaCache, META_CAP);
    return summary;
  })().finally(() => inflight.delete(id));

  inflight.set(id, task);
  return task;
}

async function searchByTitle(title) {
  const key = normalizeTitle(title);
  if (!key) return null;
  const cached = searchCache.get(key);
  if (fresh(cached)) return cached.hits;

  const q = key.split(' ').slice(0, 8).join(' ');
  const body = await fetchJson(
    `${BASE}/catalog/anime/kitsu-anime-list/search=${encodeURIComponent(q)}.json`,
  );
  const hits = body && Array.isArray(body.metas) ? body.metas : null;
  searchCache.set(key, { at: Date.now(), hits });
  trim(searchCache, SEARCH_CAP);
  return hits;
}

/**
 * Sceglie l'hit Kitsu piu' affine: titolo normalizzato (nome + alias), copertura
 * dei token, tipo (serie/film) e veto sul anno per scartare gli omonimi.
 */
function pickBestMatch(hits, ctx) {
  if (!Array.isArray(hits) || !hits.length || !ctx) return null;
  const normTitle = normalizeTitle(ctx.title || '');
  const tokens = normTitle.split(' ').filter(Boolean);
  if (!tokens.length) return null;
  const wantMovie = ctx.type === 'movie' ? true : ctx.type === 'series' ? false : null;

  let best = null;
  let bestScore = 0;
  for (const h of hits) {
    const hay = [h.name, ...(h.aliases || [])].map(normalizeTitle).filter(Boolean);
    if (!hay.length) continue;

    let score = 0;
    if (hay.includes(normTitle)) score += 5;
    else if (hay.some((n) => n.includes(normTitle) || normTitle.includes(n))) score += 4;

    const hitTokens = new Set(hay.flatMap((n) => n.split(' ').filter(Boolean)));
    const covered = tokens.filter((t) => hitTokens.has(t)).length;
    score += Math.min(3, Math.round((covered / tokens.length) * 3));

    const htype = String(h.type || '').toLowerCase();
    if (wantMovie === true && htype === 'movie') score += 2;
    else if (wantMovie === false && (htype === 'series' || htype === 'anime')) score += 2;

    const hYear = yearOf(h.releaseInfo || h.year);
    if (ctx.year && hYear && Math.abs(ctx.year - hYear) > 2) continue; // omonimi / remake

    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return bestScore >= MIN_SCORE ? best : null;
}

/** Dal campo "Categoria" della pagina AnimeWorld: Film -> movie, altrimenti serie. */
const guessType = (page) => (/film|movie|cinema/i.test(page.category || '') ? 'movie' : 'series');

// ---------------------------------------------------------------------------
// API pubblica
// ---------------------------------------------------------------------------

/**
 * Recupera (e mette in cache) il riassunto Kitsu per uno slug AnimeWorld.
 * Non lancia mai: problemi di rete/addon -> null, i dati AnimeWorld restano.
 */
async function enrichFor(slug, page) {
  if (!config.kitsuEnabled) return null;
  if (!slug || !page || page.notFound) return null;
  const cached = slugInfo.get(slug);
  if (fresh(cached)) return cached.info;

  let meta = null;
  // Strada principale: id che AnimeWorld gia' espone (AniList prima, e' rapido).
  if (page.anilistId) meta = await getMetaById(`anilist:${page.anilistId}`);
  if (!meta && page.malId) meta = await getMetaById(`mal:${page.malId}`);
  // Fallback: ricerca per titolo con controlli anti-omonimi.
  if (!meta && page.title) {
    const hits = await searchByTitle(page.title);
    const best = pickBestMatch(hits, {
      title: page.title,
      type: guessType(page),
      year: page.year,
    });
    if (best) meta = await getMetaById(best.id);
  }
  if (!meta) return null;

  const info = { ...meta, sourceTitle: page.title || null };
  slugInfo.set(slug, { at: Date.now(), info });
  trim(slugInfo, SLUG_CAP);
  return info;
}

/** Lettura non bloccante: informazioni Kitsu gia' in cache per lo slug. */
function peek(slug) {
  const cached = slugInfo.get(slug);
  return fresh(cached) ? cached.info : null;
}

/**
 * Fonde i dati AnimeWorld (pagina /play) con il riassunto Kitsu. La trama e'
 * sempre quella italiana di AnimeWorld (Kitsu e' solo fallback); voto e art
 * vengono da Kitsu; generi, anno e totale episodi restano di AnimeWorld per
 * coerenza con il sito italiano.
 */
function mergeWithPage(page, info) {
  if (!info) return null;
  return {
    description: page.description || info.description || '',
    genres: page.genres && page.genres.length ? page.genres : info.genres,
    year: page.year || info.year || null,
    rating: info.rating || page.rating || null,
    totalEpisodes: page.totalEpisodes || info.totalEpisodes || null,
    status: info.status || page.state || null,
    runtime: info.runtime || page.duration || null,
    poster: page.poster || info.poster || null,
    background: info.background || null,
    logo: info.logo || null,
    episodeThumbs: info.episodeThumbs || null,
    kitsuId: info.kitsuId || null,
  };
}

const stats = () => ({
  enabled: config.kitsuEnabled,
  slugCached: slugInfo.size,
  metaCached: metaCache.size,
  searchCached: searchCache.size,
});

/** Svuota tutte le cache Kitsu (richiamato periodicamente per liberare spazio). */
function flush() {
  const n = slugInfo.size + metaCache.size + searchCache.size;
  slugInfo.clear();
  metaCache.clear();
  searchCache.clear();
  inflight.clear();
  return n;
}

module.exports = { enrichFor, peek, mergeWithPage, normalizeTitle, pickBestMatch, stats, flush };