'use strict';
// Diagnostica: cosa restituisce l'addon Kitsu qui (stesso di Render) e se
// kitso.io espone tmdbId (fonte imdb/tmdb indipendente dalla edge dell'addon).
const kitsu = require('../src/kitsu');
const config = require('../src/config');
const { fetch } = globalThis;

const BASE = config.kitsuBase;

async function debugAddon(id) {
  try {
    const r = await fetch(`${BASE}/meta/anime/${id}.json`, { signal: AbortSignal.timeout(20000) });
    const body = await r.json();
    const m = body && body.meta;
    if (!m) return console.log(`${id}: nessun meta (status ${r.status})`);
    const vids = Array.isArray(m.videos) ? m.videos : [];
    const withThumb = vids.filter((v) => v && typeof v.thumbnail === 'string' && v.thumbnail.startsWith('http'));
    console.log(`${id}: imdb_id=${m.imdb_id || 'MANCANTE'} id=${m.id} videos=${vids.length} conThumb=${withThumb.length}`);
    if (vids[0]) console.log(`   v0.thumbnail=${vids[0].thumbnail || 'nessuna'}`);
  } catch (err) {
    console.log(`${id}: ERR ${err.message}`);
  }
}

async function kitsuIo(id) {
  try {
    const r = await fetch(`https://kitsu.io/api/edge/anime/${id}`, { signal: AbortSignal.timeout(15000) });
    const body = await r.json();
    const a = body && body.data && body.data.attributes;
    if (!a) return console.log(`kitsu.io ${id}: nessun attributes (${r.status})`);
    console.log(
      `kitsu.io anime/${id}: tmdbId=${a.tmdbId || 'nessuno'} imdbId=${a.imdbId || 'nessuno'} slugs=${JSON.stringify(a.slug && a.slug.slice(0, 60))}`,
    );
  } catch (err) {
    console.log(`kitsu.io ${id}: ERR ${err.message}`);
  }
}

(async () => {
  await debugAddon('anilist:121'); // FMA
  await debugAddon('anilist:197754'); // Liar Game
  await kitsuIo(121); // FMA
  await kitsuIo(197754); // Liar Game
})().catch((e) => {
  console.error(e);
  process.exit(1);
});