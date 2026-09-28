'use strict';

const config = require('./config');
const ids = require('./ids');
const { getLatestEpisodes } = require('./aw/home');
const { getSchedule } = require('./aw/schedule');
const { getItalianMovies, getItalianDubbed } = require('./aw/filter');
const { getAnimePage } = require('./aw/play');

const log = (...a) => console.log(...a);

/**
 * Stato dei 4 cataloghi.
 * Ogni refresh salva i dati freschi; se un catalog fallisce si mantiene
 * l'ultimoBuono risultato (stale-while-error) cosi' l'addon resta fruibile.
 */
const state = {
  latest: { items: [], at: 0, error: null },
  schedule: { days: [], today: null, items: [], at: 0, error: null },
  movies: { items: [], at: 0, error: null },
  dubbed: { items: [], at: 0, error: null },
  // epId -> { slug, epNumber, ... } per costruire i meta senza rifare scraping
  episodeIndex: new Map(),
  startedAt: Date.now(),
  refreshCount: 0,
  lastError: null,
  refreshing: false,
};

/** Ordina gli episodi di oggi: prima chi ha un orario, cronologico. */
function sortScheduleItems(items) {
  return [...items].sort((a, b) => {
    if (a.time && !b.time) return -1;
    if (!a.time && b.time) return 1;
    if (a.time && b.time) return a.time.localeCompare(b.time);
    return (b.epNumber || 0) - (a.epNumber || 0);
  });
}

function indexEpisodes(list) {
  for (const item of list) {
    if (item.epNumber) {
      // Chiave sintetica usata dagli id video: awv.<num>.<slug>
      state.episodeIndex.set(ids.videoId(item.epNumber, item.slug), item);
    }
    if (item.epId) {
      // Grep diretto per l'id grezzo del player AnimeWorld.
      state.episodeIndex.set(`raw:${item.epId}`, item);
    }
  }
}

async function refreshLatest() {
  const items = await getLatestEpisodes();
  state.latest = { items, at: Date.now(), error: null };
  indexEpisodes(items);
  log(`[store] "Ultimi Episodi": ${items.length} episodi`);
  return items;
}

async function refreshSchedule(now = new Date()) {
  const data = await getSchedule(now);
  const today = data.days.find((d) => d.date === data.today);

  const timed = sortScheduleItems(today ? today.items : []);
  const loose = sortScheduleItems(data.indeterminate);

  // Di default il calendario contiene SOLO le uscite di oggi con orario.
  // Gli "indeterminate" sono della settimana intera e si aggiungono solo su
  // richiesta esplicita (INCLUDE_INDETERMINATE=true).
  const items = [...timed, ...(config.includeIndeterminate ? loose : [])].map((i) => ({
    ...i,
    date: data.today,
    dateLabel: formatItalianDate(data.today),
    withoutTime: !i.time,
  }));

  state.schedule = {
    weekStart: data.weekStart,
    days: data.days,
    today: data.today,
    todayLabel: today ? today.label : null,
    items,
    timedCount: timed.length,
    at: Date.now(),
    error: null,
  };
  indexEpisodes(items);
  log(
    config.includeIndeterminate
      ? `[store] "Calendario Anime": ${timed.length} con orario + ${loose.length} senza orario ` +
          `per ${data.today} (settimana da ${data.weekStart})`
      : `[store] "Calendario Anime": ${timed.length} uscite di oggi ${data.today} ` +
          `(orari fissi; ${loose.length} indeterminate escluse)`,
  );
  return state.schedule;
}

async function refreshMovies() {
  const items = await getItalianMovies();
  state.movies = { items, at: Date.now(), error: null };
  log(`[store] "Anime Movie Italiani": ${items.length} titoli`);
  return items;
}

async function refreshDubbed() {
  const items = await getItalianDubbed();
  state.dubbed = { items, at: Date.now(), error: null };
  log(`[store] "Anime Doppiati in Italiano": ${items.length} titoli`);
  return items;
}

const REFRESHERS = [
  ['latest', refreshLatest],
  ['schedule', refreshSchedule],
  ['movies', refreshMovies],
  ['dubbed', refreshDubbed],
];

/** Un refresh completo; in parallelo sui cataloghi, errori isolati per catalogo. */
async function refreshAll(now = new Date()) {
  if (state.refreshing) {
    log('[store] refresh gia\' in corso, skip');
    return;
  }
  state.refreshing = true;
  const started = Date.now();
  state.refreshCount += 1;

  const results = await Promise.allSettled(
    REFRESHERS.map(([, fn]) => (fn === refreshSchedule ? fn(now) : fn())),
  );

  let failed = 0;
  results.forEach((res, i) => {
    const key = REFRESHERS[i][0];
    if (res.status === 'fulfilled') return;
    failed += 1;
    const message = res.reason && res.reason.message ? res.reason.message : String(res.reason);
    state[key].error = message;
    state.lastError = message;
    log(`[store] ERRORE catalogo "${key}": ${message}`);
  });

  state.refreshing = false;
  log(
    `[store] refresh #${state.refreshCount} completato in ${Date.now() - started}ms ` +
      `(${failed ? `${failed} cataloghi in errore, dati precedenti mantenuti` : 'tutto ok'})`,
  );
  return state;
}

let timer = null;

function startScheduler() {
  if (timer) return;
  log(`[store] scheduler: aggiornamento automatico ogni ${Math.round(config.refreshMs / 60000)} minuti`);
  timer = setInterval(() => {
    refreshAll().catch((err) => log('[store] refresh fallito:', err.message));
  }, config.refreshMs);
  if (timer.unref) timer.unref();
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

const MESI = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

function formatItalianDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y) return iso;
  return `${d} ${MESI[m - 1]} ${y}`;
}

/** Ritorna i dati di un episodio dal calendario gia' indicizzati. */
function lookupEpisode(epId) {
  return state.episodeIndex.get(epId) || null;
}

module.exports = {
  state,
  refreshAll,
  startScheduler,
  stopScheduler,
  lookupEpisode,
  formatItalianDate,
  getAnimePage,
};
