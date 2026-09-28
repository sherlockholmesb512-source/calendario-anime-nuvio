'use strict';
// Test TMDB thumbnails: verifica che fetchTmdbThumbs trovi gli still per
// episodio a partire dall'imdb_id (es. FMA tt0421357, Liar Game tt39229633).
const kitsu = require('../src/kitsu');

const IMDB = [
  'tt0421357', // Fullmetal Alchemist
  'tt39229633', // Liar Game
  'tt1475582', // Sherlock (controllo: niente anime)
];

(async () => {
  for (const id of IMDB) {
    try {
      const t0 = Date.now();
      const thumbs = await kitsu.fetchTmdbThumbs(id);
      const keys = Object.keys(thumbs || {}).map(Number);
      const min = keys.length ? Math.min(...keys) : 0;
      const max = keys.length ? Math.max(...keys) : 0;
      const sample = thumbs && thumbs[min];
      let code = 'n/a';
      if (sample) {
        try {
          code = (await fetch(sample, { method: 'HEAD' })).status;
        } catch {
          code = 'ERR';
        }
      }
      console.log(
        `${id}: ${keys.length} still (ep ${min}-${max}) in ${Date.now() - t0}ms | primo=[${sample}] (${code})`,
      );
    } catch (err) {
      console.log(`${id}: ERR ${err.message}`);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});