'use strict';

const minutes = (n) => n * 60 * 1000;

module.exports = {
  // Nuvio / Railway
  port: Number(process.env.PORT || 7000),

  // Nome del catalogo: "Calendario Anime"
  addonId: 'com.calendarioanime.nuvio',
  addonName: 'Calendario Anime',

  // Origine AnimeWorld
  awBase: 'https://www.animeworld.ac',

  // Fuso orario usato dal calendario di AnimeWorld (orari italiani).
  scheduleTz: 'Europe/Rome',

  // Aggiornamento automatico dei cataloghi: ogni 5 minuti.
  refreshMs: Number(process.env.REFRESH_MS || minutes(5)),

  // Cache delle pagine anime (meta + lista episodi): 6 ore.
  animePageCacheMs: minutes(60 * 6),

  // Cache del token CSRF di AnimeWorld: 30 minuti.
  csrfCacheMs: minutes(30),

  // Cache degli stream gia' risolti: 20 minuti.
  streamCacheMs: minutes(20),

  // Limiti di scraping
  httpTimeoutMs: Number(process.env.HTTP_TIMEOUT_MS || 20000),
  httpRetries: 3,
  maxConcurrent: 4,
  minRequestGapMs: Number(process.env.MIN_REQUEST_GAP_MS || 120),

  // Pagine del filtro da scrapare per catalogo.
  movieFilterPages: 8,
  dubFilterPages: 26,

  // Quanti episodi "ultimi" tenere dal widget homepage.
  maxLatestEpisodes: 180,

  // Nel calendario mostriamo SOLO gli episodi in uscita oggi con orario certo.
  // AnimeWorld tiene in una sezione a parte ("uscite indeterminate") gli episodi
  // della settimana ancora senza giorno/orario: non sono uscite di oggi, quindi
  // stanno esclusi. Mettendo true verrebbero aggiunti in coda a quelli di oggi.
  includeIndeterminate: process.env.INCLUDE_INDETERMINATE === 'true',

  // Limite massimo di item serviti in una singola risposta di catalogo: vale sia
  // come default (client che non chiedono nulla) sia come tetto (client che
  // chiedono un limit piu' alto).
  // I cataloghi 3 e 4 superano di gran lunga la vecchia pagina da 60 item, e
  // i client che non paginano mai (supportSkip=false) si fermavano a meta'
  // pagina 2: cosi' l'intero catalogo arriva nella prima risposta.
  // 1800 e' scelto per lasciare margine al catalogo doppiati (~1000 oggi):
  // su Render free il costo e' trascurabile (la risposta e' compressa in
  // Brotli, ~30 KB per il catalogo intero) e il tempo di risposta non dipende
  // dal numero di item. Oltre ~2000 il limite diventa il client, che ridisegna
  // tutta la lista a ogni apertura (le risposte sono no-store).
  pageSize: 1800,

  // Arricchimento dei metadati dall'addon di terze parti Kitsu
  // (https://anime-kitsu.strem.fun/manifest.json): descrizioni, voto IMDb,
  // generi, art (background/logo), stato. Gli id AnimeWorld (MAL/AniList) fanno
  // da ponte. Se l'addon non risponde si continuano a usare i dati AnimeWorld.
  kitsuBase: process.env.KITSU_BASE || 'https://anime-kitsu.strem.fun',
  kitsuEnabled: process.env.KITSU_ENABLED !== 'false',
  kitsuCacheMs: Number(process.env.KITSU_CACHE_MS || minutes(60 * 24)),
  // L'addon Kitsu puo' essere lento a freddo o indisponibile: 20 s e un retry.
  kitsuTimeoutMs: Number(process.env.KITSU_TIMEOUT_MS || 20000),
  // API pubblica kitso.io: fallback per le miniature degli episodi quando l'addon
  // non le fornisce. 0/'' per disattivare il fallback.
  kitsuApiBase: process.env.KITSU_API_BASE || 'https://kitsu.io/api/edge',

  // TMDB API: fonte secondaria per le miniature degli episodi (still per
  // episodio) e per le trame in italiano quando AIOMetadata non risponde.
  tmdbApiKey: process.env.TMDB_API_KEY || '04fb466f7dc90ca105e00debcaa7cf8a',

  // TheTVDB v4 (chiave dell'utente): serve da riserva per la struttura delle
  // stagioni quando AIOMetadata e TMDB non danno risultati.
  tvdbApiKey: process.env.TVDB_API_KEY || '99d46f0a-5db5-4191-8f0d-876e8c0625d6',

  // AnimeSkip (guide/trascrizioni episodi) e MDBList: conservati per uso futuro,
  // l'addon non li interroga ancora attivamente.
  animeskipKey: process.env.ANIMESKIP_KEY || 'Md2KLZeMTCzCb4QM7B735Q1Zt48l9tPj',
  mdblistKey: process.env.MDBLIST_KEY || 'ct7r2fww0x0s95oyaz7dc8apj',

  // -------------------------------------------------------------------------
  // Stagioni multiple + dettagli episodio
  // -------------------------------------------------------------------------

  // AIOMetadata (addon di terze parti basato su TVDB/TMDB/MAL): e' la fonte
  // migliore per gli anime perche' conosce le STAGIONI REALI (su TMDB molte
  // stagioni anime sono fuse in una sola) e offre titolo, trama italiana,
  // miniature e data di uscita di ogni singolo episodio.
  aiomBase:
    process.env.AIO_BASE === undefined
      ? 'https://aiometadata.fortheweak.cloud/stremio/b297adf1-6269-4ac4-9b59-813deef624bd'
      : (process.env.AIO_BASE || ''),
  aiomEnabled: process.env.AIO_ENABLED !== 'false',
  aiomTimeoutMs: Number(process.env.AIO_TIMEOUT_MS || 15000),
  aiomCacheMs: minutes(24),

  // Raggruppamento delle stagioni AnimeWorld: quando una serie ha piu' pagine
  // (sequel/prequel) la scheda le unisce tutte in un solo elenco episodi.
  seasonsEnabled: process.env.SEASONS_ENABLED !== 'false',
  // Quante pagine di stagioni affini scaricare per serie (le pagine restano in
  // cache 6 ore, quindi e' un costo una tantum per stagione).
  maxSeasonPages: Number(process.env.MAX_SEASON_PAGES || 5),
  // Quanto a lungo resta valida la risoluzione del gruppo di stagioni.
  bundleCacheMs: Number(process.env.BUNDLE_CACHE_MS || minutes(12)),

  // Fonti stream AGGIUNTIVE da EasyStreams (addon solo-stream italiano di
  // terze parti). ATTUALMENTE NON USATE: /stream restituisce SOLO lo streaming
  // diretto di AnimeWorld (l'utente vuole il solo primo flusso). Il codice di
  // integrazione resta qui per una eventuale riattivazione; il suffisso
  // "id:stagione:episodio" segue il protocollo Stremio.
  easyStreamsUrl:
    process.env.EASYSTREAMS_URL === undefined
      ? 'https://easystreams.realbestia.com/nuvio'
      : (process.env.EASYSTREAMS_URL || ''),
  // EasyStreams e' lento e variabile (1-30 s, code lato provider): risposta
  // limitata a questo budget, poi si replica con il solo stream AnimeWorld.
  // Dopo un insuccesso non si rigira a ogni click (cache negativa breve).
  easyStreamsTimeoutMs: Number(process.env.EASYSTREAMS_TIMEOUT_MS || 15000),
  easyStreamsTtlMs: Number(process.env.EASYSTREAMS_CACHE_MS || minutes(10)),
  easyStreamsNegTtlMs: Number(process.env.EASYSTREAMS_NEG_CACHE_MS || minutes(2)),

  // Nella richiesta /meta il budget massimo per l'arricchimento Kitsu on-demand:
  // oltre questo tempo la scheda risponde subito con i soli dati AnimeWorld
  // (la trama deve essere leggibile da subito) e l'arricchimento prosegue in
  // background con la coda. 0 per tornare al comportamento bloccante pieno.
  metaEnrichTimeoutMs: Number(process.env.META_ENRICH_TIMEOUT_MS || 5000),

  // -------------------------------------------------------------------------
  // Trailer (meta.trailers)
  // -------------------------------------------------------------------------
  // L'addon aggiunge un pulsante "Trailer" alla scheda. Per avere i trailer
  // SOTTOTITOLATI IN ITALIANO la fonte migliore sono i canali italiani che li
  // pubblicano (Crunchyroll Italia, Yamato Video, Dynit, ...): si cercano su
  // YouTube con una query "<titolo> trailer italiano" e si scelgono i risultati
  // dei canali/keyword affidabili. Come riserva si usa il trailer che AnimeWorld
  // incorpora nella pagina (di norma il PV giapponese). TRAILERS_ENABLED=false
  // per non mostrare alcun trailer.
  trailersEnabled: process.env.TRAILERS_ENABLED !== 'false',
  // Quanti trailer mostrare al massimo nella scheda.
  trailersMax: Number(process.env.TRAILERS_MAX || 3),
  // Cache dei trailer trovati per titolo (le ricerche YouTube sono lente).
  trailersCacheMs: Number(process.env.TRAILERS_CACHE_MS || minutes(60 * 24)),
  trailersTimeoutMs: Number(process.env.TRAILERS_TIMEOUT_MS || 5000),

  // Cast (attori e doppiatori) da AniList GraphQL (dati pubblici, nessuna chiave).
  // Preferiti i doppiatori italiani; senza, i seiyuu giapponesi; senza, i nomi
  // dei personaggi principali. CAST_ENABLED=false per disattivarlo.
  castEnabled: process.env.CAST_ENABLED !== 'false',

  // Svuota-cache automatico: ogni 30 minuti vengono eliminate le cache locali
  // (pagine /play, stream risolti, metadati Kitsu) per liberare spazio ed
  // evitare dati stantii. 0 per disattivarlo.
  cacheSweepMs: Number(process.env.CACHE_SWEEP_MS || minutes(30)),

  logLevel: process.env.LOG_LEVEL || 'info',
};
