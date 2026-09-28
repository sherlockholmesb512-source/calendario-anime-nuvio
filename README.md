# Calendario Anime — addon per Nuvio

Addon per **Nuvio** (e qualunque client compatibile con il protocollo addon di Stremio)
che raccoglie i dati di **AnimeWorld** in 4 cataloghi, aggiornati automaticamente ogni 5 minuti.

| # | Catalogo | Sorgente | Contenuto |
|---|----------|----------|-----------|
| 1 | **Ultimi Episodi** | homepage AnimeWorld | Gli episodi appena usciti, con audio ITA/DUB e numero episodio |
| 2 | **Calendario Anime** | `/schedule` | **Solo le uscite di oggi con orario**, con numero episodio / episodi totali |
| 3 | **Anime Movie Italiani** | `/filter?type=4&language=it` (8 pagine) | 320 film in italiano |
| 4 | **Anime Doppiati in Italiano** | `/filter?language=it` (26 pagine) | 1003 opere con doppiaggio italiano |

I quattro cataloghi sono dichiarati di tipo **`anime`**, così Nuvio li raccoglie nella
sezione **Anime** di Cerca → Scopri (le schede Home diventano "… · Anime").
**Supportano la ricerca** (`extra: search`): la lente di Nuvio interroga AnimeWorld
(ricerca per titolo) filtrata dal catalogo in cui stai cercando, così trovi un episodio
in "Ultimi Episodi", un film in "Movie Italiani" e solo doppiati in "Doppiati in Italiano".
Attenzione: è il *catalogo* ad essere di tipo `anime`, mentre i singoli elementi
restano di tipo `series` o `movie`: in Nuvio è il tipo dell'elemento a decidere se
mostrare episodi, "Continua a guardare" e il pannello episodi, e `anime` non
rientra in nessuno di quei controlli. Per lo stesso motivo i percorsi storici
`/catalog/series/…` e `/catalog/movie/…` continuano a funzionare oltre a
`/catalog/anime/…`.

## Installazione in Nuvio

**Impostazioni → Addon → Aggiungi addon**, poi incolla:

```
https://calendario-anime-sgjw.onrender.com/manifest.json
```

Su Android / Apple TV si può usare direttamente la deep link:

```
stremio://calendario-anime-sgjw.onrender.com/manifest.json
```

La pagina `https://calendario-anime-sgjw.onrender.com/` mostra lo stato
dei cataloghi e gli endpoint disponibili.

---

## Come funziona

Il sito non espone alcuna API pubblica, quindi tutto viene ricavato leggendo l'HTML
(le pagine sono in `windows-1252`, decodificato con `TextDecoder`). Gli stream si ottengono
chiamando l'endpoint interno del player, `GET /api/episode/info?id=<epId>&alt=0`, che restituisce
l'URL MP4 diretto: serve l'header `CSRF-Token` ma **non** richiede cookie né sessione.

Per ogni episodio (o film) l'addon espone **lo streaming diretto di AnimeWorld**
(`https://…/…mp4`). AnimeWorld non espone etichette di qualità (singolo MP4), quindi il
titolo dello stream mostra la **dimensione reale del file** misurata con una richiesta
HEAD (`AnimeWorld • Streaming diretto (~440 MB)`); se il probe fallisce il titolo resta
semplice. Niente embed o "apri sul sito": il player riproduce il file.

Accanto allo stream diretto, l'addon interroga anche **EasyStreams**
(`https://easystreams.realbestia.com`, addon solo-stream italiano di terze parti) e
restituisce in più le fonti che trova (torrent/http), usando l'id IMDb o Kitsu
dell'anime e il formato `id:stagione:episodio` del protocollo Stremio. EasyStreams è
lento e variabile (1-12 s): la risposta attende al massimo `EASYSTREAMS_TIMEOUT_MS`
(default 10 s) e poi replica con il solo stream AnimeWorld; il risultato è in cache
10 minuti. `EASYSTREAMS_URL=''` disattiva questa integrazione (di default è attiva).

