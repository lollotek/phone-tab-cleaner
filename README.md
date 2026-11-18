# PhoneCleanKit (`pck`)

Legge le schede aperte di Chrome sul telefono Android (adb, debug wireless) e le salva in un file Markdown con descrizione e tag, senza mai ripetere i link già presenti.

Specifica completa: [docs/SPEC.md](docs/SPEC.md).

## Installazione

```bash
npm install
npm link        # opzionale: rende disponibile il comando `pck`
```

Senza `npm link` si usa `node bin/pck.js <comando>`.

## Uso rapido

```bash
pck pair 192.168.1.2:37123 123456      # solo la prima volta (porta e codice di "Abbina dispositivo")
pck connect 192.168.1.2:41401          # porta mostrata in "Debug wireless" (cambia ogni volta)
pck status                             # dispositivo, Chrome, numero di schede
pck tabs                               # elenco schede (--json per l'output JSON)
pck sync --dry-run                     # anteprima delle voci, senza scrivere
pck sync                               # aggiunge i link nuovi a ./links.md
pck sync -f D:\note\links.md           # file diverso
pck sync --close --dry-run -v          # quali schede verrebbero chiuse
pck sync --ai --close                  # salva e poi chiude sul telefono le schede salvate (chiede conferma; -y per saltarla)
```

Opzioni globali: `--serial <ip:porta>`, `--adb <path>`, `-v` (log dettagliato).
Opzioni di `sync`: `-f/--file`, `--dry-run`, `--close`, `-y/--yes`, `--no-fetch`, `--include-local`, `--concurrency <n>`, `--ai [provider]`, `--model <nome>`, `--lang <codice>`.

## Descrizioni e tag con l'AI

```bash
pck sync --ai                          # provider di default: local (LM Studio su localhost:1234)
pck sync --ai claude                   # Claude (ANTHROPIC_API_KEY o `ant auth login`)
pck sync --ai gemini                   # Gemini (GEMINI_API_KEY)
pck sync --ai local --model qwen/qwen3.5-9b
pck describe --ai https://example.com https://github.com/...   # prova senza telefono, non scrive
```

### Indicazioni personali per i tag

Scrivi le tue regole in linguaggio naturale in [pck.prompt.md](pck.prompt.md): il testo viene aggiunto al prompt dell'AI. Il file si cerca nella cartella corrente, poi in `%USERPROFILE%\.pck\`, oppure si indica con `--instructions <file>`. Esempio:

```markdown
- Se ci sono elementi di stampa 3D, taglio laser, lavorazione del legno, cosplay o DIY, aggiungi il tag #maker.
- Se ci sono elementi di cosplay, aggiungi anche il tag #cosplay.
```

I tag scritti con `#` vengono proposti al modello anche se non sono ancora nel file dei link. Vale solo con `--ai`; per la modalità a regole si usano `tagRules.keywords` e `tagRules.domains` nel config.

Con `local` il modello è quello caricato in LM Studio. Per Ollama imposta `ai.providers.local.baseUrl` a `http://localhost:11434/v1` e scegli il modello con `--model`. Se l'AI fallisce su un lotto, quei link ricevono descrizione e tag dalle regole.

**Schede inattive:** Chrome archivia le schede vecchie nella sezione "Schede inattive", che il tool non riesce a leggere. Prima del sync ripristinale in Chrome (vista schede → Schede inattive → Ripristina tutte). Per non farle riformare: Impostazioni → Schede → Schede inattive → Mai.

L'ultimo indirizzo usato viene salvato in `%USERPROFILE%\.pck\config.json`: le volte successive basta `pck sync` (se la porta non è cambiata).

## Chrome sul PC (`--source pc`)

Lo stesso tool funziona anche con le schede di Chrome aperto sul PC, con il tuo profilo normale:

