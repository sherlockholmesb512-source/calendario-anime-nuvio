'use strict';

const config = require('../config');
const { getHtml, getJson, getCsrfToken, invalidateCsrf, jsonHeaders } = require('./http');
const { toText, absolute, IT_MONTHS } = require('./parse');

// ---------------------------------------------------------------------------
// Cache delle pagine anime (meta + lista episodi)
// ---------------------------------------------------------------------------

const pageCache = new Map(); // slug -> { at, data }
const streamCache = new Map(); // epId -> { at, data }

function cacheGet(map, key, maxAge) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > maxAge) {
    map.delete(key);
    return null;
  }
  return hit.data;
}

/**
 * Lettura "fredda" dalla cache: non blocca e non scade percio' i cataloghi
 * possono rispondere subito anche a freddo, con i dati leggeri.
 */
function cachePeek(slug) {
  const hit = pageCache.get(slug);
  return hit ? hit.data : null;
}

function cacheStats() {
  return { pages: pageCache.size, streams: streamCache.size };
}

/**
 * Svuota le cache locali (pagine /play e stream gia' risolti). Richiamato
 * periodicamente dallo svuota-cache automatico: cosi' copertine e dati vecchi
 * non si accumulano e l'addon si mantiene sempre aggiornato. Quando serve, i
 * dati vengono ri-scaricati al volo.
 */
function flushCaches() {
  const pages = pageCache.size;
  const streams = streamCache.size;
  pageCache.clear();
  streamCache.clear();
  return { pages, streams };
}

// Deduplica le richieste simultanee sulla stessa pagina.
const inflight = new Map();

/** "07 Aprile 2026" -> "2026-04-07T00:00:00.000Z" */
function parseItalianDate(text) {
  const t = toText(text);
  const m = /(\d{1,2})\s+([a-z\u00e0-\u00ff]+)\s+(\d{4})/i.exec(t.toLowerCase());
  if (!m) return null;
  const month = IT_MONTHS.indexOf(m[2]);
  if (month < 0) return null;
  return new Date(Date.UTC(Number(m[3]), month, Number(m[1]))).toISOString();
}

function parseSeason(text) {
  const t = toText(text); // es. "Primavera 2026"
  const m = /([a-z\u00e0-\u00ff]+)\s+(\d{4})/i.exec(t.toLowerCase());
  return m ? { season: m[1], year: m[2] } : null;
}

/**
 * Pagina /play/<slug> di un anime: contiene tutto (titolo, descrizione, generi,
 * anno, MAL/AniList) e la lista episodi con gli id usati dal player.
 */
async function getAnimePage(slug, { force = false } = {}) {
  if (!force) {
    const cached = cacheGet(pageCache, slug, config.animePageCacheMs);
    if (cached) return cached;
    if (inflight.has(slug)) return inflight.get(slug);
  }

  const task = (async () => {
    const res = await getHtml(`${config.awBase}/play/${slug}`);
    if (res.notFound) {
      const missing = { slug, notFound: true, videos: [] };
      pageCache.set(slug, { at: Date.now(), data: missing });
      return missing;
    }
    const html = res.body;
    const data = parseAnimePage(html, slug);
    pageCache.set(slug, { at: Date.now(), data });
    return data;
  })();

  inflight.set(slug, task);
  try {
    return await task;
  } finally {
    inflight.delete(slug);
  }
}

