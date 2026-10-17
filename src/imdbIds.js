'use strict';

/**
 * Indice IMDb <-> slug AnimeWorld.
 *
 * Perche' esiste: Nuvio costruisce l'elemento di libreria (e quindi l'id
 * inviato a Trakt) dal campo `id` dell'elemento di catalogo/scheda, e lo
 * considera un id IMDb solo se inizia con "tt" (`id.takeIf { it.startsWith("tt") }`).
 * Gli id `awa.<slug>` non sono quindi compatibili con Trakt ("ID Trakt
 * compatibili mancanti").
 *
 * Qui teniamo la corrispondenza fra l'id IMDb di un'opera e lo slug AnimeWorld,
 * cosi' catalogo e scheda possono esporre `tt<imdb>` quando noto, con
 * `awa.<slug>` come ripiego.
 *
 * Tutte le stagioni di una stessa opera condividono lo stesso id IMDb (e' cosi'
 * su AnimeWorld): la mappa imdb->slug tiene il PRIMO slug registrato, mentre
 * slug->imdb viene aggiornata sempre. L'arricchimento in background registra gli
 * slug dei cataloghi episodici prima dei doppiati, quindi di norma vince la
 * prima stagione disponibile.
 */

const config = require('./config');
const { getSearchItems } = require('./aw/filter');
const { normalize, stripAudio } = require('./text');

const IMDB_RE = /^tt\d+$/;
const NEG_TTL = 30 * 60 * 1000;
const MAX = 6000;
const TMDB = 'https://api.themoviedb.org/3';

const byImdb = new Map(); // imdb -> slug (primo registrato vince)
const bySlug = new Map(); // slug -> imdb (aggiornato sempre)
const negCache = new Map(); // imdb -> { at } (nessuno slug trovato)
const inflight = new Map(); // imdb -> Promise<slug|null>

