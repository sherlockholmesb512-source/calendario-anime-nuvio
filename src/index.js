'use strict';

const path = require('path');
const express = require('express');

const config = require('./config');
const store = require('./store');
const enrich = require('./enrich');
const { buildManifest } = require('./manifest');
const routes = require('./routes');
const { flushExpired } = require('./aw/play');
const kitsu = require('./kitsu');
const sweep = require('./sweep');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// Un client addon deve poter ricevere richieste da qualsiasi Nuvio/desktop.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

// ---------------------------------------------------------------------------
// Rotte del protocollo addon (Stremio / Nuvio)
// ---------------------------------------------------------------------------

// 1) Manifesto
app.get('/manifest.json', routes.noCache, (req, res) => {
  routes.json(res, buildManifest(routes.baseUrlOf(req)));
});

// 2) Cataloghi
app.get(
  '/catalog/:type/:id/:search',
  routes.noCache,
  routes.stripJson,
  routes.handleCatalogSearch,
);
app.get(
  '/catalog/:type/:id',
  routes.noCache,
  routes.stripJson,
  routes.handleCatalog,
);

// 3) Meta
app.get(
  '/meta/:type/:id',
  routes.noCache,
  routes.stripJson,
  routes.handleMeta,
);

// 4) Stream
app.get(
  '/stream/:type/:id',
  routes.noCache,
  routes.stripJson,
  routes.handleStream,
);

// ---------------------------------------------------------------------------
// Utilita'
// ---------------------------------------------------------------------------

app.get('/health', routes.noCache, routes.health);

app.post('/-/refresh', routes.noCache, async (req, res) => {
  await store.refreshAll();
  routes.json(res, { ok: true, refreshCount: store.state.refreshCount, health: 'vedi /health' });
});

// Refresh manuale senza aspettare: utile per Railway/vitprobe e per il test.
app.get('/-/refresh', routes.noCache, async (req, res) => {
  await store.refreshAll();
  routes.json(res, { ok: true, refreshCount: store.state.refreshCount });
});

app.get('/', routes.noCache, routes.landing);

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));

app.use((req, res) => routes.json(res, { error: 'Not found' }, 404));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[errore]', err && err.stack ? err.stack : err);
  routes.json(res, { error: 'Errore interno' }, 500);
});

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

async function bootstrap() {
  console.log(`[avvio] ${config.addonName} — porta ${config.port}`);
  console.log(`[avvio] timezone calendario: ${config.scheduleTz}`);

  // Non blocchiamo l'avvio: il server risponde subito con lo stato vuoto
  // mentre il primo refresh gira in background.
  store
    .refreshAll()
    .then(() => {
      // Metti subito in coda l'arricchimento delle schede: prima quelle dei
      // cataloghi episodici (calendario e ultimi episodi, prioritarie), poi le
      // opere di movie/doppiati. La coda lavora a 6 slug ogni 20 s, quindi il
      // catalogo intero si arricchisce in modo progressivo nelle ore successive.
      const added = enrich.enqueue(allCatalogSlugs());
      console.log(`[avvio] ${added} schede in coda per l'arricchimento`);
    })
    .catch((err) => console.error('[avvio] primo refresh fallito:', err.message));

  store.startScheduler();
  enrich.start();

  // A ogni refresh accodiamo anche le nuove schede arrivate.
  const hook = setInterval(
    () => {
      enrich.enqueue(allCatalogSlugs());
    },
    config.refreshMs,
  );
  if (hook.unref) hook.unref();

  // Svuota-cache SELEZIONATO: ogni 30 minuti si eliminano solo le voci SCADUTE
  // (pagine /play oltre il TTL, stream risolti, summary Kitsu, TMDB) lasciando
  // intatte quelle ancora fresche; subito dopo vengono ri-accodati solo gli
  // slug scaduti. Niente piu' riscrapiatura in blocco di AnimeWorld: i dati
  // rimangono in cache finche' non invecchiano davvero.
  if (config.cacheSweepMs > 0) {
    const sweeper = setInterval(() => {
      const pages = flushExpired();
      const kitsuSwept = kitsu.flushExpired();
      const reenqueued = enrich.enqueue(pages.evicted.concat(kitsuSwept.evicted));
      sweep.note({
        lastAt: new Date().toISOString(),
        pages: pages.pages,
        streams: pages.streams,
        kitsu: kitsuSwept.slug,
        reenqueued,
      });
      console.log(
        `[sweep] voci scadute rimosse: ${pages.pages} pagine, ${pages.streams} stream, ` +
          `${kitsuSwept.slug} kitsu, ${kitsuSwept.tmdb} tmdb — ${reenqueued} schede ri-accodate`,
      );
    }, config.cacheSweepMs);
    if (sweeper.unref) sweeper.unref();
  }
}

/** Slug unici di tutti e 4 i cataloghi (per la coda di arricchimento). */
function allCatalogSlugs() {
  return [
    ...store.state.schedule.items.map((i) => i.slug),
    ...store.state.latest.items.map((i) => i.slug),
    ...store.state.movies.items.map((i) => i.slug),
    ...store.state.dubbed.items.map((i) => i.slug),
  ];
}

if (require.main === module) {
  const server = app.listen(config.port, () => {
    console.log(`[avvio] in ascolto su http://0.0.0.0:${config.port}`);
    bootstrap();
  });

  const shutdown = (signal) => {
    console.log(`[avvio] ${signal}: chiusura in corso`);
    store.stopScheduler();
    enrich.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