function parseAnimePage(html, slug) {
  const titleTag = /<h1[^>]*id="anime-title"[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const title = titleTag ? toText(titleTag[1]) : slug;

  const descEl = /<div class="desc">([\s\S]*?)<\/div>/i.exec(html);
  const description = descEl ? toText(descEl[1]) : '';

  // Copertina: il tag principale usa a volte data-src (lazy-load); in assenza si
  // cerca l'og:image; l'ultima spiaggia e' la copertina costruita dall'id.
  const thumbRe =
    /<img[^>]*id="(?:mobile-)?thumbnail-watch"[^>]*(?:src|data-src)="([^"]+)"/i;
  const posterEl = thumbRe.exec(html);
  let poster = posterEl ? absolute(posterEl[1]) : null;
  if (!poster) {
    const ogRe = /<meta[^>]*property=["']?og:image["']?[^>]*content=["']([^"']+)["']/is.exec(html)
      || /<meta[^>]*content=["']([^"']+\.(?:jpe?g|png|webp|avif))["'][^>]*property=["']?og:image["']?/is.exec(html);
    if (ogRe) poster = absolute(ogRe[1]);
  }
  if (!poster) {
    const parts = String(slug || '').split('.');
    const animeId = (parts[parts.length - 1] || '').trim();
    if (/^[A-Za-z0-9_-]{1,32}$/.test(animeId)) {
      poster = `https://img.animeworld.ac/copertine/${animeId}.jpg`;
    }
  }

  // Blocchi <dl class="meta col-sm-6">: Categoria / Audio / Data / Stagione / Studio / Genere
  //                      e                Voto / Durata / Episodi / Stato / Visualizzazioni
  const meta = {};
  const dls = html.match(/<dl class="meta col-sm-6">[\s\S]*?<\/dl>/g) || [];
  for (const dl of dls) {
    const pairs = dl.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g);
    for (const p of pairs) {
      const key = toText(p[1]).replace(/:\s*$/, '').toLowerCase();
      if (!key || meta[key] !== undefined) continue;
      meta[key] = toText(p[2]);
    }
  }

  const season = parseSeason(meta.stagione || '');
  const releaseDate = meta['data di uscita'] ? parseItalianDate(meta['data di uscita']) : null;
  const totalEpisodes = (() => {
    const m = /(\d+)/.exec(meta.episodi || '');
    if (m) return Number(m[1]);
    const max = /<label for="watchlist-edit-episodes"[^>]*max="(\d+)"/i.exec(html);
    return max ? Number(max[1]) : null;
  })();
  const rating = (() => {
    const m = /([\d.,]+)\s*\/\s*10/.exec(meta.voto || '');
    return m ? Number(m[1].replace(',', '.')) : null;
  })();

  const genres = (meta.genere || '')
    .split(',')
    .map((g) => toText(g))
    .filter(Boolean);

  const malId = (/myanimelist\.net\/anime\/(\d+)/.exec(html) || [])[1] || null;
  const anilistId = (/anilist\.co\/anime\/(\d+)/.exec(html) || [])[1] || null;

  // Lista episodi: <li class="episode"><a data-id="<epId>" data-num="N" href="...">
  const videos = [];
  const seen = new Set();
  const epRe =
    /<li class="episode">\s*<a\s+data-episode-id="(\d+)"\s+data-id="([^"]+)"\s+data-episode-num="(\d+)"\s+data-num="(\d+)"[^>]*href="\/play\/([^"]+)"/g;
  let m;
  while ((m = epRe.exec(html)) !== null) {
    const epId = m[2];
    if (seen.has(epId)) continue;
    seen.add(epId);
    videos.push({
      id: epId,
      num: Number(m[4]) || Number(m[3]),
      animeEpisodeId: m[1],
      href: m[5],
    });
  }
  videos.sort((a, b) => a.num - b.num);

  return {
    slug,
    notFound: false,
    title,
    description,
    poster,
    category: meta.categoria || null,
    audio: meta.audio || null,
    state: meta.stato || null,
    duration: meta.durata || null,
    views: meta.visualizzazioni || null,
    season: season ? season.season : null,
    year: season ? season.year : (releaseDate ? releaseDate.slice(0, 4) : null),
    releaseDate,
    totalEpisodes,
    rating,
    genres,
    malId,
    anilistId,
    videos,
    pageUrl: `${config.awBase}/play/${slug}`,
  };
}

// ---------------------------------------------------------------------------
// Stream: /api/episode/info?id=<epId>
// ---------------------------------------------------------------------------

function isDirectVideo(url) {
  return /^https?:\/\//i.test(url || '') && !/^\s*</.test(url || '');
}

/**
 * Risolve l'URL diretto del video per un episodio.
 * Richiede il token CSRF, che NON richiede sessione/cookie.
 */
async function getEpisodeStream(epId, { force = false } = {}) {
  if (!force) {
    const cached = cacheGet(streamCache, epId, config.streamCacheMs);
    if (cached) return cached;
  }

  const url = `${config.awBase}/api/episode/info?id=${encodeURIComponent(epId)}&alt=0`;
  let token = await getCsrfToken();
  let payload;
  try {
    payload = await getJson(url, { headers: jsonHeaders(token), retries: 1 });
  } catch (err) {
    if (err.message.includes('401')) {
      invalidateCsrf();
      token = await getCsrfToken();
      payload = await getJson(url, { headers: jsonHeaders(token), retries: 2 });
    } else {
      throw err;
    }
  }

  const direct = isDirectVideo(payload && payload.grabber) ? payload.grabber : null;
  const data = {
    epId,
    url: direct,
    embed: payload && typeof payload.target === 'string' && payload.target.startsWith('/')
      ? `${config.awBase}${payload.target}`
      : null,
  };
  streamCache.set(epId, { at: Date.now(), data });
  return data;
}

module.exports = {
  getAnimePage,
  getEpisodeStream,
  cachePeek,
  cacheStats,
  flushCaches,
  parseAnimePage,
  parseItalianDate,
};
