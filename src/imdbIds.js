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

const stats = () => ({
  imdb: byImdb.size,
  slugs: bySlug.size,
  negative: negCache.size,
  inflight: inflight.size,
});

function flush() {
  byImdb.clear();
  bySlug.clear();
  negCache.clear();
  inflight.clear();
}

module.exports = {
  remember,
  imdbFor,
  resolvedId,
  resolveSlug,
  stats,
  flush,
  IMDB_RE,
};