1. In Chrome (versione 144 o successiva) apri `chrome://inspect/#remote-debugging` e attiva il debug remoto per l'istanza in uso (basta farlo una volta).
2. Lancia il comando: Chrome mostra una finestra per **approvare** il collegamento, una sola volta per esecuzione.

```bash
pck tabs --source pc
pck sync --source pc --ai --close
```

**Siti esclusi:** le app web da tenere aperte non vengono mai salvate né chiuse. Di default sono WhatsApp Web, Telegram Web, Gmail, Google Calendar, Outlook, Teams e Meet. Per cambiarle si imposta `exclude` in `pck.config.json`, ricordando che la lista sostituisce quella di default:

```json
{ "exclude": ["web.whatsapp.com", "mail.google.com", "gemini.google.com/app"] }
```

Una voce `host` vale anche per i sottodomini; `host/percorso` limita a un percorso (es. solo le chat di Gemini).

Per usare il PC come sorgente predefinita: `"defaultSource": "pc"` in `pck.config.json`. In alternativa ci si può collegare a un Chrome avviato con `--remote-debugging-port` (con una cartella dati separata), impostando `"pc": { "browserUrl": "http://127.0.0.1:9222" }`.

## Interfaccia web (`pck ui`)

```bash
pck ui                    # avvia il server locale e apre il browser
pck ui --no-open          # stampa solo l'indirizzo
pck ui --port 4320 -f D:\note\links.md
```

L'interfaccia gira solo su `127.0.0.1`. L'indirizzo stampato contiene un token di accesso (`#t=…`) che cambia a ogni avvio; un'altra scheda va aperta con quell'indirizzo. Ctrl+C nel terminale la chiude.

- **In alto**: lo stato di AI (provider e modello), del telefono e di Chrome sul PC, con i dettagli al passaggio del mouse.
- **Funzioni**:
  - **Sync telefono / Sync PC**, con le opzioni "con AI" e "chiudi schede salvate": prima della chiusura mostra quante schede verranno chiuse e chiede conferma;
  - **Controlla**, anche con verifica dei link;
  - **Annulla ultima**, che rimette il backup più recente;
  - **Cestino**.

  Le operazioni lunghe mostrano l'avanzamento, con il log completo sotto "Log".
- **Ricerca**: testo libero; `#tag` filtra (più tag = tutti richiesti); `-#tag` esclude; `-parola` esclude un testo. Un clic su un tag lo aggiunge al filtro, Alt+clic lo esclude. `/` porta alla ricerca. Dopo "Controlla" compare il filtro "solo con problemi".
- **Ogni voce**: modifica tag (con suggerimenti dai tag già usati; Invio salva, Esc annulla), modifica descrizione (Ctrl+Invio salva), rigenera con AI, apri sul telefono, apri in Chrome sul PC, elimina.
- **Selezione multipla**: aggiungi tag, togli tag, rigenera con AI, apri sul telefono/PC, elimina. "Seleziona tutti i risultati" agisce solo sulle voci filtrate.
- **Cestino**: le voci eliminate vanno in `links-eliminati.md` accanto a `links.md` e si possono ripristinare. `sync` non le salva di nuovo e, con la chiusura delle schede attiva, chiude anche le loro schede.
- Ogni modifica passa dai backup in `.pck-backup/`. Se il file cambia altrove (es. `pck sync` dal terminale), la pagina si aggiorna invece di sovrascriverlo. Durante sync e rigenera le modifiche dalla pagina sono sospese.
- La pagina stessa (`127.0.0.1:4317`) non viene mai salvata né chiusa dai sync.
- Con la sorgente PC, Chrome chiede di approvare ogni collegamento: con "chiudi schede" le richieste sono due, una per l'anteprima e una per il sync.

## Rigenerare voci già salvate (`pck retag`)

Rigenera descrizione e tag di voci già presenti nel file, con l'AI (default) o con le sole regole (`--no-ai`). Titolo e URL restano invariati e vengono riscritte solo le righe scelte.

