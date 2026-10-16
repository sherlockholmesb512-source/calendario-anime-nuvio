'use strict';

const config = require('./config');
const store = require('./store');
const enrich = require('./enrich');
const { buildManifest, CAT } = require('./manifest');
const ids = require('./ids');
const { getAnimePage, getEpisodeStream, cachePeek } = require('./aw/play');
const { getSearchItems } = require('./aw/filter');
const { italianDayLabel, isoInItaly, timeInItaly } = require('./aw/schedule');
const kitsu = require('./kitsu');
const seasons = require('./seasons');
const external = require('./external');
const trailers = require('./trailers');
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

// ---------------------------------------------------------------------------
// Fonti stream aggiuntive: EasyStreams (addon solo-stream italiano)
// ---------------------------------------------------------------------------

const easyStreamsCache = new Map(); // "tipo|id" -> { at, streams }
const easyStreamsNegCache = new Map(); // "tipo|id" -> { at } (ultimo insuccesso)
const easyStreamsInflight = new Map();
const easyStreamsStats = { calls: 0, ok: 0, empty: 0, errors: 0, lastMs: 0, lastErrorAt: 0 };

/**
 * Interroga EasyStreams per { type: 'series'|'movie', id } e restituisce i suoi
 * flussi (torrent o http). Timeout breve (l'addon e' lento e variabile): dopo
 * il budget si replica con il solo stream AnimeWorld. Risposta in cache TTL
 * lungo; gli insuccessi in una cache negativa breve (niente giri a vuoto).
 */
async function fetchEasyStreams(type, id) {
  if (!config.easyStreamsUrl || !id) return [];
  const cacheKey = `${type}|${id}`;
  const hit = easyStreamsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < config.easyStreamsTtlMs) return hit.streams;
  const neg = easyStreamsNegCache.get(cacheKey);
  if (neg && Date.now() - neg.at < config.easyStreamsNegTtlMs) return [];
  if (easyStreamsInflight.has(cacheKey)) return easyStreamsInflight.get(cacheKey);

  const task = (async () => {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.easyStreamsTimeoutMs);
    easyStreamsStats.calls += 1;
    try {
      const res = await fetch(
        `${config.easyStreamsUrl}/stream/${type}/${encodeURIComponent(id)}.json`,
        { signal: ctrl.signal, headers: { accept: 'application/json' } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const streams = (Array.isArray(body && body.streams) ? body.streams : []).filter(
        (s) => s && (s.url || s.infoHash),
      );
      easyStreamsCache.set(cacheKey, { at: Date.now(), streams });
      easyStreamsStats.lastMs = Date.now() - started;
      if (streams.length) easyStreamsStats.ok += 1;
      else easyStreamsStats.empty += 1;
      return streams;
    } catch (err) {
      easyStreamsStats.errors += 1;
      easyStreamsStats.lastMs = Date.now() - started;
      easyStreamsStats.lastErrorAt = Date.now();
      easyStreamsNegCache.set(cacheKey, { at: Date.now() });
      console.warn(
        `[es] ${type} ${id} non disponibile dopo ${easyStreamsStats.lastMs}ms: ${
          ctrl.signal.aborted ? 'timeout' : err.message
        }`,
      );
      return []; // nessuna fonte aggiuntiva: AnimeWorld basta sempre
    } finally {
      clearTimeout(timer);
    }
  })();
  easyStreamsInflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    easyStreamsInflight.delete(cacheKey);
  }
}

/**
 * Id e tipo per EasyStreams dalla richiesta. Preferisce l'imdb_id dell'anime
 * (enrich Kitsu); altrimenti l'id con prefisso Kitsu/AniList/MAL. Per le serie
 * aggiunge "stagione:episodio" (protocollo Stremio) dal numero del video.
 * `kinfo` opzionale: se assente legge dalla cache Kitsu (peek).
 */
