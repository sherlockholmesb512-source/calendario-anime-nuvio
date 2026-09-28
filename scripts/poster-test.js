'use strict';
// Diagnostica: verifica che parseAnimePage estragga la copertina vera (og:image
// di AnimeWorld) per un set di pagine /play reali.
const { parseAnimePage } = require('../src/aw/play');

const SLUGS = [
  'snowball-earth-ita.wJNBF',
  'liar-game.MVKsv',
  'fullmetal-alchemist.Ge2kM',
  'mission-yozakura-family-2-ita.MUrbA',
  'star-detective-precure.quYaR',
  'one-piece-subita.qzG-LE',
];

(async () => {
  let ok = 0;
  for (const slug of SLUGS) {
    try {
      const html = await (
        await fetch(`https://www.animeworld.ac/play/${slug}`, {
          headers: { 'user-agent': 'Mozilla/5.0' },
        })
      ).text();
      const parsed = parseAnimePage(html, slug);
      const poster = parsed.poster || '';
      // verifica che l'immagine esista davvero
      let code = 'n/a';
      try {
        const r = await fetch(poster, { method: 'HEAD' });
        code = r.status;
      } catch {
        code = 'ERR';
      }
      const good = code === 200;
      if (good) ok++;
      console.log(`${good ? 'OK ' : 'NO '} ${slug.padEnd(36)} -> ${poster}  [${code}]`);
    } catch (err) {
      console.log(`ERR ${slug}: ${err.message}`);
    }
  }
  console.log(`\n${ok}/${SLUGS.length} copertine valide`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});