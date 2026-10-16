'use strict';

/**
 * Raggruppamento delle stagioni AnimeWorld.
 *
 * Su AnimeWorld ogni stagione e' una pagina a parte con uno slug proprio e
 * spesso un titolo diverso (i sequel sono chiamati con il nome dell'arco):
 *
 *   tokyo-revengers.QpXLK                    -> Stagione 1
 *   tokyo-revengers-seiya-kessen-hen.tzgly   -> Stagione 2
 *   tokyo-revengers-tenjiku-hen.s6abB        -> Stagione 3
 *   reincarnated-as-a-sword-2.WJy2x          -> Stagione 2
 *
 * Senza raggruppare, la scheda di un sequel mostrava la sola stagione in
 * corso. Qui la scheda unisce TUTTE le stagioni in un unico elenco episodi,
 * numerate come le vuole il cliente (Stremio/Nuvio raggruppa per "season").
 *
 * Le pagine affini si trovano:
 *   1. nella sezione "Correlati" della pagina /play (gia' scaricata: gratis);
 *   2. come ripiego, con la ricerca AnimeWorld per il titolo base.
 *
 * I numeri di stagione arrivano dalle fonti esterne (AIOMetadata/TVDB/TMDB):
 * e' l'unico modo affidabile, perche' dallo slug si ricava solo la stagione
 * quando AnimeWorld la mette nel nome ("<titolo>-2-ita").
 */

