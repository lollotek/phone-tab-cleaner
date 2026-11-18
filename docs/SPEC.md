# PhoneCleanKit — Documentazione di riferimento

> Tool CLI in Node.js che si collega al telefono Android via **adb (debug wireless)**, legge tutte le schede aperte di **Chrome**, e le archivia in un file **Markdown** con descrizione e tag, evitando doppioni. Opzionalmente chiude le schede salvate.

Stato: **specifica v0.1** (2026-11-14) — nessun codice ancora scritto.

---

## 1. Obiettivi

| # | Requisito | Note |
|---|-----------|------|
| R1 | Connessione al telefono via adb wireless | adb in `D:\programmi\scrcpy-win64-v3.3.4\adb.exe` (configurabile) |
| R2 | Lettura di tutte le schede Chrome (titolo + URL) | Solo Chrome stabile (`com.android.chrome`) |
| R3 | Scrittura su un unico file `.md`, sezioni per data | Append-only, le voci esistenti non vengono riscritte |
| R4 | Breve descrizione + tag per ogni link | Modalità **ibrida**: metadati+regole di default, `--ai` per usare un LLM |
| R5 | Se il file esiste: usarlo come riferimento per i tag e il controllo doppioni | Vocabolario tag estratto dal file |
| R6 | Chiusura opzionale delle schede salvate | Solo con `--close`, con conferma |

Fuori scope (per ora): altri browser (Edge, Brave, Samsung Internet), Chrome Beta/Dev, schede in incognito (non esposte da Chrome), cronologia/preferiti.

---

## 2. Come funziona (principio tecnico)

Chrome per Android espone il protocollo **DevTools** su un socket Unix "abstract" chiamato `chrome_devtools_remote` — lo stesso che usa `chrome://inspect` sul desktop. Non serve root né un'app sul telefono: basta il debug (USB o wireless) attivo.

```
PC                                   Telefono
──                                   ────────
adb forward tcp:9222  ───────────►   localabstract:chrome_devtools_remote
GET  http://127.0.0.1:9222/json/list      → elenco schede [{id,title,url,type}]
GET  http://127.0.0.1:9222/json/close/<id> → chiude una scheda (solo con --close)
```

Esempio di risposta `/json/list`:

```json
[
  {
    "id": "12",
    "type": "page",
    "title": "Node.js — Documentation",
    "url": "https://nodejs.org/docs/latest/api/",
    "description": "",
    "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/12"
  }
]
```

Note:
- Il socket esiste **solo se Chrome è in esecuzione**. Se il forward fallisce o `/json/list` non risponde, il tool avvia Chrome con
  `adb shell am start -n com.android.chrome/com.google.android.apps.chrome.Main` e riprova.
- Si filtrano solo gli elementi con `type: "page"` (esclusi service worker, iframe, ecc.).
- ⚠️ **Da verificare nello spike (M0)**: con molte schede, che `/json/list` restituisca *tutte* le schede, anche quelle non caricate in memoria o dentro gruppi di schede. Se ne mancano, l'alternativa è un comando CDP via WebSocket (`Target.getTargets`).
- La porta locale non è fissa: il tool ne sceglie una libera e alla fine rimuove il forward (`adb forward --remove`).

---

## 3. Collegamento wireless (adb)

Requisiti sul telefono: *Opzioni sviluppatore → Debug wireless* attivo, PC e telefono sulla stessa rete.

| Fase | Comando adb | Comando PhoneCleanKit |
|------|-------------|------------------------|
| Abbinamento (una volta sola) | `adb pair 192.168.1.50:37123 123456` | `pck pair 192.168.1.50:37123 123456` |
| Connessione | `adb connect 192.168.1.50:41235` | `pck connect [ip:porta]` |
| Ricerca automatica | `adb mdns services` | `pck connect` senza argomenti |
| Verifica | `adb devices -l` | `pck status` |

- La porta di **abbinamento** e quella di **connessione** sono diverse, e quella di connessione cambia a ogni riattivazione del debug wireless. Per questo `pck connect` senza argomenti prova prima la ricerca mDNS (`_adb-tls-connect._tcp`), poi l'ultimo indirizzo salvato nel config.
- Con più dispositivi collegati, si sceglie con `--serial <ip:porta>`; in caso contrario il tool chiede quale usare.

---

## 4. Interfaccia CLI

Nome binario: `pck`

```
pck pair <ip:porta> <codice>     Abbina il telefono (debug wireless)
pck connect [ip:porta]           Connette (mDNS / ultimo indirizzo se omesso)
pck status                       Mostra dispositivo, Chrome attivo, n° schede
pck tabs [--json]                Elenca le schede aperte (solo lettura)
pck sync [opzioni]               Comando principale: schede → markdown
```

### Opzioni di `pck sync`

| Opzione | Default | Descrizione |
|---------|---------|-------------|
| `-f, --file <path>` | `./links.md` (o `defaultFile` da config) | File markdown di destinazione |
| `--ai [provider]` | off | Descrizioni e tag generati da un LLM: `claude`, `gemini`, `local` (vedi §6.3) |
| `--model <nome>` | da config | Modello del provider AI |
| `--lang <codice>` | `it` | Lingua delle descrizioni |
| `--no-fetch` | off | Non scarica le pagine; descrizione vuota o dal titolo |
| `--close` | off | Dopo il salvataggio chiude sul telefono le schede salvate e quelle già presenti nel file |
| `-y, --yes` | off | Salta la conferma di `--close` |
| `--dry-run` | off | Mostra cosa farebbe, senza scrivere né chiudere |
| `--serial <id>` | auto | Dispositivo adb da usare |
| `--concurrency <n>` | 5 | Download paralleli dei metadati |
| `-v, --verbose` | off | Log dettagliato (comandi adb, richieste HTTP) |

### Esempio di output

