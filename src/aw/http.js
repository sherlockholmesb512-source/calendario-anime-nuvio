'use strict';

const config = require('../config');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let lastRequestAt = 0;
let queueTail = Promise.resolve();

const log = (...args) => {
  if (config.logLevel !== 'silent') console.log(...args);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeBody(buffer, contentType) {
  const bytes = new Uint8Array(buffer);
  let charset = 'windows-1252';
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (m) charset = m[1].toLowerCase();
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/**
 * Accoda una richiesta: AnimeWorld non ama la concorrenza, quindi
 * limitiamo il parallelismo e mettiamo un piccolo gap fra le richieste.
 */
function schedule(task) {
  const run = queueTail.then(async () => {
    const wait = config.minRequestGapMs - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return task();
  });
  // La catena non deve rompersi se una richiesta fallisce.
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Corsia prioritaria per le richieste legate a un clic dell'utente (meta,
// stream): NON si accodano dietro ai fetch di sfondo della coda enrich (che
// occupano la coda seriale a batch di 6 slug con retry e backoff). Concorrenza
// limitata e piccola per non infastidire AnimeWorld.
let fastActive = 0;
const FAST_MAX = 2;
async function schedulePriority(task) {
  while (fastActive >= FAST_MAX) await sleep(30);
  fastActive += 1;
  try {
    return await task();
  } finally {
    fastActive -= 1;
  }
}

async function rawRequest(url, { headers = {}, method = 'GET' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.httpTimeoutMs);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
        ...headers,
      },
    });
    const buf = await res.arrayBuffer();
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      body: decodeBody(buf, res.headers.get('content-type')),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** GET HTML con retry e backoff esponenziale. priority = corsia utente. */
async function getHtml(url, { retries = config.httpRetries, headers, priority = false } = {}) {
  const go = priority ? schedulePriority : schedule;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await go(() => rawRequest(url, { headers }));
      if (res.status >= 500) throw new Error(`HTTP ${res.status} su ${url}`);
      if (res.status === 404) return { ...res, notFound: true };
      if (res.status >= 400) throw new Error(`HTTP ${res.status} su ${url}`);
      if (/Pagina non trovata/i.test(res.body.slice(0, 4000))) {
        return { ...res, notFound: true };
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        const backoff = 400 * 2 ** attempt;
        log(`[aw] retry ${attempt + 1}/${retries} per ${url} (${err.message})`);
        await sleep(backoff);
      }
    }
  }
  throw lastError;
}

/** GET JSON con retry. priority = corsia utente. */
async function getJson(url, { retries = config.httpRetries, headers, priority = false } = {}) {
  const go = priority ? schedulePriority : schedule;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await go(() => rawRequest(url, { headers }));
      if (res.status >= 400) throw new Error(`HTTP ${res.status} su ${url}`);
      return JSON.parse(res.body);
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(400 * 2 ** attempt);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Token CSRF: richiesto da /api/episode/info. Si prende da una pagina leggera.
// ---------------------------------------------------------------------------

const CSRF_PROBE = `${config.awBase}/calendario-anime-nuvio-probe-404`;
let csrfCache = { token: null, at: 0 };

async function getCsrfToken() {
  if (csrfCache.token && Date.now() - csrfCache.at < config.csrfCacheMs) {
    return csrfCache.token;
  }
  const res = await getHtml(CSRF_PROBE, { retries: 2, priority: true });
  const m = /name="csrf-token"[^>]*content="([^"]+)"/i.exec(res.body);
  if (!m) throw new Error('Token CSRF non trovato su AnimeWorld');
  csrfCache = { token: m[1], at: Date.now() };
  return csrfCache.token;
}

function invalidateCsrf() {
  csrfCache = { token: null, at: 0 };
}

const jsonHeaders = (token, referer) => ({
  Referer: referer || `${config.awBase}/`,
  'X-Requested-With': 'XMLHttpRequest',
  'CSRF-Token': token,
  Accept: 'application/json, text/javascript, */*; q=0.01',
});

module.exports = { getHtml, getJson, getCsrfToken, invalidateCsrf, jsonHeaders, log };