function easyStreamsTarget(req, resolved, videoKey, kinfo) {
  const type = req.params.type === 'movie' ? 'movie' : 'series';
  kinfo = kinfo || kitsu.peek(resolved.slug) || {};
  let id = /^tt\d+$/.test(String(kinfo.imdbId || '')) ? kinfo.imdbId : null;
  if (!id && /^[a-z]+:\d+$/i.test(String(kinfo.kitsuId || ''))) id = kinfo.kitsuId;
  if (!id) return null;

  if (type === 'series') {
    const parsed = ids.parseVideo(videoKey) || ids.parseEpisodeMeta(videoKey) || {};
    let num = parsed.num;
    if (!num) return null; // gli id "awa" di serie (pochi) non hanno episodio
    // Stagione/episodio "veri": per i sequel AnimeWorld usa uno slug diverso con
    // numero che riparte da 1 (e le pagine di prosecuzione sono unite). Se il
    // gruppo di stagioni e' in cache lo usiamo per la coppia stagione:episodio
    // che i client si aspettano, altrimenti ricadiamo sullo slug.
    let season = ids.seasonOf(resolved.slug);
    const loc = seasons.locateEpisode(seasons.peekBundle(resolved.slug), resolved.slug, num);
    if (loc) {
      season = loc.season;
      num = loc.num;
    }
    id = `${id}:${season}:${num}`;
  }
  return { type, id };
}

/**
 * Id/tipo EasyStreams per lo slug risolto, arricchendo Kitsu on-demand (budget
 * breve, come in /meta) se l'enrich non e' ancora in cache: cosi' le fonti
 * aggiuntive compaiono anche al primo click su un episodio appena uscito.
 */
async function resolveEasyStreamsTarget(req, resolved, videoKey) {
  // La pagina di una prosecuzione ("X 2 Part 2") ha slug e id propri, spesso
  // senza id esterni: per Kitsu usiamo la pagina PRINCIPALE del gruppo, cosi'
  // l'anime resta riconosciuto (imdb/kitsu). Stagione ed episodio "veri" li
  // ricava easyStreamsTarget dal gruppo in cache.
  const bundle = seasons.peekBundle(resolved.slug);
  const kSlug = bundle && bundle.mainSlug ? bundle.mainSlug : resolved.slug;
  let kinfo = kitsu.peek(kSlug);
  if ((!kinfo || kitsu.needsRetry(kSlug)) && config.kitsuEnabled) {
    let page = cachePeek(kSlug);
    if (!page) {
      // Episodio del catalogo con la pagina MAI fetchata (lo store lo risolve
      // da solo): la recuperiamo ora per avere gli id MAL/AniList, sempre
      // dentro il budget breve (la coda di sfondo la fetcha comunque a parte).
      page = await Promise.race([
        getAnimePage(kSlug, { priority: false }).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(META_ENRICH_WAIT), META_ENRICH_TIMEOUT_MS)),
      ]);
      if (page === META_ENRICH_WAIT) return null; // non blocchiamo oltre il budget
    }
    if (page && !page.notFound) {
      try {
        kinfo = await Promise.race([
          kitsu.enrichFor(kSlug, page).then(() => kitsu.peek(kSlug)).catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(META_ENRICH_WAIT), META_ENRICH_TIMEOUT_MS)),
        ]);
        if (kinfo === META_ENRICH_WAIT) kinfo = null; // l'enrich pesante prosegue in background
      } catch (err) {
        console.warn(`[es] kitsu non disponibile per ${kSlug}: ${err.message}`);
        kinfo = null;
      }
    }
  }
  return easyStreamsTarget(req, resolved, videoKey, kinfo);
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

// Budget massimo, in /meta, per la ricerca dei trailer italiani su YouTube:
// oltre questo tempo la scheda risponde subito con il trailer di AnimeWorld
// (se disponibile) e la ricerca prosegue in background, pronta per la prossima
// richiesta. Evita che un YouTube lento rallenti l'apertura della scheda.
const META_TRAILER_TIMEOUT_MS = Number(process.env.META_TRAILER_TIMEOUT_MS || 3500);
const META_TRAILER_WAIT = Symbol('meta-trailer-wait');

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

