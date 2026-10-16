'use strict';

/**
 * Fonti metadati ESTERNE per stagioni ed episodi.
 *
 * AnimeWorld non ha le stagioni reali (ogni stagione e' una pagina a parte,
 * spesso con titoli diversi: "Tokyo Revengers: Tenjiku Arc" e' la 3^ stagione)
 * ne' le miniature/trame per singolo episodio. Le fonti usate, in ordine:
 *
 *   1. AIOMetadata (https://aiometADATA.../manifest.json) — addon di terze parti
 *      che serve dati TVDB/TMDB/MAL: conosce le stagioni degli anime e offre
 *      titolo, trama ITALIANA, immagine e data di uscita di ogni episodio.
 *      Si interroga per id MyAnimeList/AniList, che AnimeWorld espone gia'.
 *   2. TMDB (chiave dell'utente): still + trama italiana per episodio e
 *      struttura stagioni. Su TMDB molte stagioni anime sono fuse in una
 *      sola, per cui e' una riserva e non la fonte primaria.
 *   3. TheTVDB (chiave dell'utente): solo struttura delle stagioni.
 *
 * Tutte le funzioni sono "best effort": qualsiasi errore o timeout viene
 * assorbito e l'addon continua con i soli dati AnimeWorld.
 */

const config = require('./config');

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function requestJson(url, { timeoutMs = 15000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Cache condivisa
// ---------------------------------------------------------------------------

const cache = new Map(); // chiave -> { at, data }
const inflight = new Map();
const NEG_TTL = 10 * 60 * 1000;
const failMark = new Map();

const fresh = (hit, ttl) => Boolean(hit) && Date.now() - hit.at < ttl;

function remember(key, data, ttl) {
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 800) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  return data;
}

function memo(key, ttl, producer) {
  const hit = cache.get(key);
  if (fresh(hit, ttl)) return Promise.resolve(hit.data);
  if (inflight.has(key)) return inflight.get(key);
  const failed = failMark.get(key);
  if (failed && Date.now() - failed < NEG_TTL) return Promise.resolve(null);

  const task = (async () => {
    try {
      const data = await producer();
      if (data) {
        failMark.delete(key);
        return remember(key, data, ttl);
      }
      failMark.set(key, Date.now());
      return null;
    } catch (err) {
      failMark.set(key, Date.now());
      console.warn(`[ext] ${key} non disponibile: ${err.message}`);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

// ---------------------------------------------------------------------------
// Normalizzazione comune: video -> stagioni
// ---------------------------------------------------------------------------

function emptyExternal(source = null) {
  return { source, seasons: {}, next: null, imdbId: null, tmdbId: null };
}

/**
 * Trasforma l'elenco piatto dei video (formato Stremio: season/episode/title/
 * overview/thumbnail/released) in stagioni numerate con episodi indicizzati.
 * La stagione 0 (special/pillole) viene ignorata: non ha senso nella scheda.
 */
function normalizeVideos(videos, source) {
  const out = emptyExternal(source);
  if (!Array.isArray(videos)) return out;

  const now = Date.now();
  let nextCandidate = null;

  for (const v of videos) {
    const season = Number(v && v.season);
    const episode = Number(v && v.episode);
    if (!Number.isFinite(season) || season < 1) continue;
    if (!Number.isFinite(episode) || episode < 1) continue;

    const bucket = out.seasons[season] || (out.seasons[season] = {
      number: season,
      name: null,
      airDate: null,
      episodeCount: 0,
      episodes: {},
    });

    const released = v && v.released ? String(v.released) : null;
    bucket.episodes[episode] = {
      title: clean(v.title) || null,
      overview: clean(v.overview) || null,
      thumbnail:
        v && typeof v.thumbnail === 'string' && /^https?:\/\//i.test(v.thumbnail)
          ? v.thumbnail
          : null,
      released,
      runtime: (v && Number(v.runtime)) || null,
    };
    if (episode > bucket.episodeCount) bucket.episodeCount = episode;

    const airDate = released ? released.slice(0, 10) : null;
    if (airDate && (!bucket.airDate || airDate < bucket.airDate)) bucket.airDate = airDate;

    const ts = released ? Date.parse(released) : NaN;
    if (Number.isFinite(ts) && ts > now) {
      if (!nextCandidate || ts < nextCandidate.ts) {
        nextCandidate = {
          ts,
          season,
          episode,
          released,
          title: bucket.episodes[episode].title,
        };
      }
    }
  }

  out.next = nextCandidate;
  return out;
}

/** Unisci due fonti: la prima ha la priorita' episodio per episodio. */
function mergeExternal(primary, secondary) {
  if (!primary) return secondary || emptyExternal();
  if (!secondary) return primary;
  const out = { ...primary, seasons: { ...primary.seasons } };
  for (const [n, sec] of Object.entries(secondary.seasons || {})) {
    const num = Number(n);
    const pri = out.seasons[num];
    if (!pri) {
      out.seasons[num] = sec;
      continue;
    }
    const episodes = { ...sec.episodes };
    for (const [e, data] of Object.entries(pri.episodes)) {
      const cur = episodes[e] || {};
      episodes[e] = {
        title: cur.title || data.title || null,
        overview: cur.overview || data.overview || null,
        thumbnail: cur.thumbnail || data.thumbnail || null,
        released: cur.released || data.released || null,
        runtime: cur.runtime || data.runtime || null,
      };
    }
    out.seasons[num] = {
      ...pri,
      episodes,
      episodeCount: Math.max(pri.episodeCount || 0, sec.episodeCount || 0),
      airDate: pri.airDate || sec.airDate || null,
      name: pri.name || sec.name || null,
    };
  }
  if (!out.next && secondary.next) out.next = secondary.next;
  return out;
}

// ---------------------------------------------------------------------------
// 1) AIOMetadata
// ---------------------------------------------------------------------------

function aiomIds(page) {
  const ids = [];
  if (page.malId) ids.push(`mal:${page.malId}`);
  if (page.anilistId) ids.push(`anilist:${page.anilistId}`);
  if (page.imdbId) ids.push(`imdb:${page.imdbId}`);
  return ids;
}

async function fetchAiom(page) {
  if (!config.aiomEnabled || !config.aiomBase || !page) return null;
  const ids = aiomIds(page);
  if (!ids.length) return null;

  for (const id of ids) {
    const key = `aiom|${id}`;
    const data = await memo(key, config.aiomCacheMs, async () => {
      const body = await requestJson(
        `${config.aiomBase}/meta/series/${encodeURIComponent(id)}.json`,
        { timeoutMs: config.aiomTimeoutMs },
      );
      const meta = body && body.meta;
      if (!meta || !Array.isArray(meta.videos) || !meta.videos.length) return null;
      const ext = normalizeVideos(meta.videos, 'aiom');
      if (!Object.keys(ext.seasons).length) return null;
      ext.imdbId = meta.imdb_id || meta._imdbId || null;
      ext.tmdbId = meta._tmdbId || null;
      ext.tvdbId = meta._tvdbId || null;
      ext.name = meta.name || null;
      return ext;
    });
    if (data) return data;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2) TMDB
// ---------------------------------------------------------------------------

const TMDB = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w780';

/**
 * Titolo "pulito" per la ricerca: AnimeWorld aggiunge suffissi come
 * "(ITA)", "(Sub ITA)", "(DOPPIATO)" e due punti che mandano a vuoto la query.
 */
function searchTitle(title) {
  let t = clean(title);
  t = t.replace(/\s*\((?:ita|sub\s*ita|dub|doppiato|sub|eng|completo)[^)]*\)\s*/gi, ' ');
  t = t.split(':')[0];
  return clean(t);
}

function pickTvMatch(cands, year) {
  if (!Array.isArray(cands) || !cands.length) return null;
  const scored = cands
    .filter((c) => c && c.id && c.original_language === 'ja')
    .map((c) => {
      let score = 0;
      if (c.origin_country && c.origin_country.includes('JP')) score += 3;
      const y = Number(String(c.first_air_date || '').slice(0, 4));
      if (year && y && Math.abs(y - Number(year)) <= 1) score += 4;
      return { c, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].c : cands[0];
}

async function resolveTvId(page) {
  const key = config.tmdbApiKey;
  if (!key) return null;
  const title = searchTitle(page.title);
  if (!title) return null;
  const year = page.year ? Number(page.year) : null;
  const cacheKey = `tmdb-id|${title.toLowerCase()}|${year || ''}`;
  return memo(cacheKey, config.aiomCacheMs, async () => {
    const src = await requestJson(
      `${TMDB}/search/tv?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(title)}&language=it-IT${year ? `&first_air_date_year=${year}` : ''}`,
      { timeoutMs: 12000 },
    );
    const best = pickTvMatch(src && src.results, year);
    return best ? { id: best.id, name: best.name } : null;
  });
}

/** Struttura stagioni + episodi (titolo/trama italiana, still, data). */
async function fetchTmdb(page, wantSeasons = []) {
  const key = config.tmdbApiKey;
  if (!key || !page) return null;
  const resolved = await resolveTvId(page);
  if (!resolved) return null;

  const wanted = [...new Set(wantSeasons.map(Number).filter((n) => Number.isFinite(n) && n >= 1))];
  if (!wanted.length) wanted.push(1);

  const seasons = {};
  for (const season of wanted) {
    const data = await memo(`tmdb|${resolved.id}|s${season}`, config.aiomCacheMs, async () => {
      const body = await requestJson(
        `${TMDB}/tv/${resolved.id}/season/${season}?api_key=${encodeURIComponent(key)}&language=it-IT`,
        { timeoutMs: 12000 },
      );
      if (!body || !Array.isArray(body.episodes) || !body.episodes.length) return null;
      const videos = body.episodes.map((e) => ({
        season,
        episode: Number(e.episode_number),
        title: clean(e.name) || null,
        overview: clean(e.overview) || null,
        thumbnail: e.still_path ? `${TMDB_IMG}${e.still_path}` : null,
        released: e.air_date || null,
        runtime: e.runtime || null,
      }));
      return { name: clean(body.name) || null, airDate: body.air_date || null, videos };
    });
    if (data) {
      const ext = normalizeVideos(data.videos, 'tmdb');
      const s = ext.seasons[season];
      if (s) {
        s.name = data.name;
        if (data.airDate) s.airDate = data.airDate;
        seasons[season] = s;
      }
    }
  }

  if (!Object.keys(seasons).length) return null;
  const out = emptyExternal('tmdb');
  out.seasons = seasons;
  out.tmdbId = resolved.id;
  return out;
}

/** Elenco delle stagioni note su TMDB (numero, nome, numero episodi, data). */
async function fetchTmdbSeasonList(page) {
  const key = config.tmdbApiKey;
  if (!key || !page) return null;
  const resolved = await resolveTvId(page);
  if (!resolved) return null;
  return memo(`tmdb-list|${resolved.id}`, config.aiomCacheMs, async () => {
    const body = await requestJson(
      `${TMDB}/tv/${resolved.id}?api_key=${encodeURIComponent(key)}&language=it-IT`,
      { timeoutMs: 12000 },
    );
    if (!body || !Array.isArray(body.seasons)) return null;
    return body.seasons
      .filter((s) => Number(s.season_number) >= 1)
      .map((s) => ({
        number: Number(s.season_number),
        name: clean(s.name) || null,
        episodeCount: Number(s.episode_count) || 0,
        airDate: s.air_date || null,
      }))
      .sort((a, b) => a.number - b.number);
  });
}

// ---------------------------------------------------------------------------
// 3) TheTVDB (solo struttura stagioni, riserva)
// ---------------------------------------------------------------------------

let tvdbToken = null;
let tvdbTokenAt = 0;

async function tvdbLogin() {
  if (tvdbToken && Date.now() - tvdbTokenAt < 60 * 60 * 1000) return tvdbToken;
  if (!config.tvdbApiKey) return null;
  const body = await requestJson('https://api4.thetvdb.com/v4/login', {
    method: 'POST',
    timeoutMs: 12000,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: config.tvdbApiKey }),
  });
  const token = body && body.data && body.data.token;
  if (token) {
    tvdbToken = token;
    tvdbTokenAt = Date.now();
  }
  return token || null;
}

async function fetchTvdbSeasonList(page) {
  try {
    const token = await tvdbLogin();
    if (!token || !page.malId) return null;
    const headers = { Authorization: `Bearer ${token}` };
    const search = await requestJson(
      `https://api4.thetvdb.com/v4/search?query=${encodeURIComponent(searchTitle(page.title))}&type=series&remoteId=mal:${page.malId}`,
      { timeoutMs: 12000, headers },
    );
    const hit = Array.isArray(search) && search[0];
    if (!hit || !hit.tvdb_id) return null;
    const series = await requestJson(
      `https://api4.thetvdb.com/v4/series/${hit.tvdb_id}/seasons/default`,
      { timeoutMs: 12000, headers },
    );
    const seasons = (series && series.data && series.data.seasons) || [];
    return seasons
      .filter((s) => Number(s.number) >= 1)
      .map((s) => ({
        number: Number(s.number),
        name: clean(s.name) || null,
        episodeCount: 0,
        airDate: null,
      }))
      .sort((a, b) => a.number - b.number);
  } catch (err) {
    console.warn(`[ext] tvdb non disponibile: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Interfaccia principale
// ---------------------------------------------------------------------------

/**
 * Dettagli episodi/stagioni per una pagina AnimeWorld.
 * `wantSeasons` limita le stagioni richieste a TMDB (AIOMetadata le da' tutte
 * in una sola chiamata).
 */
async function getEpisodeDetails(page, wantSeasons = []) {
  if (!page || page.notFound) return emptyExternal();
  const aiom = await fetchAiom(page).catch(() => null);
  if (aiom && Object.keys(aiom.seasons).length) return aiom;

  const tmdb = await fetchTmdb(page, wantSeasons).catch(() => null);
  return mergeExternal(tmdb, null);
}

/** Struttura delle stagioni (numero, nome, episodi, data) per una pagina. */
async function getSeasonList(page) {
  if (!page || page.notFound) return null;
  const aiom = await fetchAiom(page).catch(() => null);
  if (aiom && Object.keys(aiom.seasons).length) {
    return Object.values(aiom.seasons)
      .map((s) => ({
        number: s.number,
        name: s.name,
        episodeCount: s.episodeCount,
        airDate: s.airDate,
      }))
      .sort((a, b) => a.number - b.number);
  }
  const tmdb = await fetchTmdbSeasonList(page).catch(() => null);
  if (tmdb && tmdb.length) return tmdb;
  return fetchTvdbSeasonList(page).catch(() => null);
}

const stats = () => ({ cached: cache.size, inflight: inflight.size, failed: failMark.size });

module.exports = {
  getEpisodeDetails,
  getSeasonList,
  normalizeVideos,
  mergeExternal,
  searchTitle,
  stats,
};
