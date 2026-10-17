'use strict';

/**
 * Genera data/imdb-map.json: la mappa slug AnimeWorld -> id IMDb ("tt...").
 *
 * Riusa la pipeline dell'addon: pagina /play di AnimeWorld (id AniList/MAL) +
 * arricchimento Kitsu (imdb_id) e, come riserva, la ricerca TMDB per titolo.
 * La mappa viene committata nel repo: l'istanza Render (piano free) e' effimera,
 * quindi dopo ogni deploy/riavvio/sleep i tt... andrebbero riconquistati uno a
 * uno dalla coda di arricchimento (ore per i ~1.300 titoli di movie/doppiati).
 * Con la mappa pronta, la copertura e' immediata al primo avvio.
 *
 * Uso:  npm run map        (oppure: node scripts/build-imdb-map.js)
 * Utili: MAP_CONCURRENCY=8 (default 6), MAP_VERBOSE=1
 */

const fs = require('fs');
const path = require('path');

const config = require('../src/config');
const store = require('../src/store');
const { getAnimePage } = require('../src/aw/play');
const kitsu = require('../src/kitsu');
const imdbIds = require('../src/imdbIds');

const OUT = path.join(__dirname, '..', 'data', 'imdb-map.json');
const CONCURRENCY = Math.max(1, Number(process.env.MAP_CONCURRENCY || 6));

/** Tutti gli slug dei 4 cataloghi, con il titolo di riserva del catalogo. */
function collectTargets() {
  const targets = new Map(); // slug -> nome (dal catalogo)
  const add = (slug, name) => {
    if (slug && !targets.has(slug)) targets.set(slug, name || null);
  };
  for (const item of store.state.latest.items || []) add(item.slug, item.name);
  const today = store.scheduleToday();
  for (const item of (today && today.items) || []) add(item.slug, item.title);
  for (const item of store.state.schedule.indeterminate || []) add(item.slug, item.title);
  if (store.state.schedule.hero) {
    add(store.state.schedule.hero.slug, store.state.schedule.hero.title);
  }
  for (const item of store.state.movies.items || []) add(item.slug, item.name);
  for (const item of store.state.dubbed.items || []) add(item.slug, item.name);
  return targets;
}

/** Risolve un singolo slug: pagina -> Kitsu -> TMDB, oppure solo titolo. */
async function resolveOne(slug, name) {
  const known = imdbIds.imdbFor(slug);
  if (known) return known;

  let page = null;
  try {
    page = await getAnimePage(slug);
  } catch (err) {
    if (process.env.MAP_VERBOSE) console.warn(`[map] pagina ${slug}: ${err.message}`);
  }

  if (page && !page.notFound) {
    try {
      await kitsu.enrichFor(slug, page);
    } catch (err) {
      if (process.env.MAP_VERBOSE) console.warn(`[map] kitsu ${slug}: ${err.message}`);
    }
    if (imdbIds.imdbFor(slug)) return imdbIds.imdbFor(slug);
    try {
      await imdbIds.ensureForSlug(slug, page); // TMDB per titolo + anno
    } catch (err) {
      if (process.env.MAP_VERBOSE) console.warn(`[map] tmdb ${slug}: ${err.message}`);
    }
    return imdbIds.imdbFor(slug) || null;
  }

  // Pagina non raggiungibile: tentiamo comunque per titolo dal catalogo.
  if (name) {
    try {
      await imdbIds.ensureForSlug(slug, { title: name, year: null, category: '' });
    } catch (err) {
      if (process.env.MAP_VERBOSE) console.warn(`[map] tmdb ${slug}: ${err.message}`);
    }
  }
  return imdbIds.imdbFor(slug) || null;
}

/** Mappa precedente su disco: count, mappa e generatedAt (o valori vuoti). */
function readPrevious() {
  const empty = { count: 0, map: null, generatedAt: null };
  try {
    if (!fs.existsSync(OUT)) return empty;
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8').replace(/^\uFEFF/, ''));
    const map = (prev && prev.map) || null;
    return {
      count: Number(prev && prev.count) || Object.keys(map || {}).length,
      map,
      generatedAt: (prev && prev.generatedAt) || null,
    };
  } catch {
    return empty;
  }
}

/** Stessa mappa (stessi slug con gli stessi id), a prescindere dall'ordine. */
function sameMap(a, b) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

async function main() {
  const started = Date.now();
  console.log(`[map] refresh dei cataloghi (${config.scheduleTz})...`);
  await store.refreshAll();

  const targets = collectTargets();
  const slugs = [...targets.keys()];
  console.log(`[map] ${slugs.length} slug unici da risolvere (concorrenza ${CONCURRENCY})`);
  if (!slugs.length) throw new Error('nessuno slug nei cataloghi: refresh fallito?');

  let done = 0;
  let found = 0;
  let missing = 0;
  const queue = slugs.slice();

  async function worker() {
    for (;;) {
      const slug = queue.shift();
      if (!slug) return;
      try {
        const id = await resolveOne(slug, targets.get(slug));
        if (id) found += 1;
        else missing += 1;
      } catch (err) {
        missing += 1;
        if (process.env.MAP_VERBOSE) console.warn(`[map] ${slug}: ${err.message}`);
      } finally {
        done += 1;
        if (done % 100 === 0 || done === slugs.length) {
          console.log(`[map] ${done}/${slugs.length} — ${found} con IMDb, ${missing} senza`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Slug in ordine alfabetico: la serializzazione diventa deterministica e un
  // semplice riordino dei cataloghi non produce un file (e quindi un commit)
  // diverso a parita' di contenuto.
  const map = {};
  for (const slug of slugs.slice().sort()) {
    const id = imdbIds.imdbFor(slug);
    if (id) map[slug] = id;
  }

  // Guardia anti-regressione: se la fonte esterna risponde male (blocco IP,
  // outage) la copertura puo' crollare. Meglio una mappa vecchia che una
  // vuota: sotto la soglia il file NON viene toccato e il comando esce in
  // errore (cosi' anche la GitHub Action non committa nulla).
  const previous = readPrevious();
  const minRatio = Number(process.env.MAP_MIN_RATIO || 0.8);
  const minAccepted = Math.max(1, Math.floor(previous.count * minRatio));
  if (previous.count > 0 && Object.keys(map).length < minAccepted) {
    throw new Error(
      `copertura crollata: ${Object.keys(map).length} voci < ${minAccepted} accettate ` +
        `(mappa precedente: ${previous.count}). File non aggiornato.`,
    );
  }

  // Se gli slug/gli id non sono cambiati conserviamo il `generatedAt` di prima:
  // il file resta identico byte per byte, la GitHub Action non committa e non
  // parte un deploy di Render inutile.
  const unchanged = Boolean(previous.map) && sameMap(previous.map, map);
  const payload = {
    version: 1,
    generatedAt: unchanged ? previous.generatedAt : new Date().toISOString(),
    count: Object.keys(map).length,
    map,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 0)}\n`);
  console.log(
    `[map] scritto ${OUT}: ${payload.count}/${slugs.length} slug con IMDb ` +
      `(senza: ${slugs.length - payload.count}) in ${Math.round((Date.now() - started) / 1000)}s` +
      `${unchanged ? ' — contenuto invariato' : ''}`,
  );
  return payload;
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[map] errore:', err && err.stack ? err.stack : err);
      process.exit(1);
    });
}

module.exports = { main, collectTargets, resolveOne };
