'use strict';

const config = require('../config');
const { getHtml } = require('./http');
const { toText, attr, absolute } = require('./parse');

/**
 * Pagine di /filter di AnimeWorld.
 *   type=4                        -> Movie
 *   type=0,1,2,3,5                -> Anime, ONA, OVA, Special, ecc. (tutto tranne i Movie)
 */
function moviesUrl(page) {
  return `${config.awBase}/filter?type=4&language=it&sort=0&page=${page}`;
}

function dubbedUrl(page) {
  return `${config.awBase}/filter?type=0&type=1&type=2&type=3&type=5&language=it&sort=0&page=${page}`;
}

async function getFilterPage(url) {
  const res = await getHtml(url);
  const html = res.body;
  const start = html.indexOf('class="film-list"');
  if (start < 0) return [];
  const region = html.slice(start);

  const items = [];
  const seen = new Set();
  const re = /<a href="\/play\/([^"/]+)"\s+class="poster"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(region)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);

    const block = m[2];
    const img = /<img[^>]*\ssrc="([^"]+)"/i.exec(block);
    const badge = /<div class="(movie|sub|dub|ona|ova|special|tv)">\s*([^<]*)<\/div>/i.exec(block);
    const tip = /data-tip="api\/tooltip\/(\d+)"/i.exec(m[0]);

    // Il nome canonico e' nel <a class="name"> successivo, l'alt e' un backup.
    const after = region.slice(m.index + m[0].length, m.index + m[0].length + 600);
    const nameEl = /<a[^>]*class="name"[^>]*>([\s\S]*?)<\/a>/i.exec(after);

    items.push({
      slug,
      animeKey: slug.slice(slug.lastIndexOf('.') + 1),
      numId: tip ? Number(tip[1]) : null,
      name: (nameEl ? toText(nameEl[1]) : '') || (img ? attr(img[0], 'alt') : '') || slug,
      poster: absolute(attr(img ? img[0] : '', 'src')),
      badge: badge ? badge[1].toUpperCase() : null,
      url: `${config.awBase}/play/${slug}`,
    });
  }
  return items;
}

/** Scarica N pagine di filtro in sequenza leggera e de-duplica. */
async function getCatalogByFilter(urlBuilder, pages) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= pages; page += 1) {
    const items = await getFilterPage(urlBuilder(page));
    for (const item of items) {
      if (seen.has(item.slug)) continue;
      seen.add(item.slug);
      out.push(item);
    }
  }
  return out;
}

const getItalianMovies = () => getCatalogByFilter(moviesUrl, config.movieFilterPages);
const getItalianDubbed = () => getCatalogByFilter(dubbedUrl, config.dubFilterPages);

module.exports = { getItalianMovies, getItalianDubbed, getFilterPage, moviesUrl, dubbedUrl, toText };
