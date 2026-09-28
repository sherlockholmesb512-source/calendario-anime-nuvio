'use strict';

/**
 * Simula il flusso completo di un client Nuvio/Stremio via HTTP reale.
 *   node scripts/http-test.js [http://127.0.0.1:7311]
 */

const BASE = process.argv[2] || 'http://127.0.0.1:7311';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  OK   ${label}${extra ? ` — ${extra}` : ''}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`);
  }
};

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': 'NuvioAddonSDK/1.0' } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, headers: res.headers, text, json };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Il server scrapa AnimeWorld al boot (26 pagine per il catalogo "Doppiati"):
 * aspettiamo che il primo refresh sia finito, altrimenti i test leggono cataloghi vuoti.
 */
async function waitForFirstRefresh(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write('  ... attesa del primo refresh');
  for (;;) {
    try {
      const h = await get('/health');
      const c = h.json && h.json.catalogs;
      const ready =
        h.json &&
        h.json.ok &&
        !h.json.refreshing &&
        c &&
        c.latest.count > 0 &&
        c.schedule.count >= 0 &&
        c.movies.count > 0 &&
        c.dubbed.count > 0;
      if (ready) {
        console.log(`\n     pronto: ${c.latest.count} episodi, ${c.schedule.count} uscite, ${c.movies.count} movie, ${c.dubbed.count} doppiati`);
        return c;
      }
    } catch {
      /* server non ancora in ascolto */
    }
    if (Date.now() > deadline) throw new Error('primo refresh non completato entro il timeout');
    process.stdout.write('.');
    await sleep(2000);
  }
}

async function main() {
  console.log(`\n### Flusso addon Nuvio verso ${BASE}\n`);

  // 0. Il server deve aver completato lo scraping iniziale.
  console.log('0) Attesa del primo refresh');
  await waitForFirstRefresh();

  // 1. Manifesto
  console.log('1) GET /manifest.json');
  const man = await get('/manifest.json');
  ok(man.status === 200, 'status 200', String(man.status));
  const m = man.json;
  ok(m && m.id && m.version && m.name, 'campi obbligatori presenti', m && `${m.id} ${m.version}`);
  ok(Array.isArray(m.catalogs) && m.catalogs.length === 4, '4 cataloghi', `${(m.catalogs || []).length}`);
  ok(
    (m.resources || []).includes('catalog') &&
      (m.resources || []).includes('meta') &&
      (m.resources || []).includes('stream'),
    'risorse catalog/meta/stream',
    (m.resources || []).join(','),
  );
  const names = (m.catalogs || []).map((c) => c.name);
  ok(
    names.join('|') === 'Ultimi Episodi|Calendario Anime|Anime Movie Italiani|Anime Doppiati in Italiano',
    'nomi cataloghi nell\'ordine richiesto',
    names.join(' | '),
  );
  ok(
    (m.catalogs || []).every((c) => c.extra && c.extra.some((e) => e.name === 'skip')),
    'ogni catalogo supporta skip (paginazione)',
  );

  // Nuvio raggruppa i cataloghi nel tipo media dichiarato: deve essere "anime"
  // per comparire nella sezione Anime di Cerca/Scopri.
  ok(
    (m.catalogs || []).every((c) => c.type === 'anime'),
    'cataloghi dichiarati di tipo "anime" (sezione Anime)',
    (m.catalogs || []).map((c) => c.type).join(','),
  );
  ok(
    /sole uscite di\s+oggi/.test(m.description || ''),
    'descrizione del manifesto coerente con il catalogo giornaliero',
    (m.description || '').slice(0, 80),
  );
  ok((m.types || []).includes('anime'), '"anime" elencato fra i types del manifesto', (m.types || []).join(','));

  // Logo e sfondo raggiungibili
  for (const asset of ['logo.png', 'background.png']) {
    const r = await fetch(`${BASE}/${asset}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    ok(r.ok && isPng && buf.length > 1000, `asset ${asset}`, `HTTP ${r.status} · ${buf.length} byte · PNG ${isPng}`);
  }

  // 2. Cataloghi
  console.log('\n2) GET /catalog/{type}/{id}.json');
  const catalogInfo = [];
  for (const cat of m.catalogs) {
    const r = await get(`/catalog/${cat.type}/${cat.id}.json?skip=0`);
    ok(r.status === 200, `catalogo "${cat.name}" status 200`, String(r.status));
    const metas = (r.json && r.json.metas) || [];
    ok(metas.length > 0, `catalogo "${cat.name}" ha elementi`, `${metas.length} elementi`);
    const total = Number(r.headers.get('x-catalog-items-total'));
    // L'intero catalogo deve arrivare gia' nella prima risposta: e' questo che
    // garantisce che i client senza paginazione (supportsSkip=false) vedano
    // tutto, fino a page=8 nei film e alle 26 pagine nei doppiati.
    ok(
      metas.length === total,
      `catalogo "${cat.name}" servito per intero nella prima risposta`,
      `${metas.length}/${total}`,
    );
    const ids = new Set(metas.map((x) => x.id));
    ok(ids.size === metas.length, `catalogo "${cat.name}" id univoci`, `${ids.size}/${metas.length}`);
    ok(
      metas.every((x) => x.id && x.type && x.name && x.poster),
      `catalogo "${cat.name}" campi completi`,
    );
    // Il catalogo e' di tipo "anime", ma i singoli elementi devono restare
    // "series"/"movie": e' il tipo dell'elemento che abilita in Nuvio
    // episodi, "Continua a guardare" e il pannello episodi.
    ok(
      metas.every((x) => x.type === 'series' || x.type === 'movie'),
      `catalogo "${cat.name}" elementi di tipo series/movie`,
      [...new Set(metas.map((x) => x.type))].join(','),
    );

    // "Calendario Anime" = solo uscite DI OGGI con orario certo: ogni elemento
    // deve mostrare nel card "Ep N[/M] · Oggi HH:MM" (es. "Ep 26/26 · Oggi 18:30").
    if (cat.id === 'calendario-anime-calendario') {
      const noTime = metas.filter((x) => !/^Ep \d+(\/\d+)? · Oggi \d{1,2}:\d{2}$/.test(x.releaseInfo || ''));
      ok(
        metas.length > 0 && noTime.length === 0,
        'calendario: episodio (e totale) + orario di oggi su ogni card',
        `${metas.length} uscite, ${noTime.length} fuori formato` +
          (noTime.length ? ` (${noTime.slice(0, 3).map((x) => x.releaseInfo).join(' | ')})` : ''),
      );
      ok(
        metas.every((x) => /^Ep \d+/.test(x.releaseInfo || '') && /Episodio \d+/.test(x.description || '')),
        'calendario: numero episodio nel card e nella descrizione',
        (metas[0] && (metas[0].description || '').split('\n')[1]) || '',
      );
    }
    const refreshed = r.headers.get('x-catalog-refreshed-at');
    ok(Boolean(total && refreshed), `catalogo "${cat.name}" header di freschezza`, `${total} elementi, aggiornato ${refreshed}`);
    if (metas[0]) console.log(`     esempio: ${metas[0].id} | ${metas[0].name} | ${metas[0].releaseInfo}`);
    catalogInfo.push({ cat, metas, total: Number(total) });

    // Paginazione: nel protocollo Stremio "skip" e' un offset ASSOLUTO, quindi
    // Il catalogo e' servito per intero nella prima risposta; skip resta un
    // offset ASSOLUTO: una richiesta a skip=X deve restituire il sottoinsieme
    // che parte da X (tutti gia' presenti nella prima risposta), e la richiesta
    // oltre la fine deve restituire zero elementi. Questa e' la semantica che
    // i client Nuvio (rawItemCount->nextSkip) usano per fermarsi alla fine.
    const PAGE = 60;
    if (total > PAGE) {
      const p2 = await get(`/catalog/${cat.type}/${cat.id}.json?skip=${PAGE}`);
      const m2 = (p2.json && p2.json.metas) || [];
      const known = new Set(metas.map((x) => x.id));
      const unknown = m2.filter((x) => !known.has(x.id));
      ok(
        unknown.length === 0 && m2.length === total - PAGE,
        `paginazione "${cat.name}" skip=${PAGE} = offset assoluto`,
        `${m2.length} elementi, ${unknown.length} non noti dalla prima pagina`,
      );
      ok(m2[0] && m2[0].id === metas[PAGE].id, `paginazione "${cat.name}" riprende da dove finito`, m2[0] && m2[0].id);

      // Oltre la fine: lista vuota (il client Nuvio a questo punto si ferma).
      const past = await get(`/catalog/${cat.type}/${cat.id}.json?skip=${total}`);
      const mpast = (past.json && past.json.metas) || [];
      ok(mpast.length === 0, `paginazione "${cat.name}" skip>=totale -> 0 elementi`, `${mpast.length} elementi`);
    }

    // I vecchi percorsi series/movie devono continuare a funzionare per i
    // client che hanno gia' salvato l'addon.
    const legacy = cat.id === 'calendario-anime-movie-italiani' ? 'movie' : 'series';
    const lr = await get(`/catalog/${legacy}/${cat.id}.json?skip=0`);
    const lmetas = (lr.json && lr.json.metas) || [];
    ok(
      lr.status === 200 && lmetas.length === metas.length && lmetas[0] && lmetas[0].id === metas[0].id,
      `percorso legacy /catalog/${legacy}/... per "${cat.name}"`,
      `HTTP ${lr.status}, ${lmetas.length} elementi`,
    );
  }

  // 3. Meta
  console.log('\n3) GET /meta/{type}/{id}.json');
  // Episodio dal catalogo "Calendario Anime"
  const sched = catalogInfo.find((c) => c.cat.id === 'calendario-anime-calendario');
  const schedEp = sched.metas.find((x) => (x.behaviorHints || {}).defaultVideoId);
  ok(Boolean(schedEp), 'calendario: elemento con episodio predefinito', schedEp && schedEp.id);
  if (!schedEp) {
    console.log(`\n${failures} VERIFICHE FALLITE — meta non testabile\n`);
    process.exit(1);
  }
  const schedMeta = await get(`/meta/series/${schedEp.id}.json`);
  ok(schedMeta.status === 200, 'meta episodio status 200', String(schedMeta.status));
  // SINTONO con il tipo "anime" del catalogo
  const schedMetaAnime = await get(`/meta/anime/${schedEp.id}.json`);
  ok(
    schedMetaAnime.status === 200 && schedMetaAnime.json.meta && schedMetaAnime.json.meta.id === schedMeta.json.meta.id,
    'meta episodio anche via /meta/anime/...',
    `HTTP ${schedMetaAnime.status}`,
  );
  const sm = schedMeta.json && schedMeta.json.meta;
  ok(sm && sm.name, 'meta episodio', sm && sm.name);
  ok(Array.isArray(sm.videos) && sm.videos.length > 0, 'meta con lista episodi', `${(sm.videos || []).length} video`);
  ok(
    (sm.videos || []).some((v) => v.id === sm.behaviorHints.defaultVideoId),
    'defaultVideoId presente fra i video',
    sm.behaviorHints.defaultVideoId,
  );
  console.log(`     ${sm.name}: ${(sm.videos || []).length} episodi, default = ${sm.behaviorHints.defaultVideoId}`);

  // Movie
  const movies = catalogInfo.find((c) => c.cat.id === 'calendario-anime-movie-italiani');
  const movieMeta = await get(`/meta/movie/${movies.metas[0].id}.json`);
  const mm = movieMeta.json && movieMeta.json.meta;
  ok(mm && mm.name, 'meta movie', mm && mm.name);
  ok(mm && mm.links && mm.links.some((l) => l.url.includes('animeworld.ac')), 'meta movie con link esterno');
  console.log(`     ${mm.name} (${mm.releaseInfo}) — ${String(mm.description || '').split('\n')[0].slice(0, 80)}`);

  // 4. Stream
  console.log('\n4) GET /stream/{type}/{id}.json');
  const videoId = sm.behaviorHints.defaultVideoId;
  const st = await get(`/stream/series/${videoId}.json`);
  ok(st.status === 200, 'stream episodio status 200', String(st.status));
  const streams = (st.json && st.json.streams) || [];
  ok(streams.length > 0, 'stream trovati', `${streams.length}`);
  const direct = streams.find((s) => s.url && /\.(mp4|m3u8|mkv|webm)/i.test(s.url));
  ok(Boolean(direct), 'stream diretto presente', direct && direct.url.slice(0, 100));
  // Come richiesto: un unico stream, quello diretto di AnimeWorld (niente
  // embed, niente externalUrl, niente "apri sul sito").
  ok(
    streams.length === 1 &&
      streams[0].url &&
      direct &&
      !streams.some((s) => s.externalUrl) &&
      (streams[0].name || '').toLowerCase().includes('animeworld'),
    'solo lo streaming diretto di AnimeWorld',
    streams.map((s) => `${s.name || ''}${s.url ? ' (url)' : ''}${s.externalUrl ? ' (external)' : ''}`).join(' | '),
  );
  ok(
    streams.every((s) => s.name && (s.url || s.externalUrl)),
    'ogni stream ha name e url/externalUrl',
  );
  ok(
    streams.some((s) => (s.behaviorHints || {}).bingeGroup),
    'bingeGroup presente per raggruppare gli episodi',
    (streams.find((s) => s.behaviorHints) || {}).behaviorHints.bingeGroup,
  );

  if (direct) {
    const head = await fetch(direct.url, { method: 'HEAD' });
    ok(head.ok, 'URL diretto riproducibile', `HTTP ${head.status} · ${head.headers.get('content-type')}`);
    ok(
      (head.headers.get('accept-ranges') || '').includes('bytes'),
      'supporto Range (seek)',
      head.headers.get('accept-ranges') || 'assente',
    );
  }

  // Stream del movie
  const mst = await get(`/stream/movie/${movies.metas[0].id}.json`);
  const mstreams = (mst.json && mst.json.streams) || [];
  ok(
    mstreams.some((s) => s.url) && mstreams.every((s) => s.url && !s.externalUrl && !s.embed),
    'stream movie: solo diretto AnimeWorld',
    (mstreams.find((s) => s.url) || {}).url,
  );

  // 5. Errori gestiti
  console.log('\n5) Gestione errori');
  const bad1 = await get('/catalog/series/non-esiste.json');
  ok(bad1.status === 404, 'catalogo inesistente -> 404', String(bad1.status));
  const badType = await get('/catalog/anime/calendario-anime-non-esiste.json');
  ok(badType.status === 404, 'catalogo inesistente su /anime/ -> 404', String(badType.status));
  const badCombo = await get('/catalog/movie/calendario-anime-calendario.json');
  ok(badCombo.status === 404, 'tipo incompatibile -> 404', String(badCombo.status));
  const bad2 = await get('/meta/series/xxx.json');
  ok(bad2.status === 404, 'id non valido -> 404', String(bad2.status));
  const bad3 = await get('/stream/series/awv.9999.inesistente.XXXXX.json');
  ok(bad3.status === 200 && Array.isArray(bad3.json.streams), 'stream irrisolvibile -> lista vuota, non crash', JSON.stringify(bad3.json));
  const health = await get('/health');
  ok(health.status === 200 && health.json.ok, '/health ok', `refresh #${health.json.refreshCount}`);

  // 6. Cache disabilitata sui cataloghi
  const cc = (await get('/catalog/series/calendario-anime-calendario.json')).headers.get('cache-control');
  ok(String(cc).includes('no-store'), 'cataloghi serviti senza cache intermediata', cc);

  console.log(`\n${failures === 0 ? 'TUTTO OK — addon pronto' : `${failures} VERIFICHE FALLITE`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST FALLITO:', e);
  process.exit(1);
});
