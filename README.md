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
