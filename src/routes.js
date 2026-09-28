'use strict';

const config = require('./config');
const store = require('./store');
const enrich = require('./enrich');
const { buildManifest, CAT } = require('./manifest');
const ids = require('./ids');
const { getAnimePage, getEpisodeStream, cachePeek } = require('./aw/play');
const { getSearchItems } = require('./aw/filter');
const kitsu = require('./kitsu');
const sweep = require('./sweep');

const { state, lookupEpisode } = store;

// Cache della risposta /meta (in memoria, TTL breve): reduce le richieste
// ripetute di Nuvio/desktop verso buildMeta (pagina + peek + eventuale TMDB).
// Bastano 10-15 min: i dati si aggiornano comunque al massimo con quel ritardo.
const META_CACHE_TTL_MS = Number(process.env.META_CACHE_MS || 10 * 60 * 1000);
const META_CACHE_CAP = 2500;
const metaCache = new Map(); // id|tipo -> { at, body }

function metaCacheGet(key) {
  const hit = metaCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > META_CACHE_TTL_MS) {
    metaCache.delete(key);
    return null;
  }
  return hit.body;
}

function metaCacheSet(key, body) {
  metaCache.set(key, { at: Date.now(), body });
  if (metaCache.size > META_CACHE_CAP) {
    const first = metaCache.keys().next().value;
    if (first !== undefined) metaCache.delete(first);
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const json = (res, body, status = 200) =>
  res.status(status).type('application/json; charset=utf-8').send(JSON.stringify(body));

const noCache = (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Access-Control-Allow-Origin', '*');
  next();
};

/** I client chiamano /catalog/<type>/<id>.json: togliamo l'estensione. */
const stripJson = (req, res, next) => {
  if (req.params.id) req.params.id = req.params.id.replace(/\.json$/i, '');
  next();
};

/** Sigla del fuso italiano corrente, es. "CEST". */
function italyZoneAbbr(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('it-IT', {
      timeZone: config.scheduleTz,
      timeZoneName: 'short',
    }).formatToParts(now);
    return (parts.find((p) => p.type === 'timeZoneName') || {}).value || 'ora italiana';
  } catch {
    return 'ora italiana';
  }
}

const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();
const cap = (text) => clean(text).slice(0, 4000);

/** "461703270" -> "~440 MB"; "1069829022" -> "~1.0 GB". */
function humanSize(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return null;
  return b >= 1024 * 1024 * 1024
    ? `~${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`
    : `~${Math.round(b / (1024 * 1024))} MB`;
}

/**
 * Poster "copertine" di AnimeWorld costruito dall'id dell'opera contenuto nello
 * slug (es. `liar-game.MVKsv` -> `https://img.animeworld.ac/copertine/MVKsv.jpg`).
 * Usato come ultima spiaggia: cosi' card e miniature non restano MAI vuote.
 */
const copertine = (slug) => {
  const parts = String(slug || '').split('.');
  const id = (parts[parts.length - 1] || '').trim();
  return /^[A-Za-z0-9_-]{1,32}$/.test(id) ? `https://img.animeworld.ac/copertine/${id}.jpg` : null;
};

// Budget breve per l'arricchimento Kitsu on-demand nella richiesta /meta:
// se non conclude entro questo tempo la scheda risponde con i soli dati
// AnimeWorld (trama inclusa) e l'enrich pesante prosegue in background.
const META_ENRICH_TIMEOUT_MS = config.metaEnrichTimeoutMs > 0 ? config.metaEnrichTimeoutMs : 5000;
const META_ENRICH_WAIT = Symbol('meta-enrich-wait');

function paginate(items, skip, limit) {
  const from = Math.max(0, Number(skip) || 0);
  const size = Math.min(Math.max(Number(limit) || config.pageSize, 1), 1200);
  return items.slice(from, from + size);
}

// ---------------------------------------------------------------------------
// Dati anime: cache "calda" (bloccante) o leggeri dalla pagina in cache
// ---------------------------------------------------------------------------

/**
 * Dati di un anime senza bloccare la richiesta: se la pagina /play e' in cache
 * la usiamo, altrimenti restituimo i dati minimi e accodiamo l'arricchimento.
 * Se l'arricchimento Kitsu e' gia' disponibile viene fuso (descrizione/voto da
 * Kitsu, generi/anno/totale da AnimeWorld).
 */
function lightMeta(slug, fallbackName, fallbackPoster) {
  const page = cachePeek(slug);
  if (page && !page.notFound) {
    const merged = kitsu.mergeWithPage(page, kitsu.peek(slug));
    return {
      name: page.title || fallbackName,
      // Il poster scrapato (fallbackPoster/item.poster) e' un URL reale preso
      // dalla pagina AnimeWorld: ha la priorita' sulla copertina "costruita"
      // dall'id dello slug (che puo' non esistere su img.animeworld.ac).
      poster: (merged && merged.poster) || page.poster || fallbackPoster || copertine(slug),
      description: (merged && merged.description) || page.description,
      genres: (merged && merged.genres) || page.genres,
      year: (merged && merged.year) || page.year,
      rating: (merged && merged.rating) || page.rating,
      totalEpisodes: (merged && merged.totalEpisodes) || page.totalEpisodes,
      enriched: true,
      kitsu: Boolean(merged && merged.kitsuId),
    };
  }
  return {
    name: fallbackName || slug,
    poster: fallbackPoster,
    description: null,
    genres: [],
    year: null,
    rating: null,
    totalEpisodes: null,
    enriched: false,
    kitsu: false,
  };
}

const epLabel = (ep, total) => (total ? `Episodio ${ep}/${total}` : `Episodio ${ep}`);
const epShort = (ep, total) => (total ? `${ep}/${total}` : `${ep}`);

// ---------------------------------------------------------------------------
// Anteprime dei 4 cataloghi
// ---------------------------------------------------------------------------

/** 1. Ultimi Episodi: un elemento per episodio uscito. */
function latestPreview(item) {
  const meta = lightMeta(item.slug, item.name, item.poster);
  const audio = item.badge === 'DUB' ? 'DUB ITA' : 'SUB ITA';
  return {
    id: ids.episodeMetaId(item.epNumber || 0, item.slug),
    type: 'series',
    name: meta.name,
    poster: meta.poster || item.poster,
    description: cap([`${audio} — ultimo episodio uscito.`, item.epNumber ? epLabel(item.epNumber, meta.totalEpisodes) : null, meta.description].filter(Boolean).join('\n\n')),
    releaseInfo: item.epNumber ? `Ep ${item.epNumber}` : 'Nuovo',
    genres: meta.genres.length ? meta.genres.slice(0, 6) : undefined,
    imdbRating: meta.rating || undefined,
    behaviorHints: { defaultVideoId: ids.videoId(item.epNumber || 0, item.slug) },
  };
}

/** 2. Calendario Anime: solo gli episodi in uscita oggi, con numero, totale e orario. */
function schedulePreview(item, zone) {
  const meta = lightMeta(item.slug, item.title, item.poster);
  const when = item.time ? `alle ${item.time} (${zone})` : 'orario non ancora definito';
  // Nel card deve comparire subito l'episodio con il totale e l'orario, es.:
  //   "Liar Game"  —  Ep 26/26 · Oggi 18:30
  // Il totale arriva dal arricchimento della pagina /play (in cache); se non e'
  // ancora noto usciamo con il solo numero episodio.
  const epPart = item.epNumber ? `Ep ${epShort(item.epNumber, meta.totalEpisodes)}` : 'Ep ?';
  const whenPart = item.time ? `Oggi ${item.time}` : 'Oggi';
  return {
    id: ids.episodeMetaId(item.epNumber || 0, item.slug),
    type: 'series',
    name: meta.name,
    poster: meta.poster || item.poster,
    description: cap([`Uscita di oggi ${when}.`, item.epNumber ? epLabel(item.epNumber, meta.totalEpisodes) + '.' : null, meta.description].filter(Boolean).join('\n\n')),
    releaseInfo: `${epPart} · ${whenPart}`,
    genres: meta.genres.length ? meta.genres.slice(0, 6) : undefined,
    imdbRating: meta.rating || undefined,
    behaviorHints: { defaultVideoId: ids.videoId(item.epNumber || 0, item.slug) },
  };
}

/** 3 e 4. Movie / Doppiati: un elemento per opera. */
function animePreview(item, type) {
  const meta = lightMeta(item.slug, item.name, item.poster);
  const isMovie = type === 'movie';
  const tag = isMovie
    ? item.badge === 'DUB'
      ? 'Movie • DOPPIATO ITA'
      : 'Movie • ITA'
    : item.badge === 'DUB'
      ? 'Doppiato in italiano'
      : 'In italiano';
  return {
    id: ids.animeId(item.slug),
    type,
    name: meta.name,
    poster: meta.poster || item.poster,
    description: cap([tag, meta.description].filter(Boolean).join('\n\n')),
    releaseInfo: meta.year || (isMovie ? 'Movie' : 'ITA'),
    genres: meta.genres.length ? meta.genres.slice(0, 6) : undefined,
    imdbRating: meta.rating || undefined,
  };
}

// ---------------------------------------------------------------------------
// /catalog/:type/:id
// ---------------------------------------------------------------------------

// Ogni catalogo e' dichiarato nel manifest come tipo "anime" (e' il tipo che
// Nuvio usa per la sezione Anime), ma accetta anche il percorso storico
// "series"/"movie": i client gia' configurati continuano a funzionare.
const CATALOGS = {
  [CAT.latest]: { bucket: 'latest', type: 'anime', aliases: ['series'], build: latestPreview },
  [CAT.schedule]: {
    bucket: 'schedule',
    type: 'anime',
    aliases: ['series'],
    build: (item) => schedulePreview(item, italyZoneAbbr()),
  },
  [CAT.movies]: {
    bucket: 'movies',
    type: 'anime',
    aliases: ['movie'],
    build: (i) => animePreview(i, 'movie'),
  },
  [CAT.dubbed]: {
    bucket: 'dubbed',
    type: 'anime',
    aliases: ['series'],
    build: (i) => animePreview(i, 'series'),
  },
};

function handleCatalog(req, res) {
  const { type, id } = req.params;
  const def = CATALOGS[id];
  if (!def) return json(res, { error: `Catalogo sconosciuto: ${id}` }, 404);
  if (type !== def.type && !def.aliases.includes(type)) {
    return json(res, { error: `Il catalogo "${id}" e' di tipo ${def.type}, non ${type}` }, 404);
  }

  // Alcuni client passano la ricerca nel path (/catalog/x/search=q.json),
  // altri come query (?search=q): gestiamo entrambi.
  if (req.query.search != null) {
    req.params.search = `search=${req.query.search}`;
    return handleCatalogSearch(req, res);
  }

  const bucket = state[def.bucket];
  const page = paginate(bucket.items, req.query.skip, req.query.limit);
  const metas = page.map((item) => def.build(item)).filter(Boolean);

  res.set('X-Catalog-Items-Total', String(bucket.items.length));
  if (bucket.at) res.set('X-Catalog-Refreshed-At', new Date(bucket.at).toISOString());
  return json(res, { metas });
}

/**
 * Ricerca nel catalogo: /catalog/<type>/<id>/search=<query>. Risponde con la
 * ricerca di AnimeWorld filtrata dal ruolo del catalogo (movie/doppiati) o,
 * per gli episodic, con gli elementi del bucket quando lo slug e' gia' in
 * lista, altrimenti con l'anteprima del titolo (apribile via scheda).
 */
async function handleCatalogSearch(req, res) {
  const { type, id, search } = req.params;
  const def = CATALOGS[id];
  if (!def) return json(res, { error: `Catalogo sconosciuto: ${id}` }, 404);
  if (type !== def.type && !def.aliases.includes(type)) {
    return json(res, { error: `Il catalogo "${id}" e' di tipo ${def.type}, non ${type}` }, 404);
  }

  let query = String(search || '')
    .replace(/\.json$/i, '')
    .replace(/^search=/i, '')
    .trim();
  try {
    query = decodeURIComponent(query);
  } catch {
    // resta il valore grezzo se la decodifica fallisse
  }
  query = query.replace(/\+/g, ' ').trim();
  if (!query) return json(res, { metas: [] });

  let items;
  try {
    items = await getSearchItems(query, 30);
  } catch (err) {
    console.warn(`[catalog] ricerca "${query}" in "${id}" fallita: ${err.message}`);
    return json(res, { metas: [] });
  }
  if (!items.length) return json(res, { metas: [] });

  const seen = new Set();
  const metas = [];
  for (const item of items) {
    if (metas.length >= 30) break;
    if (seen.has(item.slug)) continue;
    seen.add(item.slug);

    // Nei cataloghi episodic, se lo slug e' gia' nel bucket usiamo l'anteprima
    // del bucket (con numero episodio): altrimenti il titolo generico.
    const inBucket = state[def.bucket].items.find((x) => x.slug === item.slug);
    if (inBucket) {
      const m = def.build(inBucket);
      if (m) metas.push(m);
      continue;
    }
    if (def.bucket === 'movies') {
      if (item.badge === 'MOVIE' || item.badge === 'DUB') {
        const m = animePreview(item, 'movie');
        if (m) metas.push(m);
      }
      continue;
    }
    if (def.bucket === 'dubbed') {
      if (item.badge === 'DUB') {
        const m = animePreview(item, 'series');
        if (m) metas.push(m);
      }
      continue;
    }
    const m = animePreview(item, 'series');
    if (m) metas.push(m);
  }

  return json(res, { metas });
}

// ---------------------------------------------------------------------------
// /meta/:type/:id   (bloccante: una richiesta per clic utente, cache 6h)
// ---------------------------------------------------------------------------

async function buildMeta(slug, type, num, baseId) {
  // Bloccante di proposito: una richiesta per clic utente, con cache 6 ore.
  // Corsia prioritaria: se la pagina non e' ancora in cache non deve aspettare
  // dietro ai fetch di sfondo della coda enrich.
  const page = await getAnimePage(slug, { priority: true });

  if (!page || page.notFound) {
    return {
      meta: {
        id: baseId,
        type,
        name: slug,
        description: 'Contenuto non disponibile su AnimeWorld.',
      },
    };
  }

  // Kitsu: se gia' arricchito in background lo usiamo; altrimenti (deep link,
  // slug mai passato dalla coda) lo chiediamo qui ma SOLO entro un budget breve:
  // la trama AnimeWorld deve tornare subito (prima era cosi'), l'arricchimento
  // pesante (addon + kitso.io + metahub) continua in background con la coda.
  let kinfo = kitsu.peek(slug);
  if ((!kinfo || kitsu.needsRetry(slug)) && config.kitsuEnabled) {
    try {
      kinfo = await Promise.race([
        kitsu.enrichFor(slug, page),
        new Promise((resolve) => setTimeout(() => resolve(META_ENRICH_WAIT), META_ENRICH_TIMEOUT_MS)),
      ]);
      if (kinfo === META_ENRICH_WAIT) {
        kinfo = null; // non blocchiamo la scheda: i dati AnimeWorld bastano
      }
    } catch (err) {
      console.warn(`[meta] kitsu non disponibile per ${slug}: ${err.message}`);
    }
  }
  const merged = kitsu.mergeWithPage(page, kinfo) || {};

  // Rete di sicurezza TMDB: se l'enrich in background non ha ancora prodotto
  // thumbnail/trame episodio (es. addon lento su Render che fa perdere la corsa
  // on-demand), interroghiamo TMDB per titolo+anno — due richieste veloci, in
  // cache condivisa, di modo che gli episodi non restino mai con la sola
  // copertina. La copertina resta comunque l'ultimo fallback.
  const season = ids.seasonOf(slug);
  if (config.tmdbApiKey && !merged.episodeThumbs && page.title) {
    try {
      const tm = await Promise.race([
        kitsu.fetchTmdbSeason(null, page.title, page.year, season),
        new Promise((resolve) => setTimeout(() => resolve(META_ENRICH_WAIT), 3000)),
      ]);
      if (tm && tm !== META_ENRICH_WAIT) {
        if (tm.thumbs) merged.episodeThumbs = tm.thumbs;
        if (tm.overviews) {
          merged.episodeOverviews = { ...(merged.episodeOverviews || {}), ...tm.overviews };
        }
      }
    } catch {
      // la scheda resta comunque completa: gli episodi useranno la copertina
    }
  }

  const videos = (page.videos || []).map((v) => ({
    id: ids.videoId(v.num, slug),
    title:
      (merged.totalEpisodes || page.totalEpisodes)
        ? `Episodio ${v.num}/${merged.totalEpisodes || page.totalEpisodes}`
        : `Episodio ${v.num}`,
    // Stagione riconosciuta dallo slug (sequel "<titolo>-<N>-ita").
    season,
    episode: v.num,
    // Miniatura del singolo episodio quando disponibile (Kitsu/TMDB/metahub);
    // altrimenti la copertina dell'anime (sempre presente, mai vuota).
    thumbnail:
      (merged.episodeThumbs && merged.episodeThumbs[v.num]) ||
      merged.poster ||
      page.poster ||
      copertine(slug),
    // Trama del singolo episodio in italiano (TMDB) quando disponibile.
    overview:
      (merged.episodeOverviews && merged.episodeOverviews[v.num]) || undefined,
  }));

  const notes = [
    page.category ? `Categoria: ${page.category}` : null,
    page.audio ? `Audio: ${page.audio}` : null,
    (merged.totalEpisodes || page.totalEpisodes) ? `Episodi totali: ${merged.totalEpisodes || page.totalEpisodes}` : null,
    (merged.runtime || page.duration) ? `Durata: ${merged.runtime || page.duration}` : null,
    (merged.status || page.state) ? `Stato: ${merged.status || page.state}` : null,
    (merged.rating || page.rating) ? `Voto: ${merged.rating || page.rating}${kinfo ? ' (IMDb)' : '/10'}` : null,
    page.malId ? `MyAnimeList: mal/${page.malId}` : null,
    page.anilistId ? `AniList: anime/${page.anilistId}` : null,
  ].filter(Boolean);

  const meta = {
    id: baseId,
    type,
    name: page.title,
    poster: merged.poster || page.poster || copertine(slug),
    description: cap([merged.description || page.description, notes.join(' · ')].filter(Boolean).join('\n\n')),
    releaseInfo: merged.year || page.year || '',
    genres: merged.genres || page.genres || [],
    imdbRating: merged.rating || page.rating || undefined,
    background: merged.background || undefined,
    logo: merged.logo || undefined,
    cast: merged.cast && merged.cast.length ? merged.cast : undefined,
    posterShape: 'poster',
    links: [{ name: 'Apri su AnimeWorld', category: 'Anime', url: page.pageUrl }],
  };

  if (type === 'movie') {
    const only = videos[0];
    if (only) {
      meta.behaviorHints = { defaultVideoId: only.id, bingeGroup: `calendario-anime|${slug}` };
    }
  } else {
    meta.videos = videos;
    const chosen = (num && videos.find((v) => v.episode === num)) || videos[videos.length - 1];
    if (chosen) {
      meta.behaviorHints = { defaultVideoId: chosen.id, bingeGroup: `calendario-anime|${slug}` };
    }
  }

  return { meta };
}

async function handleMeta(req, res) {
  const { type, id } = req.params;
  // Gli elementi sono esposti come "series"/"movie"; "anime" e' accettato come
  // sinonimo di "series" per i client che usano il tipo del catalogo.
  const contentType = type === 'anime' ? 'series' : type;
  if (contentType !== 'movie' && contentType !== 'series') {
    return json(res, { error: 'Tipo non valido' }, 400);
  }

  const cacheKey = `${contentType}|${id}`;
  const hit = metaCacheGet(cacheKey);
  if (hit) return json(res, hit);

  try {
    const anime = ids.parseAnime(id);
    if (anime) {
      const body = await buildMeta(anime.slug, contentType, null, ids.animeId(anime.slug));
      metaCacheSet(cacheKey, body);
      return json(res, body);
    }

    const ep = ids.parseEpisodeMeta(id);
    if (ep) {
      const body = await buildMeta(ep.slug, 'series', ep.num, ids.episodeMetaId(ep.num, ep.slug));
      metaCacheSet(cacheKey, body);
      return json(res, body);
    }
  } catch (err) {
    console.warn(`[meta] errore su "${id}": ${err.message}`);
    return json(res, { error: 'Meta non disponibile al momento' }, 503);
  }

  return json(res, { error: `ID non riconosciuto: ${id}` }, 404);
}

// ---------------------------------------------------------------------------
// /stream/:type/:id
// ---------------------------------------------------------------------------

/** Dall'id video sintetico risolve l'id episodio reale del player AnimeWorld. */
async function resolveEpisodeId(videoKey) {
  const v = ids.parseVideo(videoKey);
  if (v) {
    // Se l'episodio e' gia' in uno dei due cataloghi episodic, non serve nulla.
    const hit = lookupEpisode(ids.videoId(v.num, v.slug));
    if (hit && hit.epId) return { epId: hit.epId, slug: v.slug };
    const page = await getAnimePage(v.slug, { priority: true });
    if (!page || page.notFound) return null;
    const list = page.videos || [];
    const found = list.find((e) => e.num === v.num) || list[list.length - 1];
    return found ? { epId: found.id, slug: v.slug } : null;
  }

  const a = ids.parseAnime(videoKey);
  if (a) {
    const page = await getAnimePage(a.slug, { priority: true });
    const list = (page && page.videos) || [];
    return list.length ? { epId: list[list.length - 1].id, slug: a.slug } : null;
  }

  const m = ids.parseEpisodeMeta(videoKey);
  if (m) {
    const hit = lookupEpisode(ids.videoId(m.num, m.slug));
    if (hit && hit.epId) return { epId: hit.epId, slug: m.slug };
    const page = await getAnimePage(m.slug, { priority: true });
    const list = (page && page.videos) || [];
    const found = list.find((e) => e.num === m.num) || list[list.length - 1];
    return found ? { epId: found.id, slug: m.slug } : null;
  }

  return null;
}

async function handleStream(req, res) {
  const { id } = req.params;
  const videoKey = decodeURIComponent(id).replace(/\.json$/i, '');

  let resolved;
  try {
    resolved = await resolveEpisodeId(videoKey);
  } catch (err) {
    console.warn(`[stream] impossibile risolvere "${videoKey}": ${err.message}`);
    return json(res, { streams: [] });
  }
  if (!resolved) return json(res, { streams: [] });

  let stream;
  try {
    stream = await getEpisodeStream(resolved.epId, { priority: true });
  } catch (err) {
    console.warn(`[stream] errore sorgente per ${resolved.epId}: ${err.message}`);
    return json(res, { streams: [] });
  }

  const group = resolved.slug ? `calendario-anime|${resolved.slug}` : `calendario-anime|${resolved.epId}`;
  const streams = [];

  // Come richiesto: l'unica sorgente e' lo streaming diretto di AnimeWorld.
  // AnimeWorld non espone risoluzioni (singolo MP4 diretto): mostriamo la
  // dimensione reale del file quando il probe HEAD e' riuscito.
  if (stream.url) {
    const size = humanSize(stream.size);
    streams.push({
      name: 'AnimeWorld',
      title: size ? `AnimeWorld • Streaming diretto (${size})` : 'AnimeWorld • Streaming diretto',
      url: stream.url,
      behaviorHints: { bingeGroup: group, notWebReady: false },
    });
  }

  return json(res, { streams });
}

// ---------------------------------------------------------------------------
// Landing page e stato
// ---------------------------------------------------------------------------

function baseUrlOf(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `${proto}://${host}` : '';
}

const stamp = (at) => (at ? new Date(at).toISOString() : null);
const ageMin = (at) => (at ? Math.max(0, Math.round((Date.now() - at) / 60000)) : null);

function landing(req, res) {
  const base = baseUrlOf(req);
  const manifest = buildManifest(base);
  const host = req.headers.host || 'TUO-DOMINIO.up.railway.app';

  const rows = manifest.catalogs
    .map((c) => `<tr><td>${c.name}</td><td><code>${c.type}</code></td><td><code>${c.id}</code></td></tr>`)
    .join('');

  const line = (ok, label, extra) =>
    `<p class="${ok ? 'ok' : 'warn'}">${label}: ${extra}</p>`;

  res.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${manifest.name} — addon Nuvio</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:840px;margin:0 auto;padding:32px 20px;line-height:1.6}
h1{margin:0 0 4px} h2{margin-top:32px} .sub{color:#6b7280;margin-top:0}
code,pre{background:#f3f4f6;color:#111827;border-radius:6px;padding:2px 6px;font-size:13px}
pre{padding:14px;overflow:auto}
table{border-collapse:collapse;width:100%;margin:16px 0}
td,th{border:1px solid #e5e7eb;padding:8px 10px;text-align:left;font-size:14px}
th{background:#f9fafb}
.ok{color:#15803d;font-weight:600}.warn{color:#b45309;font-weight:600}
</style></head><body>
<h1>${manifest.name}</h1>
<p class="sub">Addon Nuvio / Stremio — 4 cataloghi, aggiornati automaticamente ogni ${Math.round(config.refreshMs / 60000)} minuti.</p>

<h2>Installazione in Nuvio</h2>
<p>Impostazioni → Addon → Aggiungi addon → Incolla URL:</p>
<pre>${base}/manifest.json</pre>
<p>Su Android / Apple TV puoi usare direttamente:</p>
<pre>stremio://${host}/manifest.json</pre>

<h2>Cataloghi</h2>
<table><tr><th>Catalogo</th><th>Tipo</th><th>ID</th></tr>${rows}</table>

<h2>Stato dei dati</h2>
${line(Boolean(state.latest.at), 'Ultimi Episodi', `${state.latest.items.length} episodi${state.latest.at ? ` · aggiornati ${ageMin(state.latest.at)} min fa` : ''}`)}
${line(Boolean(state.schedule.at), `Calendario Anime (${state.schedule.today || 'n/d'})`, `${state.schedule.timedCount || 0} uscite in giornata, tutte con orario`)}
${line(Boolean(state.movies.at), 'Anime Movie Italiani', `${state.movies.items.length} titoli`)}
${line(Boolean(state.dubbed.at), 'Anime Doppiati in Italiano', `${state.dubbed.items.length} titoli`)}
<p>Arricchimento schede: ${enrich.stats().processed} completate, ${enrich.stats().pending} in coda.</p>
${state.lastError ? `<p class="warn">Ultimo errore: ${state.lastError}</p>` : ''}

<h2>Endpoint</h2>
<p><code>GET /manifest.json</code> · <code>GET /catalog/{type}/{id}.json?skip=0</code> ·
<code>GET /meta/{type}/{id}.json</code> · <code>GET /stream/{type}/{id}.json</code> ·
<code>GET /health</code> · <code>POST /-/refresh</code></p>
</body></html>`);
}

function health(req, res) {
  const bucket = (s) => ({
    count: (s.items || []).length,
    refreshedAt: stamp(s.at),
    ageMin: ageMin(s.at),
    error: s.error,
  });
  return json(res, {
    ok: Boolean(state.latest.at || state.movies.at),
    uptimeSec: Math.round(process.uptime()),
    refreshIntervalMin: Math.round(config.refreshMs / 60000),
    refreshCount: state.refreshCount,
    refreshing: state.refreshing,
    lastError: state.lastError,
    catalogs: {
      latest: bucket(state.latest),
      schedule: {
        ...bucket(state.schedule),
        today: state.schedule.today,
        weekStart: state.schedule.weekStart,
        todayWithTime: state.schedule.timedCount || 0,
        includeIndeterminate: config.includeIndeterminate,
      },
      movies: bucket(state.movies),
      dubbed: bucket(state.dubbed),
    },
    enrich: enrich.stats(),
    sweeper: sweep.get(),
  });
}

module.exports = {
  handleCatalog,
  handleCatalogSearch,
  handleMeta,
  handleStream,
  landing,
  health,
  json,
  noCache,
  stripJson,
  baseUrlOf,
};
