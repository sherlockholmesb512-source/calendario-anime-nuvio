'use strict';

const config = require('../config');
const { getHtml } = require('./http');
const { toText, attr, absolute } = require('./parse');

/**
 * Homepage AnimeWorld -> widget "Ultimi Episodi".
 *
 * Il widget ha 12 "pagine" da 15 elementi (=180 episodi) gia' tutte in HTML:
 * i bottoni prev/next sfogliano solo i blocchi gia' presenti.
 *
 * Ogni item:
 *   <a href="/play/<slug>/<epId>" class="poster" data-tip="api/tooltip/<id>"
 *      title="<Titolo> Ep 26"><img src=... alt="<Titolo>"><div class="ep"> Ep 26 </div></a>
 */
async function getLatestEpisodes() {
  const res = await getHtml(config.awBase);
  const html = res.body;

  const widgetStart = html.indexOf('widget hotnew');
  if (widgetStart < 0) throw new Error('Widget "Ultimi Episodi" non trovato in homepage');

  // Inizio del blocco "all" (il primo dei tab: tutti / sub / dub / trending).
  const contentRe = /<div class="content\s*" data-name="([a-z]+)">/g;
  const blocks = [];
  let m;
  while ((m = contentRe.exec(html)) !== null) {
    if (m.index >= widgetStart) blocks.push({ name: m[1], index: m.index });
  }
  if (!blocks.length) throw new Error('Nessun blocco contenuto nel widget "Ultimi Episodi"');
  const allBlock = blocks.find((b) => b.name === 'all') || blocks[0];

  // Il widget ha un solo "widget-title": il successivo segna la fine del blocco.
  const nextTitle = html.indexOf('<div class="widget-title">', allBlock.index + 1);
  const nextBlock = blocks[blocks.indexOf(allBlock) + 1];
  const ends = [nextTitle, nextBlock ? nextBlock.index : Infinity, html.length].filter(
    (v) => v > allBlock.index,
  );
  const region = html.slice(allBlock.index, Math.min(...ends));

  // Gli <a class="poster"> con href a due segmenti esistono solo in questo widget.
  const posterRe =
    /<a\s+[^>]*?href="(\/play\/([^"/]+)\/([^"/]+))"[^>]*?class="poster"[^>]*?>/g;
  const hits = [...region.matchAll(posterRe)];
  if (!hits.length) throw new Error('Nessun episodio trovato nel widget "Ultimi Episodi"');

  const items = [];
  const seen = new Set();
  for (let i = 0; i < hits.length && items.length < config.maxLatestEpisodes; i += 1) {
    const hit = hits[i];
    const slug = hit[2];
    const epId = hit[3];
    if (seen.has(epId)) continue;
    seen.add(epId);

    // Finestra: dalla apertura dell'<a> fino all'inizio del poster successivo.
    const stop = i + 1 < hits.length ? hits[i + 1].index : hit.index + 1200;
    const chunk = region.slice(hit.index, stop);

    const imgTag = /<img[^>]*>/i.exec(chunk);
    const epTxt = /<div class="ep">([\s\S]*?)<\/div>/i.exec(chunk);
    const badge = /<div class="(sub|dub)">/i.exec(chunk);
    const epNumber = epTxt ? Number(toText(epTxt[1]).replace(/\D+/g, '')) : null;

    items.push({
      epId,
      slug,
      animeKey: slug.slice(slug.lastIndexOf('.') + 1),
      numId: Number((attr(hit[0], 'data-tip') || '').split('/').pop()) || null,
      name: (imgTag && attr(imgTag[0], 'alt')) || '',
      poster: imgTag ? absolute(attr(imgTag[0], 'src')) : null,
      epNumber: Number.isFinite(epNumber) && epNumber > 0 ? epNumber : null,
      badge: badge ? badge[1].toUpperCase() : null,
      url: `${config.awBase}/play/${slug}/${epId}`,
    });
  }

  return items;
}

module.exports = { getLatestEpisodes };
