'use strict';

const config = require('./config');
const ids = require('./ids');
const { getLatestEpisodes } = require('./aw/home');
const { getSchedule, italianDayLabel } = require('./aw/schedule');
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
  schedule: {
    weekStart: null,
    days: [],
    indeterminate: [],
    hero: null,
    at: 0,
    error: null,
  },
  movies: { items: [], at: 0, error: null },
  dubbed: { items: [], at: 0, error: null },
  // epId -> { slug, epNumber, ... } per costruire i meta senza rifare scraping
  episodeIndex: new Map(),
  startedAt: Date.now(),
  refreshCount: 0,
  lastError: null,
  refreshing: false,
};

/** Ordina le uscite: prima quelle con orario, in ordine cronologico. */
function sortScheduleItems(items) {
  return [...items].sort((a, b) => {
    if (a.at && !b.at) return -1;
    if (!a.at && b.at) return 1;
    if (a.at && b.at) return a.at - b.at;
    return (b.epNumber || 0) - (a.epNumber || 0);
  });
}

function indexEpisodes(list) {
  for (const item of list) {
    if (item.epNumber && item.slug) {
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
  state.schedule = {
    weekStart: data.weekStart,
    days: data.days,
    indeterminate: data.indeterminate,
    hero: data.hero,
    at: Date.now(),
    error: null,
  };
  for (const day of data.days) indexEpisodes(day.items);
  indexEpisodes(data.indeterminate);
  const today = scheduleToday(now);
  log(
    `[store] "Calendario Anime": settimana da ${data.weekStart}, ` +
      `${data.days.length} giorni, ${data.indeterminate.length} senza data fissa` +
      (today ? `, oggi ${today.date}: ${today.items.length} uscite` : ''),
  );
  return state.schedule;
}

/**
 * Le uscite di OGGI, calcolate al momento della richiesta confrontando
 * l'ora corrente con l'intervallo reale [start, end) di ogni giorno.
 * In questo modo il catalogo "gira da solo" a mezzanotte senza aspettare
 * il refresh periodico.
 */
function scheduleToday(now = new Date()) {
  const s = state.schedule;
  if (!s || !Array.isArray(s.days) || !s.days.length) return null;
  const t = now.getTime();

  let day = s.days.find((d) => t >= d.start && t < d.end);
  if (!day) day = s.days.find((d) => d.isToday) || null;
  if (!day) return null;

  return {
    ...day,
    label: day.label || italianDayLabel(day.date),
    items: sortScheduleItems(day.items || []),
  };
}

/**
 * Prossima uscita di un anime nella settimana corrente del calendario.
 * Ritorna { at, date, time, epNumber, label } oppure null. Le uscite di oggi
 * restano valide per qualche ora dopo l'orario (cosi' la scheda puo' ancora
 * dire "oggi alle 18:30" mentre l'episodio e' appena uscito).
 */
function nextAir(slug, now = new Date()) {
  const s = state.schedule;
  if (!s || !slug || !Array.isArray(s.days)) return null;
  const t = now.getTime();
  const graceMs = 6 * 60 * 60 * 1000;
  let best = null;

  for (const day of s.days) {
    for (const item of day.items || []) {
      if (item.slug !== slug) continue;
      const at = item.at || day.start;
      if (at + graceMs < t) continue;
      if (best && best.at <= at) continue;
      best = {
        at,
        date: day.date,
        time: item.time || null,
        epNumber: item.epNumber || null,
        label: italianDayLabel(day.date),
        released: Boolean(item.released),
      };
    }
  }
  return best;
}

/** Indice { slug -> prossima uscita } per la settimana corrente. */
function nextAirIndex(now = new Date()) {
  const s = state.schedule;
  const index = new Map();
  if (!s || !Array.isArray(s.days)) return index;
  const slugs = new Set();
  for (const day of s.days) for (const item of day.items || []) slugs.add(item.slug);
  for (const slug of slugs) {
    const air = nextAir(slug, now);
    if (air) index.set(slug, air);
  }
  return index;
}

/** Slug da scaldare (pagine /play) per i due cataloghi episodici. */
function episodicSlugs() {
  const out = new Set();
  const today = scheduleToday();
  for (const item of state.latest.items || []) if (item.slug) out.add(item.slug);
  for (const item of (today && today.items) || []) if (item.slug) out.add(item.slug);
  for (const item of state.schedule.indeterminate || []) if (item.slug) out.add(item.slug);
  if (state.schedule.hero && state.schedule.hero.slug) out.add(state.schedule.hero.slug);
  return [...out];
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
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MESI[m - 1]} ${y}`;
}

/** Ritorna i dati di un episodio dal calendario gia' indicizzati. */
function lookupEpisode(epId) {
  return state.episodeIndex.get(epId) || null;
}

/** Prewarm leggero: porta in cache la pagina /play degli episodi di oggi. */
async function warmSchedulePages(limit = 12) {
  const today = scheduleToday();
  if (!today) return 0;
  let done = 0;
  for (const item of today.items) {
    if (done >= limit) break;
    if (!item.slug) continue;
    try {
      const page = await getAnimePage(item.slug, { priority: false });
      if (page && !page.notFound) done += 1;
    } catch {
      // una pagina non disponibile non deve bloccare il resto
    }
  }
  return done;
}

module.exports = {
  state,
  refreshAll,
  startScheduler,
  stopScheduler,
  lookupEpisode,
  scheduleToday,
  nextAir,
  nextAirIndex,
  episodicSlugs,
  warmSchedulePages,
  formatItalianDate,
  getAnimePage,
};
