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

  // Limite massimo di item serviti in una singola risposta di catalogo.
  // I cataloghi 3 e 4 superano di gran lunga la vecchia pagina da 60 item, e
  // i client che non paginano mai (supportSkip=false) si fermavano a meta'
  // pagina 2. Ora l'intero catalogo arriva nella prima risposta.
  pageSize: 1200,

  // Arricchimento dei metadati dall'addon di terze parti Kitsu
  // (https://anime-kitsu.strem.fun/manifest.json): descrizioni, voto IMDb,
  // generi, art (background/logo), stato. Gli id AnimeWorld (MAL/AniList) fanno
  // da ponte. Se l'addon non risponde si continuano a usare i dati AnimeWorld.
  kitsuBase: process.env.KITSU_BASE || 'https://anime-kitsu.strem.fun',
  kitsuEnabled: process.env.KITSU_ENABLED !== 'false',
  kitsuCacheMs: Number(process.env.KITSU_CACHE_MS || minutes(60 * 24)),
  // L'addon Kitsu puo' essere lento a freddo o indisponibile: 20 s e un retry.
  kitsuTimeoutMs: Number(process.env.KITSU_TIMEOUT_MS || 20000),

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