Le *informazioni* (trama, voto IMDb, generi, art) arrivano dall'addon di terze parti
**Kitsu** (`https://anime-kitsu.strem.fun`): il match sfrutta gli id MyAnimeList/AniList che
le pagine AnimeWorld espongono già (senza id, ricerca per titolo con controllo di anno e
tipo per evitare remake/omonimi). La **trama resta in italiano**: quella scritta nelle pagine
AnimeWorld ha la precedenza, Kitsu è solo il fallback. Dove possibile le miniature dei
singoli episodi vengono da Kitsu/metahub invece della copertina dell'anime. Se Kitsu non
risponde si resta sui dati AnimeWorld; `KITSU_ENABLED=false` lo disattiva del tutto.

Ogni **30 minuti** (configurabile con `CACHE_SWEEP_MS`, `0` per disattivarlo) le cache locali
vengono svuotate automaticamente: pagine `/play`, stream risolti e metadati Kitsu. Niente si
accumula, lo spazio resta libero e i dati si ri-scaricano freschi (le schede vengono
ri-accodate e si ri-arricchiscono in background).

Il **cast** (attori e doppiatori) arriva da **AniList GraphQL** (dati pubblici, nessuna chiave):
per ogni anime si preferiscono i **doppiatori italiani**, senza di loro i seiyuu giapponesi,
in ultima spiaggia i personaggi principali; `CAST_ENABLED=false` lo disattiva. Le miniature
degli episodi e i poster non restano mai vuoti: in mancanza del dato arricchito si usa la
copertina AnimeWorld costruita dall'id dell'opera (`img.animeworld.ac/copertine/<id>.jpg`).

### Flusso dati

```
AnimeWorld ──scrape──► src/aw/*  ──► src/store.js  ──► 4 cataloghi in memoria
                            │              ▲
                            │              └── ogni 5 minuti (setInterval)
                            └──► src/enrich.js  arricchimento progressivo in coda
                                   └──► src/kitsu.js  metadati (addon Kitsu)
```

- **`src/store.js`** tiene i 4 cataloghi in memoria e li ricarica ogni 5 minuti in parallelo.
  Se un catalogo fallisce mantiene l'ultimo risultato buono (*stale-while-error*), così
  l'addon resta fruibile anche se AnimeWorld è momentaneamente irraggiungibile.
- **`src/enrich.js`** arricchisce in background le schede (descrizione, generi, anno, voto,
  episodi totali) con un budget di 6 pagine ogni 20 secondi e cache 6 ore, così `/catalog`
  resta istantaneo. I cataloghi 3 e 4 (oltre 1300 titoli) restano leggeri.
- **`src/kitsu.js`** fonde i metadati dell'addon Kitsu a quelli di AnimeWorld, con cache di
  24 ore, timeout e *stale-while-error*: mai un errore se l'addon cade.
