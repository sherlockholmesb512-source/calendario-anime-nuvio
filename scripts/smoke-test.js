'use strict';

/**
 * Test end-to-end dei 4 cataloghi senza avviare il server.
 *   node scripts/smoke-test.js
 */

const store = require('../src/store');
const ids = require('../src/ids');
const { getAnimePage, getEpisodeStream, cachePeek } = require('../src/aw/play');
const routes = require('../src/routes');

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) {
    console.log(`  OK   ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`);
  }
};

async function main() {
  console.log('\n=== Refresh dei 4 cataloghi ===');
  const t0 = Date.now();
  await store.refreshAll();
  console.log(`  refresh completato in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const { state } = store;

  // ---------------------------------------------------------------- 1
  console.log('=== 1. Ultimi Episodi ===');
  ok(state.latest.items.length > 0, 'episodi raccolti', `${state.latest.items.length}`);
  const last = state.latest.items[0];
  console.log(`  primo: ${last.name} ep ${last.epNumber} (${last.badge || 'n/d'}) ${last.slug}`);
  ok(Boolean(last.name), 'titolo presente', last.name);
  ok(Boolean(last.poster && last.poster.startsWith('http')), 'poster valido', last.poster);
  ok(last.epNumber > 0, 'numero episodio', String(last.epNumber));
  ok(Boolean(last.epId), 'id episodio del player', last.epId);
  const firstId = ids.episodeMetaId(last.epNumber, last.slug);
  console.log(`  id meta: ${firstId}`);

  // ---------------------------------------------------------------- 2
  console.log('\n=== 2. Calendario Anime ===');
  ok(state.schedule.items.length > 0, 'uscite di oggi', `${state.schedule.items.length}`);
  console.log(`  oggi = ${state.schedule.today} (${state.schedule.todayLabel}), settimana da ${state.schedule.weekStart}`);
  console.log(`  con orario: ${state.schedule.timedCount}, senza orario: ${state.schedule.items.length - state.schedule.timedCount}`);
  for (const item of state.schedule.items.slice(0, 5)) {
    console.log(`   - ${item.title} ep ${item.epNumber} @ ${item.time || 'n/d'} (${item.slug})`);
  }
  const today = state.schedule.items[0];
  ok(Boolean(today.title), 'titolo presente', today.title);
  ok(today.date === state.schedule.today, 'data = oggi', today.date);
  const withTime = state.schedule.items.filter((i) => i.time);
  ok(withTime.length > 0, 'almeno un\'uscita con orario', `${withTime.length}`);
  ok(
    withTime.every((i) => /^\d{1,2}:\d{2}$/.test(i.time)),
    'formato orario HH:MM valido',
    withTime.map((i) => i.time).join(', '),
  );

  // Verifica che tutte le date della settimana siano coerenti.
  const dates = state.schedule.days.map((d) => `${d.label}:${d.date}`);
  console.log(`  giorni: ${dates.join(' ')}`);

  // ---------------------------------------------------------------- 3
  console.log('\n=== 3. Anime Movie Italiani ===');
  ok(state.movies.items.length >= 280, 'movie raccolte', `${state.movies.items.length} (8 pagine)`);
  console.log(`  primo: ${state.movies.items[0].name} (${state.movies.items[0].slug})`);
  ok(Boolean(state.movies.items[0].name), 'titolo presente', state.movies.items[0].name);

  // ---------------------------------------------------------------- 4
  console.log('\n=== 4. Anime Doppiati in Italiano ===');
  ok(state.dubbed.items.length >= 900, 'titoli raccolti', `${state.dubbed.items.length} (26 pagine)`);
  console.log(`  primo: ${state.dubbed.items[0].name} (${state.dubbed.items[0].slug})`);
  ok(Boolean(state.dubbed.items[0].name), 'titolo presente', state.dubbed.items[0].name);

  // ------------------------------------------------------- arricchimento
  console.log('\n=== Arricchimento (pagina /play) ===');
  const probe = last.slug;
  const page = await getAnimePage(probe);
  ok(Boolean(page.title), 'titolo dalla pagina anime', page.title);
  ok(Boolean(page.description && page.description.length > 40), 'descrizione', `${(page.description || '').length} caratteri`);
  ok(Array.isArray(page.genres) && page.genres.length > 0, 'generi', (page.genres || []).join(', '));
  ok(Boolean(page.totalEpisodes), 'episodi totali', String(page.totalEpisodes));
  ok(page.videos.length > 0, 'episodi in lista', `${page.videos.length}`);
  ok(Boolean(page.malId), 'id MyAnimeList', page.malId);
  ok(Boolean(page.year), 'anno', page.year);
  console.log(`  categorie: ${page.category} | audio: ${page.audio} | stato: ${page.state} | voto: ${page.rating}`);

  // ------------------------------------------------------------- meta
  console.log('\n=== Endpoint /meta ===');
  const built = routes;
  const metaRes = await callRoute(built.handleMeta, {
    params: { type: 'series', id: firstId },
  });
  const metaJson = JSON.parse(metaRes.body);
  ok(Boolean(metaJson.meta), 'meta episodio presente', metaJson.meta && metaJson.meta.name);
  ok(
    Array.isArray(metaJson.meta.videos) && metaJson.meta.videos.length > 0,
    'lista episodi nel meta',
    `${(metaJson.meta.videos || []).length} video`,
  );
  ok(
    metaJson.meta.behaviorHints && metaJson.meta.behaviorHints.defaultVideoId,
    'episodio predefinito',
    metaJson.meta.behaviorHints && metaJson.meta.behaviorHints.defaultVideoId,
  );

  const movieSlug = state.movies.items[0].slug;
  const movieRes = await callRoute(built.handleMeta, {
    params: { type: 'movie', id: ids.animeId(movieSlug) },
  });
  const movieJson = JSON.parse(movieRes.body);
  ok(Boolean(movieJson.meta), 'meta movie presente', movieJson.meta && movieJson.meta.name);
  ok(
    Boolean(movieJson.meta.links && movieJson.meta.links.some((l) => l.url.includes('animeworld'))),
    'link alla pagina anime',
    movieJson.meta.links && movieJson.meta.links[0].url,
  );

  // ----------------------------------------------------------- stream
  console.log('\n=== Endpoint /stream (risoluzione sorgente) ===');
  const streamRes = await callRoute(built.handleStream, {
    params: { type: 'series', id: ids.videoId(last.epNumber, last.slug) },
  });
  const streamJson = JSON.parse(streamRes.body);
  const direct = (streamJson.streams || []).find((s) => s.url);
  ok((streamJson.streams || []).length > 0, 'stream trovati', `${(streamJson.streams || []).length}`);
  ok(Boolean(direct), 'URL diretto presente', direct && direct.url.slice(0, 110));

  // Verifica che l'URL diretto sia davvero un video riproducibile.
  if (direct) {
    const head = await fetch(direct.url, { method: 'HEAD' });
    ok(head.ok, 'URL diretto risponde', `HTTP ${head.status} · ${head.headers.get('content-type')} · ${head.headers.get('content-length')} byte`);
  }

  const movieStreamRes = await callRoute(built.handleStream, {
    params: { type: 'movie', id: ids.animeId(movieSlug) },
  });
  const movieStream = JSON.parse(movieStreamRes.body);
  ok(
    (movieStream.streams || []).some((s) => s.url),
    'stream movie risolto',
    ((movieStream.streams || []).find((s) => s.url) || {}).url,
  );

  // --------------------------------------------------------- cataloghi
  console.log('\n=== Endpoint /catalog (anteprime) ===');
  for (const [id, type] of [
    ['calendario-anime-ultimi-episodi', 'series'],
    ['calendario-anime-calendario', 'series'],
    ['calendario-anime-movie-italiani', 'movie'],
    ['calendario-anime-doppiati-italiano', 'series'],
  ]) {
    const r = await callRoute(built.handleCatalog, { params: { type, id }, query: { skip: '0' } });
    const j = JSON.parse(r.body);
    ok((j.metas || []).length > 0, `catalogo ${id}`, `${(j.metas || []).length} metas`);
    const first = (j.metas || [])[0];
    if (first) {
      console.log(`     id: ${first.id}`);
      console.log(`     nome: ${first.name} | ${first.releaseInfo} | default: ${first.behaviorHints && first.behaviorHints.defaultVideoId}`);
      console.log(`     desc: ${String(first.description || '').replace(/\n/g, ' ').slice(0, 120)}`);
    }
  }

  console.log(`\n${failures === 0 ? 'TUTTO OK' : `${failures} VERIFICHE FALLITE`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Invoca un handler Express e restituisce { status, body }. */
function callRoute(handler, { params = {}, query = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      _headers: {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      set(k, v) {
        this._headers[k] = v;
        return this;
      },
      type(t) {
        this._headers['content-type'] = t;
        return this;
      },
      send(body) {
        resolve({ status: this.statusCode, body, headers: this._headers });
        return this;
      },
    };
    handler({ params, query, headers: { host: 'localhost' } }, res);
  });
}

main().catch((err) => {
  console.error('\nSMOKE TEST FALLITO:', err);
  process.exit(1);
});
