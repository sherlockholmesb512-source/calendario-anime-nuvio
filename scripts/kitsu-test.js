'use strict';

/* Test diretto del modulo src/kitsu.js (richiede connessione a Internet:
 * colpisce sia l'addon Kitsu sia la rete). Eseguito con: npm run test:kitsu */

process.env.KITSU_ENABLED = process.env.KITSU_ENABLED || 'true';
process.env.KITSU_TIMEOUT_MS = process.env.KITSU_TIMEOUT_MS || '25000';

const kitsu = require('../src/kitsu');

let failures = 0;
const ok = (cond, label, extra) => {
  const txt = `  ${cond ? 'OK  ' : 'FAIL'} ${label}${cond ? '' : ` — ${extra ?? ''}`}`;
  console.log(txt);
  if (!cond) failures += 1;
};

async function main() {
  console.log('### Test arricchimento Kitsu\n');

  // 1) Normalizzazione del titolo (suffissi/caratteri tipici AnimeWorld).
  ok(kitsu.normalizeTitle('Yu-Gi-Oh! - The Dark Side of Dimensions (ITA)') === 'yu gi oh the dark side of dimensions',
     'normalizeTitle pulisce suffissi e punteggiatura',
     kitsu.normalizeTitle('Yu-Gi-Oh! - The Dark Side of Dimensions (ITA)'));
  ok(kitsu.normalizeTitle('MaR - Märchen Awakens Romance (ITA)') === 'mar marchen awakens romance',
     'normalizeTitle rimuove gli accenti',
     kitsu.normalizeTitle('MaR - Märchen Awakens Romance (ITA)'));

  // 2) Match diretto tramite AniList (strada principale e veloce).
  const page1 = { title: 'One Piece', category: 'Serie TV', year: 1999, malId: '21', anilistId: '21' };
  const info1 = await kitsu.enrichFor('kitsu-test-one-piece', page1);
  ok(Boolean(info1), 'One Piece: match via anilist:21', info1 && info1.kitsuId);
  if (info1) {
    ok((info1.name || '').toLowerCase() === 'one piece', 'One Piece: nome', info1.name);
    ok(info1.year === 1999, 'One Piece: anno', String(info1.year));
    ok(Boolean(info1.description), 'One Piece: descrizione presente', (info1.description || '').slice(0, 60));
    ok(Array.isArray(info1.genres) && info1.genres.length > 0, 'One Piece: generi', (info1.genres || []).join(', '));
    ok(typeof info1.rating === 'number' && info1.rating >= 5 && info1.rating <= 10, 'One Piece: voto IMDb', String(info1.rating));
    ok(
      info1.episodeThumbs && /^https?:\/\//.test(info1.episodeThumbs[1] || ''),
      'One Piece: miniatura del primo episodio (non la copertina)',
      (info1.episodeThumbs || {})[1] || 'assente',
    );
  }

  // 3) Via MAL (piu' lenta a freddo, usata quando manca AniList).
  const page2 = { title: 'One Piece', category: 'Serie TV', year: 1999, malId: '21', anilistId: null };
  const info2 = await kitsu.enrichFor('kitsu-test-one-piece-mal', page2);
  ok(Boolean(info2) && info2.kitsuId === info1.kitsuId, 'One Piece: match via mal:21 (stesso id canonico)', info2 && info2.kitsuId);

  // 4) Cache per slug: la seconda lettura non rifà richieste.
  kitsu.peek('kitsu-test-one-piece');
  ok(true, 'peek non lancia');

  // 5) Anti-omonimi: "Liar Game" del 2007 (anime "classico") NON deve finire sul
  //    remake 2026 di Kitsu: o torna null (nessuna certezza) o un anno compatibile.
  const page3 = { title: 'Liar Game', category: 'Serie TV', year: 2007, malId: null, anilistId: null };
  const info3 = await kitsu.enrichFor('kitsu-test-liar-game', page3);
  ok(
    !info3 || (info3.year && Math.abs(info3.year - 2007) <= 2),
    'Liar Game 2007: nessun match erroneo sul remake 2026',
    info3 ? `${info3.name} (${info3.year})` : 'nessun match (OK)',
  );

  // 6) mergeWithPage: trama italiana da AnimeWorld, Kitsu solo come fallback;
  //    generi italiani, voto da Kitsu.
  const merged = kitsu.mergeWithPage(
    { description: 'Nao Kanzaki riceve una lettera misteriosa…', genres: ['Drammatico', 'Mistero'], year: 2007, totalEpisodes: 26 },
    {
      description: 'When Nao Kanzaki receives a strange letter…',
      genres: ['Drama', 'Mystery'],
      year: 2026,
      rating: 6.9,
      totalEpisodes: null,
      kitsuId: 'kitsu:50108',
      background: 'https://x/bg.jpg',
    },
  );
  ok(merged.description.includes('lettera misteriosa'), 'merge: trama in italiano da AnimeWorld', merged.description.slice(0, 40));
  ok(merged.genres[0] === 'Drammatico', 'merge: generi da AnimeWorld (italiani)', merged.genres.join(', '));
  ok(merged.rating === 6.9, 'merge: voto da Kitsu', String(merged.rating));
  ok(merged.year === 2007, 'merge: anno da AnimeWorld', String(merged.year));
  ok(merged.totalEpisodes === 26, 'merge: totale da AnimeWorld', String(merged.totalEpisodes));
  ok(merged.background === 'https://x/bg.jpg', 'merge: background da Kitsu');
  const noItalian = kitsu.mergeWithPage(
    { genres: [], year: null, totalEpisodes: null },
    { description: 'Only English synopsis', genres: ['Drama'], year: 2016, rating: 7.4, totalEpisodes: null, kitsuId: 'kitsu:12' },
  );
  ok(noItalian.description === 'Only English synopsis', 'merge: Kitsu come fallback quando manca la trama italiana', noItalian.description.slice(0, 30));

  // 7) Addon raggiungibile? Se il flusso principale è fallito per problemi di rete
  //    lo segnaliamo chiaramente (il test 3 fallirebbe già, così l'errore è esplicito).
  if (!info1 && !info2) {
    try {
      const r = await fetch('https://anime-kitsu.strem.fun/manifest.json');
      console.log(`\n  Nota: addon Kitsu risponde HTTP ${r.status} ma il meta?`);
    } catch {
      console.log('\n  Nota: addon Kitsu NON raggiungibile — verifica la rete.');
    }
  }

  console.log(failures ? `\n${failures} VERIFICHE FALLITE` : '\nTUTTO OK — kitsu');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('Errore imprevisto:', err);
  process.exit(1);
});