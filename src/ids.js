'use strict';

/**
 * Schema degli ID (solo caratteri [A-Za-z0-9._-], come da specifica addon Stremio).
 *
 *   awa.<slug>        -> meta di un anime            es. awa.liar-game.MVKsv
 *   awm.<num>.<slug>  -> meta di un episodio         es. awm.26.liar-game.MVKsv
 *   awv.<num>.<slug>  -> id video (episodio)         es. awv.26.liar-game.MVKsv
 *
 * Gli slug AnimeWorld sono sempre `<nome-slug>.<animeId>`, dove il nome-slug
 * contiene solo [a-z0-9-]. Dividere sui punti e' quindi inequivocabile:
 *   kind . [num .] slug
 */

const AW_ANIME = 'awa';
const AW_META_EP = 'awm';
const AW_VIDEO = 'awv';

const animeId_ = (slug) => `${AW_ANIME}.${slug}`;
const episodeMetaId = (num, slug) => `${AW_META_EP}.${num}.${slug}`;
const videoId = (num, slug) => `${AW_VIDEO}.${num}.${slug}`;

/** Accetta id con o senza estensione .json. */
const clean = (id) => String(id || '').replace(/\.json$/i, '');

function parse(kind, id) {
  const raw = clean(id);
  const parts = raw.split('.');
  if (parts[0] !== kind) return null;
  if (kind === AW_ANIME) {
    return parts.length >= 3 ? { slug: parts.slice(1).join('.') } : null;
  }
  if (parts.length < 4) return null;
  const num = Number(parts[1]);
  if (!Number.isFinite(num)) return null;
  return { num, slug: parts.slice(2).join('.') };
}

const parseAnime = (id) => parse(AW_ANIME, id);
const parseEpisodeMeta = (id) => parse(AW_META_EP, id);
const parseVideo = (id) => parse(AW_VIDEO, id);

/** id numerico/alfanumerico dell'anime su AnimeWorld (ultima parte dello slug). */
const animeKey = (slug) => {
  const s = String(slug || '');
  const i = s.lastIndexOf('.');
  return i < 0 ? s : s.slice(i + 1);
};

module.exports = {
  AW_ANIME,
  AW_META_EP,
  AW_VIDEO,
  animeId: animeId_,
  episodeMetaId,
  videoId,
  parseAnime,
  parseEpisodeMeta,
  parseVideo,
  animeKey,
};
