'use strict';
// Test TMDB per-episodio: still (thumbnail) e trame italiane (overview) per
// stagione, a partire dall'imdb_id (FMA tt0421357, Liar Game tt39229633).
const kitsu = require('../src/kitsu');

const CASES = [
  ['tt0421357', 'Fullmetal Alchemist', 2003],
  ['tt39229633', 'Liar Game', 2007],
];

(async () => {
  let ok = 0;
  for (const [imdb, name, year] of CASES) {
    try {
      const t0 = Date.now();
      const data = await kitsu.fetchTmdbSeason(imdb, name, year);
      const keys = Object.keys((data && data.thumbs) || {}).map(Number);
      const okeys = Object.keys((data && data.overviews) || {}).map(Number);
      const min = keys.length ? Math.min(...keys) : 0;
      const max = keys.length ? Math.max(...keys) : 0;
      const sample = data && data.thumbs && data.thumbs[min];
      let code = 'n/a';
      if (sample) {
        try {
          code = (await fetch(sample, { method: 'HEAD' })).status;
        } catch {
          code = 'ERR';
        }
      }
      const ov = data && data.overviews && data.overviews[min];
      const good = code === 200 && ov;
      if (good) ok++;
      console.log(
        `${good ? 'OK ' : 'NO '} ${imdb} (${name}): ${keys.length} still (ep ${min}-${max}) ${okeys.length} trame in ${Date.now() - t0}ms | ep${min} still [${code}] trama_len=${ov ? ov.length : 0}`,
      );
      if (ov) console.log(`       trama ep${min}: ${ov.slice(0, 110)}...`);
    } catch (err) {
      console.log(`${imdb}: ERR ${err.message}`);
    }
  }
  console.log(`\n${ok}/${CASES.length} OK`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});