/** "ven" da una data ISO (usata per le sigle compatte del calendario). */
function weekdayShort(iso) {
  try {
    return new Intl.DateTimeFormat('it-IT', { weekday: 'short' })
      .format(new Date(`${String(iso).slice(0, 10)}T12:00:00Z`))
      .replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * "Prossimo episodio: Ep 3 — venerdì 17 ottobre alle 15:30" ricavato dal
 * calendario AnimeWorld (gratuito, in memoria). Se l'uscita di oggi e' gia'
 * passata non torna nulla: e' gia' l'ultimo episodio uscito.
 */
function nextAirLine(slug) {
  const now = Date.now();
  const sched = store.nextAir(slug);
  if (!sched || !sched.at || !sched.date) return null;
  const head = sched.epNumber ? `Ep ${sched.epNumber} — ` : '';
  if (sched.at > now) {
    return `Prossimo episodio: ${head}${sched.label} ${sched.date}${sched.time ? ` alle ${sched.time}` : ''}`;
  }
  if (sched.date === isoInItaly(now) && sched.time) {
    return `Prossimo episodio: ${head}oggi alle ${sched.time}`;
  }
  return null;
}

/** Forma compatta per la riga releaseInfo della card: "Oggi 15:30" / "ven 17 15:30". */
function nextAirShort(slug) {
  const now = Date.now();
  const sched = store.nextAir(slug);
  if (!sched || !sched.at || !sched.date || sched.at < now) return null;
  if (sched.date === isoInItaly(now)) return sched.time ? `Oggi ${sched.time}` : 'Oggi';
  const wd = weekdayShort(sched.date);
  const day = Number(sched.date.slice(8, 10));
  const dayPart = wd && day ? `${wd} ${day}` : sched.date;
  return sched.time ? `${dayPart} · ${sched.time}` : dayPart;
}

/** 1. Ultimi Episodi: un elemento per episodio uscito (id stabile per SERIE). */
function latestPreview(item) {
  const meta = lightMeta(item.slug, item.name, item.poster);
  const audio = item.badge === 'DUB' ? 'DUB ITA' : 'SUB ITA';
  const nextLine = nextAirLine(item.slug);
  const nextShort = nextAirShort(item.slug);
  return {
    // Id PER SERIE (stabile, non per episodio): Nuvio aggancia qui "già visto"
    // e progresso, e la scheda mostra tutta la serie con le sue stagioni.
    id: ids.animeId(item.slug),
    type: 'series',
    name: meta.name,
    poster: meta.poster || item.poster,
    description: cap(
      [nextLine, `${audio} — ultimo episodio uscito.`,
        item.epNumber ? epLabel(item.epNumber, meta.totalEpisodes) : null,
        meta.description].filter(Boolean).join('\n\n'),
    ),
    releaseInfo:
      (item.epNumber ? `Ep ${epShort(item.epNumber, meta.totalEpisodes)}` : 'Nuovo') +
      (nextShort ? ` · ${nextShort}` : ''),
    genres: meta.genres.length ? meta.genres.slice(0, 6) : undefined,
    imdbRating: meta.rating || undefined,
    behaviorHints: { defaultVideoId: ids.videoId(item.epNumber || 0, item.slug) },
  };
}

/** 2. Calendario Anime: solo gli episodi in uscita oggi, con numero, totale e orario. */
function schedulePreview(item, zone) {
  const meta = lightMeta(item.slug, item.title, item.poster);
  const indeterminate = Boolean(item.indeterminate);
  const when = indeterminate
    ? 'senza data fissa'
    : item.time
      ? `alle ${item.time} (${zone})`
      : 'orario non ancora definito';
  // Nel card deve comparire subito l'episodio con il totale e l'orario, es.:
  //   "Liar Game"  —  Ep 26/26 · Oggi 18:30
  // Il totale arriva dall'arricchimento della pagina /play (in cache); se non e'
  // ancora noto usciamo con il solo numero episodio.
  const epPart = item.epNumber ? `Ep ${epShort(item.epNumber, meta.totalEpisodes)}` : 'Ep ?';
  const whenPart = indeterminate ? 'Senza data fissa' : item.time ? `Oggi ${item.time}` : 'Oggi';
  const lead = indeterminate
    ? 'Episodio in arrivo, AnimeWorld non ha ancora fissato una data.'
    : `Uscita di oggi ${when}.`;
  return {
    // Id PER SERIE: come in "Ultimi Episodi", cosi' Nuvio riconosce la serie
    // (episodi visti, lista stagioni) e non l'episodio singolo.
    id: ids.animeId(item.slug),
    type: 'series',
    name: meta.name,
    poster: meta.poster || item.poster,
    description: cap(
      [lead, item.epNumber ? epLabel(item.epNumber, meta.totalEpisodes) + '.' : null,
        meta.description].filter(Boolean).join('\n\n'),
    ),
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
  const nextShort = isMovie ? null : nextAirShort(item.slug);
  return {
    id: ids.animeId(item.slug),
    type,
    name: meta.name,
    poster: meta.poster || item.poster,
    description: cap([tag, nextAirLine(item.slug), meta.description].filter(Boolean).join('\n\n')),
    releaseInfo:
      (meta.year || (isMovie ? 'Movie' : 'ITA')) + (nextShort ? ` · ${nextShort}` : ''),
    genres: meta.genres.length ? meta.genres.slice(0, 6) : undefined,
    imdbRating: meta.rating || undefined,
  };
}

// ---------------------------------------------------------------------------
// Contenuto "vivo" del catalogo Calendario (ricalcolato a ogni richiesta)
// ---------------------------------------------------------------------------

/**
 * Le uscite di OGGI, scelte al momento confrontando l'ora corrente con gli
 * intervalli reali [start, end) dei giorni: a mezzanotte il catalogo gira da
 * solo senza aspettare il refresh periodico. Deduplicate per slug (una serie
 * non deve comparire due volte nella stessa giornata).
 */
function liveScheduleItems() {
  const today = store.scheduleToday();
  const out = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || !item.slug || seen.has(item.slug)) return;
    seen.add(item.slug);
    out.push(item);
  };
  for (const item of (today && today.items) || []) push(item);
  if (config.includeIndeterminate) {
    for (const item of state.schedule.indeterminate || []) push(item);
  }
  return out;
}

/** Elementi su cui cercare/paginare per un catalogo. */
const bucketItems = (def) =>
  def.live ? liveScheduleItems() : (state[def.bucket] && state[def.bucket].items) || [];

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
    // "live": il contenuto NON viene dallo snapshot dell'ultimo refresh ma e'
    // ricalcolato a ogni richiesta (uscite di oggi secondo l'ora corrente).
    live: true,
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

  const items = bucketItems(def);
  const page = paginate(items, req.query.skip, req.query.limit);
  const metas = page.map((item) => def.build(item)).filter(Boolean);

  res.set('X-Catalog-Items-Total', String(items.length));
  const at = def.live ? state.schedule.at : state[def.bucket].at;
  if (at) res.set('X-Catalog-Refreshed-At', new Date(at).toISOString());
  if (def.live) {
    const today = store.scheduleToday();
    if (today) res.set('X-Schedule-Date', today.date || '');
  }
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
    const inBucket = bucketItems(def).find((x) => x.slug === item.slug);
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

  // Gruppo di stagioni: TUTTE le pagine/stagioni dell'opera (fonte primaria la
  // sezione "Correlati" della pagina, poi la ricerca), con i numeri di stagione
  // e i dettagli episodio (titolo/trama italiana, still, data di uscita) dalle
  // fonti esterne. Cosi' un sequel non mostra piu' la sola stagione in corso.
  let bundle = null;
  if (config.seasonsEnabled) {
    try {
      bundle = await seasons.getSeriesBundle(slug, { priority: true });
    } catch (err) {
      console.warn(`[meta] gruppo stagioni non disponibile per ${slug}: ${err.message}`);
    }
  }

  let eps = seasons.flattenEpisodes(bundle);
  if (!eps.length) {
    // Ripiego: sola pagina principale (comportamento precedente).
    const season = ids.seasonOf(slug);
    eps = (page.videos || []).map((v) => ({
      num: v.num,
      season,
      epId: v.id,
      slug,
      total: page.totalEpisodes || null,
      title: null,
      overview: null,
      thumbnail: null,
      released: null,
      runtime: null,
    }));
  }

  const totalHere = merged.totalEpisodes || page.totalEpisodes || null;
  const videos = eps.map((e) => {
    const isMain = e.slug === slug;
    // Trame/miniature Kitsu/TMDB: valgono per la pagina principale, mentre per
    // le altre stagioni arrivano dalla fonte esterna del bundle.
    const thumbs = isMain ? merged.episodeThumbs : null;
    const overs = isMain ? merged.episodeOverviews : null;
    const total = e.total || totalHere;
    const label = total ? `Episodio ${e.num}/${total}` : `Episodio ${e.num}`;
    return {
      // Id video con lo slug della PROPRIA stagione: /stream lo risolve sulla
      // pagina giusta anche quando la serie ne ha piu' di una. Per le pagine di
      // prosecuzione unite (srcNum/srcSlug) conta lo slug e il numero ORIGINALI,
      // non quello rinumerato nella stagione.
      id: ids.videoId(e.srcNum != null ? e.srcNum : e.num, e.srcSlug || e.slug),
      season: e.season,
      episode: e.num,
      // "Episodio 3/24 — Il ritorno del drago": numero, totale e titolo reale.
      title: e.title ? `${label} — ${e.title}` : label,
      // Miniatura del singolo episodio (still) dalla fonte esterna/Kitsu/TMDB;
      // in ultima istanza la copertina dell'anime (mai vuota).
      thumbnail:
        e.thumbnail ||
        (thumbs && thumbs[e.num]) ||
        merged.poster ||
        page.poster ||
        copertine(e.slug),
      // Trama del singolo episodio in italiano.
      overview: e.overview || (overs && overs[e.num]) || undefined,
      // Data di uscita (la usa il cliente per ordinare e marcizzare le stagioni).
      released: e.released || undefined,
    };
  });

  const nextLine = nextAirLineFor(bundle, slug);

  const seasonNote =
    bundle && bundle.seasonCount > 1
      ? `Stagioni: ${bundle.seasonCount} (tutte raccolte in questa scheda)`
      : null;
  const notes = [
    page.category ? `Categoria: ${page.category}` : null,
    page.audio ? `Audio: ${page.audio}` : null,
    totalHere ? `Episodi totali: ${totalHere}` : null,
    seasonNote,
    (merged.runtime || page.duration) ? `Durata: ${merged.runtime || page.duration}` : null,
    (merged.status || page.state) ? `Stato: ${merged.status || page.state}` : null,
    (merged.rating || page.rating) ? `Voto: ${merged.rating || page.rating}${kinfo ? ' (IMDb)' : '/10'}` : null,
    page.malId ? `MyAnimeList: mal/${page.malId}` : null,
    page.anilistId ? `AniList: anime/${page.anilistId}` : null,
  ].filter(Boolean);

  // Trailer: ricerca best-effort dei trailer sottotitolati in italiano (canali
  // italiani su YouTube), con riserva sul trailer incorporato da AnimeWorld.
  // La scheda non aspetta oltre un budget breve: se YouTube e' lento risponde
  // subito col solo trailer AnimeWorld e la ricerca prosegue in background.
  let trailerList = [];
  try {
    const found = await Promise.race([
      trailers.getTrailers({ title: page.title, year: page.year, awTrailer: page.trailer }),
      new Promise((resolve) => setTimeout(() => resolve(META_TRAILER_WAIT), META_TRAILER_TIMEOUT_MS)),
    ]);
    if (found && found !== META_TRAILER_WAIT) {
      trailerList = found;
    } else if (page.trailer) {
      trailerList = [{ source: page.trailer, type: 'Trailer' }];
    }
  } catch {
    // nessun trailer: la scheda resta completa lo stesso
  }

  const meta = {
    id: baseId,
    type,
    name: page.title,
    poster: merged.poster || page.poster || copertine(slug),
    // Prima riga la prossima uscita: "Prossimo episodio: Ep 3 — venerdì 17
    // ottobre alle 15:30" (calendario) oppure "— 24 ottobre" (fonte esterna).
    description: cap(
      [nextLine, merged.description || page.description, notes.join(' · ')]
        .filter(Boolean)
        .join('\n\n'),
    ),
    releaseInfo: merged.year || page.year || '',
    genres: merged.genres || page.genres || [],
    imdbRating: merged.rating || page.rating || undefined,
    background: merged.background || undefined,
    logo: merged.logo || undefined,
    cast: merged.cast && merged.cast.length ? merged.cast : undefined,
    trailers: trailerList.length ? trailerList : undefined,
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
    // Punto di ingresso: l'episodio richiesto (id "awm") oppure l'ultimo gia'
    // uscito (le date future delle fonti esterne non devono diventare default).
    const now = Date.now();
    const aired = videos.filter((v) => {
      const t = v.released ? Date.parse(v.released) : NaN;
      return !Number.isFinite(t) || t <= now;
    });
    const chosen =
      (num && videos.find((v) => v.id === ids.videoId(num, slug))) ||
      aired[aired.length - 1] ||
      videos[videos.length - 1];
    if (chosen) {
      meta.behaviorHints = { defaultVideoId: chosen.id, bingeGroup: `calendario-anime|${slug}` };
    }
  }

  return { meta };
}

