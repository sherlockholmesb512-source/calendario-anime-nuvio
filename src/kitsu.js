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
const castCache = new Map(); // anilistId -> { at, cast }
const inflight = new Map(); // id richiesto -> Promise
const failMark = new Map(); // slug -> timestamp ultimo insuccesso (anti-stallo)

const trim = (map, cap) => {
  while (map.size > cap) {
    const first = map.keys().next().value;
    map.delete(first);
  }
};

const fresh = (entry, now = Date.now()) => Boolean(entry) && now - entry.at < (entry.ttl || TTL);

// Un fallimento di rete/addon viene dimenticato dopo 5 minuti, cosi' una
// richiesta utente non s'inceppa ripetutamente su un addon irraggiungibile.
const NEG_TTL = 5 * 60 * 1000;
const CAST_CAP = 1500;

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

async function requestJson(url, init = {}, tries = 2, timeoutMs = TIMEOUT) {
  for (let i = 0; i < tries; i += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (!res.ok) continue; // retry
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    } catch {
      // timeout o rete: retry
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

const fetchJson = (url) => requestJson(url);

/** Riduce il meta Kitsu ai campi che ci servono (via video, li teniamo noi). */
async function summarizeMeta(m) {
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

  // Miniatura del singolo episodio, in ordine di episodio. Fonte primaria: i
  // video dell'addon Kitsu (media.kitsu.app o metahub, gia' pronti all'uso).
  // Se l'addon non ne fornisce (es. cache edge diversa per regione) si passa
  // all'API pubblica kitso.io, che espone le thumbnails ufficiali con il numero
  // relativo (per le serie multistagione i numeri ricominciano dalla stagione 2:
  // l'episodio vincente resta il numero "relativo" della ripartenza).
  const episodeThumbs = {};
  let thumbIndex = 0;
  for (const v of vids) {
    if (!v || typeof v.thumbnail !== 'string' || !/^https?:\/\//i.test(v.thumbnail)) continue;
    thumbIndex += 1;
    episodeThumbs[thumbIndex] = v.thumbnail;
    if (thumbIndex >= 1000) break;
  }
  let hasThumbs = Object.keys(episodeThumbs).length > 0;
  const imdbId = m.imdb_id || null;
  // 2) API pubblica kitso.io: miniature ufficiali per numero relativo.
  if (!hasThumbs && m.id) {
    const direct = await fetchKitsuThumbs(m.id);
    if (direct) {
      for (const [n, url] of Object.entries(direct)) {
        if (Number(n) >= 1 && Number(n) <= 1000) episodeThumbs[Number(n)] = url;
      }
      hasThumbs = Object.keys(episodeThumbs).length > 0;
    }
  }
  // 3) metahub (stills IMDb) costruito dall'imdb_id: solo per serie a stagione
  //    unica e solo se ep1 ed epN risultano davvero esistenti (niente immagini
  //    rotte per titoli che metahub non copre).
  if (!hasThumbs && imdbId && m.type !== 'movie' && totalEpisodes) {
    const mh = await fetchMetahubThumbs(imdbId, totalEpisodes);
    if (mh) {
      for (const [n, url] of Object.entries(mh)) episodeThumbs[Number(n)] = url;
      hasThumbs = true;
    }
  }

  return {
    kitsuId: m.id || null,
    imdbId,
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

// ---------------------------------------------------------------------------
// Thumbnail episodi dall'API pubblica kitso.io (fallback quando l'addon non le
// fornisce). Nessuna chiave richiesta; paginazione su links.next fino a 12 pag.
// ---------------------------------------------------------------------------

async function fetchKitsuThumbs(kitsuId) {
  if (!config.kitsuApiBase) return null;
  const raw = String(kitsuId || '').replace(/^kitsu:/i, '');
  if (!/^\d+$/.test(raw)) return null;
  let url = `${config.kitsuApiBase}/anime/${raw}/episodes?page%5Blimit%5D=20`;
  const thumbs = {};
  let pages = 0;
  while (url && pages < 15) {
    const body = await requestJson(url, {}, 1, 12000);
    if (!body || !Array.isArray(body.data)) break;
    const seen = new Set();
    for (const e of body.data) {
      const a = (e && e.attributes) || {};
      const tn = (a.thumbnail && (a.thumbnail.original || a.thumbnail)) || null;
      const n = Number(a.relativeNumber != null ? a.relativeNumber : a.number);
      if (typeof tn === 'string' && tn && Number.isFinite(n) && n >= 1 && n <= 1000 && !seen.has(n)) {
        seen.add(n);
        thumbs[n] = tn;
      }
    }
    url = (body.links && body.links.next) || null;
    pages += 1;
  }
  return Object.keys(thumbs).length ? thumbs : null;
}

// ---------------------------------------------------------------------------
// Thumbnail episodi da metahub (stills IMDb) come ultima spiaggia: l'immagine
// viene servita al client, quindi non dipende dalla raggiungibilita' di servizi
// esterni da parte di Render. Prima di fidarsi verifichiamo ep1 ed epN.
// ---------------------------------------------------------------------------

const METAHUB = 'https://episodes.metahub.space';

async function fetchMetahubThumbs(imdbId, count) {
  const num = Number(count);
  if (!imdbId || !Number.isFinite(num) || num < 1 || num > 300) return null;
  const exists = async (n) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(`${METAHUB}/${imdbId}/1/${n}/w780.jpg`, {
        method: 'HEAD',
        signal: ctrl.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  if (!(await exists(1)) || !(await exists(num))) return null;
  const thumbs = {};
  for (let n = 1; n <= num; n += 1) {
    thumbs[n] = `${METAHUB}/${imdbId}/1/${n}/w780.jpg`;
  }
  return thumbs;
}

function getMetaById(id) {
  const cached = metaCache.get(id);
  if (fresh(cached)) return Promise.resolve(cached.summary);
  if (inflight.has(id)) return inflight.get(id);

  const task = (async () => {
    const body = await fetchJson(`${BASE}/meta/anime/${id}.json`);
    const m = body && body.meta;
    if (!m) return null;
    const summary = await summarizeMeta(m);
    const now = Date.now();
    // Se la risposta e' arrivata senza miniature episodio (succede quando la
    // cache edge dell'addon serve una copia vecchia), la riconsideriamo presto
    // invece di tenerla 24 h: cosi' le thumbnail si auto-riparano.
    const hasVids = Array.isArray(m.videos) && m.videos.length > 0;
    const slim = hasVids && !summary.episodeThumbs;
    const ttl = slim ? NEG_TTL : TTL;
    metaCache.set(id, { at: now, summary, ttl });
    if (m.id && m.id !== id) metaCache.set(m.id, { at: now, summary, ttl });
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

// ---------------------------------------------------------------------------
// Cast (attori/doppiatori) da AniList GraphQL — dati pubblici, nessuna chiave.
// ---------------------------------------------------------------------------

const ANILIST_API = 'https://graphql.anilist.co';
const CAST_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    characters(perPage: 12, sort: [ROLE, ID]) {
      edges {
        role
        node { name { full } }
        vaIt: voiceActors(sort: [RELEVANCE], language: ITALIAN) { name { full } }
        vaJp: voiceActors(sort: [RELEVANCE], language: JAPANESE) { name { full } }
      }
    }
  }
}`;

function buildCastList(body) {
  const media = body && body.data && body.data.Media;
  const edges = media && Array.isArray(media.characters && media.characters.edges)
    ? media.characters.edges
    : [];
  if (!edges.length) return [];
  const names = [];
  const seen = new Set();
  const push = (n) => {
    const t = String(n || '').trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      names.push(t);
    }
  };
  // 1) doppiatori italiani; 2) se non ce ne sono, i seiyuu giapponesi;
  // 3) in ultima spiaggia i nomi dei personaggi principali.
  const jp = [];
  for (const e of edges) {
    for (const v of e.vaIt || []) push(v && v.name && v.name.full);
    for (const v of e.vaJp || []) {
      const f = v && v.name && v.name.full;
      if (f) jp.push(f);
    }
  }
  if (!names.length) jp.forEach(push);
  if (!names.length) {
    for (const e of edges) push(e.node && e.node.name && e.node.name.full);
  }
  return names.slice(0, 20);
}

/** Recupera (e mette in cache per AniList id) il cast: mai errori verso l'esterno. */
async function fetchCast(anilistId) {
  if (!config.castEnabled || !anilistId) return null;
  const cached = castCache.get(anilistId);
  if (fresh(cached)) return cached.cast;

  const body = await requestJson(ANILIST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: CAST_QUERY, variables: { id: Number(anilistId) } }),
  });
  const cast = buildCastList(body);
  castCache.set(anilistId, { at: Date.now(), cast: cast.length ? cast : null });
  trim(castCache, CAST_CAP);
  return cast.length ? cast : null;
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
 * Recupera (e mette in cache) le informazioni Kitsu + cast per uno slug.
 * Non lancia mai: problemi di rete/addon -> null, i dati AnimeWorld restano.
 * Il cast (AniList) e' indipendente da Kitsu: arriva anche se l'addon cade.
 */
async function enrichFor(slug, page) {
  if (!config.kitsuEnabled && !config.castEnabled) return null;
  if (!slug || !page || page.notFound) return null;
  const cached = slugInfo.get(slug);
  if (fresh(cached)) {
    // Una voce "parziale" (cast arrivato, meta Kitsu no) viene ritentata dopo
    // NEG_TTL: non deve congelare la scheda senza Kitsu per 24 h.
    if (!cached.partial || Date.now() < (cached.retryAt || 0)) return cached.info;
  }
  const failedAt = failMark.get(slug);
  if (failedAt && Date.now() - failedAt < NEG_TTL) return null;

  let meta = null;
  // Strada principale: id che AnimeWorld gia' espone (AniList prima, e' rapido).
  if (config.kitsuEnabled && page.anilistId) meta = await getMetaById(`anilist:${page.anilistId}`);
  if (!meta && config.kitsuEnabled && page.malId) meta = await getMetaById(`mal:${page.malId}`);
  // Fallback: ricerca per titolo con controlli anti-omonimi.
  if (!meta && config.kitsuEnabled && page.title) {
    const hits = await searchByTitle(page.title);
    const best = pickBestMatch(hits, {
      title: page.title,
      type: guessType(page),
      year: page.year,
    });
    if (best) meta = await getMetaById(best.id);
  }
  // Cast dagli id AniList (quando la pagina li espone).
  let cast = null;
  if (config.castEnabled && page.anilistId) {
    try {
      cast = await fetchCast(page.anilistId);
    } catch {
      cast = null;
    }
  }

  if (!meta && !cast) {
    failMark.set(slug, Date.now());
    return null;
  }
  failMark.delete(slug);

  const info = meta
    ? { ...meta, sourceTitle: page.title || null, cast }
    : { sourceTitle: page.title || null, cast };
  const partial = !meta;
  slugInfo.set(slug, {
    at: Date.now(),
    info,
    partial,
    retryAt: partial ? Date.now() + NEG_TTL : 0,
  });
  trim(slugInfo, SLUG_CAP);
  return info;
}

/** Lettura non bloccante: informazioni Kitsu gia' in cache per lo slug. */
function peek(slug) {
  const cached = slugInfo.get(slug);
  return fresh(cached) ? cached.info : null;
}

/**
 * Dice se la voce in cache e' "parziale" (cast senza meta Kitsu) e oltre il
 * tempo di retry: in quel caso la scheda va ri-arricchita a richiesta.
 */
function needsRetry(slug) {
  const cached = slugInfo.get(slug);
  return Boolean(cached && cached.partial && Date.now() >= (cached.retryAt || 0));
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
    cast: info.cast && info.cast.length ? info.cast : null,
    kitsuId: info.kitsuId || null,
  };
}

const stats = () => ({
  enabled: config.kitsuEnabled,
  castEnabled: config.castEnabled,
  slugCached: slugInfo.size,
  metaCached: metaCache.size,
  searchCached: searchCache.size,
  castCached: castCache.size,
});

/** Svuota tutte le cache Kitsu/cast (richiamato periodicamente per liberare spazio). */
function flush() {
  const n = slugInfo.size + metaCache.size + searchCache.size + castCache.size;
  slugInfo.clear();
  metaCache.clear();
  searchCache.clear();
  castCache.clear();
  inflight.clear();
  failMark.clear();
  return n;
}

module.exports = { enrichFor, peek, needsRetry, mergeWithPage, normalizeTitle, pickBestMatch, stats, flush, fetchCast, fetchKitsuThumbs, fetchMetahubThumbs };