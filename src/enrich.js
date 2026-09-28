'use strict';

const config = require('./config');
const { getAnimePage } = require('./aw/play');
const { enrichFor: kitsuEnrich } = require('./kitsu');

/**
 * Arricchimento progressivo in background.
 *
 * I cataloghi "Ultimi Episodi" e "Calendario Anime" rispondono subito con i
 * dati leggeri presi dalla homepage / dal calendario; in parallelo, in coda e
 * con rate limit, recuperiamo la pagina /play di ogni anime per ottenere
 * descrizione, generi, anno, voto e numero totale di episodi.
 *
 * Le pagine restano in cache 6 ore, quindi un anime viene scaricato una volta
 * sola e i refresh successivi non generano nuove richieste verso AnimeWorld.
 */

const BUDGET = Number(process.env.ENRICH_BUDGET || 6);
const EVERY_MS = Number(process.env.ENRICH_EVERY_MS || 20000);
const MAX_QUEUE = Number(process.env.ENRICH_MAX_QUEUE || 1600);

const pending = [];
const queued = new Set();
let processed = 0;
let failed = 0;
let running = false;
let timer = null;

const stats = () => ({ pending: pending.length, processed, failed, running });

/** Accoda gli slug ancora da arricchire (ignora quelli gia' in coda). */
function enqueue(slugs) {
  let added = 0;
  for (const slug of slugs) {
    if (!slug || queued.has(slug)) continue;
    queued.add(slug);
    pending.push(slug);
    added += 1;
  }
  trim();
  return added;
}

/** La coda puo' crescere: teniamo solo gli slug piu' recenti. */
function trim() {
  while (pending.length > MAX_QUEUE) queued.delete(pending.shift());
}

/** Processa al massimo `budget` slug. Ritorna quanti ne sono stati elaborati. */
async function run(budget = BUDGET) {
  if (running) return 0;
  running = true;
  let done = 0;
  try {
    for (let i = 0; i < budget && pending.length; i += 1) {
      const slug = pending.shift();
      if (!slug) break;
      try {
        const page = await getAnimePage(slug);
        // In aggiunta alla pagina /play, chiediamo anche il riassunto Kitsu:
        // descrizione, voto, generi, art. Non deve mai rompere la coda.
        if (page && !page.notFound && config.kitsuEnabled) {
          try {
            await kitsuEnrich(slug, page);
          } catch (err) {
            console.warn(`[enrich] kitsu fallito ${slug}: ${err.message}`);
          }
        }
        processed += 1;
        done += 1;
      } catch (err) {
        failed += 1;
        console.warn(`[enrich] fallito ${slug}: ${err.message}`);
        // Non rimettiamo in coda: altrimenti loop infinito sullo stesso errore.
      } finally {
        queued.delete(slug);
      }
    }
  } finally {
    running = false;
  }
  return done;
}

function start() {
  if (timer) return;
  console.log(
    `[enrich] coda in background attiva: ${BUDGET} slug ogni ${Math.round(EVERY_MS / 1000)}s, ` +
      `cache pagine ${config.animePageCacheMs / 3600000}h, ` +
      `kitsu ${config.kitsuEnabled ? 'on' : 'off'}`,
  );
  timer = setInterval(() => {
    run().catch((err) => console.warn('[enrich] errore:', err.message));
  }, EVERY_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

const reset = () => {
  pending.length = 0;
  queued.clear();
};

module.exports = { enqueue, run, start, stop, stats, trim, reset };