const config = require('./config');
const ids = require('./ids');
const external = require('./external');
const { getAnimePage } = require('./aw/play');
const { getSearchItems } = require('./aw/filter');

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Minuscolo, senza accenti/punteggiatura: per confrontare i titoli. */
function normalize(str) {
  return clean(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Titolo "base" di un'opera: toglie i suffissi delle edizioni e delle stagioni.
 *   "Tokyo Revengers: Tenjiku Arc"            -> "Tokyo Revengers"
 *   "Reincarnated as a Sword 2 (Sub ITA)"     -> "Reincarnated as a Sword"
 *   "Re:Zero kara Hajimeru Isekai Seikatsu 3" -> "Re:Zero kara Hajimeru Isekai Seikatsu"
 */
function baseTitleOf(title) {
  let t = clean(title);
  t = t.replace(/\s*\((?:ita|sub\s*ita|dub|doppiato|sub|eng|completo)[^)]*\)\s*$/i, ' ');
  // Il titolo dopo i due punti e' il nome dell'arco/stagione
  // ("Tokyo Revengers: Tenjiku Arc" -> "Tokyo Revengers"), ma solo se la parte
  // prima dei due punti e' un vero titolo (almeno due parole): "Mission:
  // Yozakura Family" NON viene spezzato in "Mission".
  const colon = t.indexOf(':');
  if (colon >= 4 && t.slice(0, colon).trim().split(/\s+/).length >= 2) {
    t = t.slice(0, colon);
  }
  t = t.replace(/\s*[-–—]\s*(?:stagione|season|parte|part)?\s*\d+(?:\.\d+)?\s*$/i, ' ');
  t = t.replace(/\s+(?:parte|part|stagione|season)\s+\d+\s*$/i, ' ');
  t = t.replace(/\s*\((?:19|20)\d{2}\)\s*$/, ' ');
  return clean(t);
}

/** Lo slug corrisponde al titolo base (franchise)? */
function isSameFranchise(name, baseNorm) {
  if (!baseNorm) return false;
  const n = normalize(name);
  if (!n) return false;
  if (n === baseNorm) return true;
  // Il candidate e' "lungo" quanto il base e continua ("Tokyo Revengers" ->
  // "Tokyo Revengers Christmas Showdown").
  if (n.startsWith(`${baseNorm} `)) return true;
  // Il candidate e' PIU' BREVE del base: il titolo della pagina aperta contiene
  // il numero di stagione/cour ("Reincarnated as a Sword 2" -> "Reincarnated
  // as a Sword"). Senza questa direzione i sequel non trovavano la stagione 1.
  if (baseNorm.startsWith(`${n} `)) return true;
  return false;
}

/** Audio dell'edizione: "-ita" e' la versione doppiata in italiano. */
const audioOf = (slug) => (/-ita(?=\.|$)/i.test(String(slug || '')) ? 'ita' : 'sub');

/** Il nome marca esplicitamente il numero di stagione ("<titolo>-2-ita")? */
function slugSeasonMarker(slug) {
  const m = /-(\d{1,2})(?:-(?:sub|dub|eng))?-ita(?=\.|$)/i.exec(String(slug || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : null;
}

const isMoviePage = (page) => /movie/i.test(String(page.category || ''));

/**
 * Chiave di "gruppo edizione": nome dello slug SENNA il suffisso audio.
 * Su AnimeWorld il doppiato italiano e' una pagina a parte con slug
 * "<nome>-ita" (es. `tokyo-revengers-ita.l6O9h` accanto a `tokyo-revengers.QpXLK`,
 * stesso anime, stessa stagione): raggrupparle evita che ogni edizione venga
 * assegnata a una stagione diversa e che gli episodi compaiano due volte.
 */
function audioGroupKey(slug) {
  const s = String(slug || '');
  const dot = s.lastIndexOf('.');
  const name = dot >= 0 ? s.slice(0, dot) : s;
  return name.replace(/(?:-(?:sub|dub|eng))?-ita$/i, '');
}

/**
 * AnimeWorld spezza a volte una stessa stagione in piu' pagine ("Part 2",
 * "Cour 2"): sono la prosecuzione della stessa stagione, non una nuova. La
 * chiave toglie l'audio e il suffisso cour, cosi' "X 2" e "X 2 Part 2" finiscono
 * nello stesso gruppo.
 */
const CONTINUATION_RE = /-(?:part|parte|cour)-\d{1,2}$/i;

function continuationBase(slug) {
  return audioGroupKey(slug).replace(CONTINUATION_RE, '');
}

const isContinuationSlug = (slug) => CONTINUATION_RE.test(audioGroupKey(slug));

// ---------------------------------------------------------------------------
// Cache dei gruppi
// ---------------------------------------------------------------------------

const bundleCache = new Map(); // slug principale -> { at, data }
const slugIndex = new Map(); // qualsiasi slug del gruppo -> slug chiave in cache
const inflight = new Map();
const failMark = new Map();
const NEG_TTL = 15 * 60 * 1000;

const fresh = (hit) => Boolean(hit) && Date.now() - hit.at < config.bundleCacheMs;

/** Indicizza TUTTI gli slug di un gruppo: /stream puo' chiedere un sequel. */
function indexBundle(key, data) {
  for (const entry of (data && data.entries) || []) {
    if (entry.slug) slugIndex.set(entry.slug, key);
    // Le pagine di prosecuzione unite non sono entry a se': indicizza anche i
    // loro slug (srcSlug), cosi' /stream ritrova il gruppo partendo da esse.
    for (const v of entry.mergedVideos || []) {
      if (v.srcSlug) slugIndex.set(v.srcSlug, key);
    }
  }
}

function unindexBundle(key) {
  for (const [slug, k] of slugIndex) {
    if (k === key) slugIndex.delete(slug);
  }
}

function dropBundle(key) {
  if (bundleCache.delete(key)) unindexBundle(key);
}

function trimCache() {
  while (bundleCache.size > 500) {
    const first = bundleCache.keys().next().value;
    if (first === undefined) break;
    dropBundle(first);
  }
}

/** Svuota i gruppi scaduti (chiamato dallo sweep periodico). */
function flushExpired() {
  const now = Date.now();
  const evicted = [];
  for (const [slug, hit] of bundleCache) {
    if (now - hit.at > config.bundleCacheMs) {
      dropBundle(slug);
      evicted.push(slug);
    }
  }
  return evicted;
}

// ---------------------------------------------------------------------------
// Scoperta delle pagine affini
// ---------------------------------------------------------------------------

async function collectCandidates(slug, page) {
  const base = baseTitleOf(page.title || slug);
  const baseNorm = normalize(base);
  const found = new Map();

  for (const rel of page.related || []) {
    if (!rel || !rel.slug || rel.slug === slug) continue;
    found.set(rel.slug, { slug: rel.slug, name: rel.name || rel.slug });
  }

  // Ripiego: la ricerca AnimeWorld per il titolo base trova le stagioni anche
  // quando la sezione "Correlati" e' incompleta.
  if (found.size < 2 && base) {
    try {
      const hits = await getSearchItems(base, 30);
      for (const hit of hits) {
        if (!hit || !hit.slug || hit.slug === slug) continue;
        if (!found.has(hit.slug)) found.set(hit.slug, { slug: hit.slug, name: hit.name || hit.slug });
      }
    } catch (err) {
      console.warn(`[seasons] ricerca "${base}" fallita: ${err.message}`);
    }
  }

  const out = [];
  for (const cand of found.values()) {
    if (!isSameFranchise(cand.name, baseNorm)) continue;
    out.push(cand);
  }
  return { base, baseNorm, candidates: out };
}

// ---------------------------------------------------------------------------
// Numerazione delle stagioni
// ---------------------------------------------------------------------------

/**
 * Assegna a ogni pagina il suo numero di stagione.
 * Ordine di preferenza: marcatore nello slug -> match con la fonte esterna
 * (stesso numero di episodi + anno compatibile) -> posizione cronologica.
 */
function assignSeasons(entries, seasonList) {
  const list = (seasonList || [])
    .slice()
    .filter((s) => s && Number.isFinite(Number(s.number)) && Number(s.number) >= 1)
    .map((s) => ({
      number: Number(s.number),
      name: s.name || null,
      episodeCount: Number(s.episodeCount) || 0,
      airDate: s.airDate || null,
    }))
    .sort(
      (a, b) =>
        String(a.airDate || '9999').localeCompare(String(b.airDate || '9999')) ||
        a.number - b.number,
    );

  const ordered = entries.slice().sort((a, b) => {
    const da = String(a.page.releaseDate || a.page.year || '9999');
    const db = String(b.page.releaseDate || b.page.year || '9999');
    return da.localeCompare(db) || String(a.slug).localeCompare(String(b.slug));
  });

  const used = new Set();

  // 1) marcatore esplicito nello slug
  for (const entry of ordered) {
    const marker = slugSeasonMarker(entry.slug);
    if (marker && !used.has(marker)) {
      entry.season = marker;
      used.add(marker);
    }
  }

  // 2) match con la struttura esterna
  for (const entry of ordered) {
    if (entry.season) continue;
    const count = entry.page.totalEpisodes || (entry.page.videos || []).length || 0;
    const year = entry.page.year ? Number(entry.page.year) : null;

    const sameYear = (s) =>
      !year || !s.airDate || Math.abs(Number(String(s.airDate).slice(0, 4)) - year) <= 1;

    let pick =
      list.find((s) => !used.has(s.number) && count && s.episodeCount === count && sameYear(s)) ||
      list.find((s) => !used.has(s.number) && count && s.episodeCount === count) ||
      list.find((s) => !used.has(s.number) && sameYear(s));

    if (pick) {
      entry.season = pick.number;
      used.add(pick.number);
    }
  }

  // 3) ripiego cronologico: 1, 2, 3... nell'ordine di uscita
  let nextFree = 1;
  for (const entry of ordered) {
    if (entry.season) continue;
    while (used.has(nextFree)) nextFree += 1;
    entry.season = nextFree;
    used.add(nextFree);
  }

  return ordered;
}

/** Un solo gruppo per stagione: in conflitto vince l'edizione giusta. */
function dedupeBySeason(entries, preferIta) {
  const bySeason = new Map();
  for (const entry of entries) {
    const current = bySeason.get(entry.season);
    if (!current) {
      bySeason.set(entry.season, entry);
      continue;
    }
    const wanted = preferIta ? 'ita' : 'sub';
    const aWins = audioOf(entry.slug) === wanted;
    const bWins = audioOf(current.slug) === wanted;
    if (aWins !== bWins) {
      if (aWins) bySeason.set(entry.season, entry);
      continue;
    }
    const aEps = entry.mergedVideos ? entry.mergedVideos.length : (entry.page.videos || []).length;
    const bEps = current.mergedVideos
      ? current.mergedVideos.length
      : (current.page.videos || []).length;
    if (aEps > bEps) bySeason.set(entry.season, entry);
  }
  return [...bySeason.values()].sort((a, b) => a.season - b.season);
}

/**
 * Collassa le edizioni audio della stessa opera: le pagine con slug
 * "<nome>" (sub) e "<nome>-ita" (doppiato) sono la stessa stagione. Si tiene
 * l'edizione con l'audio della pagina aperta e, per il resto, quella con piu'
 * episodi; le altre vengono scartate (evita episodi duplicati in scheda).
 */
function collapseAudioEditions(candidates, preferIta, mainSlug) {
  const wanted = preferIta ? 'ita' : 'sub';
  const mainKey = audioGroupKey(mainSlug);
  const byGroup = new Map();
  for (const cand of candidates) {
    const key = audioGroupKey(cand.slug);
    // Variante audio della stessa stagione della pagina aperta: la pagina
    // aperta la rappresenta gia'.
    if (key === mainKey) continue;
    const cur = byGroup.get(key);
    if (!cur) {
      byGroup.set(key, cand);
      continue;
    }
    const aWins = (audioOf(cand.slug) === wanted) !== (audioOf(cur.slug) === wanted);
    if (aWins) {
      if (audioOf(cand.slug) === wanted) byGroup.set(key, cand);
      continue;
    }
    // Stesso audio (o nessuno dei due preferito): teniamo comunque la prima
    // pagina; il confronto sul numero di episodi avviene sul gruppo completo.
  }
  return [...byGroup.values()];
}

/** Numero del primo episodio di una pagina (0 se vuota). */
function minEpisodeNum(entry) {
  const nums = (entry.page.videos || []).map((v) => v.num);
  return nums.length ? Math.min(...nums) : 0;
}

/**
 * Une le pagine di prosecuzione della stessa stagione.
 *
 * AnimeWorld a volte spezza una stagione in piu' pagine ("X 2" e "X 2 Part 2",
 * oppure "Cour 2"): senza unirle il cliente mostra una "stagione" fittizia di
 * pochi episodi. Gli episodi uniti vengono rinumerati di seguito ma conservano
 * lo slug e il numero ORIGINALI (srcSlug/srcNum), perche' /stream risolve
 * l'episodio riaprendo proprio quella pagina.
 */
function mergeContinuations(entries) {
  const groups = new Map();
  const order = [];
  for (const entry of entries) {
    const base = continuationBase(entry.slug);
    let group = groups.get(base);
    if (!group) {
      group = { base, members: [] };
      groups.set(base, group);
      order.push(base);
    }
    group.members.push(entry);
  }

  const out = [];
  for (const base of order) {
    const { members } = groups.get(base);
    if (members.length === 1) {
      out.push(members[0]);
      continue;
    }
    // Pagina "principale" del gruppo: quella che NON e' una prosecuzione,
    // preferendo la pagina aperta; altrimenti la pagina aperta.
    const primary =
      members.find((m) => m.isMain && !isContinuationSlug(m.slug)) ||
      members.find((m) => !isContinuationSlug(m.slug)) ||
      members.find((m) => m.isMain) ||
      members[0];
    const parts = members
      .filter((m) => m !== primary && (m.page.videos || []).length)
      .sort(
        (a, b) =>
          minEpisodeNum(a) - minEpisodeNum(b) || String(a.slug).localeCompare(String(b.slug)),
      );

    if (!parts.length) {
      out.push(primary);
      continue;
    }

    const mergedVideos = [];
    let maxNum = 0;
    for (const v of (primary.page.videos || []).slice().sort((a, b) => a.num - b.num)) {
      mergedVideos.push({ num: v.num, srcNum: v.num, srcSlug: primary.slug, epId: v.id });
      if (v.num > maxNum) maxNum = v.num;
    }
    for (const part of parts) {
      const pv = (part.page.videos || []).slice().sort((a, b) => a.num - b.num);
      if (!pv.length) continue;
      const offset = maxNum + 1 - pv[0].num;
      for (const v of pv) {
        mergedVideos.push({
          num: v.num + offset,
          srcNum: v.num,
          srcSlug: part.slug,
          epId: v.id,
        });
      }
      maxNum = pv[pv.length - 1].num + offset;
    }

    primary.mergedVideos = mergedVideos;
    primary.mergedTotal = maxNum;
    out.push(primary);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Costruzione del gruppo
// ---------------------------------------------------------------------------

async function buildBundle(slug, priority) {
  const page = await getAnimePage(slug, { priority });
  if (!page || page.notFound) return null;

  const single = () => ({
    mainSlug: slug,
    baseTitle: page.title || slug,
    entries: [{ slug, page, season: ids.seasonOf(slug), isMain: true }],
    external: null,
    seasonCount: 1,
  });

  if (!config.seasonsEnabled || isMoviePage(page)) return single();

  const { base, candidates } = await collectCandidates(slug, page);
  if (!candidates.length) return single();

  // Pagine affini (in cache 6 ore: un costo una tantum per stagione).
  const entries = [{ slug, page, isMain: true }];
  // Prima di scaricare, deduplica le edizioni audio della STESSA opera:
  // "<nome>-ita" (doppiato) e "<nome>" (sub) sono la medesima stagione. Viene
  // tenuta l'edizione corrispondente a quella della pagina aperta, cosi' la
  // scheda non mostra due volte gli stessi episodi sotto stagioni diverse.
  const preferIta = audioOf(slug) === 'ita';
  const collapsed = collapseAudioEditions(candidates, preferIta, slug);
  const limited = collapsed.slice(0, Math.max(1, config.maxSeasonPages));
  for (const cand of limited) {
    if (entries.length >= config.maxSeasonPages + 1) break;
    try {
      const sibling = await getAnimePage(cand.slug, { priority: false });
      if (!sibling || sibling.notFound) continue;
      if (!sibling.videos || !sibling.videos.length) continue;
      if (isMoviePage(sibling)) continue;
      entries.push({ slug: cand.slug, page: sibling });
    } catch (err) {
      console.warn(`[seasons] pagina ${cand.slug} non disponibile: ${err.message}`);
    }
  }

  if (entries.length === 1) {
    const only = single();
    only.baseTitle = base || only.baseTitle;
    return only;
  }

  // Fonte esterna: conosce le stagioni reali dell'opera.
  let ext = await external.getEpisodeDetails(page, []).catch(() => null);
  let seasonList = ext && Object.keys(ext.seasons || {}).length
    ? Object.values(ext.seasons).map((s) => ({
        number: s.number,
        name: s.name,
        episodeCount: s.episodeCount,
        airDate: s.airDate,
      }))
    : await external.getSeasonList(page).catch(() => null);

  const assigned = assignSeasons(entries, seasonList);
  // Le pagine di prosecuzione ("X 2 Part 2") diventano un'unica stagione prima
  // della scelta "una pagina per stagione".
  const collapsed2 = mergeContinuations(assigned);
  const merged = dedupeBySeason(collapsed2, preferIta);

  // Se la prima chiamata esterna non copriva tutte le stagioni (fallback
  // TMDB, che le serve una per volta) le recupera ora.
  const wantedSeasons = merged.map((e) => e.season);
  const missing = wantedSeasons.filter((n) => !(ext && ext.seasons && ext.seasons[n]));
  if (missing.length) {
    const extra = await external.getEpisodeDetails(page, missing).catch(() => null);
    ext = external.mergeExternal(ext, extra);
  }

  return {
    mainSlug: slug,
    baseTitle: base || page.title || slug,
    entries: merged,
    external: ext,
    seasonCount: merged.length,
  };
}

/**
 * Gruppo di stagioni di un anime (cache 12 ore). Ritorna null solo se la
 * pagina principale non esiste.
 */
async function getSeriesBundle(slug, { priority = false, force = false } = {}) {
  if (!slug) return null;
  if (!force) {
    const hit = bundleCache.get(slug);
    if (fresh(hit)) return hit.data;
    if (inflight.has(slug)) return inflight.get(slug);
    const failed = failMark.get(slug);
    if (failed && Date.now() - failed < NEG_TTL) {
      const page = await getAnimePage(slug, { priority }).catch(() => null);
      if (!page || page.notFound) return null;
      return {
        mainSlug: slug,
        baseTitle: page.title || slug,
        entries: [{ slug, page, season: ids.seasonOf(slug), isMain: true }],
        external: null,
        seasonCount: 1,
      };
    }
  }

  const task = (async () => {
    try {
      const data = await buildBundle(slug, priority);
      if (!data) {
        failMark.set(slug, Date.now());
        return null;
      }
      bundleCache.set(slug, { at: Date.now(), data });
      indexBundle(slug, data);
      trimCache();
      failMark.delete(slug);
      return data;
    } catch (err) {
      failMark.set(slug, Date.now());
      console.warn(`[seasons] gruppo ${slug} non disponibile: ${err.message}`);
      return null;
    } finally {
      inflight.delete(slug);
    }
  })();

  inflight.set(slug, task);
  return task;
}

/**
 * Gruppo gia' in cache (nessun fetch). Usato da /stream per tradurre la pagina
 * di un episodio nella coppia "stagione:episodio" che i client si aspettano.
 * Accetta qualunque slug del gruppo (anche un sequel).
 */
function peekBundle(slug) {
  if (!slug) return null;
  const direct = bundleCache.get(slug);
  if (fresh(direct)) return direct.data;
  const key = slugIndex.get(slug);
  const viaIndex = key ? bundleCache.get(key) : null;
  return fresh(viaIndex) ? viaIndex.data : null;
}

/**
 * Posizione "di scheda" (stagione + numero mostrati) dell'episodio che sulla
 * pagina AnimeWorld ha `num` come numero e `slug` come slug. Per le pagine di
 * prosecuzione unite i due numeri differiscono. Ritorna null se non lo trova.
 */
function locateEpisode(bundle, slug, num) {
  if (!bundle) return null;
  for (const entry of bundle.entries) {
    const videos = entry.mergedVideos
      ? entry.mergedVideos
      : (entry.page.videos || []).map((v) => ({
          num: v.num,
          srcNum: v.num,
          srcSlug: entry.slug,
        }));
    for (const v of videos) {
      if (v.srcSlug === slug && v.srcNum === num) return { season: entry.season, num: v.num };
    }
  }
  return null;
}

/** Elenco piatto e ordinato di tutti gli episodi di un'opera, tutte le stagioni. */
function flattenEpisodes(bundle) {
  const out = [];
  if (!bundle) return out;
  for (const entry of bundle.entries) {
    const details = bundle.external && bundle.external.seasons
      ? bundle.external.seasons[entry.season]
      : null;
    // Video della stagione: le pagine di prosecuzione unite portano gia' i campi
    // srcNum/srcSlug (slug e numero originali per /stream); per le pagine normali
    // coincidono con lo slug della pagina e il numero dell'episodio.
    const videos = entry.mergedVideos
      ? entry.mergedVideos
      : (entry.page.videos || []).map((v) => ({
          num: v.num,
          srcNum: v.num,
          srcSlug: entry.slug,
          epId: v.id,
        }));
    // Totale episodi della stagione: la fonte esterna conosce anche quelli non
    // ancora pubblicati su AnimeWorld ("Episodio 3/13"); il gruppo unito e la
    // pagina coprono i casi in cui la fonte esterna e' incompleta.
    const total =
      Math.max(
        (details && details.episodeCount) || 0,
        entry.mergedTotal || 0,
        entry.page.totalEpisodes || 0,
      ) || null;
    for (const v of videos) {
      const info = details && details.episodes ? details.episodes[v.num] : null;
      out.push({
        num: v.num,
        season: entry.season,
        epId: v.epId,
        slug: v.srcSlug,
        srcNum: v.srcNum,
        srcSlug: v.srcSlug,
        total,
        title: info ? info.title : null,
        overview: info ? info.overview : null,
        thumbnail: info ? info.thumbnail : null,
        released: info ? info.released : null,
        runtime: info ? info.runtime : null,
      });
    }
  }
  out.sort((a, b) => a.season - b.season || a.num - b.num);
  return out;
}

/** Prossimo episodio non ancora uscito, secondo la fonte esterna. */
function nextEpisodeFromExternal(bundle) {
  const next = bundle && bundle.external && bundle.external.next;
  if (!next) return null;
  const entry = (bundle.entries || []).find((e) => e.season === next.season);
  return {
    ...next,
    slug: entry ? entry.slug : bundle.mainSlug,
  };
}

const stats = () => ({ cached: bundleCache.size, inflight: inflight.size, failed: failMark.size });

module.exports = {
  getSeriesBundle,
  peekBundle,
  locateEpisode,
  flattenEpisodes,
  nextEpisodeFromExternal,
  flushExpired,
  baseTitleOf,
  normalize,
  isSameFranchise,
  slugSeasonMarker,
  audioOf,
  mergeContinuations,
  stats,
};
