'use strict';
// Test TMDB per-episodio: still (thumbnail) e trame italiane (overview) per
// stagione, a partire dall'imdb_id o dal titolo (suffissi AW puliti) + stagione.
const kitsu = require('../src/kitsu');
const { seasonOf } = require('../src/ids');

const CASES = [
  ['tt0421357', 'Fullmetal Alchemist', 2003, 1],
  ['tt39229633', 'Liar Game', 2007, 1],
  [null, 'Mission Yozakura Family', 2024, 2],
];

(async () => {
  let ok = 0;
  for (const [imdb, name, year, season] of CASES) {
    try {
      const t0 = Date.now();
      const data = await kitsu.fetchTmdbSeason(imdb, name, year, season);
      const keys = Object.keys((data && data.thumbs) || {}).map(Number);
      const okeys = Object.keys((data && data.overviews) || {}).map(Number);
      const min = keys.length ? Math.min(...keys) : 0;
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
        `${good ? 'OK ' : 'NO '} ${imdb || 'titolo'} S${season} (${name}): ${keys.length} still ${okeys.length} trame in ${Date.now() - t0}ms | ep${min} [${code}] trama_len=${ov ? ov.length : 0}`,
      );
      if (ov) console.log(`       trama S${season} ep${min}: ${ov.slice(0, 105)}...`);
    } catch (err) {
      console.log(`${imdb || name} S${season}: ERR ${err.message}`);
    }
  }

  const slugs = [
    ['fullmetal-alchemist.Ge2kM', 1],
    ['one-piece-subita.qzG-LE', 1],
    ['kaiju-no-8-narumis-week-at-work-ita.wcf3m', 1],
    ['mission-yozakura-family-2-ita.MUrbA', 2],
    ['mushoku-tensei-jobless-reincarnation-3-ita.IzjzH', 3],
    ['rezero-kara-hajimeru-isekai-seikatsu-4-ita.27i3b', 4],
  ];
  let sok = 0;
  for (const [slug, want] of slugs) {
    const got = seasonOf(slug);
    const g = got === want;
    if (g) sok++;
    console.log(`${g ? 'OK ' : 'NO '} seasonOf(${slug}) = ${got} (atteso ${want})`);
  }
  console.log(`\n${ok}/${CASES.length} TMDB OK | ${sok}/${slugs.length} seasonOf OK`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});