```
$ pck sync --close
✔ Connesso a 192.168.1.50:41235 (Pixel 8)
✔ Chrome: 47 schede
  • 31 nuove · 12 già presenti nel file · 4 ignorate (chrome://, about:blank)
✔ Metadati scaricati (29/31, 2 errori → descrizione dal titolo)
✔ Scritte 31 voci in links.md (sezione "2026-11-14 18:32")
? Chiudere 43 schede sul telefono? (y/N) y
✔ 43 schede chiuse
```

---

## 5. Formato del file Markdown

Un unico file, una sezione `##` per ogni sync, con le voci aggiunte in fondo al file.

```markdown
# Link salvati

## 2026-11-14 18:32

- [Node.js — Documentation](https://nodejs.org/docs/latest/api/) — Documentazione ufficiale delle API di Node.js. #dev #nodejs #docs
- [Ricetta carbonara](https://example.com/carbonara) — Ricetta tradizionale con guanciale e pecorino. #cucina

## 2026-11-02 09:10

- [...](...) — ... #tag
```

### Regole del formato
- **Una voce = una riga**: `- [Titolo](URL) — Descrizione. #tag1 #tag2`
- Tag: minuscoli, kebab-case, senza spazi (`#machine-learning`), compatibili con Obsidian/GitHub.
- Il titolo viene ripulito da `[`, `]`, e dagli a capo. Dall'URL vengono tolti solo i parametri di tracciamento (`writeCleanUrls`); non viene normalizzato oltre, per non rompere i link.
- Se la descrizione manca: `- [Titolo](URL) #tag`.
- Il file può contenere **altro testo scritto a mano**: il parser legge solo le righe che rispettano il formato, ignora il resto e non lo modifica mai.
- La scrittura è atomica (file temporaneo + rename). Prima di ogni modifica viene creato un **backup a rotazione** in `.pck-backup/` accanto al file (`links-AAAAMMGG-HHMMSS.md`, suffisso `-2`, `-3`… se nello stesso secondo), conservando gli ultimi `backup.keep` (default 10). Implementato in M4-A (`src/backup.js`); prima c'era un unico `links.md.bak` sovrascritto a ogni scrittura.

### Lettura del file esistente (riferimento)
Il parser estrae da ogni voce:
- **URL** → insieme degli URL normalizzati, usato per il controllo doppioni.
- **Tag** → vocabolario con il numero di utilizzi, usato per assegnare i tag (§6).

Regex indicativa per una voce:
```js
/^\s*[-*]\s+\[(?<title>[^\]]*)\]\((?<url>[^)\s]+)\)(?:\s+—\s+(?<desc>.*?))?(?<tags>(?:\s+#[\p{L}\p{N}_/-]+)*)\s*$/u
```
(Vengono riconosciuti anche link `- [..](..)` scritti a mano senza descrizione o senza tag.)

---

## 6. Pipeline di `pck sync`

```
connect → forward → /json/list → filtra → normalizza → dedup
       → fetch metadati → descrizione+tag (regole | AI) → scrivi md → [chiudi schede]
```

### 6.1 Filtro e normalizzazione URL
Schede **ignorate**: `chrome://`, `chrome-native://`, `about:`, `data:`, `file:`, `javascript:`, pagine di nuova scheda.

