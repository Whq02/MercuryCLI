[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI (mercury-cli.ai, pacchetto npm `mercury-tech-cli`) esegue agenti di programmazione con IA nel terminale, all'interno dei tuoi repository git su macOS, Linux e Windows.

Sito web: [mercury-cli.ai](https://mercury-cli.ai) · Repository: [github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI) (`Whq02/MercuryCLI`) · npm: `mercury-tech-cli`

Un agente legge e modifica i file, esegue comandi di shell, avanza passo passo nei test e nei debugger e verifica i risultati. Scegli tu il provider del modello, il modello e che cosa l'agente può fare:

- **Concourse multisessione e worktree isolati:** esegui più sessioni fianco a fianco nel Session Concourse (`/concourse`) e delega in parallelo il lavoro a crewmate di provider diversi (`Crewmate`), in checkout isolati di `git worktree` con prenotazioni dei file di progetto, così che gli agenti paralleli non si sovrascrivano a vicenda.
- **20 provider di modelli, `/llmhost` e `/localsetup`:** mantieni attivo l'accesso a tutti i 20 provider contemporaneamente (OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot/Kimi, Z.AI/GLM, OpenRouter, Hugging Face, xAI/Grok, Meta/Muse, Mistral, Nous Portal, OpenCode Zen, Qwen, MiniMax, Together AI, Cohere, Groq, Cerebras, Fireworks AI) e cambia provider e modello durante la chat. Apri `/llmhost` per scegliere un modello, controllarne la quantizzazione, la suddivisione `conversations × context` e il livello di ragionamento, ed eseguirlo su una GPU in affitto (Runpod, Vast.ai o Lambda), sul tuo computer (`mercury host`) o su un server esistente. Oppure esegui `/localsetup` per installare o collegare Ollama insieme a LM Studio, vLLM e llama.cpp.
- **Memoria di progetto RAG ibrida Mneme:** usa un modello di embedding semantico BGE da 118 MB eseguito in locale (`bge-base-en-v1.5`), con ranking delle parole BM25, tracciamento delle citazioni, regole fissate riportate alla lettera, contesto di avvio sensibile al branch, controlli di contraddizione al momento della scrittura, note di handoff tra una sessione e l'altra e il grafo nel browser di `/memory page`.
- **Strumenti per compilatore, AST e debug DAP:** collega l'intelligenza del codice LSP e i refactoring con anteprima (`LspRead`, `LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`), la ricerca e la riscrittura strutturale sull'AST con tree-sitter in 23 linguaggi (`AstSearch`, `AstEdit`), un debugger integrato per il Debug Adapter Protocol (`Debug`) che usa `debugpy`, `js-debug`, `lldb`, `gdb` e `dlv` per procedere passo passo nei test falliti di Python, Node, Go e Rust, e celle `Eval` persistenti di Python e JavaScript.
- **`WebSearch` senza chiave e `WebFetch` in markdown:** cerca tramite la ricerca nativa del provider, le chiavi di Brave o Tavily, le API ufficiali (Stack Exchange, npm, PyPI, crates.io, GitHub, Hacker News, Wikipedia), SearXNG e DuckDuckGo senza chiave, e recupera la documentazione pubblica in markdown entro un limite di 38.000 caratteri per chiamata.
- **Controllo del desktop, dettatura vocale con Whisper, pianificazione con Saturn e integrazioni con gli editor:** controlla le applicazioni desktop (`Computer`), trascrive la dettatura vocale a pressione (push-to-talk) sul dispositivo con Whisper (`/voice`), pianifica sessioni ricorrenti o singole con Saturn (`/saturn`) e si collega a VS Code tramite l'Agent Client Protocol (`mercury acp`), insieme a Unity, Blender, Godot e Aseprite.
- **Generazione di video (`Video`):** invia prompt e file di riferimento del progetto a un generatore MiniMax configurato ([docs/VIDEO.md](../VIDEO.md)) e salva nel progetto l'MP4 generato e, facoltativamente, un fotogramma PNG di anteprima di 1 secondo.

Mercury viene usato per sviluppare Mercury, con più sessioni e modelli su attività lunghe. Tenere traccia di questo lavoro è la parte difficile: che cosa è ancora in esecuzione, che cosa è cambiato e che cosa richiede una decisione. Ogni sessione scrive la propria nota di handoff alla fine, e la sessione successiva legge quella nota una sola volta all'avvio, insieme alle mie regole fissate, evitando che il contesto si contamini da una sessione all'altra.

![Un prompt al coordinatore nella bacheca delle sessioni avvia due sessioni, ciascuna nel proprio worktree; una chiede conferma prima di modificare e tutte e due finiscono con le modifiche pronte da rivedere](../media/session-board-stream.gif)

Mercury è disponibile come codice sorgente sotto la Business Source License 1.1, e gli SDK in [sdk/](../../sdk/) e [sdk-py/](../../sdk-py/) sono concessi in licenza sotto la Apache License 2.0. Vedi [Licenza](#licenza) per le condizioni d'uso in produzione.

## Installazione

Gli archivi di release sono disponibili per Mac con Apple silicon e Intel, Linux x64 e arm64, e Windows x64 e arm64. Installa `git` separatamente; ogni archivio include Node e ripgrep, quindi non serve installare Node a parte.

Scegli un metodo di installazione:

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS e Linux (x64 e arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows (x64 e arm64), in PowerShell 7
brew install Whq02/mercury/mercury                 # Homebrew: macOS e Linux x64
npm install -g mercury-tech-cli                    # npm; `bun install -g mercury-tech-cli` è lo stesso pacchetto
mise use -g npm:mercury-tech-cli                   # mise, tramite il pacchetto npm
```

Gli indirizzi di installazione conservano conteggi approssimativi delle richieste di script per origine e per giorno UTC (le installazioni completate non vengono conteggiate); il contatore non memorizza alcun indirizzo IP, stringa user-agent o cookie.

Apri un nuovo terminale, oppure esegui la riga `export PATH=…` stampata dall'installer della shell, poi esegui `mercury --version` per verificare e `mercury` da un repository per avviare il [primo avvio](#il-primo-avvio). In Windows PowerShell, e dopo un'installazione con Homebrew, npm, bun o mise, `mercury` funziona nello stesso terminale.

<details>
<summary>Percorsi di installazione, aggiornamenti e verifica delle release</summary>

### Differenze tra i metodi di installazione

Gli installer di shell e PowerShell scaricano la release più recente per la tua piattaforma, verificano il suo SHA-256 con `SHA256SUMS.txt`, la decomprimono ed eseguono il comando `mercury install` contenuto nell'archivio stesso.

Homebrew e il pacchetto npm sono ciascuno fissati a una release specifica e vengono ripubblicati dopo ogni tag, quindi possono restare indietro rispetto alla release più recente. I comandi Homebrew usano il nome completo del tap `Whq02/mercury/mercury` (il semplice `mercury` in `homebrew-core` è un altro programma). Il pacchetto npm `mercury-tech-cli` è un launcher che scarica la release fissata; mise installa lo stesso pacchetto. `mercury install --uninstall` rimuove la release installata e lo shim del comando, ma mantiene la configurazione e le sessioni (se hai installato il launcher npm, esegui anche `npm uninstall -g mercury-tech-cli`).

L'installazione di Mercury è locale all'utente e non richiede l'accesso da amministratore. Puoi rieseguire un comando di installazione senza rischi.

### Percorsi di installazione

Le versioni rilasciate si trovano nella directory di configurazione, in `~/.mercury/versions/<version>` (`%USERPROFILE%\.mercury\versions` su Windows). Il comando `mercury` viene installato in `~/.local/bin` su macOS e Linux, oppure in `%LOCALAPPDATA%\Mercury\bin` su Windows.

`mercury install` aggiunge la directory del comando a PATH una sola volta: una riga protetta nel file di avvio della shell, oppure una voce nel PATH utente di Windows. Un nuovo terminale recepisce la modifica automaticamente.

### Aggiornamenti

Usa `mercury update` con qualsiasi metodo di installazione.

Per un'installazione fatta con l'installer di shell o PowerShell, oppure con `mercury install`, aggiorna Mercury sul posto. `--check` verifica se ci sono aggiornamenti, `--status` riporta lo stato dell'aggiornamento e `--rollback` torna alla versione precedente, che resta su disco.

Con Homebrew, chiede conferma prima di eseguire `brew upgrade Whq02/mercury/mercury`. La risposta predefinita è no; digita `y` per approvare. Mercury trasmette l'output del comando e verifica la versione installata al termine. Usa `--yes` per saltare la domanda negli script.

Il launcher npm usa lo stesso layout di release degli installer e delega ogni esecuzione alla release installata. Perciò `mercury update` aggiorna un'installazione npm sul posto, attraverso il canale di aggiornamento di Mercury. `npm update -g mercury-tech-cli` cambia solo la release che il pacchetto installa alla prima esecuzione. Vale anche quando si usa mise.

`--check` legge la stessa lista di release per tutti i metodi di installazione e ti indica come aggiornare la tua. Quando è disponibile un aggiornamento, la schermata iniziale mostra `vX.Y.Z available · mercury update` una volta nell'angolo in basso a destra, e la chat mostra un avviso temporaneo. Imposta `MERCURY_UPDATE_NOTICE=0` per nasconderli entrambi.

Le richieste di installazione e aggiornamento scaricano in modo anonimo la lista pubblica delle release e gli archivi. Puoi eseguirle senza account né token. Se una richiesta anonima viene rifiutata, Mercury consulta la GitHub CLI (`gh`) con l'accesso effettuato.

Dopo un aggiornamento, Mercury verifica se il comando nel tuo PATH punta all'installazione aggiornata. Se un'altra installazione ha la precedenza, o se il comando aggiornato non è nel PATH, spiega il problema e come risolverlo. `mercury health` segnala lo stesso problema.

### Verifica delle release

Prima di attivare una release, Mercury controlla il suo archivio con `SHA256SUMS.txt`. Richiede inoltre un payload firmato con la chiave di firma delle release di Mercury presente nell'elenco fidato incorporato, prima di preparare l'aggiornamento. Una firma rifiutata lascia invariata l'installazione attiva.

Usa `--allow-unsigned` per accettare un payload non firmato. Mercury continua a rifiutare le chiavi di firma sconosciute, i blocchi di firma malformati e i contenuti manomessi. Sia il risultato del comando sia il relativo registro locale mostrano che hai consentito un payload non firmato.

A partire dalla 1.0.0-beta.3, gli archivi vengono firmati durante il packaging e le firme vengono verificate prima della pubblicazione. Un'installazione verificata non mostra alcun avviso di firma all'avvio. `mercury health` riporta la chiave di firma `627b54b734ca0e72`.

Gli archivi della 1.0.0-beta.2 non sono firmati. Queste installazioni segnalano la provenienza non firmata una volta per installazione, quando avvii Mercury in modo interattivo senza comando né flag. Il controllo di salute continua a mostrare questo stato. Significa che il manifest dell'archivio non ha firma; il download viene comunque verificato con `SHA256SUMS.txt`.

[docs/TRUST.md](../TRUST.md) spiega i risultati della verifica e come controllare manualmente un archivio. [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) tratta la verifica all'avvio.

### Note sulle piattaforme

Gli archivi di release esistono per ogni piattaforma elencata sopra. Qualsiasi altra macchina compila dal codice sorgente.

Gli archivi per Mac Intel sono disponibili dalla 1.0.0-beta.3. Vengono impacchettati in modo incrociato su un runner Apple silicon e testati all'avvio sotto Rosetta prima della pubblicazione. I Mac Intel che usano la 1.0.0-beta.2 richiedono una build dal codice sorgente.

</details>

## Requisiti

Gli archivi di release includono Node 24 LTS. Il launcher, `mercury install` e `mercury update` usano quel runtime incluso; `git` è l'unico requisito separato per la release stessa.

Per compilare dal codice sorgente ti servono:

- **Node 24 LTS**, nell'intervallo supportato `>=24.20.0 <25`. `.node-version` fissa la patch usata per le build ed è inclusa negli archivi di release.
- **bun 1.3.x** per la build. Non è incluso nelle release.
- **git**. Su Windows, esegui PowerShell 7 dentro Windows Terminal o nel terminale di VS Code. Vedi [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md).

Il minimo di Node include la correzione per nodejs/node#56645. Sotto la 24.20.0, i comandi `run` headless che chiamano uno strumento vengono interrotti in uscita su Windows.

I launcher scelgono Node in quest'ordine: il binario esplicito `MERCURY_NODE`, il runtime incluso, poi un'installazione compatibile di Node nel PATH. Se il runtime manca, il launcher segnala un errore.

### Shell di Windows

Gli archivi di release includono il motore di shell compatibile con bash di Mercury (`brush`), e su Windows serve per impostazione predefinita lo strumento Bash: trova un programma `.cmd` o `.bat`, come `npm`, tramite il suo nome semplice grazie a PATHEXT, passa `%VAR%` e `^` a un file batch senza modifiche, esegue un programma indicato con un percorso relativo dopo `cd` e mantiene lo stato della shell tra le chiamate. Il `bash.exe` di Git per Windows non è richiesto; quando è installato, `MERCURY_SHELL_ENGINE=system`, oppure `system` in `/config` sotto Shell engine, fa sì che lo strumento Bash usi solo `bash.exe`.

Leggi la riga `shell` del controllo di salute per vedere quale shell è attiva e perché: il motore incluso (il predefinito su Windows, oppure attivato dal pin o dall'impostazione), oppure Git Bash quando il motore è stato disattivato o il suo pacchetto manca.

Su macOS e Linux la shell di sistema è quella predefinita; imposta `MERCURY_SHELL_ENGINE=brush`, oppure scegli `brush` in `/config`, sotto Shell engine, per eseguire lo strumento Bash anche lì sul motore incluso, con stato della shell persistente.

Una build dal codice sorgente senza il pacchetto del motore né Git per Windows si avvia comunque, ma lo strumento Bash non è disponibile. Lo strumento PowerShell resta disponibile, e il diagnostico `shell` spiega come ripristinare il supporto a Bash.

## Compilazione dal codice sorgente

Mercury si compila con bun e funziona su Node 24 LTS. Installa [i requisiti per la compilazione dal codice sorgente](#requisiti), incluso bun 1.3.x:

```sh
curl -fsSL https://bun.sh/install | bash           # macOS e Linux
powershell -c "irm bun.sh/install.ps1 | iex"       # Windows, in PowerShell 7
bun --version                                      # 1.3.x
```

Poi, in un clone di questo repository:

```sh
bun run setup                      # una volta; bun install + i pacchetti inclusi
bun run build.ts                   # scrive dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### Supporto ai terminali

L'interfaccia a schermo intero richiede un TTY reale, ma non ha una dimensione minima del terminale. Il layout completo parte da 100 colonne per 26 righe; le finestre più piccole usano un layout compatto.

Mercury usa il colore a 24 bit quando il terminale dichiara il supporto tramite `COLORTERM=truecolor` oppure viene riconosciuto come iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal o VS Code. Gli altri terminali usano 256 colori, incluso Terminal di Apple su macOS 15 e versioni precedenti.

La riga Terminal color del controllo di salute mostra la profondità rilevata e il motivo. Imposta `MERCURY_TRUECOLOR=1` per un terminale che supporta il colore reale ma non lo dichiara, oppure `MERCURY_TRUECOLOR=0` per forzare i 256 colori.

### Componenti opzionali

`setup` scarica i pacchetti di capacità inclusi: pyright, debugpy, js-debug, grammatiche extra, il runtime Node della piattaforma e brush. Se un download fallisce, quel pacchetto viene saltato e la build e gli strumenti interessati segnalano il componente mancante. Eseguire `bun install` da solo produce una build senza questi pacchetti.

Per compilare il supporto vocale, esegui `setup` con Rust installato. Questo compila `native/voice`. Aggiungi cmake per compilare anche `native/whisper`. Con Rust installato, `setup` compila anche l'addon del driver desktop (`native/desktop`) con cui lavora lo strumento `Computer`. Con Rust installato, `setup` compila inoltre l'addon locale di embedding (`native/embed`, `bun run scripts/vendor/build-embed.ts`) e scarica il modello BGE da 118 MB (`bun run scripts/vendor/fetch-embed-models.ts --default`); senza cargo il pacchetto viene saltato, setup lo dichiara e la ricerca in memoria di Mneme si limita alla corrispondenza di parole. Ogni archivio di release include il pacchetto di embedding compilato per la sua piattaforma; su Linux e Windows i calcoli usano un kernel vettorizzato, quindi un Recall per significato richiede circa un decimo di secondo (qualche centesimo di secondo su macOS, che usa Accelerate). Se una build nativa non ha i propri strumenti, setup la salta e il controllo di salute segnala l'addon mancante. Anche il motore di shell per Windows viene compilato sulla tua macchina, perché upstream non fornisce un binario per Windows.

Vedi [Shell di Windows](#shell-di-windows) e [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) per il motore di shell `brush`.

La build scrive solo in `dist/`. Configurazione e sessioni risiedono in `~/.mercury`, oppure nella directory impostata da `MERCURY_CONFIG_DIR`, e vengono create alla prima esecuzione. Su Windows, esegui direttamente `node dist\mercury.mjs`.

### Installare una build dal codice sorgente come comando

`scripts/ops/deploy-runtime.sh` pubblica una build da un albero pulito in una nuova cartella `<config home>/runtime/builds/<build>` e fa puntare `runtime/current` ad essa (`runtime/dist` è il vecchio nome dello stesso link). `scripts/ops/deploy-launcher.sh` installa il launcher in `<config home>/bin/mercury`. Aggiungi quella directory al PATH; per zsh:

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

Il launcher si interrompe con un errore se il runtime manca. Non passa a un'altra build. La scelta di Node segue l'ordine descritto in [Requisiti](#requisiti). Per un'installazione da release, esegui `mercury install` o `mercury update`, che lasciano invariati i checkout dei sorgenti; vedi [Aggiornamenti](#aggiornamenti).

[AGENTS.md](../../AGENTS.md) è la breve guida alla build e all'esecuzione. [BUILD-NOTES.md](../../BUILD-NOTES.md) tratta la build con più dettaglio.

## Il primo avvio

Al primo avvio interattivo scegli un aspetto e poi accedi a un provider. La schermata mostra un'anteprima dei cambi di tema mentre scorri le opzioni. True Black è l'impostazione predefinita; le altre opzioni sono il tema scuro oasis e Black and white, che non applica alcun colore: usa l'inchiostro del terminale su uno sfondo proprio, come appare Mercury su un terminale senza colori. Puoi cambiarlo in seguito con `/appearance`.

Puoi anche scegliere "sign in later" per esplorare senza collegare un account. Quando una chiave di provider nel tuo ambiente ha già collegato un provider, il passo di accesso non viene chiesto. Poi il passo Guardrails ti ricorda di controllare le modifiche e i comandi di Mercury, e che ciò che legge può contenere istruzioni per il modello. In un terminale che Mercury sa configurare (Terminal.app, la famiglia VS Code, Alacritty, Zed), un passo Terminal keys può configurare le scorciatoie per andare a capo nelle impostazioni del terminale stesso (su Terminal.app di macOS imposta `Option+Enter` per il ritorno a capo e silenzia il campanello del terminale in tutti i profili, con effetto dopo il riavvio di Terminal.app; nella famiglia VS Code, Alacritty e Zed scrive `Shift+Enter` per il ritorno a capo). È disattivato a meno che tu non lo scelga, e viene conservata una copia di backup.

Poi Mercury chiede se ti fidi della cartella che hai aperto. Nulla richiesto da una configurazione dello spazio di lavoro viene eseguito prima che tu conceda questa fiducia. La concessione copre l'intero repository; rifiutare chiude Mercury. Vedi [docs/TRUST.md](../TRUST.md).

Un avvio interattivo normale apre la schermata iniziale. Ha dieci voci di menu, e Continue Last Session compare solo quando c'è una cronologia di sessioni:

- **New Session in \<folder\>** avvia una nuova sessione nella cartella corrente.
- **Continue Last Session** torna alla chat più recente.
- **Boot Menu** configura le sessioni future, inclusi motion, crewmate e workflow.
- **MCPs & Skills** sceglie che cosa caricherà la sessione successiva. Vedi [docs/KIT.md](../KIT.md).
- **Agents** crea e modifica gli agenti.
- **Health Check** controlla l'installazione.
- **Saturn Scheduler** pianifica le sessioni. Vedi [docs/SATURN.md](../SATURN.md).
- **Logins** collega gli account dei provider.
- **Session Concourse** apre l'elenco delle sessioni del progetto corrente.
- **Sessions · Projects** ti permette di scegliere una sessione o un repository.

Le voci di menu si aprono sopra la schermata iniziale, e `Esc` torna alla voce selezionata. L'elenco delle sessioni si apre su una schermata separata, raggiungibile anche con `Shift+→`. Un argomento di prompt, `--continue` o `--resume` ti porta direttamente alla chat.

### Motion, crewmate e workflow

La sezione Performance del Boot Menu include un'impostazione Motion: `auto`, `full`, `reduced` o `off`. Controlla l'animazione a riposo dell'interfaccia ed è disponibile anche in `/config`.

Sotto Agents, gli interruttori Crewmates e Workflows stabiliscono se le nuove sessioni ricevono gli strumenti Crewmate e Workflow. Spegnere un interruttore rimuove lo strumento corrispondente; i tentativi di avviare quel tipo di lavoro restituiscono la stessa spiegazione. All'interno di una sessione, `/crewmates on|off` e `/workflows on|off` cambiano l'impostazione al successivo confine di turno.

## Il ciclo quotidiano: Session Concourse, git worktree e crewmate

### Avviare una sessione e isolare i worktree

Premi `Enter` su New Session per creare una sessione nella cartella corrente con il modello predefinito. Mercury apre la chat e, contemporaneamente, aggiunge la sessione all'elenco delle sessioni. Dietro il menu tiene pronto un processo per ridurre il lavoro di avvio.

Avviare un'altra sessione non interrompe la precedente. Puoi lasciare un'attività in esecuzione e lavorare altrove. Avvia con `--worktree [name]` (oppure chiedi un `worktree` in chat per eseguire `EnterWorktree`) per dare a una sessione il proprio branch e il proprio checkout sotto `.mercury/worktrees/`. Anche i crewmate in parallelo possono girare in worktree isolati e coordinare i file condivisi con le prenotazioni dei file di progetto; vedi [Cosa contiene](#cosa-contiene-memoria-rag-mneme-lsp-ast-in-23-linguaggi-debugger-dap-ricerca-web-e-integrazioni) e [docs/CREW.md](../CREW.md).

### Lavorare in chat

Descrivi il lavoro in linguaggio naturale. L'agente legge, modifica, esegue e verifica il codice secondo la modalità di permessi che hai scelto. Le chiamate agli strumenti compaiono mentre vengono eseguite, come schede compatte oppure con l'output completo. Scegli la visualizzazione in `/config`, sotto Tool output; l'impostazione viene salvata per gli avvii successivi.

Usa `/model` e `/effort` per regolare la sessione. `/permissions` controlla che cosa può essere eseguito senza approvazione e che cosa deve chiedere prima.

Rivedi le modifiche con `/diff`, per origine, file e hunk. `! <command>` esegue un comando di shell in chat con l'ultima parte dell'output in tempo reale. `/runs` mostra le shell e i crewmate in esecuzione (`/tasks` apre la stessa bacheca), e `/crewmates` apre la vista Crew in tempo reale. Tra un turno e l'altro, `/clear` salva la chat corrente e apre una sessione nuova, e `/restart` sposta la chat su una build di Mercury appena installata. `/title` assegna un nome alla chat, e `/help` elenca i comandi disponibili.

### Spostarsi tra le schermate

`Shift+←` e `Shift+→` spostano il focus tra le schermate disponibili in quel momento. Un avvio nuovo mostra la schermata iniziale e l'elenco delle sessioni. La schermata della chat viene aggiunta quando una sessione riceve il focus e rimossa quando si chiude l'ultima chat. I suggerimenti di tasti mostrano solo gli spostamenti disponibili.

Chiudendo tutte le chat torni alla schermata iniziale. Usa `--chat` per avere solo la schermata iniziale e la chat, senza l'elenco delle sessioni. `--concourse-off` salva questa preferenza per gli avvii futuri; `--concourse-on` o `/config` la riattivano.

### Gestire le sessioni nel Session Concourse

Apri l'elenco delle sessioni con `/concourse` oppure con `Shift+→` dalla schermata iniziale. Mostra prima le sessioni in esecuzione del progetto corrente, seguite dalle chat salvate non in esecuzione, dalla più recente alla più vecchia.

Ogni sessione in esecuzione ha una cella NOW che mostra la sua attività corrente. Seleziona una riga e premi `Enter` per tornare alla chat mentre le altre sessioni continuano a girare. Una sessione andata in crash resta nell'elenco come NEEDS YOU, con il motivo, finché non la rilasci.

[docs/SESSIONS.md](../SESSIONS.md) descrive il ciclo di vita delle sessioni.

## Provider e modelli: accessi, `/localsetup` e `/llmhost`

Usa `/logins` per collegare un provider. Apre lo stesso catalogo di accesso usato durante la configurazione. `/accounts` gestisce in seguito gli slot dei provider collegati.

- **OpenAI:** abbonamento ChatGPT o chiave API.
- **Anthropic:** abbonamento Claude, accesso a Console o chiave API.
- **OpenRouter:** accesso al catalogo tramite OAuth o una chiave API; le richieste di modello negano la raccolta dei dati e richiedono ogni parametro fin dall'inizio. `/config → OpenRouter routing policy` imposta le scelte di fallback e di zero data retention; scegli open per allentare la policy e lasciare il routing a OpenRouter.
- **Google Gemini:** Sign in with Google, una chiave API o un tuo client OAuth. Sign in with Google esegue Gemini con la quota del piano associato all'account Google (un account gratuito, Google AI Pro o Google AI Ultra) tramite il client Antigravity di Google: il prompt, gli schemi degli strumenti e i risultati degli strumenti vengono inviati all'endpoint Code Assist di Google con quel client e l'account con cui hai effettuato l'accesso, e `/model` elenca i modelli che Google offre all'account. Una chiave API o un tuo client OAuth fatturano invece un progetto Cloud.
- **Hugging Face:** accesso con codice dispositivo o token Hub.
- **Kimi (Moonshot):** accesso con codice dispositivo o chiave API.
- **GLM (Z.AI):** una chiave dell'abbonamento GLM Coding Plan oppure una chiave API generale a consumo. `/logins zai` salva l'una o l'altra e registra il piano; anche `ZAI_API_KEY` funziona, con `ZAI_KEY_PLAN=coding|general` che indica il piano (se non è impostata, Mercury lo legge dall'elenco dei modelli della chiave stessa).
- **DeepSeek:** una chiave API della piattaforma DeepSeek (`/logins deepseek`, oppure `DEEPSEEK_API_KEY`).
- **xAI (Grok):** accedi con il tuo abbonamento Grok (SuperGrok / X Premium) oppure incolla una chiave API tramite `/logins xai`.
- **Meta (Muse):** Sign in with Meta (un abbonamento Muse Code, con un codice dispositivo nel browser) oppure una chiave Model API a consumo. Sign in with Meta scambia il codice dispositivo con gli endpoint OIDC di Meta (`https://auth.meta.com/oidc/device/authorization/` e `/oidc/device/token/`) sotto l'id client pubblico di Muse Code, invia il token dell'account risultante una sola volta a `https://api.meta.ai/muse-code/key` per generare la chiave API dell'abbonamento (e in letture limitate di `/usage` per il livello del piano e le finestre di utilizzo), e invia solo la chiave generata a ogni richiesta di modello verso `https://api.meta.ai/v1`. Una chiave Model API incollata, oppure `MODEL_API_KEY` / `META_API_KEY`, viene fatturata a consumo.

- **Qwen:** una chiave QwenCloud (Token Plan o a consumo) oppure una chiave Alibaba Cloud Model Studio (a consumo, Token Plan o Coding Plan), verificata sul proprio endpoint prima di essere salvata; una chiave di piano elenca i modelli del piano, con Qwen3.8 Max per primo.
- **MiniMax:** una chiave Open Platform oppure una chiave di abbonamento M Plan.
- **Together AI** e **Cohere:** chiave API.
- **Groq**, **Cerebras** e **Fireworks AI:** chiave API; la chiave di qualsiasi famiglia può arrivare anche da un comando indicato in `credentials.keyCommands.<family>`.

Mistral, Nous Portal e OpenCode Zen si collegano anch'essi tramite `/logins`, per un totale di 20 famiglie di provider con accesso. I server di modelli locali (Ollama, LM Studio, vLLM e llama.cpp) e gli endpoint personalizzati compatibili con OpenAI funzionano senza accesso a un provider. Esegui `/localsetup` per installare o avviare Ollama, scaricare un modello che stia nella memoria, impostare la sua finestra di contesto oppure collegare un server LM Studio, vLLM o llama.cpp già in esecuzione ([docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)). Ogni provider usa il proprio protocollo, le proprie credenziali e la propria gestione degli errori, e le richieste non passano mai a un altro provider. Vedi [docs/ENGINES.md](../ENGINES.md).

`/llmhost` elenca i modelli che puoi ospitare e mostra dove ciascuno può girare in questo momento: su una GPU noleggiata da Runpod, Vast.ai o Lambda, sul tuo computer o su un computer SSH salvato (`mercury host`), oppure su un server di modelli esistente. Ogni pagina del modello mostra le opzioni di quantizzazione, come il budget di memoria della GPU si divide tra conversazioni parallele (`conversations × context`) e il livello di ragionamento predefinito (che `/effort` modifica per richiesta). I noleggi GPU richiedono una conferma esplicita del prezzo orario, e la configurazione prosegue in background se chiudi il popup. Su Runpod puoi anche regolare qualità, suddivisioni del contesto e ragionamento prima di noleggiare o su un pod in esecuzione (`Tune`), mantenere i pesi su un volume a caricamento rapido e impostare controlli di disponibilità ogni 5 secondi. I noleggi su Vast.ai e Lambda sono nuovi nella 1.0.0-beta.40 e sono stati verificati con le API pubblicate dei fornitori tramite fixture (non sono state eseguite prove di noleggio reali). Vedi [docs/LLM-HOST.md](../LLM-HOST.md).

Le nuove sessioni usano il provider collegato più di recente e il modello più recente disponibile per quell'account. I modelli a cui l'account non può accedere vengono saltati. Se quel provider non ha un modello utilizzabile, Mercury controlla il provider collegato subito prima. Questa scelta avviene all'avvio della sessione; una richiesta fallita in una sessione esistente resta con il proprio provider.

`/model` spiega la selezione. Una parola che indica la famiglia sceglie il modello più recente di quella famiglia: `/model grok`, `/model deepseek`, `/model kimi` o `/model glm`. Senza alcun provider collegato, la schermata iniziale e `/model` ti indirizzano a `/logins`. `/defaultprovider` ti permette di rendere esplicitamente un provider la scelta più recente.

L'accesso ai provider resta soggetto alle condizioni e alla disponibilità del provider stesso. La licenza di Mercury non le sostituisce.

## La CLI headless: `mercury run`, Docker e il runner JSON-RPC

La stessa build funziona senza l'interfaccia interattiva. `node dist/mercury.mjs --help` elenca tutte le opzioni.

`mercury run "<prompt>"` esegue un prompt senza interfaccia da terminale:

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` stampa la risposta; il motivo di un turno fallito va su stderr.
- `json` stampa l'ultima riga `outcome` come un singolo oggetto JSON.
- `rows` scrive un oggetto JSON per riga: `session`, poi un `turn` e le sue righe `text`, `reasoning`, `tool_call`, `tool_result` e `step`, che termina con `outcome`. Attese, avanzamento degli strumenti, attività in background e avvisi hanno righe proprie. Ogni riga contiene `seq`, `timestamp` e `session_id`; le righe di un turno contengono anche il suo numero `turn`. `seq` numera il flusso di questa esecuzione a partire da 1; `turn` conta i turni della sessione, quindi un'esecuzione che continua una conversazione salvata (`-c`, `-r`, `--fork`) numera il proprio turno dopo quelli già presenti, e la sua riga `session` indica in `resume_of` la conversazione che prosegue.

I tipi di riga di output, in base al campo `type`:

- `session`: la riga di apertura: `version`, `build` (i primi dodici caratteri esadecimali dell'albero da cui è stato compilato il bundle, come li mostra `mercury daemon status`; assente quando non c'è un manifest accanto al bundle), `resume_of` (in un'esecuzione che prosegue, l'id di sessione della conversazione che prosegue; coincide con `session_id` a meno che l'esecuzione non sia stata biforcata), `cwd`, `model`, `mode`, i `tools`, `mcp_servers`, `commands`, `agents`, `skills` ed `extensions` della sessione, e `tools_withheld` (presente quando una regola di negazione trattiene uno strumento per il suo nome semplice: per ogni voce, `tool`, `rule` e `source`).
- `turn`: un turno `started` o `waiting`, con il suo `turn_id`; `model`, `message_ids` e il conteggio di `agents`, quando noto.
- `text`: un blocco di testo completato: `message_id`, `block`, `text` e la sua `phase` (`commentary` o `final_answer`).
- `reasoning`: un blocco di ragionamento completato: `message_id`, `block`, `text`, oppure `redacted: true`.
- `tool_call`: una chiamata a uno strumento: `call_id`, `tool`, `input`, con il suo `message_id` e `block`.
- `tool_result`: il risultato della chiamata: `call_id`, `status` (`ok`, `error`, `aborted` o `refused`) e `output`. Una chiamata che il modello ha costruito così male da essere rifiutata prima dell'esecuzione (uno strumento sconosciuto, argomenti che non sono JSON valido o che non rispettano lo schema dello strumento) riceve comunque la sua coppia: una riga `tool_call` con gli argomenti così come sono arrivati (`{}` quando non erano un oggetto) e una riga `tool_result` con status `refused` il cui `output` è il motivo; segue il `notice` di correzione. Una chiamata del genere non è mai stata eseguita e non è un diniego.
- `tool_update`: avanzamento di uno strumento in esecuzione: `call_id`, `tick`, `source` (`shell`, `powershell`, `mcp` o `eval`) e uno qualsiasi tra `line`, `elapsed_s`, `lines`, `bytes`, `budget_ms`, `progress` e `total` che la chiamata riporta. Una chiamata di shell o PowerShell emette un tick man mano che arriva l'output (un comando che non stampa nulla non emette mai tick); una chiamata MCP quando il suo server riporta l'avanzamento; una chiamata Eval mentre la sua cella è in esecuzione; nessun altro strumento emette tick; una chiamata Browser o Crewmate resta silenziosa fino al risultato.
- `step`: una chiamata al modello del thread principale: `message_id`, `model`, `usage`, e `stop` quando il modello indica perché si è fermato.
- `outcome`: il risultato del turno, descritto più avanti.
- `close`: la nota lasciata per la sessione successiva alla chiusura: `state` (`stored`, `skipped` o `none`), `note_chars` e lo `usage` delle chiamate al modello che l'hanno scritta, così che chi somma l'uso di ogni riga ottiene quello dell'outcome. Con il prompt passato come argomento, la nota viene richiesta dentro l'ultimo turno e `close` precede l'`outcome` di quel turno; con `--input rows` segue l'ultimo `outcome` quando stdin si chiude.
- `wait`: un'attesa del modello: `state` (`first_byte`, `retry`, `silence`, `loading` o `done`) con i valori che quello stato porta, come `since_ms`, `attempt` e `of`, `delay_ms`, `reason` e `http_status`.
- `heartbeat`: il flusso del modello ha dato segni di vita dopo almeno un secondo senza un evento analizzato: sono arrivati byte che non hanno prodotto alcuna riga. La riga non contiene nient'altro e arriva al massimo una volta al secondo; la frequenza dipende dalla forma dello streaming del provider, quindi un flusso che non fa mai pause tra un evento e l'altro non ne emette nessuna.
- `compaction`: una compattazione `started`, in `progress` o `ended`: `trigger` (`manual`, `auto` o `overflow`), `stage`, `fill`, `summary_tokens` e, alla fine, `exit` (`landed`, `cancelled` o `failed`).
- `mode`: la modalità di permessi è cambiata: `mode`.
- `rate_limit`: lo stato del limite del provider: `status` (`allowed`, `warning` o `rejected`), `window`, `resets_at`, `utilization` e i campi di overage.
- `task`: un'attività in background `started`, in `progress` o `ended`: `task_id`, `task_type`, `description`, `usage`, `summary`, `status` (`completed`, `failed` o `stopped`) e `output_file`, man mano che diventano noti.
- `notice`: un `warning` o `error` per chi legge: `text`, e un `code`, come `input_refused`.
- `command_output`: l'output di un comando slash che non ha mai raggiunto il modello: `command` e `text`.
- `mission_updated`: il registro delle attività della sessione è cambiato; leggilo di nuovo.
- `samples_updated`: i campioni della sessione sono cambiati; leggili di nuovo.

Con `--partial` e `--format rows` si aggiungono le righe `block_start`, `text_delta`, `reasoning_delta`, `tool_input_delta` e `retracted`. I delta appartengono a `message_id` e `block`; una riga `retracted` ritira i delta di quel messaggio. La riga completata di testo o di strumento è il valore completo.

L'outcome contiene `schema`, `turn_id`, `status`, `steps`, `wall_ms`, `usage`, `models` e `denials`, con `answer` al completamento e `error` (`message`, `class`, `detail` facoltativo) in caso di errore. `stop`, `api_ms`, `cost_usd`, l'output `structured` richiesto e `notices` sono inclusi quando disponibili. `wall_ms` è il tempo trascorso del turno. `api_ms` è la somma delle durate di ogni richiesta al modello fatta dal turno (inclusi i tentativi ripetuti e le richieste dei crewmate eseguite in parallelo al thread principale), quindi può superare `wall_ms` quando le richieste si sono sovrapposte. `cost_usd` è il valore in USD delle richieste con prezzo del turno, qualunque sia lo status: una richiesta che Mercury non può valutare (nessuna tariffa registrata, nessun costo indicato nella risposta) non vi aggiunge nulla e lascia il proprio modello elencato in `models` senza un `cost_usd` proprio; il campo è assente solo quando nel turno non c'era nulla con prezzo. Con un accesso tramite abbonamento Claude, le richieste Anthropic non hanno un prezzo in dollari, quindi né loro né la riga contengono `cost_usd`; l'uso resta. L'usage riporta `input_tokens` (token in cache inclusi), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` e, quando riportati, `reasoning_output_tokens`, sommati sul thread principale e sui crewmate. `models` scompone l'uso dei token per modello. `steps` conta solo le chiamate al modello dell'agente principale; le chiamate al modello fatte dai crewmate compaiono come righe `step` proprie, etichettate con `parent_call_id`.

Lo stato è `completed`, `blocked`, `refused`, `failed`, `interrupted`, `turn_limit`, `budget_limit`, `time_limit`, `schema_unmet` o `loop_stopped`. Un'esecuzione con `--max-time` (in secondi, oppure `10m`, `1h`) termina con `time_limit` al passo successivo una volta scaduto il tempo; la chiamata al modello o il giro di strumenti in corso non viene interrotto. Un'esecuzione completata esce con codice 0, gli altri esiti con codice 1, e un errore d'uso con codice 2. SIGINT e SIGTERM escono con 130 e 143 dopo che l'outcome del turno interrotto è stato scritto. Una chiamata a uno strumento rifiutata è elencata in `denials`. Quando il rifiuto è stato una richiesta di permesso a cui nessuno ha potuto rispondere (un'esecuzione senza host in una modalità che chiede, `--mode dontAsk`, oppure la richiesta di un host scaduta) e nessuna chiamata successiva allo strumento nel turno ha successo, l'esecuzione è `blocked`: la risposta viene conservata, `error` indica lo strumento e come riprendere (`--allowed-tools`, un altro `--mode` o un host che risponda alle richieste), e l'esecuzione esce con codice 1. Se una chiamata successiva allo strumento nello stesso turno ha successo, il turno si recupera e termina come `completed` (codice 0) con un `notice` di avviso (`"<Tool> was not approved; the run continued with other tools."`). Un rifiuto a cui hai risposto (con una regola di negazione, un hook o un host che ha detto di no) lascia completato un turno completato. Anche una chiamata `AskUserQuestion` senza risposta fa terminare l'esecuzione come `blocked`, con la domanda citata in `error`; Mercury legge l'esito dalle richieste registrate dell'esecuzione, mai dal testo della risposta, quindi una domanda scritta solo nella risposta termina come `completed`. Un comando slash sconosciuto termina come `refused` con la stessa frase che mostra la schermata interattiva (`Unknown command: /name · /help lists commands`) ed esce con codice 1.

`--input rows` richiede `--format rows` e legge un oggetto di input per riga:

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

I tipi di input sono `prompt` con `content` (blocchi di testo o di testo e immagine), `shell` con `command` e `note` con `to` (un id di agente) e `content`. Ognuno accetta un `id` facoltativo; le righe di prompt e di shell accettano anche `priority` (`now`, `next` o `later`), `sent_at` e `origin`. Una forma di input rifiutata produce un `notice` con codice `input_refused`; un JSON malformato termina l'esecuzione. Queste righe trasportano solo input; le risposte ai permessi usano il protocollo del runner descritto più avanti.

Usa `mercury run -` oppure invia testo tramite pipe a `mercury run` per leggere l'intero prompt da stdin. Accanto a un argomento di prompt, il testo ricevuto dalla pipe viene aggiunto come contesto delimitato: la pipe viene letta fino alla chiusura o finché non resta in silenzio per un secondo, così un flusso che continua a consegnare dati viene letto fino in fondo, e una pipe che resta aperta e silenziosa non trattiene l'esecuzione. Senza prompt e con un terminale su stdin, `run` stampa il proprio utilizzo ed esce con codice 2.

`--mode <mode>` seleziona l'impostazione dei permessi. `--sovereign` esegue senza richieste di permesso, e `--allow-sovereign` rende questa modalità disponibile per un passaggio successivo. La politica dei permessi e le regole di negazione restano valide. Un utente root che entra in modalità sovereign riceve un avviso su stderr; l'esecuzione prosegue.

Usa `-c` per continuare la conversazione più recente, `-r` per riprendere per ID, titolo o selettore, `-w` per eseguire in un worktree gestito, e `--lean` per una sessione minima. Un `run` non ha un host che risponda alle richieste di permesso: le sue regole di permesso e la sua modalità decidono che cosa può essere eseguito, e una chiamata che richiede ancora approvazione viene negata.

### L'immagine headless

Il `Dockerfile` nella radice del repository crea un'immagine Linux x64 per CI e server. Il suo entrypoint è `mercury` e il verbo predefinito è `run`, quindi l'immagine esegue un prompt su un albero montato e termina con il codice dell'esecuzione:

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

L'immagine contiene il bundle, il suo runtime Node 24 (in `PATH`), gli strumenti inclusi di ricerca, shell, debugger, linguaggi e immagini, `git` e l'archivio dei certificati; non ci sono schermata di avvio né flusso di accesso. Viene eseguita come utente non root `mercury`, con la propria directory di configurazione dentro il container (`MERCURY_CONFIG_DIR`), e `/work` è la sua directory di lavoro. Colori e mouse seguono il rilevamento del terminale del prodotto, e `--user 0` esegue come root con l'unico avviso sovereign descritto sopra.

Una chiave di provider arriva come variabile d'ambiente, con gli stessi nomi che il prodotto legge ovunque: `ANTHROPIC_API_KEY` o `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` o `GOOGLE_API_KEY`, `XAI_API_KEY` (e `XAI_MANAGEMENT_API_KEY` per il suo misuratore d'uso), `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY` (e `MISTRAL_ADMIN_API_KEY` per il suo misuratore dell'organizzazione), `NOUS_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`, `TOGETHER_API_KEY` o `TOGETHER_AI_API_KEY`, `COHERE_API_KEY` o `CO_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `DASHSCOPE_API_KEY`, `MODEL_API_KEY` o `META_API_KEY`, `MERCURY_COMPAT_API_KEY` per un endpoint personalizzato compatibile con OpenAI e `MERCURY_LOCAL_API_KEY` per un server locale. Senza chiave l'esecuzione viene rifiutata in una riga ed esce con codice 1. `docker run -i … mercury run -` legge il prompt da stdin.

### Ospitare una sessione

`mercury runner` serve una sessione a un host tramite stdio: JSON-RPC 2.0, un messaggio per riga. L'host invia prima `initialize` e attende la risposta prima di inviare lavoro:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

Il nome e la versione dell'host viaggiano sotto `host`; `capabilities` dichiara `holds_asks`, `elicitation` e `partial_rows`. Ogni `id` di richiesta è un intero positivo: una richiesta il cui `id` sia altro riceve la risposta `-32600` con `id: null`, quindi numera le richieste a partire da 1.

`queue/add` accetta lo stesso oggetto prompt, shell o note dell'input a righe descritto sopra. L'output arriva in notifiche `row`. `session/facts` legge lo stato della sessione; `session/set_mode` cambia subito la modalità di permessi; `session/set_model` e `session/set_effort` cambiano il modello e l'effort, e una modifica fatta mentre un turno è in esecuzione viene trattenuta fino alla fine del turno: risponde con `at: "turn_end"`, poi `session/applied` la annuncia. `turn/interrupt` interrompe un turno; chiudi stdin per terminare la sessione.

Le richieste di permesso arrivano come `permission/request`, con `kind: "tool"` o `kind: "network"`. L'host risponde con `outcome: "allow"` o `outcome: "deny"`; un allow può contenere un `input` modificato e `rules` di permesso. Una richiesta ritirata invia `$/cancel_request` con il suo `request_id`. `holds_asks` assegna all'host il controllo del timer della richiesta. Una domanda MCP usa `elicitation/request` solo quando l'host dichiara `elicitation`; altrimenti riceve la risposta `cancel`.

Un metodo sconosciuto riceve `-32601`, parametri non validi `-32602`, un `id` che non è un intero positivo `-32600`, e una richiesta prima dell'inizializzazione `-32002`. Un rifiuto per regola è `-32010`, con una frase in `error.message` e un motivo in `error.data.kind`, come `mode`, `model`, `effort` o `claim`. Il runner risponde a una riga malformata con `-32700` e continua; tre righe malformate consecutive lo terminano.

### Altri comandi

I comandi disponibili includono:

- **`mercury health`**: rapporto diagnostico, detto anche certificato di salute. `--json` restituisce il rapporto completo, `--deep` esegue l'inventario approfondito e `--fix` esegue le correzioni guidate.
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**: accede (`login [<family>]`), elenca le famiglie di provider (`list`), verifica se un account è collegato (`status [<family>]`), esce (`logout [<family>]`) oppure genera un token Anthropic di lunga durata (`mint`).
- **`mercury models [--json]`**: stampa i modelli raggiungibili dagli account con accesso effettuato (gli stessi dati di `mercury://models`).
- **`mercury mcp`**: gestisce i server MCP con `add`, `import`, `list`, `get`, `remove`, `trust-reset` e `serve`.
- **`mercury extensions`**: installa le estensioni e gestisce le loro fonti. Azioni: `list`, `sources`, `add`, `remove`, `refresh`, `install`, `trust`, `enable`, `disable`, `update`, `uninstall`, `fence`, `unfence`, `inspect` e `scaffold`.
- **`mercury roster`**: elenca l'inventario degli agenti.
- **`mercury usage`**: stampa la riga compatta di cifre che mostra la schermata `/usage`; `--json` stampa la lettura completa: le finestre di ogni provider con accesso effettuato, con quanto usato e il ripristino, le cifre e i crediti dichiarati, ciascuno con la sua fonte e la sua età, e la spesa della sessione per modello, letta come la legge la schermata (il lettore di ogni provider con accesso effettuato viene campionato una volta, come all'apertura).
- **`mercury daemon run|status|stop|restart`**: avvia, ispeziona, ferma o riavvia il daemon in background. I suoi posti di sessione sono processi figli di `mercury runner`; il daemon invia i loro prompt e ospita le loro richieste di permesso.
- **`mercury sessions list`** (anche `mercury sessions` da solo): elenca le sessioni salvate di questo progetto, dalla più recente: l'id, quando è stata scritta l'ultima volta, la dimensione, `live` quando il daemon la ospita in questo momento, e il titolo o il primo prompt; `--all` legge tutti i progetti, `--limit <n>` limita l'elenco. L'id è ciò che `mercury --resume <id>` riapre e ciò che `sessions delete` rimuove.
- **`mercury sessions delete <id>`**: elimina deliberatamente una sessione salvata — la sua trascrizione e i registri conservati accanto (ricevute, snapshot di ripresa) — dopo una domanda di conferma; `--yes` salta la domanda negli script. Una sessione che il daemon ospita in questo momento viene rifiutata, e un id sconosciuto viene rifiutato con un suggerimento all'inventario (`/sessions` dentro Mercury). Le sessioni salvate, del resto, non vengono mai eliminate da sole.
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**: esegue un computer locale o SSH come server di modelli per tutte le sessioni che condividono la directory di configurazione (`compat/box-<name>/<model>`), usando un archivio locale di pesi verificato o un download confermato. Vedi [docs/LLM-HOST.md](../LLM-HOST.md).
- **`mercury lsp list`** e **`mercury lsp install <server>`**: il catalogo dei language server, con ogni server installato (con il suo binario) o assente (con l'indicazione per installarlo); `install` mostra l'indicazione di installazione di un server, chiede conferma, esegue esattamente quella (`--yes` salta la domanda negli script) e riferisce dove è finito il binario. Un server sconosciuto viene rifiutato con l'elenco. Mercury non installa mai un language server da solo; aprire un file avvia soltanto un server già installato.
- **`mercury acp`**: serve un editor tramite l'Agent Client Protocol, con un processo runner figlio per ogni sessione. `mercury bridge install` installa l'estensione per VS Code; `mercury bridge status` la controlla; `mercury bridge uninstall` la rimuove.
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**: gestisce i job del motore per il progetto Godot nella directory corrente. Mercury esegue le suite sui propri worker headless a partire da una copia congelata del progetto. Il servizio include un gate di compilazione, cattura di immagini, statistiche sui frame, profili completati, accesso alla coda dei job, annullamento e risultati per ID. Vedi [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md).
- **`mercury image <image>`**: mostra un'immagine nel terminale.
- **`mercury install`** e **`mercury update`** (alias `upgrade`): installano o aggiornano gli archivi di release; con `--json` il documento va su stdout qualunque sia il verdetto, e il codice di uscita indica se è fallito. Vedi [Installazione](#installazione).
- **`mercury version`** e **`mercury help [command]`**: stampano la riga di versione o una pagina di aiuto, come `--version` e `--help`; nessuno dei due avvia una sessione.

## Cosa contiene: memoria RAG Mneme, LSP, AST in 23 linguaggi, debugger DAP, ricerca web e integrazioni

- **Memoria di progetto RAG ibrida Mneme.** Mneme è attiva per impostazione predefinita e conserva i fatti di ogni progetto in semplici pagine markdown per argomento (`Retain`, `Recall`, `Reflect`, `Correct`). Recall unisce un modello di embedding semantico BGE da 118 MB eseguito in locale (`bge-base-en-v1.5` `q8_0`, MIT, incluso in ogni archivio di release e compilato per la sua piattaforma; vedi [Componenti opzionali](#componenti-opzionali)) con il ranking BM25 delle parole con stemming, la ponderazione per recenza e il tracciamento delle citazioni tramite reciprocal rank fusion (`k = 60`). Le regole fissate (`pin: true`) vengono caricate alla lettera nella sezione delle regole fissate e cambiano solo su tua indicazione. All'avvio di una sessione, Mercury valuta i fatti non fissati e le note precedenti rispetto al branch corrente, ai file toccati di recente e alla nota di handoff dell'ultima sessione, entro un budget di avvio dedicato (`memory.startLimit`, 4.000 caratteri per impostazione predefinita). I controlli di contraddizione in fase di scrittura individuano inversioni di polarità, negazioni e cambi di numeri prima che un fatto in conflitto venga salvato. Ogni sessione scrive all'uscita una nota di handoff con parole proprie per la pagina di ingresso della sessione successiva, più una voce facoltativa nel diario della sessione. `/memory` apre il centro della memoria, e `/memory page` disegna la libreria nel browser come grafo di nodi e archi. Vedi [docs/MNEME.md](../MNEME.md).
- **Intelligenza del codice LSP, riscritture AST in 23 linguaggi, debugger DAP e celle `Eval`.** Letture ancorate e modifiche atomiche su più file (`ChangeSet`); interrogazioni del language server (`LspRead`) e refactoring in anteprima poi applicati (`LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`); ricerca e riscrittura sull'albero sintattico (`AstSearch`, `AstEdit`) con le metavariabili `$NAME` e `$$$NAME` su 23 grammatiche negli archivi di release (16 in ogni build di `bun install` più 7 nel pacchetto delle grammatiche); celle di codice Python (`python3`) e JavaScript (modulo ES di Node) persistenti (`Eval`); e un debugger Debug Adapter Protocol (`Debug`) che pilota `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`, `netcoredbg`, `rdbg`, l'adattatore di debug dell'SDK Dart, `kotlin-debug-adapter`, l'adattatore di debug di elixir-ls e Godot. Lo strumento `Test`, con l'operazione `debug`, porta un test fallito in Python (`pytest`, `unittest`), JavaScript/TypeScript (`node-test`, `vitest`, `jest`), Go (`go test`) o Rust (`cargo test`) direttamente in una sessione `Debug`, dove si può procedere passo passo. Vedi [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md), [transazioni di modifica](../CHANGE-TRANSACTIONS.md), [pattern strutturali](../STRUCTURAL-PATTERNS.md), [celle di codice](../EVAL.md) e [il debugger](../DEBUGGER.md).
- **`WebSearch` senza chiave e `WebFetch` in markdown.** `WebSearch` segue un'unica cascata: prima la ricerca live nativa del provider, quando il modello della sessione la supporta (`ProviderSearch`); poi le chiavi Brave o Tavily salvate; poi le API ufficiali scelte in base alla forma della query (Stack Exchange, npm, PyPI, crates.io, ricerca di codice su GitHub, Hacker News Algolia, Wikipedia); poi le API JSON di SearXNG configurate (`MERCURY_SEARCH_SEARXNG_INSTANCES`) e, infine, lo scraping delle pagine di DuckDuckGo senza chiave (attivo per impostazione predefinita; disattivalo in `/config` o con `MERCURY_SEARCH_KEYLESS=0`). Ogni risposta resta sotto i 2.000 token e indica la fonte che ha risposto. `WebFetch` legge le pagine pubbliche come markdown, con le parole della pagina stessa, entro un budget di 38.000 caratteri per chiamata (una pagina che richiede un browser viene letta tramite il lettore ospitato `r.jina.ai`, a meno che `MERCURY_FETCH_READER=0` non sia impostato, e un indirizzo di rete privata non viene mai inviato a quel lettore). Vedi [docs/ENGINES.md](../ENGINES.md).
- **Agenti, crewmate tra provider (`Crewmate`), worktree e prenotazioni dei file.** Due agenti integrati (`mercury-crew` per il lavoro delegato di ogni tipo e `mercury-scout` per la ricognizione in sola lettura) affiancano le definizioni di agente che crei in `/agents`. Avvia crewmate su qualsiasi provider con accesso effettuato, isola il lavoro parallelo in checkout di `git worktree` (`isolation: "worktree"`), coordina i file condivisi con prenotazioni dei file di progetto interne al processo (`mcp__mercury__lease_take`, `mcp__mercury__lease_release`, `mcp__mercury__lease_list`), e guida o riprendi i crewmate per nome o id con `SendMessage` e `ResumeCrewmate`. Segui i crewmate e le esecuzioni dei workflow in `/crewmates` e `/runs`. Vedi [docs/CREW.md](../CREW.md).
- **Uso del computer desktop.** Attivo per impostazione predefinita quando è disponibile il driver nativo del desktop. Lo strumento `Computer` cattura screenshot e controlla mouse e tastiera nell'applicazione in primo piano. Mercury verifica l'applicazione per nome e identità prima di agire, chiede approvazione a meno che le tue regole di permesso, la concessione della sessione, l'impostazione di accesso o la modalità di permessi non consentano già l'azione, si ferma con `Esc`, consente a una sola sessione alla volta di controllare il desktop e tiene gli screenshot fuori dal file della conversazione salvato. Imposta `MERCURY_COMPUTER_USE=0` per rimuovere lo strumento. Vedi [docs/COMPUTER-USE.md](../COMPUTER-USE.md).
- **Input vocale Whisper sul dispositivo (`/voice`).** `/voice on` scarica al primo uso il modello vocale inglese da 60 MB (`base.en-q5_1`), ne verifica il digest SHA-256 e attiva la dettatura; `/voice off` la disattiva. Tieni premuta la barra spaziatrice per 1 s per parlare e rilasciala per fermarti, oppure esegui `/voice` da solo per avviare e fermare una registrazione mentre la voce è attiva. Whisper trascrive sul dispositivo, quindi l'audio non lascia mai la macchina, e `MERCURY_WHISPER_MODEL` seleziona `tiny.en-q5_1`, `small.en-q5_1`, il modello multilingue `base-q5_1` oppure un file `.gguf` locale. Vedi [docs/VOICE.md](../VOICE.md).
- **Scheduler cron e di sessioni Saturn (`/saturn`).** Pianifica un prompt per una sessione esistente (`CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, `/loop`) oppure pianifica una nuova sessione che parta a un orario prestabilito. Le pianificazioni possono essere eseguite una volta o ripetersi. Vedi [docs/SATURN.md](../SATURN.md).
- **Ponti per VS Code (ACP), Unity, Blender, Godot e Aseprite.** `mercury acp` si collega agli editor che supportano l'Agent Client Protocol. L'estensione per VS Code (`mercury bridge install`) esegue Mercury nell'editor tramite quel protocollo: chat, sessioni, agenti, artefatti e revisioni, con la selezione e i diagnostici dell'editor che accompagnano ogni prompt. Integrazioni separate e facoltative si collegano agli editor Unity (`MERCURY_UNITY=1`), Blender (`MERCURY_BLENDER=1`) e Godot (`MERCURY_GODOT_TOOLS=1`) quando sono in esecuzione, con accesso in batch ad Aseprite (`MERCURY_ASEPRITE=1`). Vedi [Unity](../UNITY-BRIDGE.md), [Blender](../BLENDER-BRIDGE.md), [Godot](../VULCAN-GODOT-TOOLS.md) e [Aseprite](../ASEPRITE-BRIDGE.md).
- **Estensioni.** Ogni estensione ha un unico manifest. Aggiungi fonti da un URL git, da una cartella locale o da un archivio, approvate tramite il loro hash delle contribuzioni. Vedi [docs/EXTENSIONS.md](../EXTENSIONS.md).
- **MCPs & Skills.** Configurazione per repository di ciò che le sessioni caricano, con preset con nome e controlli che puoi modificare durante una sessione. Vedi [docs/KIT.md](../KIT.md).
- **Diagnostica.** Il controllo di salute e `/health` producono un rapporto supportato da evidenze diagnostiche, con un verdetto `certified`, `caution` o `fault` e correzioni verificate. Vedi [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md).
- **Fiducia e permessi.** Fiducia nello spazio di lavoro, regole e modalità di permessi, e i comandi che ogni sessione rifiuta. Vedi [docs/TRUST.md](../TRUST.md).
- **Apollo Mode**, l'intervista di specifica: rispondi alle domande dell'agente per completare la specifica che userà per costruire un prototipo. Vedi [docs/APOLLO-MODE.md](../APOLLO-MODE.md).
- **Ripristino.** Pubblicazione atomica, operazioni registrate in un journal e riconciliazione all'avvio. Vedi [docs/DURABILITY.md](../DURABILITY.md).

I flag di runtime sono definiti in `src/substrate/flagRegistry.ts`, esposti come impostazioni `MERCURY_*` e generati su richiesta. La compatibilità delle integrazioni è documentata in [docs/COMPATIBILITY.md](../COMPATIBILITY.md). L'indice completo della documentazione è in [docs/README.md](../README.md).

## Comandi slash

`/help` elenca i comandi interattivi disponibili. Usa `/palette` per la ricerca fuzzy dei comandi. La tabella seguente raggruppa i comandi integrati attivi per impostazione predefinita secondo le categorie usate da `/help`; l'elenco in tempo reale include anche `/samples` sotto `current work` quando Samples è abilitato (`MERCURY_SAMPLES=1` o la riga Samples del Boot Menu), `/showcase` quando è impostato `MERCURY_DEV_SURFACES=1`, e qualsiasi skill o comando di estensione.

| Categoria | Comandi |
| --- | --- |
| current work | `/run` `/runs` `/workbench` `/diff` `/mission` |
| crew & delegation | `/agents` `/crewmates` `/crew` `/workflows` `/daemon` `/saturn` `/seats` `/kill` `/unkill` |
| session & context | `/clear` `/compact` `/context` `/rewind` `/sessions` `/concourse` `/rename` `/title` `/contract` `/export` `/copy` `/usage` `/realms` `/restart` |
| memory & goals | `/memory` `/console` |
| model & effort | `/model` `/effort` `/submodels` `/advise` `/caching` |
| git & review | `/review` `/audit` |
| health & introspection | `/health` `/verify` `/trace` `/capabilities` `/lsp` |
| config & setup | `/config` `/jev` `/localsetup` `/llmhost` `/permissions` `/hooks` `/mcp` `/extensions` `/skills` `/browser` `/orient` `/keybindings` `/keys` `/vim` `/mouse` `/keysetup` `/bootmenu` `/voice` |
| appearance & cockpit | `/appearance` `/critter` `/palette` `/zen` `/browse` |
| account & app | `/logins` `/logout` `/accounts` `/defaultprovider` `/update-notes` `/feedback` `/help` `/exit` |

| Comando | Cosa fa |
| --- | --- |
| `/llmhost` | Scegli un modello da noleggiare su Runpod, Vast.ai o Lambda, eseguilo sul tuo computer oppure collega un server esistente. |
| `/restart` | Sposta questa chat sulla build di Mercury installata; i monitoraggi in esecuzione e le shell in background si fermano. |
| `/mcp` | Ispeziona i server, accedi, sfoglia gli strumenti e i parametri di ciascun server, riconnetti oppure attiva o disattiva un server per questa chat. |

`/mouse off` restituisce il puntatore al terminale per la selezione e la copia nativa del testo. La preferenza viene salvata e compare in `/config` come Mouse capture.

Un argomento obbligatorio inizia con `<…>` nell'uso di una skill. Per esempio, `/update-config` e `/debug` richiedono un argomento. Se ne invii uno da solo, ottieni la descrizione e l'uso; non parte nessun turno. Selezionandolo nei suggerimenti e premendo Enter, `/name ` resta pronto perché tu aggiunga l'argomento. `/loop` non ha un argomento obbligatorio e parte subito.

## Segnalare un problema

Per una segnalazione breve, usa [il modulo per i tester](https://mercury-cli.ai/report) oppure `/bug --short <what you tried>` dentro Mercury. Chiede il tuo sistema operativo, che cosa hai provato e che cosa si è rotto; non serve allegare un dump del controllo di salute.

Esegui `/bug <what happened>` dentro Mercury per vedere l'anteprima di una segnalazione prima di inviarla tramite la GitHub CLI (`gh`) con cui hai effettuato l'accesso. Senza `gh`, Mercury salva una bozza locale nella directory di configurazione e ti indica la pagina delle issue del repository.

Puoi anche aprire una issue direttamente usando il modello per bug, provider/modello o richiesta di funzionalità. Includi l'output di `--version`, il sistema operativo, il terminale e i passaggi esatti. Le segnalazioni di bug e di provider richiedono anche `mercury health --json`, oppure `node dist/mercury.mjs health --json` per una build dal codice sorgente. Una trascrizione della schermata che non funziona è utile.

Segnala i problemi di sicurezza in privato tramite la scheda Security del repository. Non metterli nelle issue pubbliche. Vedi [SECURITY.md](../../SECURITY.md). [CONTRIBUTING.md](../../CONTRIBUTING.md) tratta issue, pull request e controlli.

## Licenza

Mercury CLI è concesso in licenza sotto la Business Source License 1.1 (`BUSL-1.1`) con la Mercury Community Production Grant in [LICENSE.md](../../LICENSE.md). Gli SDK TypeScript e Python in [sdk/](../../sdk/) e [sdk-py/](../../sdk-py/) (`mercury-cli-sdk` su npm e PyPI) sono concessi in licenza separatamente sotto la Apache License 2.0 (`Apache-2.0`), ciascuno secondo il file LICENSE che contiene ([sdk/LICENSE](../../sdk/LICENSE) e [sdk-py/LICENSE](../../sdk-py/LICENSE)), e non fanno parte del Licensed Work.

Mercury è disponibile come codice sorgente sotto la Business Source License 1.1, con la Mercury Community Production Grant. La licenza è in [LICENSE.md](../../LICENSE.md), con le sue [condizioni di produzione](../../MERCURY-COMMUNITY-PRODUCTION-TERMS.md) complementari e la [politica sui marchi](../../TRADEMARKS.md). Fa fede il testo della licenza; questo è un riepilogo.

Puoi leggere, copiare, modificare e forkare il codice sorgente. Le persone fisiche e le organizzazioni al di sotto di entrambe le soglie della comunità possono usare Mercury in produzione gratuitamente per costruire e vendere i propri prodotti, inclusi quelli commerciali. Sia il fatturato annuo consolidato sia il finanziamento esterno complessivo devono essere inferiori a US$1.000.000.

Un utente idoneo che raggiunge una delle due soglie riceve un periodo di grazia di 90 giorni. Dopodiché, il nuovo lavoro di prodotto, incluse le funzionalità nuove e sostanziali, richiede una licenza commerciale. I prodotti già in produzione quando è stata raggiunta la soglia possono essere ancora mantenuti usando le versioni di Mercury ottenute prima della fine del periodo di grazia, nel rispetto delle condizioni di manutenzione della licenza.

Vendere, rivendere con marchio bianco o ospitare Mercury stesso per conto di terzi, oppure offrire un suo sostituto, richiede una licenza commerciale indipendentemente dal fatturato o dal finanziamento.

Ogni versione passa alla Apache License 2.0 alla propria Change Date, tre anni dopo il rilascio di quella versione.

Per la licenza commerciale e l'autorizzazione all'uso del marchio, visita [mercury-cli.ai/licensing](https://mercury-cli.ai/licensing). Le licenze di terze parti incluse sono elencate in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
