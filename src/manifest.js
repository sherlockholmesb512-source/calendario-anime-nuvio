'use strict';

const config = require('./config');

const CAT = {
  latest: 'calendario-anime-ultimi-episodi',
  schedule: 'calendario-anime-calendario',
  movies: 'calendario-anime-movie-italiani',
  dubbed: 'calendario-anime-doppiati-italiano',
};

function buildManifest(baseUrl) {
  const id = config.addonId.replace(/^com\./, '');
  return {
    id,
    version: '1.0.0',
    name: config.addonName,
    description:
      'Catalogo anime in italiano: gli ultimi episodi usciti, il calendario con le sole uscite di ' +
      'oggi (numero episodio e orario), i movie doppiati in italiano e l’intero catalogo doppiato. ' +
      'Aggiornato automaticamente ogni 5 minuti.',
    logo: `${baseUrl}/logo.png`,
    background: `${baseUrl}/background.png`,
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['awa', 'awm', 'awv'],
    resources: ['catalog', 'meta', 'stream'],
    // I cataloghi sono dichiarati di tipo "anime": e' il tipo media che Nuvio
    // usa per raggrupparli nella sezione Anime di Cerca/Scopri. I singoli
    // elementi restituiti da /catalog mantengono pero' il tipo vero e proprio
    // (series o movie), altrimenti Nuvio non riconoscerebbe piu' le serie e
    // perderei Episodi, "Continua a guardare" e il pannello episodi.
    catalogs: [
      {
        type: 'anime',
        id: CAT.latest,
        name: 'Ultimi Episodi',
        pageSize: 200,
        extra: [
          {
            name: 'skip',
            isRequired: false,
            options: ['0', '200', '400', '600', '800', '1000', '1200'],
          },
          { name: 'search', isRequired: false },
        ],
      },
      {
        type: 'anime',
        id: CAT.schedule,
        name: 'Calendario Anime',
        pageSize: 200,
        extra: [
          {
            name: 'skip',
            isRequired: false,
            options: ['0', '200', '400', '600', '800', '1000', '1200'],
          },
          { name: 'search', isRequired: false },
        ],
      },
      {
        type: 'anime',
        id: CAT.movies,
        name: 'Anime Movie Italiani',
        pageSize: 200,
        extra: [
          {
            name: 'skip',
            isRequired: false,
            options: ['0', '200', '400', '600', '800', '1000', '1200'],
          },
          { name: 'search', isRequired: false },
        ],
      },
      {
        type: 'anime',
        id: CAT.dubbed,
        name: 'Anime Doppiati in Italiano',
        pageSize: 200,
        extra: [
          {
            name: 'skip',
            isRequired: false,
            options: ['0', '200', '400', '600', '800', '1000', '1200'],
          },
          { name: 'search', isRequired: false },
        ],
      },
    ],
    behaviorHints: {
      configurable: false,
      configurationRequired: false,
      adult: false,
      p2p: false,
      bingeGroup: `${id}|latest-5min`,
    },
  };
}

module.exports = { buildManifest, CAT };