Gli URL vengono **normalizzati** solo per il confronto (nel file si scrive l'URL originale):
1. Schema e host in minuscolo, si tolgono `www.` e la porta di default.
2. Si toglie il frammento `#...` (tranne gli URL "hash-router" `#/` e `#!`, configurabile).
3. Si tolgono i parametri di tracciamento: `utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `igshid`, `si`, `ref`, `ref_src` (lista estendibile da config).
4. I parametri rimasti vengono ordinati e si toglie lo slash finale nel path.
5. Gli AMP/mobile più comuni (`m.`, `amp.`, `/amp/`) restano **disattivati** di default (opzione `normalizeMobile`).

**Doppioni**: una scheda viene scartata se il suo URL normalizzato è già nel file **oppure** è già comparso in un'altra scheda della stessa sync. Un link già presente non viene **mai** ripetuto né modificato: il file è append-only e la voce esistente resta così com'è (tag compresi). Nel riepilogo i doppioni sono contati come "già presenti".

### 6.2 Metadati (default)
Per ogni link nuovo, `fetch` con:
- timeout di 8 s, al massimo 5 redirect, lettura solo dei primi ~512 KB, User-Agent generico da browser;
- concorrenza configurabile (default 5).

Dati estratti (in ordine di priorità):
- **Descrizione**: `og:description` → `meta[name=description]` → `twitter:description` → nessuna.
- **Titolo**: quello della scheda; se vuoto, `og:title` → `<title>`.
- **Segnali per i tag**: `meta[name=keywords]`, `article:tag`, `og:site_name`, `og:type`.

La descrizione viene ripulita (spazi, HTML entities) e troncata a circa 160 caratteri, su un confine di parola.
Se il download fallisce (pagina dietro login, 4xx/5xx, timeout), la voce viene scritta comunque, senza descrizione.

### 6.3 Descrizione e tag — modalità ibrida

**Modalità regole (default)**, i tag si assegnano così:
1. `tagRules.domains`: regole dominio → tag (es. `github.com → dev`, `youtube.com → video`).
2. `tagRules.keywords`: regole parola chiave (cercata in titolo, descrizione e keywords) → tag.
3. **Vocabolario del file**: un tag già usato nel file viene assegnato se il suo nome (o un sinonimo in `tagRules.aliases`) compare nel titolo, nella descrizione o nelle keywords.
4. Al massimo 4 tag per link; se non ne risulta nessuno, si usa `#da-smistare`.

**Modalità `--ai [provider]`** (implementata in M3, codice in `src/tagger/ai/`). I provider sono intercambiabili; ognuno espone solo `complete({ system, user, schema }) → testo JSON`, mentre prompt, lotti e validazione sono comuni.

| Provider | `--ai <nome>` | Implementazione | Credenziali | Default |
|----------|---------------|-----------------|-------------|---------|
| Locale | `local` | `fetch` su endpoint **compatibile OpenAI** `/v1/chat/completions` con `response_format: json_schema`. Funziona con LM Studio (default `http://localhost:1234/v1`), Ollama (`http://localhost:11434/v1`), llama.cpp | nessuna (`apiKeyEnv` opzionale) | modello **rilevato in automatico**: quello caricato in LM Studio (`/api/v0/models`), altrimenti il primo di `/v1/models` |
| Claude | `claude` | `@anthropic-ai/sdk`, `messages.create` con `output_config.format` (`json_schema`) ed `effort: low` | quelle risolte dall'SDK: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` o profilo `ant auth login` | `claude-haiku-5-5`, lotti da 20 |
| Gemini | `gemini` | `@google/genai`, `models.generateContent` con `responseMimeType: application/json` + `responseJsonSchema` | `GEMINI_API_KEY` | `gemini-flash-latest`, lotti da 20 |

- `--ai` senza nome usa `ai.defaultProvider`, che di default è **`local`**: nessun dato esce dal PC e non serve una chiave. `--model <nome>` sovrascrive il modello.
- Gli SDK di Claude e Gemini sono `optionalDependencies` e vengono caricati con import dinamico. Se mancano, il messaggio indica il comando `npm install`.
- **Input per link**: indice, URL, titolo, descrizione della pagina, parole chiave e testo principale della pagina (da `<main>`/`<article>`/`<body>`, senza nav/header/footer/script), tagliato a `ai.excerptChars` (1200).
- **Vocabolario nel prompt**: tag del file con il numero di utilizzi, più i tag previsti dalle regole (dominio/parole chiave) come suggerimenti. Il vocabolario cresce **lotto per lotto**, così un tag creato nel lotto 1 viene riusato nei successivi.
- **Istruzioni**: descrizione di una frase nella lingua configurata (**default italiano**, `--lang`), ≤160 caratteri, solo con informazioni presenti nei dati; da 1 a 4 tag, preferendo quelli esistenti; tag nuovi minuscoli in kebab-case.
- **Output**: `{"items":[{"i":0,"description":"…","tags":["…"]}]}`. Si usa l'indice del lotto e non l'URL, che è più robusto. La validazione toglie blocchi `<think>` e ```` ``` ````, scarta gli indici fuori range o doppi, normalizza i tag (slug + alias) e tronca la descrizione.
- **Errori**: per ogni lotto c'è un secondo tentativo; poi quel lotto usa le regole, con un avviso. Gli errori di configurazione (server non raggiungibile, chiave mancante) fermano il sync prima di scrivere.
- Le pagine di ricerca non vengono mandate all'AI: titolo, descrizione e `#ricerca` restano quelli delle regole.
- **Indicazioni personali** (`pck.prompt.md`): file di testo libero aggiunto al prompt come "Indicazioni dell'utente", con precedenza sulle regole generali. Esempio: "se ci sono elementi di cosplay aggiungi #cosplay".
  - Ricerca del file: `--instructions <file>` (se manca è un errore) → `ai.instructionsFile` (default `pck.prompt.md`) nella cartella corrente → `~/.pck/pck.prompt.md`. Se non si trova nessun file, si procede senza.
  - I commenti `<!-- … -->` vengono tolti. I tag scritti con `#` (con almeno una lettera) entrano nel vocabolario anche se il file dei link non li contiene ancora.
  - Vale **solo con `--ai`**: la modalità a regole non interpreta il linguaggio naturale, e per lei ci sono `tagRules.keywords`/`domains` nel config.
  - Prova (2026-11-17, LM Studio): con "stampa 3D/taglio laser/legno/cosplay/DIY → #maker; cosplay → #cosplay", le orecchie da cosplay ricevono `#cosplay #maker`, i modelli in cartone `#papercraft #cosplay #maker`, OctoFoxBook `#stampa-3d #maker`, RapidChange CNC `#maker`; Puck (editor React) nessuno dei due.
- A fine sync, i **tag nuovi** vengono mostrati nel riepilogo, così si possono rivedere.
- `pck describe <url…> [--ai …]` esegue la stessa pipeline su URL dati a mano, senza telefono e senza scrivere, ed elabora anche i link già presenti nel file. Serve a provare provider e regole.

### 6.4 Scrittura
- Il file non esiste → viene creato con l'intestazione `# Link salvati`.
- Si aggiunge una sezione `## YYYY-MM-DD HH:mm` (ora locale) con le voci nell'ordine delle schede.
- Nessun link nuovo → il file resta invariato e viene mostrato il messaggio "nessun link nuovo".

### 6.5 Chiusura schede (`--close`) — implementata in M2 (`src/close.js`)
- Si chiudono **solo** le schede il cui URL normalizzato, dopo la scrittura, risulta nel file (cioè quelle appena salvate o già presenti, compresi i doppioni con frammento diverso e le pagine Google Immagini salvate come pagina d'origine).
- **Fonte di verità**: dopo la scrittura il file viene **riletto** e si usano le chiavi effettivamente presenti.
- **Elenco aggiornato**: prima di chiudere, le schede vengono **rilette** dal telefono, perché con l'AI il sync può durare minuti. Una scheda aperta o cambiata nel frattempo si chiude solo se il suo URL attuale è nel file.
- Le schede ignorate (`chrome://`, URL vuoti, IP locali, salvo `--include-local`) non vengono mai toccate.
- Viene chiesta conferma `? Chiudere N schede sul telefono? (s/N)`; `--yes` la salta. Senza terminale interattivo e senza `--yes` non si chiude nulla (avviso).
- `--dry-run --close`: mostra quante schede verrebbero chiuse (con `-v` anche quali), senza scrivere né chiudere.
- Con `--close` e nessun link nuovo, si chiudono comunque le schede già presenti nel file.
- Si chiude solo **dopo** che la scrittura del file è riuscita. Se la chiusura fallisce (es. telefono passato `offline` durante l'AI), il file resta salvato, viene indicato di rilanciare `pck sync --close` e il codice d'uscita è ≠0.
- Gli errori sui singoli tab vengono riportati senza bloccare il resto. `/json/close/<id>` risponde in testo semplice, non JSON.

---

## 7. Configurazione

File `pck.config.json`: cercato nella cartella corrente, poi in `%USERPROFILE%\.pck\config.json`.

```json
{
  "adbPath": "D:\\programmi\\scrcpy-win64-v3.3.4\\adb.exe",
  "defaultFile": "./links.md",
  "lastDevice": "192.168.1.50:41235",
  "chromePackage": "com.android.chrome",
  "devtoolsSocket": "chrome_devtools_remote",
  "fetch": { "timeoutMs": 8000, "concurrency": 5, "maxBytes": 524288 },
  "normalize": {
    "stripParams": ["utm_*", "fbclid", "gclid", "mc_cid", "mc_eid", "igshid", "si", "ref", "ref_src"],
    "keepHashRoutes": true,
    "normalizeMobile": false
  },
  "description": { "maxLength": 160, "language": "it" },
  "ai": {
    "defaultProvider": "local",
    "excerptChars": 1200,
    "providers": {
      "local":  { "baseUrl": "http://localhost:1234/v1", "model": null, "batchSize": 5, "structured": "json_schema", "timeoutMs": 300000 },
      "claude": { "model": "claude-haiku-5-5", "batchSize": 20, "effort": "low" },
      "gemini": { "model": "gemini-flash-latest", "apiKeyEnv": "GEMINI_API_KEY", "batchSize": 20 }
    }
  },
  "tagRules": {
    "domains": {
      "github.com": ["dev"],
      "stackoverflow.com": ["dev"],
      "youtube.com": ["video"],
      "amazon.it": ["shopping"]
    },
    "keywords": {
      "ricetta": ["cucina"],
      "javascript": ["dev", "javascript"]
    },
    "aliases": { "js": "javascript", "ml": "machine-learning" },
    "fallbackTag": "da-smistare"
  }
}
```

Precedenza: opzioni CLI → variabili d'ambiente (`PCK_ADB_PATH`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) → config → valori di default.

I nomi dei modelli nel config sono solo **esempi**: vanno controllati al momento dell'implementazione (M3). Le API key non si scrivono mai nel config, si leggono solo dall'ambiente.

---

## 8. Struttura del progetto

```
PhoneCleanKit/
├─ package.json            "type": "module", bin: { "pck": "bin/pck.js" }, engines node >=20
├─ bin/pck.js              entry CLI (commander)
├─ src/
│  ├─ adb.js               wrapper execFile su adb: pair, connect, mdns, devices, forward, shell
│  ├─ chrome.js            forward socket, listTabs(), closeTab(), avvio Chrome
│  ├─ url.js               filtro + normalizzazione URL
│  ├─ markdown.js          parse (url set, vocabolario tag) + render/append sezione
│  ├─ metadata.js          fetch con limite di concorrenza + estrazione meta
│  ├─ tagger/
│  │  ├─ rules.js          tagging a regole
│  │  └─ ai/
│  │     ├─ index.js       scelta del provider, prompt comune, gruppi, validazione JSON, fallback
│  │     ├─ claude.js
│  │     ├─ gemini.js
│  │     └─ local.js       endpoint compatibile OpenAI (Ollama / LM Studio / llama.cpp)
│  ├─ config.js            caricamento e merge del config
│  └─ sync.js              orchestrazione della pipeline
├─ test/                   node:test — url, markdown, rules (con fixture)
└─ docs/SPEC.md            questo documento
```

### Dipendenze previste
| Pacchetto | Uso |
|-----------|-----|
| `commander` | parsing dei comandi CLI |
| `node-html-parser` | estrazione dei meta tag (leggero, nessun DOM completo) |
| `p-limit` | concorrenza dei fetch |
| `@inquirer/prompts` | conferme e scelta del dispositivo |
| `picocolors` + `ora` | output colorato e spinner |
| `@anthropic-ai/sdk` | solo per `--ai claude` (dipendenza opzionale, import dinamico) |
| `@google/genai` | solo per `--ai gemini` (dipendenza opzionale, import dinamico) |

Il provider `local` non richiede dipendenze: usa `fetch` direttamente.

`fetch`, `node:test` e `child_process` sono già inclusi in Node (≥20; in locale c'è la v24).

---

## 9. Gestione errori

| Situazione | Comportamento |
|------------|---------------|
| adb non trovato | Errore con il path cercato e un suggerimento per `adbPath` / `PCK_ADB_PATH` |
| Nessun dispositivo / `unauthorized` | Messaggio con i passi per `pck pair` / `pck connect`; exit 2 |
| Più dispositivi senza `--serial` | Scelta interattiva (non-TTY → errore) |
| Socket DevTools assente | Avvia Chrome, attende 3 s, riprova una volta; poi exit 3 |
| Fetch dei metadati fallito | Voce scritta senza descrizione, warning nel riepilogo |
| Errore AI | Si torna alla modalità regole per quel gruppo, con warning |
| File markdown non scrivibile | Exit 4, il file originale resta intatto (scrittura atomica + `.bak`) |

Codici di uscita: `0` ok · `1` errore generico · `2` dispositivo · `3` Chrome/DevTools · `4` I/O file.

---

## 10. Privacy e sicurezza
- Il forward viene fatto solo su `127.0.0.1`, mai esposto in rete, e rimosso a fine esecuzione.
- Con `--ai claude` o `--ai gemini`, titolo, URL e un estratto della pagina vengono inviati al provider scelto. Con `--ai local` o senza `--ai` nessun dato esce dal PC, a parte i download delle pagine stesse.
- Le pagine vengono scaricate **senza** cookie del telefono, quindi i contenuti dietro login non sono visibili (è voluto).
- `--close` è l'unica operazione che modifica il telefono, ed è sempre esplicita e confermata.

---

## 11. Roadmap

| Milestone | Contenuto | Verifica |
|-----------|-----------|----------|
| **M0 – Spike** | Script minimo: connect + forward + `/json/list` stampati a schermo | Confronto del numero di schede con quello mostrato in Chrome (incluse schede non caricate e gruppi) |
| **M1 – MVP** | `pair`, `connect`, `tabs`, `sync` con metadati e regole, formato md, dedup | Test unitari su url/markdown + sync reale |
| **M2 – Close** | `--close`, `--dry-run`, conferme | Chiusura di schede di prova |
| **M3 – AI** ✅ | `--ai` con vocabolario dei tag, fallback | Confronto regole vs AI su 63 link (vedi §13) |
| **M4 – Manutenzione dell'archivio** | Proposta dettagliata in §11.1 | — |

### 11.1 Proposta M4 (2026-11-18)

Stato di partenza (`links.md`): 208 voci in 3 sezioni, 26 tag, 0 URL doppi. Da sistemare: 18 `#da-smistare`, 12 voci senza descrizione, ~30 descrizioni in inglese, quasi tutte nella sezione del 14/11 creata con le sole regole. Tag più usati: `dev` 53, `maker` 42, `shopping` 33, `casa` 29, `ai` 28. Coppie frequenti: `ai+dev` 22, `casa+shopping` 14, `maker+stampa-3d` 12.

Principio comune: i comandi che **modificano** `links.md` toccano solo le righe interessate, mostrano un'anteprima (`--dry-run`, con prima/dopo) e salvano un backup con data e ora prima di scrivere.

| # | Comando | Cosa fa | Priorità |
|---|---------|---------|----------|
| A | backup a rotazione | `links.md.bak` viene sovrascritto a ogni scrittura, quindi due operazioni di fila perdono l'originale. Sostituirlo con `.pck-backup/links-AAAAMMGG-HHMMSS.md`, conservando gli ultimi N (default 10). | Prerequisito di B–D |
| B | `pck retag` | Rigenera descrizione e tag con l'AI per le voci filtrate: `--tag da-smistare`, `--no-description`, `--lang-mismatch` (descrizione non nella lingua configurata), `--section "<data>"`, `--url <parte>`, `--all`. Titolo e URL invariati. Generalizza lo script usato il 17/11. Effetto immediato: sistema la sezione del 14/11. | Alta |
| C | `pck tags` | Statistiche: utilizzi per tag, tag usati una sola volta, coppie frequenti, voci senza tag, `--json`. | Alta |
| C | `pck tags rename <vecchio> <nuovo>` / `merge <a> <b> --into <c>` / `remove <tag>` | Riscrive i tag nel file e aggiunge in automatico l'**alias** nel config (`vecchio → nuovo`), così regole e AI non lo ricreano. Generalizza quanto fatto a mano con `#paper → #papercraft`. | Alta |
| D | `pck check` | Controllo del file: righe malformate, URL doppi, voci senza tag o descrizione, tag non in kebab-case; `--links` verifica anche i link morti (HTTP 404/410, dominio inesistente). Solo lettura, con riepilogo e codice d'uscita. | Media |
| E | installazione | `npm link` → comando `pck` ovunque; `pck init` crea `~/.pck/config.json` e `~/.pck/pck.prompt.md` da un modello commentato; `engines` a Node ≥ 22 (richiesto dalla sorgente PC). | Media |
| F | `pck view` | Genera un file **derivato** (es. `links-per-tag.md`, o una pagina HTML con ricerca e filtri per tag) senza toccare `links.md`. | Opzionale |
| G | `pck open` | L'inverso di `--close`: riapre sul telefono o sul PC i link con un tag o di una sezione (`Target.createTarget` sul PC, intent `VIEW` via adb sul telefono). | Opzionale |

**Stato M4** (2026-11-18): repository git creato (commit iniziale `0efd694`, `links.md` incluso, `.pck-backup/` escluso).
- **A – fatto** (`fd8dece`): `src/backup.js`, test in `test/backup.test.js`.
- **B – fatto**: `pck retag` (`src/retag.js`). La logica AI comune a `sync` e `retag` è stata spostata in `src/describe.js`; il rilevamento della lingua è in `src/lang.js`; le funzioni per lavorare riga per riga (`entryLines`, `replaceLines`, `replaceTrailingTags`) sono in `src/markdown.js`.
  - Prova su una **copia** di `links.md` (`--tag da-smistare --empty --lang-mismatch`): 50 voci selezionate (49 della sezione 14/11), 50/50 rigenerate con LM Studio in 67 s, 50 righe cambiate e nessun'altra, 0 `#da-smistare` rimasti, backup creato. Il `links.md` reale non è stato modificato.
- **C – fatto**: `pck tags` (`stats` di default, `rename`, `merge --into`, `remove`, tutti con `--dry-run`), codice in `src/tags.js`. Gli alias vengono salvati con `saveConfigPatch` (config locale se esiste, altrimenti quello utente). Anche i tag suggeriti dalle regole al vocabolario dell'AI passano dagli alias.
  - Prova su una copia, in una cartella con il proprio `pck.config.json`: `rename informazioni info` (15 voci), `merge strumenti internet --into tecnologia` (19), `remove emulazione` (2): 34 righe cambiate, 3 backup (suffisso `-2` nello stesso secondo), alias scritti nel config locale, config utente invariato. Sul file reale solo `tags` (statistiche) e `rename --dry-run`.
  - Difetti trovati e corretti durante la prova: un config salvato con **BOM UTF-8** (tipico di Blocco note/PowerShell) non veniva letto; un config non valido produceva uno stack trace invece di un messaggio.

Note:
- B usa la stessa pipeline AI di `sync` (lotti, vocabolario, indicazioni, divisione dei lotti). La scrittura sostituisce le righe una per una e non riordina il file.
- C `rename` con un nome già esistente equivale a `merge`. I tag riservati (`da-smistare`, `ricerca`) non si possono rinominare in un tag esistente senza `--force`.
- D `--links` fa una richiesta per URL (≈200): solo su richiesta esplicita. Siti che bloccano i bot (403) → "non verificabile", non "morto".
- Fuori da M4: ordinare o riorganizzare `links.md` (resta append-only per sezioni, facile da confrontare con git); un repository git della cartella resta comunque consigliato.

## 12. Risultati spike M0 (2026-11-14)

Esecuzione: `node scripts/spike-tabs.mjs 192.168.1.2:41401` → **funziona**.
- `adb connect` riuscito; Chrome era già in esecuzione (`Chrome/157.0.8103.50`, `com.android.chrome`).
- `/json/list` ha restituito **65 target, tutti `type: "page"`**. Non serve root né "USB web debugging" in Chrome.
- La porta 39271 era stata rifiutata: conferma che la porta cambia, quindi serve `pck connect` con mDNS e l'ultimo indirizzo usato (§3).

Cose emerse dai dati reali, da gestire in M1:
1. **Entity HTML nei titoli**: Chrome restituisce titoli come `Karpathy&#39;s`, `Shows &amp; Tickets`, quindi vanno decodificati.
2. **Tracciamento molto presente**: `fbclid`, `utm_*`, `gclid`, `gad_source`, `gad_campaignid`, `utm_id`, `utm_adset_id`, `utm_adname_id`, `ep`… Il pattern `utm_*` va bene; aggiungere `gad_*` alla lista di default.
3. **Doppioni "quasi uguali"**: `fibra.iliad.it/subscribe-fibra/#modal-call-me-back` e `fibra.iliad.it/subscribe-fibra/` diventano uguali togliendo il frammento: la normalizzazione funziona come previsto.
4. **Pagine di ricerca** (DuckDuckGo `?q=`, Google `/search`, `/imgres`): conviene trattarle a parte. Proposta: tag automatico `#ricerca`, e per `google.com/imgres` usare come link principale `imgrefurl`.
5. **URL locali / di sviluppo** (`http://192.168.1.9:5173/`): proposta di ignorare di default gli IP privati e `localhost` (opzione `skipPrivateHosts`).
6. **Titoli generici** (`www.printables.com`, `Google Image Result`, `Cerca con Google`): in questi casi meglio usare `og:title` dai metadati.

✅ **Verificato sul telefono**: anche il contatore di Chrome mostra 65 schede, quindi `/json/list` restituisce tutte le schede. Il fallback CDP (`Target.getTargets`) non serve.

Decisioni confermate (2026-11-14), implementate in M1:
- Pagine di ricerca: tag `#ricerca`; titolo/descrizione ricavati dalla query (`Ricerca DuckDuckGo: ikea kallax`); la pagina non viene scaricata.
- Google Immagini (`/imgres`): viene salvata la pagina d'origine (`imgrefurl`).
- URL locali (localhost, IP privati, `.local`): ignorati di default, inclusi con `--include-local`.

### Run telefono con 149 schede (schede inattive ripristinate) — 2026-11-17
- `sync --ai --close -y` su `192.168.1.2:42909`: 149 schede → 139 nuove (9 già presenti, 1 doppia), metadati 114/131.
- **Errore**: il 1° lotto è fallito con `Context size has been exceeded` e quei 5 link sono passati alle regole. **Causa**: il modello in LM Studio ora *ragiona* prima di rispondere (`reasoning_tokens` ≈ 800 per un solo link, contro 0 nella prova delle 14:34), e il ragionamento riempie il contesto di 8192 token.
- Le 139 voci sono state comunque scritte (sezione 17:19) dal processo `node`, che è rimasto attivo dopo l'arresto della shell che lo aveva lanciato. Poi si è interrotto prima di chiudere le schede.
- **Correzioni**:
  - provider locale: `reasoning_effort: "none"` di default (`ai.providers.local.reasoningEffort`; `null` per non inviarlo; se il server rifiuta il parametro con un 400 viene tolto automaticamente). Provato su LM Studio: 5 link in **6,9 s**, contro ~43 s nelle prove precedenti;
  - tetto alla risposta (`max_tokens` = 250 × link + 300) e limiti di lunghezza sui campi del prompt (titolo 200, URL 300, descrizione pagina 400, parole chiave 200 caratteri);
  - **errore di dimensione** (contesto pieno o risposta troncata): il lotto non viene ripetuto uguale ma diviso a metà, fino al singolo link; poi un tentativo senza testo della pagina; solo dopo le regole.
- Chiusura poi eseguita con `sync --ai --close -y`: 0 nuove, **149 schede chiuse**.
- Le voci della sezione 17:19 rimaste con le regole (14: il primo lotto fallito, più quelle con `#da-smistare` o senza descrizione; ricerche escluse) sono state **rigenerate** con `describe --ai` (14/14 in 19 s). Nel file sono stati sostituiti solo descrizione e tag; titolo e URL sono rimasti invariati, il backup è in `links.md.bak` e le voci restano 208. L'operazione è stata fatta con uno script una tantum: un comando `pck retag` è candidato per M4.
- Da rivedere: il modello usa spesso un tag generico `#informazioni` (15 voci). I 18 `#da-smistare` rimasti sono della sezione del 14/11, creata con le sole regole.
- Test: 32 verdi.

### Sorgente PC: Chrome desktop (`--source pc`) — 2026-11-17
Stessa pipeline (doppioni, AI, indicazioni, `--close`): cambia solo da dove arrivano le schede. Codice in `src/sources/` (`index.js` sceglie la sorgente, `pc.js` per il PC; il telefono usa `adb.js` + `chrome.js` come prima).
- **Perché non `--remote-debugging-port`**: dalle versioni recenti di Chrome il flag non funziona sul profilo predefinito, quindi non si potrebbero leggere le schede del profilo normale.
- **Metodo**: da Chrome 144 l'utente attiva il debug remoto dell'istanza in uso da `chrome://inspect/#remote-debugging`. Chrome scrive `DevToolsActivePort` nella cartella dati (riga 1: porta, riga 2: percorso `/devtools/browser/<id>`) e mostra una **finestra di approvazione per ogni connessione**. Gli endpoint HTTP `/json/*` possono non rispondere, quindi si usa solo CDP via WebSocket:
  - elenco: `Target.getTargets` → solo `type: "page"` senza `subtype` (esclusi prerender, service worker, iframe, target `tab`);
  - chiusura: `Target.closeTarget`.
- **Una sola connessione per esecuzione**: con `--ai --close` tra lettura e chiusura passano minuti, ma l'approvazione è una sola.
- Cartella dati: `%LOCALAPPDATA%\Google\Chrome\User Data` (Windows), `~/Library/Application Support/Google/Chrome` (macOS), `~/.config/google-chrome` (Linux); si cambia con `pc.userDataDir`. In alternativa `pc.browserUrl` per un Chrome avviato con `--remote-debugging-port` (via `/json/version` → `webSocketDebuggerUrl`).
- Errori: `DevToolsActivePort` assente → istruzioni per attivare il debug remoto (exit 3). Connessione non approvata entro `pc.approvalTimeoutMs` (60 s) o rifiutata → messaggio dedicato. Serve Node ≥ 22 per il WebSocket integrato.
- `--source` è un'opzione globale (`sync`, `tabs`, `status`); il default è `defaultSource: "phone"`.
- **Prova sul PC** (2026-11-17, Chrome 157.0.8103.79, debug remoto su `127.0.0.1:9222`): `DevToolsActivePort` letto, approvazione in Chrome, `tabs --source pc` → 35 schede con titoli e URL. `sync --source pc --close --dry-run` → 34 nuove, 1 ignorata (`chrome://inspect`), metadati 27/34, 34 schede da chiudere; nessuna scrittura né chiusura.
- **Siti esclusi** (`exclude` nel config; decisione dell'utente dopo la prova): app web da tenere aperte, che non vengono **mai salvate né chiuse** (motivo `escluso` nel riepilogo). Vale per entrambe le sorgenti.
  - Voce `"host"`: host esatto e sottodomini, `www.` ignorato (`web.whatsapp.com`). Voce `"host/percorso"`: solo quel prefisso, su segmenti interi (`gemini.google.com/app` esclude le chat ma non `gemini.google.com/`).
  - Default: `web.whatsapp.com`, `web.telegram.org`, `mail.google.com`, `calendar.google.com`, `outlook.live.com`, `outlook.office.com`, `teams.microsoft.com`, `meet.google.com`. Una lista in `pck.config.json` **sostituisce** quella di default.
  - Le chat di Gemini non sono escluse di default; per escluderle si aggiunge `gemini.google.com/app`.
  - Test unitari: 30 verdi. Anteprima sul PC con la lista (`sync --source pc --close --dry-run`): 35 schede → 33 nuove, 2 ignorate (`chrome://inspect`, `web.whatsapp.com` come `escluso`); 33 da chiudere, restano aperte `chrome://inspect` e WhatsApp Web. Nessuna scrittura né chiusura.
- Fonti: [Chrome DevTools – auto connect](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect.md.txt), [blog Chrome](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session).

### Limite: schede inattive di Chrome (verificato 2026-11-17)
Chrome archivia le schede non usate da tempo nella sezione **"Schede inattive"** (sul telefono di prova: "186 inactive items"). Queste schede **non sono esposte da DevTools**: `/json/list` e CDP `Target.getTargets` (endpoint browser) restituiscono solo le schede normali (1 sola nella prova). Senza root non c'è altro modo di leggerle (i dati di Chrome sono in `/data/data/com.android.chrome`).
- **Procedura scelta dall'utente**: in Chrome → vista schede → "Schede inattive" → "Ripristina tutte"; poi `pck sync [--ai] --close`. Per non farle riformare: Impostazioni → Schede → Schede inattive → "Mai".
- Scartata l'automazione dell'interfaccia via adb (uiautomator): fragile rispetto a versione di Chrome, lingua e dispositivo, e dall'interfaccia si leggono solo i titoli, non gli URL.
- Dopo `--close`, il tool ricorda che le schede inattive non sono incluse.
- Tempi da prevedere per ~186 schede: con le regole meno di un minuto; con `--ai local` (~9,5 s a link) circa **30 minuti**. Se il telefono va offline durante l'AI, il file resta salvato e basta rilanciare `pck sync --close`.

## 13. Stato dell'implementazione

**M1 – completato e provato sul telefono** (2026-11-14): `pair`, `connect`, `status`, `tabs`, `sync` (`--file`, `--dry-run`, `--no-fetch`, `--include-local`, `--concurrency`), più `config-path`.
- 17 test unitari (`npm test`) su URL, markdown e regole dei tag: tutti verdi.
- Estrazione dei metadati provata su URL reali: GitHub, GialloZafferano e open-pinball OK. Printables (403) e Facebook (400) bloccano i download automatici → voce scritta senza descrizione.
- **Provato sul telefono** (Realme RMX3370, Chrome 157, `192.168.1.2:37491`):
  - 1° `sync`: 66 schede → 63 voci scritte, 1 doppia (iliad con `#modal…`), 2 ignorate (1 URL vuoto, 1 IP locale). Metadati 51/55 (4 siti bloccano i download automatici). 19 tag creati.
  - 2° `sync`: 0 nuove, 64 già presenti, file invariato (stesso hash).
  - Il secondo `sync` senza `--serial` ha riusato l'indirizzo salvato.

Correzioni emerse dalla prova reale:
- **URL scritti puliti** (`writeCleanUrls: true`, default): nel file vengono tolti i parametri di tracciamento (`fbclid`, `utm_*`…), il resto dell'URL (frammento compreso) resta invariato. *Questo cambia §5*, dove era previsto l'URL originale.
- **Stesso telefono due volte in adb** (`ip:porta` e nome mDNS `adb-<serial>-…._adb-tls-connect._tcp`): i dispositivi vengono raggruppati per `getprop ro.serialno`. Nota: `adb get-serialno` restituisce il nome del trasporto, non il seriale.
- **Titoli generici** (`www.printables.com`, `Google Image Result`) senza metadati disponibili: titolo ricavato dall'URL (`Digital eyes project — printables.com`).
- Titoli GitHub ripuliti (`GitHub - owner/repo: … · GitHub` → `owner/repo: …`).
- Descrizioni scartate se già contenute nel titolo (es. Codeberg "FindMyWeb").
- Schede con URL vuoto contate come `vuota`.

Limiti noti della modalità a regole: circa 1 link su 4 finisce in `#da-smistare` (siti di negozi, viaggi, eventi senza regole). Le soluzioni sono aggiungere regole al config oppure usare `--ai` (M3).

Differenze rispetto alle sezioni precedenti:
- Il limite dei tag è in `tagRules.maxTags`; i tag di default sono in `src/config.js`.
- Per gli alias non vale il filtro sulla lunghezza minima (es. `js` → `javascript`); per i nomi dei tag del vocabolario sì (≥3 caratteri).
- Oltre alle voci formattate, anche **qualsiasi URL scritto a mano** nel file conta per i doppioni.

**M2 – implementato** (2026-11-17): `--close`, `-y/--yes`, `--dry-run` con `--close` (vedi §6.5). Test unitari della scelta delle schede (`test/close.test.js`): 26 test totali verdi.
- **Prova sul telefono** (2026-11-17, `192.168.1.2:43493`, 60 schede):
  - `sync --close --dry-run -v`: 0 nuove, 59 già presenti → 59 da chiudere, 1 resta aperta (`http://192.168.1.9:5173/`, locale). Nessuna chiusura.
  - Chiusura reale provata su una **scheda di prova** aperta apposta (`am start … example.com/?pck-close-test=…`): `/json/close/<id>` → "Target is closing"; schede 61 → 60, scheda di prova sparita. Le schede dell'utente non sono state toccate.
  - `sync --close` senza `-y` e senza terminale interattivo: avviso, nessuna scheda chiusa (sempre 60).
  - Chiusura reale confermata dall'utente: `sync --close -y` → **59 schede chiuse**, 0 errori. Rimasti: Steam Racers locale e una scheda vuota, probabilmente la nuova scheda che Chrome apre da sé quando restano poche schede.

**M2 – completato e provato sul telefono.**

**M3 – completato** (2026-11-17): `--ai [local|claude|gemini]`, `--model`, `--lang`, `--instructions`, `pck describe`. 24 test unitari verdi (prompt, parsing, validazione, lotti con ripiego).
- **Prova con LM Studio** (`gemma-4-12b-it-uncensored`, contesto 8192, lotti da 5) sui 63 link reali di `links.md`, tramite `pck describe --ai local`. Il telefono era scollegato; la pipeline è la stessa di `sync`.
  - 55/55 link elaborati (le 8 pagine di ricerca restano alle regole), nessun lotto fallito, **525 s (~9,5 s a link)**.
  - `#da-smistare` è sceso da **18 link (regole) a 0**; le descrizioni sono in italiano, concrete e senza toni promozionali, anche per le pagine in inglese.
  - Tag creati: `#musica`, `#viaggi`, `#abbigliamento`, `#video`, `#fai-da-te`; per il resto ha riusato quelli esistenti.
- Correzioni emerse dalla prova:
  - `#da-smistare` e `#ricerca` sono **riservati**: non vengono passati all'AI e vengono tolti dalle sue risposte (il modello usava `#ricerca` per "ricerca scientifica").
  - Vengono scartati i tag "storpiati" con cifre finali (`gio1`).
  - Con `describe --ai <url>`, commander assegnava il primo URL a `--ai`: ora un valore che non è un provider torna nella lista degli URL.
- **`sync --ai` sul telefono** (2026-11-17, `192.168.1.2:40925`): 61 schede → 6 nuove, 54 già presenti, 1 ignorata (IP locale). Metadati 5/6. AI 6/6 in 111 s, 6 voci aggiunte a `links.md` in una nuova sezione e `links.md.bak` creato. Errori del modello rivisti a mano: `#paper` e `#stampa-3d` su un sito di modelli in cartone.
- **Tag `#paper` → `#papercraft`** (decisione dell'utente: il tag indica i lavori con carta e cartone):
  - regole: parole chiave `papercraft`, `paper craft`, `cardboard`, `cartone`, `cartoncino`, `origami` → `#papercraft`; dominio `cardboardtemplates.com` → `#papercraft`;
  - alias `paper` / `paper-craft` → `papercraft`, così anche un `#paper` proposto dall'AI viene convertito;
  - arxiv.org ora ha `#articolo-scientifico` (prima `#paper`);
  - `links.md` aggiornato a mano: BrickWright `#paper` → `#articolo-scientifico`; CardboardTemplates `#paper #stampa-3d` → `#papercraft`.
- **Connessione wireless instabile**: pochi minuti dopo il sync il telefono è passato a `offline` (porta chiusa dal telefono, che non la riapre da solo). Il tool riprova l'ultimo indirizzo salvato; ora il messaggio d'errore elenca gli indirizzi provati e spiega lo stato `offline`.
- **Non provati**: i provider `claude` e `gemini` (nessuna chiave disponibile). Il codice segue le API documentate dei rispettivi SDK (`output_config.format` / `responseJsonSchema`).
- **Limiti noti**: errori occasionali del modello locale (es. `#paper` sul progetto IKEA `bygga`). Il riepilogo "Tag nuovi" serve a rivederli. Con un modello più grande o con `--ai claude` la qualità aumenta, ma il modello va scelto in base al tempo disponibile.

Decise:
- Lingua delle descrizioni: **italiano** di default, configurabile.
- Link già presente nel file: **non viene ripetuto né modificato** (append-only).
- AI multi-provider: Claude, Gemini, locale (endpoint compatibile OpenAI).