```bash
pck retag --tag da-smistare --dry-run          # anteprima prima/dopo
pck retag --tag da-smistare --empty --lang-mismatch
pck retag --all --section 2026-11-14           # tutta una sezione
pck retag --all --url github.com --ai claude
```

Filtri sui problemi (basta che una voce ne soddisfi uno): `--tag <tag>`, `--empty` (senza descrizione), `--lang-mismatch` (descrizione non nella lingua configurata; riconosce italiano e inglese), `--all`. Filtri sull'ambito (devono valere tutti): `--section <titolo>`, `--url <testo>`, `--limit <n>`. Le pagine di ricerca non vengono rigenerate. Se l'AI non riesce su una voce, quella voce resta com'è.

## Gestire i tag (`pck tags`)

```bash
pck tags                                         # statistiche: utilizzi, tag usati una volta, coppie frequenti (--json)
pck tags rename informazioni info --dry-run      # anteprima prima/dopo
pck tags rename informazioni info
pck tags merge strumenti internet --into tecnologia
pck tags remove emulazione
```

- Si modificano solo i tag finali delle voci; descrizioni, URL (anche con `#frammento`) e testo libero restano intatti.
- `rename` e `merge` aggiungono l'**alias** vecchio → nuovo nel config (`./pck.config.json` se esiste, altrimenti `~/.pck/config.json`), così regole e AI non ricreano il vecchio nome. Se rinomini `da-smistare` o `ricerca`, viene aggiornato anche `fallbackTag` / `searchTag`.
- `rename` verso un tag che esiste già equivale a un accorpamento: nella stessa voce non compaiono doppioni.
- `remove` non crea alias e segnala le voci rimaste senza tag.
- Se `pck.prompt.md` cita il vecchio tag viene mostrato un avviso, perché è testo libero e va aggiornato a mano.

## Controllare il file (`pck check`)

```bash
pck check                 # solo il file: nessuna richiesta di rete
pck check --links         # verifica anche i link morti (una richiesta per voce)
pck check --json          # per script
```

È in sola lettura. Gli **errori** fanno uscire il comando con codice 1:
- righe che sembrano voci ma non rispettano il formato;
- URL non validi;
- URL doppi (anche se differiscono solo per tracciamento, `www.` o slash finale);
- con `--links`, link morti (HTTP 404/410 o dominio non trovato nel DNS).

Gli **avvisi** sono voci senza tag o senza descrizione, tag non in kebab-case (con il nome suggerito) e, con `--links`, link non verificabili (siti che bloccano i bot con 403/429, errori del server, timeout). Per ogni tipo di problema viene suggerito il comando per correggerlo (`pck retag --empty`, `pck tags rename …`); `--max <n>` mostra più righe.

## Backup

Prima di ogni modifica di `links.md` il tool ne salva una copia in `.pck-backup/` (es. `links-20261118-101500.md`) e conserva le ultime 10. Il numero si cambia con `"backup": { "keep": 20 }` nel config. Per ripristinare basta copiare il backup al posto di `links.md`; se la cartella è sotto git, si può usare anche `git checkout links.md`.

## Configurazione

Le regole per i tag (dominio → tag, parole chiave → tag, alias), i parametri di tracciamento da ignorare e il percorso di adb si personalizzano in `pck.config.json` nella cartella corrente, oppure in `%USERPROFILE%\.pck\config.json`. I valori di default sono in [src/config.js](src/config.js); basta indicare le chiavi da cambiare, ad esempio:

```json
{
  "defaultFile": "D:/note/links.md",
  "tagRules": {
    "domains": { "makerworld.com": ["stampa-3d"] },
    "keywords": { "pinball": ["giochi", "flipper"] }
  }
}
```

I tag già usati nel file vengono riassegnati in automatico quando il loro nome compare nel titolo o nella descrizione di un nuovo link.

## Test

```bash
npm test
```