- **`src/aw/http.js`** mette in coda le richieste verso AnimeWorld (4 simultanee, 120 ms di
  pausa minima fra una e l'altra, 3 retry con backoff).

### Identificativi

Lo schema `id` del protocollo Stremio ammette solo `[A-Za-z0-9._-]`, quindi gli slug di
AnimeWorld (che contengono caratteri non validi) vengono rincapsulati:

| Prefisso | Significato | Esempio |
|----------|-------------|---------|
| `awa.` | scheda di un'opera | `awa.one-piece-ita.d5nahE` |
| `awm.` | scheda di un episodio, con numero | `awm.26.liar-game.MVKsv` |
| `awv.` | singolo video riproducibile | `awv.26.liar-game.MVKsv` |

Gli slug AnimeWorld sono della forma `<nome-slug>.<animeId>`, quindi dividere sui punti
è inequivocabile (`src/ids.js`).

---

## Avvio in locale

```bash
npm install
npm start            # http://127.0.0.1:7000
```

Al primo avvio lo scraping dei 4 cataloghi richiede circa 10-15 secondi: il server risponde
subito e `/health` mostra l'avanzamento.

### Test

```bash
npm run smoke        # scraping diretto, senza server
npm run http         # flusso addon completo via HTTP (serve un server attivo)
npm run http -- http://127.0.0.1:7000
npm run test:kitsu   # arricchimento metadati dall'addon Kitsu (richiede rete)
npm run assets       # rigenera public/logo.png e public/background.png
```

`npm run http` simula davvero quello che fa Nuvio: manifest → catalog (con paginazione)
→ meta → stream, e verifica che l'URL MP4 restituito sia riproducibile con supporto Range.

---

## Deploy su GitHub + Render

Codice sorgente su GitHub:
**https://github.com/sherlockholmesb512-source/calendario-anime-nuvio** (branch `main`).

Ogni push sul branch `main` ri-deploya automaticamente il servizio su Render
(`autoDeploy: yes`). Dopo la creazione/aggiornamento del servizio l'addon è raggiungibile a:

```
https://calendario-anime-sgjw.onrender.com/manifest.json
```

Dashboard: https://dashboard.render.com/web/srv-datc1kou01pc73e1v03g

### Deploy su Railway

Il progetto era inizialmente su Railway
(`https://calendario-anime-nuvio-production.up.railway.app`, progetto `calendario-anime-nuvio`);
la configurazione è in `railway.json` (build Nixpacks, healthcheck su `/health`) e `Procfile`.

Per aggiornarlo, da dentro la cartella:

```bash
railway up --service calendario-anime-nuvio --yes
```

Variabili d'ambiente disponibili: vedi `.env.example`. Le principali sono
`REFRESH_MS` (default 5 minuti), `INCLUDE_INDETERMINATE` (vedi sotto),
`META_ENRICH_TIMEOUT_MS` (budget per le richieste /meta: oltre il tempo la
scheda risponde subito con la trama AnimeWorld e l'arricchimento prosegue in
background), `TMDB_API_KEY` (miniature episodio affidabili da TMDB quando
l'addon e kitso.io non coprono il titolo; da impostare nel pannello Render),
`EASYSTREAMS_URL` (addon stream aggiuntivo; `''` per disattivare, di default
usa il manifest di easystreams.realbestia.com) e `EASYSTREAMS_TIMEOUT_MS`
(default 10 s).

---

## Il catalogo "Calendario Anime"

Il catalogo contiene **solo le uscite di oggi con orario certo**. Ogni card mostra
numero episodio e totale (quando è noto) e l'orario di uscita:

```
Liar Game          Ep 26/26 · Oggi 18:30
```

Il `/schedule` di AnimeWorld ha 8 sezioni: i 7 giorni della settimana più una sezione
**"uscite indeterminate"**, cioè episodi che usciranno ma *senza* giorno e orario definiti.
Quella sezione copre l'intera settimana, non la giornata, quindi **è esclusa** di default:
includerla mostrerebbe in "calendario di oggi" titoli che usciranno magari sabato.

Per cambiare questo comportamento:

```
INCLUDE_INDETERMINATE=true    # aggiunge in coda anche le uscite indeterminate
```

Gli orari sono interpretati nel fuso `Europe/Rome`, lo stesso usato dal sito.

---

## Struttura

```
src/
  index.js            server Express, rotte, avvio e chiusura pulita
  config.js           tutta la configurazione (con valori di default sensati)
  manifest.js         manifest.json e ID dei 4 cataloghi
  store.js            stato dei cataloghi + scheduler a 5 minuti
  enrich.js           arricchimento schede in background
  ids.js              codifica/decodifica degli ID (awa./awm./awv.)
  routes.js           handler catalog/meta/stream, landing page, /health
  aw/
    http.js           coda, rate limit, retry, token CSRF, decodifica charset
    home.js           ultimi episodi dalla homepage
    schedule.js       calendario settimanale
    filter.js         catalogo movie e doppiati (paginato)
    play.js           pagina /play: metadati + lista episodi + risoluzione stream
    parse.js          utility di parsing HTML condivise
scripts/
  smoke-test.js       test dei 4 cataloghi senza server
  http-test.js        test end-to-end del protocollo addon
  generate-assets.js  generazione di logo e sfondo
public/
  logo.png  background.png
```