function trim(map) {
  while (map.size > MAX) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

/** Registra la corrispondenza slug <-> imdb (se l'id e' un IMDb valido). */
function remember(slug, imdb) {
  const id = String(imdb || '').trim();
  if (!slug || !IMDB_RE.test(id)) return;
  if (!byImdb.has(id)) byImdb.set(id, slug);
  bySlug.set(slug, id);
  negCache.delete(id);
  trim(byImdb);
  trim(bySlug);
}

/** IMDb noto per uno slug (o null). */
const imdbFor = (slug) => bySlug.get(slug) || null;

/**
 * Id "pubblico" di un anime: l'IMDb (`tt<imdb>`) se noto, altrimenti il
 * tradizionale `awa.<slug>` (o il fallback indicato).
 */
function resolvedId(slug, fallback) {
  const imdb = bySlug.get(slug);
  if (imdb) return imdb;
  if (fallback) return fallback;
  return slug ? `awa.${slug}` : null;
}

/** Nome inglese dell'opera su TMDB a partire dall'id IMDb. */
async function tmdbNameForImdb(imdb) {
  const key = config.tmdbApiKey;
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(
      `${TMDB}/find/${encodeURIComponent(imdb)}?api_key=${encodeURIComponent(key)}&external_source=imdb_id`,
      { signal: ctrl.signal, headers: { accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const body = await res.json();
    const tv = Array.isArray(body.tv_results) ? body.tv_results[0] : null;
    if (tv && tv.name) return tv.name;
    const mv = Array.isArray(body.movie_results) ? body.movie_results[0] : null;
    if (mv && (mv.title || mv.name)) return mv.title || mv.name;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const normName = (t) => normalize(stripAudio(t));
const isDubSlug = (slug) => /-ita(?=\.|$)/i.test(String(slug || ''));

/**
 * Risolve un id IMDb nello slug AnimeWorld (deep link esterni: Trakt puo'
 * chiedere /meta o /stream per un `tt<imdb>` che non e' ancora in cache). Usa
 * TMDB per il nome inglese e la ricerca AnimeWorld, con match STRETTO sul titolo
 * base e preferenza per l'edizione sottotitolata. Gli insuccessi sono messi in
 * cache negativa; le richieste concorrenti sono de-duplicate.
 */
async function resolveSlug(imdb) {
  const id = String(imdb || '').trim();
  if (!IMDB_RE.test(id)) return null;
  const known = byImdb.get(id);
  if (known) return known;
  const neg = negCache.get(id);
  if (neg && Date.now() - neg.at < NEG_TTL) return null;
  if (inflight.has(id)) return inflight.get(id);

  const task = (async () => {
    const miss = () => {
      negCache.set(id, { at: Date.now() });
      trim(negCache);
      return null;
    };
    try {
      const name = await tmdbNameForImdb(id);
      if (!name) return miss();
      const hits = await getSearchItems(name, 30);
      const want = normName(name);
      const list = (hits || []).filter((h) => h && h.slug);
      const prefix = (n) => n && (n.startsWith(`${want} `) || want.startsWith(`${n} `));
      const pick =
        list.find((h) => normName(h.name) === want && !isDubSlug(h.slug)) ||
        list.find((h) => normName(h.name) === want) ||
        list.find((h) => prefix(normName(h.name)) && !isDubSlug(h.slug)) ||
        list.find((h) => prefix(normName(h.name)));
      if (!pick) return miss();
      remember(pick.slug, id);
      return pick.slug;
    } catch {
      return miss();
    } finally {
      inflight.delete(id);
    }
  })();

  inflight.set(id, task);
  return task;
}

// ---------------------------------------------------------------------------
// Ricerca automatica dell'IMDb per TITOLO (TMDB): copre gli slug per i quali
// l'addon Kitsu non espone l'imdb_id. TMDB /search + /external_ids danno
// l'IMDb ufficiale; il match privilegia le opere giapponesi e l'anno vicino.
// ---------------------------------------------------------------------------

const TMDB_TIMEOUT = 10000;
const ensureInflight = new Map(); // slug -> Promise<imdb|null>

async function tmdbJson(path) {
  const key = config.tmdbApiKey;
  if (!key) return null;
  const sep = path.includes('?') ? '&' : '?';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TMDB_TIMEOUT);
  try {
    const res = await fetch(`${TMDB}${path}${sep}api_key=${encodeURIComponent(key)}`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Titolo pulito per la ricerca TMDB: i suffissi di edizione di AnimeWorld
 * "(ITA)", "(SUB ITA)", "(DOPPIATO)" manderebbero la query a vuoto.
 */
const cleanTitle = (t) =>
  String(t || '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\b(ITA|SUB|DOP|DOPPIATO|SOTTOTITOLATO)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

/** Miglior risultato TMDB: preferisce l'originale giapponese e l'anno vicino. */
function pickTmdbResult(results, year) {
  const yr = Number(year) || 0;
  const scored = (results || [])
    .filter((r) => r && r.id)
    .map((r) => {
      const rYear =
        Number(String(r.first_air_date || r.release_date || '').slice(0, 4)) || 0;
      return {
        r,
        langOk: (r.original_language || '').toLowerCase() === 'ja',
        d: yr && rYear ? Math.abs(yr - rYear) : 0,
      };
    })
    .sort((a, b) => (a.langOk === b.langOk ? a.d - b.d : a.langOk ? -1 : 1));
  return scored[0] ? scored[0].r : null;
}

/**
 * IMDb per titolo+anno via TMDB (cerca prima nel tipo suggerito, poi nell'altro).
 * Ritorna "tt..." o null; nessuna eccezione verso l'esterno.
 */
async function tmdbImdbForTitle(title, year, type) {
  const clean = cleanTitle(title);
  if (!clean || !config.tmdbApiKey) return null;
  const q = encodeURIComponent(clean);
  const yr = Number(year) || '';
  const suffix = yr ? `&year=${encodeURIComponent(yr)}` : '';
  const order = type === 'movie' ? ['movie', 'tv'] : ['tv', 'movie'];
  for (const kind of order) {
    const src =
      kind === 'tv'
        ? await tmdbJson(`/search/tv?query=${q}${suffix}&language=en-US`)
        : await tmdbJson(`/search/movie?query=${q}${suffix}&language=en-US`);
    const best = pickTmdbResult(src && src.results, year);
    if (!best) continue;
    const ext =
      kind === 'tv'
        ? await tmdbJson(`/tv/${best.id}/external_ids`)
        : await tmdbJson(`/movie/${best.id}/external_ids`);
    const imdb = ext && ext.imdb_id;
    if (IMDB_RE.test(String(imdb || ''))) return imdb;
  }
  return null;
}

/**
 * Garantisce che uno slug abbia un IMDb: se non noto, lo cerca per titolo su
 * TMDB e lo registra. Le chiamate concorrenti sullo stesso slug sono deduplicate.
 */
async function ensureForSlug(slug, page) {
  if (!slug || !page || page.notFound) return null;
  const known = bySlug.get(slug);
  if (known) return known;
  if (ensureInflight.has(slug)) return ensureInflight.get(slug);

  const task = (async () => {
    try {
      const type = /film|movie|cinema/i.test(page.category || '') ? 'movie' : 'series';
      const imdb = await tmdbImdbForTitle(page.title, page.year, type);
      if (imdb) {
        remember(slug, imdb);
        return imdb;
      }
      return null;
    } finally {
      ensureInflight.delete(slug);
    }
  })();

  ensureInflight.set(slug, task);
  return task;
}

const stats = () => ({
  imdb: byImdb.size,
  slugs: bySlug.size,
  negative: negCache.size,
  inflight: inflight.size + ensureInflight.size,
});

function flush() {
  byImdb.clear();
  bySlug.clear();
  negCache.clear();
  inflight.clear();
  ensureInflight.clear();
}

module.exports = {
  remember,
  imdbFor,
  resolvedId,
  resolveSlug,
  tmdbImdbForTitle,
  ensureForSlug,
  stats,
  flush,
  IMDB_RE,
};
