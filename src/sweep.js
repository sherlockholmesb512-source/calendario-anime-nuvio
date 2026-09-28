'use strict';

/** Statistiche condivise dell'ultimo svuota-cache automatico (scritto da index.js, letto da routes). */

const state = { stats: null };

function note(stats) {
  state.stats = stats;
}

function get() {
  return state.stats;
}

module.exports = { state, note, get };