'use strict';

/**
 * Utility testuali condivise fra il raggruppamento delle stagioni (seasons.js)
 * e l'indice IMDb (imdbIds.js). Stanno qui per evitare dipendenze circolari.
 */

/** Spazi normalizzati. */
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
 * Suffisso audio dell'edizione in coda al titolo: "(ITA)", "(SUB ITA)",
 * "(DOPPIATO)", "(DUB)", "(SUB)", "(ENG)", "(COMPLETO)".
 */
const AUDIO_RE = /\s*\((?:ita|sub\s*ita|dub|doppiato|sub|eng|completo)[^)]*\)\s*$/i;

/** Toglie il suffisso audio in coda ("Titolo (ITA)" -> "Titolo"). */
function stripAudio(title) {
  return clean(clean(title).replace(AUDIO_RE, ' '));
}

/** true se il nome porta un suffisso di edizione audio ("(ITA)", "(SUB ITA)"…). */
const hasAudioSuffix = (title) => stripAudio(title) !== clean(title);

module.exports = { clean, normalize, stripAudio, hasAudioSuffix, AUDIO_RE };