/**
 * Riga "Prossimo episodio" per la descrizione della scheda.
 * Prima il calendario AnimeWorld (giorno + orario preciso), poi la fonte
 * esterna del bundle (solo data di uscita, utile anche fuori settimana).
 */
function nextAirLineFor(bundle, slug) {
  const now = Date.now();
  const main = (bundle && bundle.mainSlug) || slug;
  const sched = store.nextAir(main) || store.nextAir(slug);
  if (sched && sched.at && sched.date) {
    const head = sched.epNumber ? `Ep ${sched.epNumber} — ` : '';
    if (sched.at > now) {
      return `Prossimo episodio: ${head}${sched.label} ${sched.date}${sched.time ? ` alle ${sched.time}` : ''}`;
    }
    if (sched.date === isoInItaly(now) && sched.time) {
      return `Prossimo episodio: ${head}oggi alle ${sched.time}`;
    }
  }
  const ext = seasons.nextEpisodeFromExternal(bundle);
  if (ext && Number.isFinite(ext.ts) && ext.ts > now) {
    const iso = String(ext.released || '').slice(0, 10);
    const head = ext.episode ? `Ep ${ext.episode}` : 'Nuovo episodio';
    return `Prossimo episodio: ${head}${iso ? ` — ${store.formatItalianDate(iso)}` : ''}`;
  }
  return null;
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

  // Unica sorgente: lo streaming diretto di AnimeWorld. Le fonti aggiuntive
  // EasyStreams sono volutamente escluse (l'utente vuole solo il primo flusso,
  // quello diretto): cosi' /stream risponde subito, senza attendere l'addon
  // terzo. Le funzioni EasyStreams restano disponibili per una riattivazione.
  let stream;
  try {
    stream = await getEpisodeStream(resolved.epId, { priority: true });
  } catch (err) {
    console.warn(`[stream] errore sorgente per ${resolved.epId}: ${err.message}`);
    return json(res, { streams: [] });
  }

  const group = resolved.slug ? `calendario-anime|${resolved.slug}` : `calendario-anime|${resolved.epId}`;
  const streams = [];

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
  const today = store.scheduleToday();

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
${line(Boolean(state.schedule.at), `Calendario Anime${today ? ` (${today.date})` : ''}`, today ? `${today.items.length} uscite oggi, ${today.items.filter((i) => i.time).length} con orario definite` : 'nessuna uscita di oggi dal calendario')}
${line(Boolean(state.movies.at), 'Anime Movie Italiani', `${state.movies.items.length} titoli`)}
${line(Boolean(state.dubbed.at), 'Anime Doppiati in Italiano', `${state.dubbed.items.length} titoli`)}
<p>Arricchimento schede: ${enrich.stats().processed} completate, ${enrich.stats().pending} in coda · gruppi stagioni in cache: ${seasons.stats().cached}.</p>
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
  const today = store.scheduleToday();
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
        count: liveScheduleItems().length,
        refreshedAt: stamp(state.schedule.at),
        ageMin: ageMin(state.schedule.at),
        error: state.schedule.error,
        weekStart: state.schedule.weekStart,
        today: today
          ? {
              date: today.date,
              label: today.label,
              count: today.items.length,
              withTime: today.items.filter((i) => i.time).length,
            }
          : null,
        indeterminate: (state.schedule.indeterminate || []).length,
        hero: state.schedule.hero || null,
        includeIndeterminate: config.includeIndeterminate,
      },
      movies: bucket(state.movies),
      dubbed: bucket(state.dubbed),
    },
    seasons: seasons.stats(),
    external: external.stats(),
    trailers: trailers.stats(),
    enrich: enrich.stats(),
    sweeper: sweep.get(),
    // Le fonti aggiuntive EasyStreams non vengono piu' interrogate: /stream
    // restituisce solo lo streaming diretto di AnimeWorld.
    easyStreams: {
      enabled: false,
      cacheEntries: easyStreamsCache.size,
      negCacheEntries: easyStreamsNegCache.size,
      ...easyStreamsStats,
    },
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
