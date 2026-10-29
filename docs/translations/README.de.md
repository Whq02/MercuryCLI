[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI (mercury-cli.ai, npm-Paket `mercury-tech-cli`) führt KI-Coding-Agenten in Ihrem Terminal aus, innerhalb Ihrer eigenen Git-Repositories unter macOS, Linux und Windows.

Website: [mercury-cli.ai](https://mercury-cli.ai) · Repository: [github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI) (`Whq02/MercuryCLI`) · npm: `mercury-tech-cli`

Ein Agent liest und bearbeitet Dateien, führt Shell-Befehle aus, durchläuft Tests und Debugger Schritt für Schritt und prüft die Ergebnisse. Sie bestimmen den Modellanbieter, das Modell und den Umfang dessen, was der Agent tun darf:

- **Multi-Session-Concourse und isolierte Worktrees:** Führen Sie mehrere Sessions nebeneinander auf dem Session Concourse (`/concourse`) aus und delegieren Sie parallele Arbeit an anbieterübergreifende Crewmates (`Crewmate`) in isolierten Checkouts über `git worktree` mit projektbezogenen Datei-Leases, damit parallele Agenten einander nicht überschreiben.
- **20 Modellanbieter, `/llmhost` und `/localsetup`:** Halten Sie alle 20 Anbieter gleichzeitig angemeldet (OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot/Kimi, Z.AI/GLM, OpenRouter, Hugging Face, xAI/Grok, Meta/Muse, Mistral, Nous Portal, OpenCode Zen, Qwen, MiniMax, Together AI, Cohere, Groq, Cerebras, Fireworks AI) und wechseln Sie Anbieter und Modelle während eines Chats. Öffnen Sie `/llmhost`, um ein Modell auszuwählen, dessen Quantisierung, die Aufteilung `conversations × context` und die Thinking-Stufe zu prüfen und das Modell auf einer gemieteten GPU (Runpod, Vast.ai oder Lambda), auf Ihrem eigenen Computer (`mercury host`) oder auf einem bestehenden Server laufen zu lassen. Oder führen Sie `/localsetup` aus, um Ollama zusammen mit LM Studio, vLLM und llama.cpp zu installieren oder anzubinden.
- **Mneme-Hybrid-RAG-Projektgedächtnis:** Nutzt ein 118 MB großes, lokal auf dem Gerät laufendes semantisches Embedding-Modell BGE (`bge-base-en-v1.5`) mit BM25-Wortranking und Zitierverfolgung, wörtlich angeheftete Regeln, branch-bewussten Startkontext, Widerspruchsprüfungen beim Schreiben, Session-Übergabenotizen und den Graph-Browser `/memory page`.
- **Werkzeuge für Compiler, AST und DAP-Debugging:** Verbindet LSP-Codeintelligenz und Vorschau-Refactorings (`LspRead`, `LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`), strukturelle Suche und Umschreibung per AST für 23 Sprachen auf Basis von tree-sitter (`AstSearch`, `AstEdit`), einen integrierten Debugger über das Debug Adapter Protocol (`Debug`) (`debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`) zum schrittweisen Durchlaufen fehlschlagender Python-, Node-, Go- und Rust-Tests sowie persistente Python- und JavaScript-Zellen mit `Eval`.
- **`WebSearch` ohne Schlüssel und `WebFetch` als Markdown:** Sucht über die native Suche des Anbieters, mit Brave- oder Tavily-Schlüsseln, über offizielle APIs (Stack Exchange, npm, PyPI, crates.io, GitHub, Hacker News, Wikipedia), über SearXNG und DuckDuckGo ohne Schlüssel und ruft öffentliche Dokumentation als Markdown ab, innerhalb eines Budgets von 38.000 Zeichen pro Aufruf.
- **Desktop-Steuerung, Whisper-Spracheingabe, Saturn-Zeitplanung und Editor-Anbindungen:** Steuert Desktop-Anwendungen (`Computer`), transkribiert Push-to-talk-Diktate lokal auf dem Gerät mit Whisper (`/voice`), plant wiederkehrende oder einmalige Sessions mit Saturn (`/saturn`) und verbindet sich über das Agent Client Protocol (`mercury acp`) mit VS Code sowie mit Unity, Blender, Godot und Aseprite.
- **Videogenerierung (`Video`):** Sendet Prompts und Projekt-Referenzdateien an einen konfigurierten MiniMax-Generator ([docs/VIDEO.md](../VIDEO.md)) und speichert das erzeugte MP4 sowie optional einen 1-Sekunden-PNG-Vorschauframe im Projekt.

Mercury wird eingesetzt, um Mercury zu entwickeln; dabei laufen mehrere Sessions und Modelle über lange Aufgaben hinweg. Den Überblick über diese Arbeit zu behalten ist der schwierige Teil: was noch läuft, was sich geändert hat und was eine Entscheidung braucht. Jede Session schreibt beim Abschluss ihre eigene Übergabenotiz, und die nächste Session liest diese Notiz beim Start einmal zusammen mit meinen angehefteten Regeln. So wird Kontextvergiftung zwischen den Sessions verhindert.

![Ein Prompt an den Koordinator auf dem Session-Board startet zwei Sessions, jede in einem eigenen Worktree; eine fragt vor dem Bearbeiten nach, und beide enden mit Änderungen, die zur Prüfung bereitliegen](../media/session-board-stream.gif)

Mercury ist Open Source unter der Apache License 2.0, ebenso wie die SDKs in [sdk/](../../sdk/) und [sdk-py/](../../sdk-py/).

## Installation

Release-Archive sind für Apple silicon und Intel-Macs, Linux x64 und arm64 sowie Windows x64 und arm64 verfügbar. Installieren Sie `git` separat; jedes Archiv enthält Node und ripgrep, daher ist keine separate Node-Installation nötig.

Wählen Sie eine Installationsmethode:

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS und Linux (x64 und arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows (x64 und arm64), in PowerShell 7
brew install Whq02/mercury/mercury                 # Homebrew: macOS und Linux x64
npm install -g mercury-tech-cli                    # npm; `bun install -g mercury-tech-cli` ist dasselbe Paket
mise use -g npm:mercury-tech-cli                   # mise, über das npm-Paket
```

Die Install-Adressen führen ungefähre Zählungen der Skriptanfragen nach Quelle und UTC-Tag (abgeschlossene Installationen werden nicht gezählt); der Zähler speichert keine IP-Adresse, keinen User-Agent-String und kein Cookie.

Öffnen Sie ein neues Terminal oder führen Sie die Zeile `export PATH=…` aus, die der Shell-Installer ausgibt. Prüfen Sie danach mit `mercury --version`, ob die Installation funktioniert, und starten Sie `mercury` in einem Repository, um den [ersten Start](#der-erste-start) zu beginnen. Unter Windows PowerShell sowie nach einer Installation mit Homebrew, npm, bun oder mise funktioniert `mercury` im selben Terminal.

<details>
<summary>Installationspfade, Updates und Überprüfung von Releases</summary>

### Unterschiede zwischen den Installationsmethoden

Die Shell- und PowerShell-Installer laden das neueste Release für Ihre Plattform, prüfen dessen SHA-256 gegen `SHA256SUMS.txt`, entpacken es und führen den eigenen Befehl `mercury install` des Archivs aus.

Homebrew und das npm-Paket sind jeweils auf ein bestimmtes Release festgelegt und werden nach einem Tag erneut veröffentlicht; deshalb können sie hinter dem neuesten Release zurückliegen. Homebrew-Befehle verwenden den vollständigen Tap-Namen `Whq02/mercury/mercury` (das einfache `mercury` in `homebrew-core` ist ein anderes Programm). Das npm-Paket `mercury-tech-cli` ist ein Launcher, der sein festgelegtes Release herunterlädt; mise installiert dasselbe Paket. `mercury install --uninstall` entfernt das installierte Release und den Befehls-Shim, behält aber Ihre Konfiguration und Ihre Sessions (wenn Sie den npm-Launcher installiert haben, führen Sie außerdem `npm uninstall -g mercury-tech-cli` aus).

Die Installation von Mercury ist benutzerlokal und benötigt keine Administratorrechte. Sie können einen Installationsbefehl gefahrlos erneut ausführen.

### Installationspfade

Release-Versionen liegen unter dem config home in `~/.mercury/versions/<version>` (unter Windows `%USERPROFILE%\.mercury\versions`). Der Befehl `mercury` wird unter macOS und Linux in `~/.local/bin` installiert, unter Windows in `%LOCALAPPDATA%\Mercury\bin`.

`mercury install` nimmt das Verzeichnis des Befehls einmalig in den PATH auf: als markierte Zeile in Ihrer Shell-Startdatei oder als Eintrag im Benutzer-PATH unter Windows. Ein neues Terminal übernimmt die Änderung automatisch.

### Updates

Verwenden Sie `mercury update` mit jeder Installationsmethode.

Bei einer Installation mit dem Shell- oder PowerShell-Installer oder mit `mercury install` aktualisiert der Befehl Mercury direkt in der bestehenden Installation. `--check` prüft auf verfügbare Updates, `--status` zeigt den Update-Status an, und `--rollback` kehrt zur vorherigen Version zurück, die auf der Festplatte erhalten bleibt.

Bei Homebrew fragt Mercury nach, bevor es `brew upgrade Whq02/mercury/mercury` ausführt. Die Standardantwort ist Nein; geben Sie `y` ein, um zuzustimmen. Mercury zeigt die Ausgabe des Befehls fortlaufend an und prüft danach die installierte Version. Mit `--yes` entfällt die Abfrage in Skripten.

Der npm-Launcher verwendet dasselbe Release-Layout wie die Installer und leitet jeden Lauf an das installierte Release weiter. `mercury update` aktualisiert daher eine npm-Installation direkt über den eigenen Update-Kanal von Mercury. `npm update -g mercury-tech-cli` ändert nur das Release, das das Paket bei seinem ersten Lauf installiert. Dasselbe gilt bei Verwendung von mise.

`--check` liest für jede Installationsmethode dieselbe Release-Liste und sagt Ihnen, wie Sie Ihre Installation aktualisieren. Wenn ein Update verfügbar ist, zeigt der Startbildschirm `vX.Y.Z available · mercury update` einmal in der unteren rechten Ecke an, und der Chat zeigt denselben Hinweis, bis Sie aktualisieren. Setzen Sie `MERCURY_UPDATE_NOTICE=0`, um beides auszublenden.

Installations- und Update-Anfragen laden die öffentliche Release-Liste und die Archive anonym. Sie können sie ohne Konto oder Token ausführen. Wird eine anonyme Anfrage abgelehnt, greift Mercury auf die angemeldete GitHub CLI (`gh`) zurück.

Nach einem Update prüft Mercury, ob der Befehl in Ihrem PATH auf die aktualisierte Installation zeigt. Wenn eine andere Installation Vorrang hat oder der aktualisierte Befehl im PATH fehlt, erklärt Mercury das Problem und die Lösung. `mercury health` meldet dasselbe Problem.

### Überprüfung von Releases

Bevor Mercury ein Release aktiviert, prüft es das Archiv gegen `SHA256SUMS.txt`. Außerdem verlangt es, dass die Payload mit dem Release-Schlüssel von Mercury signiert ist, der im fest einkompilierten Trust-Roster steht, bevor das Update bereitgestellt wird. Eine abgelehnte Signatur lässt die aktive Installation unverändert.

Mit `--allow-unsigned` akzeptieren Sie eine nicht signierte Payload. Mercury lehnt weiterhin unbekannte Signaturschlüssel, fehlerhafte Signaturblöcke und manipulierte Inhalte ab. Das Ergebnis des Befehls und sein lokaler Protokolleintrag zeigen beide, dass Sie eine nicht signierte Payload zugelassen haben.

Release-Archive sind signiert. Führen Sie `mercury health` aus, um die Signatur des installierten Releases zu prüfen.

Ein Archiv ohne Release-Signatur wird als nicht signiert gekennzeichnet. Installation und Update lehnen es ab, sofern Sie nicht `--allow-unsigned` angeben.

[docs/TRUST.md](../TRUST.md) erläutert die Prüfergebnisse und wie Sie ein Archiv manuell prüfen. [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) behandelt die Überprüfung beim Start.

### Hinweise zu Plattformen

Für jede oben genannte Plattform gibt es Release-Archive. Jede andere Maschine baut aus dem Quellcode.

Release-Archive für Intel-Macs sind verfügbar.

</details>

## Voraussetzungen

Release-Archive enthalten Node 24 LTS. Die Launcher, `mercury install` und `mercury update` verwenden die mitgelieferte Laufzeitumgebung; `git` ist die einzige separate Voraussetzung für das Release selbst.

Um aus dem Quellcode zu bauen, benötigen Sie:

- **Node 24 LTS**, im unterstützten Bereich `>=24.20.0 <25`. `.node-version` legt die für Builds verwendete und in Release-Archiven enthaltene Patch-Version fest.
- **bun 1.3.x** für den Build. Bun wird nicht mit Releases mitgeliefert.
- **git**. Unter Windows führen Sie PowerShell 7 im Windows Terminal oder im Terminal von VS Code aus. Siehe [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md).

Die Node-Mindestversion enthält die Korrektur für nodejs/node#56645. Unterhalb von 24.20.0 brechen headless `run`-Befehle, die ein Werkzeug aufrufen, beim Beenden unter Windows ab.

Die Launcher wählen Node in dieser Reihenfolge aus: die über `MERCURY_NODE` festgelegte Binärdatei, die mitgelieferte Laufzeitumgebung, dann eine kompatible Node-Installation im PATH. Fehlt die Laufzeitumgebung, meldet der Launcher einen Fehler.

### Windows-Shells

Release-Archive enthalten die Bash-kompatible Shell-Engine von Mercury (`brush`). Unter Windows dient sie standardmäßig dem Bash-Werkzeug: Sie findet ein `.cmd`- oder `.bat`-Programm wie `npm` über seinen einfachen Namen mithilfe von PATHEXT, übergibt `%VAR%` und `^` unverändert an eine Batchdatei, führt ein über einen relativen Pfad benanntes Programm nach `cd` aus und behält den Shell-Zustand zwischen Aufrufen bei. `bash.exe` aus Git für Windows ist nicht erforderlich; ist es installiert, führt `MERCURY_SHELL_ENGINE=system` oder `system` unter Shell engine in `/config` das Bash-Werkzeug ausschließlich über `bash.exe` aus.

Lesen Sie die Zeile `shell` des Health-Checks, um zu sehen, welche Shell aktiv ist und warum: die mitgelieferte Engine (der Windows-Standard oder per Pin bzw. Einstellung aktiviert) oder Git Bash, wenn die Engine ausgeschaltet wurde oder ihr Paket fehlt.

Auf macOS und Linux ist die System-Shell der Standard. Setzen Sie `MERCURY_SHELL_ENGINE=brush` oder wählen Sie `brush` in `/config` unter Shell engine, um das Bash-Werkzeug auch dort über die mitgelieferte Engine mit dauerhaftem Shell-Zustand auszuführen.

Ein Build aus dem Quellcode ohne das Engine-Paket oder Git für Windows startet trotzdem, aber das Bash-Werkzeug ist nicht verfügbar. Das PowerShell-Werkzeug bleibt verfügbar, und die Diagnose `shell` erklärt, wie die Bash-Unterstützung wiederhergestellt wird.

## Aus dem Quellcode bauen

Mercury wird mit bun gebaut und läuft auf Node 24 LTS. Installieren Sie [die Voraussetzungen für den Build aus dem Quellcode](#voraussetzungen), einschließlich bun 1.3.x:

```sh
curl -fsSL https://bun.sh/install | bash           # macOS und Linux
powershell -c "irm bun.sh/install.ps1 | iex"       # Windows, in PowerShell 7
bun --version                                      # 1.3.x
```

Danach in einem Klon dieses Repositorys:

```sh
bun run setup                      # einmalig; bun install + die mitgelieferten Packs
bun run build.ts                   # schreibt dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### Terminal-Unterstützung

Die Vollbild-Oberfläche benötigt ein echtes TTY, hat aber keine Mindestgröße für das Terminal. Das volle Layout beginnt bei 100 Spalten × 26 Zeilen; kleinere Fenster verwenden ein kompaktes Layout.

Mercury verwendet 24-Bit-Farben, wenn das Terminal dies über `COLORTERM=truecolor` ankündigt oder als iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal oder VS Code erkannt wird. Andere Terminals verwenden 256 Farben, einschließlich Apples Terminal unter macOS 15 und früher.

Die Zeile Terminal color im Health-Check meldet die erkannte Farbtiefe und den Grund. Setzen Sie `MERCURY_TRUECOLOR=1` für ein Terminal, das True Color unterstützt, es aber nicht ankündigt, oder `MERCURY_TRUECOLOR=0`, um 256 Farben zu erzwingen.

### Optionale Komponenten

`setup` lädt die mitgelieferten Capability-Packs: pyright, debugpy, js-debug, zusätzliche Grammatiken, die Node-Laufzeitumgebung der Plattform und brush. Schlägt ein Download fehl, wird dieses Pack übersprungen, und der Build sowie die betroffenen Werkzeuge melden die fehlende Komponente. Wenn Sie nur `bun install` ausführen, entsteht ein Build ohne diese Packs.

Um die Sprachunterstützung zu bauen, führen Sie `setup` mit installiertem Rust aus. Dabei entsteht `native/voice`. Installieren Sie cmake, um außerdem `native/whisper` zu bauen. Mit installiertem Rust baut `setup` außerdem das Desktop-Treiber-Addon (`native/desktop`), über das das Werkzeug `Computer` läuft. Ebenfalls mit installiertem Rust baut `setup` das lokale Embedding-Addon (`native/embed`, `bun run scripts/vendor/build-embed.ts`) und lädt das 118 MB große BGE-Modell (`bun run scripts/vendor/fetch-embed-models.ts --default`). Ohne cargo wird das Pack übersprungen, setup meldet das, und die Suche im Mneme-Gedächtnis arbeitet nur mit Wortabgleich. Jedes Release-Archiv enthält das Embedding-Pack für seine Plattform; unter Linux und Windows läuft die Berechnung in einem vektorisierten Kernel, sodass eine Recall-Suche nach Bedeutung etwa eine Zehntelsekunde dauert (unter macOS, das Accelerate verwendet, einige Hundertstelsekunden). Fehlen einem nativen Build seine Werkzeuge, überspringt setup ihn, und der Health-Check meldet das fehlende Addon. Die Windows-Shell-Engine wird ebenfalls auf Ihrem Rechner kompiliert, weil upstream kein Windows-Binary bereitgestellt wird.

Siehe [Windows-Shells](#windows-shells) und [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) zur `brush`-Shell-Engine.

Der Build schreibt ausschließlich in `dist/`. Konfiguration und Sessions liegen in `~/.mercury` oder im Verzeichnis, das `MERCURY_CONFIG_DIR` festlegt, und werden beim ersten Start angelegt. Unter Windows führen Sie `node dist\mercury.mjs` direkt aus.

### Einen Build aus dem Quellcode als Befehl installieren

`scripts/ops/deploy-runtime.sh` veröffentlicht einen Build aus einem sauberen Arbeitsverzeichnis in einen neuen Ordner `<config home>/runtime/builds/<build>` und lässt `runtime/current` darauf zeigen (`runtime/dist` ist der ältere Name für denselben Link). `scripts/ops/deploy-launcher.sh` installiert den Launcher unter `<config home>/bin/mercury`. Fügen Sie dieses Verzeichnis dem PATH hinzu; für zsh:

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

Der Launcher bricht mit einem Fehler ab, wenn die Laufzeitumgebung fehlt. Er wechselt nicht zu einem anderen Build. Die Auswahl von Node folgt der Reihenfolge unter [Voraussetzungen](#voraussetzungen). Führen Sie für eine Release-Installation `mercury install` oder `mercury update` aus; beide lassen Quell-Checkouts unverändert. Siehe [Updates](#updates).

[AGENTS.md](../../AGENTS.md) ist die kurze Anleitung zum Bauen und Starten. [BUILD-NOTES.md](../../BUILD-NOTES.md) beschreibt den Build ausführlicher.

## Der erste Start

Beim ersten interaktiven Start wählen Sie ein Erscheinungsbild und melden sich danach bei einem Anbieter an. Der Bildschirm zeigt Theme-Änderungen beim Durchblättern als Vorschau an. True Black ist der Standard; die anderen Optionen sind das dunkle Theme oasis und Black and white, das überhaupt keine Farbe verwendet: die Textfarbe des Terminals auf dessen eigenem Hintergrund, so wie Mercury in einem Terminal ohne Farbe aussieht. Sie können dies später mit `/appearance` ändern.

Sie können auch „sign in later“ wählen, um sich umzusehen, ohne ein Konto zu verbinden. Wenn ein Anbieterschlüssel in Ihrer Umgebung einen Anbieter bereits anmeldet, wird der Anmeldeschritt nicht abgefragt. Danach erinnert Sie der Schritt Guardrails daran, Mercurys Änderungen und Befehle zu prüfen, und daran, dass Inhalte, die Mercury liest, Anweisungen für das Modell enthalten können. In einem Terminal, das Mercury konfigurieren kann (Terminal.app, die VS-Code-Familie, Alacritty, Zed), kann der Schritt Terminal keys Zeilenumbruch-Tastenkürzel in den Einstellungen des Terminals selbst einrichten (in Terminal.app unter macOS setzt er `Option+Enter` für einen Zeilenumbruch und schaltet die Terminal-Glocke für jedes Profil stumm; das wird nach einem Neustart von Terminal.app wirksam; in der VS-Code-Familie, Alacritty und Zed schreibt er `Shift+Enter` für einen Zeilenumbruch). Er bleibt ausgeschaltet, bis Sie ihn wählen, und es wird eine Sicherungskopie angelegt.

Danach fragt Mercury, ob Sie dem geöffneten Ordner vertrauen. Nichts, was eine Workspace-Konfiguration anfordert, läuft, bevor Sie dieses Vertrauen erteilen. Die Freigabe gilt für das gesamte Repository; Ablehnen beendet Mercury. Siehe [docs/TRUST.md](../TRUST.md).

Ein normaler interaktiver Start öffnet den Startbildschirm. Er hat zehn Menüeinträge; Continue Last Session erscheint erst, nachdem Sie einen Session-Verlauf haben:

- **New Session in \<folder\>** startet eine neue Session im aktuellen Ordner.
- **Continue Last Session** kehrt zu Ihrem letzten Chat zurück.
- **Boot Menu** konfiguriert künftige Sessions, einschließlich Motion, Crewmates und Workflows.
- **MCPs & Skills** wählt aus, was die nächste Session lädt. Siehe [docs/KIT.md](../KIT.md).
- **Agents** erstellt und bearbeitet Agenten.
- **Health Check** prüft die Installation.
- **Saturn Scheduler** plant Sessions. Siehe [docs/SATURN.md](../SATURN.md).
- **Logins** verbindet Anbieterkonten.
- **Session Concourse** öffnet die Session-Liste des aktuellen Projekts.
- **Sessions · Projects** lässt Sie eine Session oder ein Repository auswählen.

Menüeinträge öffnen sich über dem Startbildschirm, und `Esc` führt zu dem Eintrag zurück, den Sie gewählt haben. Die Session-Liste öffnet sich auf einem eigenen Bildschirm, der auch mit `Shift+→` erreichbar ist. Ein Prompt-Argument, `--continue` oder `--resume` bringt Sie direkt in den Chat.

### Motion, Crewmates und Workflows

Der Abschnitt Performance des Boot Menu enthält die Einstellung Motion: `auto`, `full`, `reduced` oder `off`. Sie steuert die Leerlaufanimation in der Oberfläche und ist auch in `/config` verfügbar.

Unter Agents legen die Schalter Crewmates und Workflows fest, ob neue Sessions die Werkzeuge Crewmate und Workflow erhalten. Schalten Sie einen Schalter aus, wird das zugehörige Werkzeug entfernt; Versuche, diese Art von Arbeit zu starten, liefern dieselbe Erklärung. Innerhalb einer Session ändern `/crewmates on|off` und `/workflows on|off` die Einstellung an der nächsten Turn-Grenze.

## Der tägliche Ablauf: Session Concourse, Git-Worktrees und Crewmates

### Eine Session starten und Worktrees isolieren

Drücken Sie `Enter` bei New Session, um eine Session im aktuellen Ordner mit Ihrem Standardmodell zu erstellen. Mercury öffnet den Chat und fügt die Session gleichzeitig der Session-Liste hinzu. Hinter dem Menü hält es einen Prozess bereit, um den Arbeitsaufwand beim Start zu verringern.

Eine weitere Session zu starten, beendet die vorherige nicht. Sie können eine Aufgabe laufen lassen und anderswo weiterarbeiten. Starten Sie mit `--worktree [name]` (oder bitten Sie im Chat um einen `worktree`, damit `EnterWorktree` ausgeführt wird), um einer Session einen eigenen Branch und Checkout unter `.mercury/worktrees/` zu geben. Parallele Crewmates können ebenfalls in isolierten Worktrees laufen und gemeinsame Dateien über projektbezogene Datei-Leases koordinieren; siehe [Was steckt drin](#was-steckt-drin-mneme-rag-gedächtnis-lsp-ast-für-23-sprachen-dap-debugger-websuche-und-anbindungen) und [docs/CREW.md](../CREW.md).

### Im Chat arbeiten

Beschreiben Sie die Aufgabe in einfacher Sprache. Der Agent liest, bearbeitet, führt aus und prüft Code im Berechtigungsmodus, den Sie gewählt haben. Werkzeugaufrufe erscheinen, während sie laufen, entweder als kompakte Karten oder mit vollständiger Ausgabe. Wählen Sie die Darstellung in `/config` unter Tool output; die Einstellung wird für spätere Starts gespeichert.

Mit `/model` und `/effort` passen Sie die Session an. `/permissions` legt fest, was ohne Freigabe laufen darf und was zuerst nachfragen muss.

Prüfen Sie Änderungen mit `/diff` nach Quelle, Datei und Hunk. `! <command>` führt einen Shell-Befehl im Chat aus und zeigt das Ende der Ausgabe live an. `/runs` zeigt laufende Shells und Crewmates (`/tasks` öffnet dieselbe Übersicht), und `/crewmates` öffnet die Live-Ansicht Crew. Zwischen zwei Turns speichert `/clear` den aktuellen Chat und öffnet eine neue Session, und `/restart` verschiebt den Chat auf einen neu installierten Mercury-Build. `/title` benennt den Chat, und `/help` listet die verfügbaren Befehle auf.

### Zwischen Bildschirmen wechseln

Mit `Shift+←` und `Shift+→` wechseln Sie zwischen den aktuell verfügbaren Bildschirmen. Ein frischer Start zeigt den Startbildschirm und die Session-Liste. Der Chat-Bildschirm wird hinzugefügt, sobald eine Session fokussiert wird, und entfernt, wenn der letzte Chat geschlossen wird. Die Tastenhinweise zeigen nur die verfügbaren Wechsel an.

Wenn Sie alle Chats schließen, kehren Sie zum Startbildschirm zurück. Mit `--chat` erhalten Sie nur den Startbildschirm und den Chat, ohne Session-Liste. `--concourse-off` speichert diese Einstellung für künftige Starts; `--concourse-on` oder `/config` schaltet sie wieder ein.

### Sessions auf dem Session Concourse verwalten

Öffnen Sie die Session-Liste mit `/concourse` oder `Shift+→` vom Startbildschirm aus. Sie zeigt zuerst die laufenden Sessions des aktuellen Projekts, danach gespeicherte Chats, die nicht laufen, die neuesten zuerst.

Jede laufende Session hat eine Zelle NOW, die ihre aktuelle Aktivität zeigt. Wählen Sie eine Zeile aus und drücken Sie `Enter`, um zurück in den Chat zu gelangen, während die anderen Sessions weiterlaufen. Eine abgestürzte Session bleibt mit dem Grund als NEEDS YOU in der Session-Liste, bis Sie sie freigeben.

[docs/SESSIONS.md](../SESSIONS.md) behandelt den Lebenszyklus der Sessions.

## Anbieter und Modelle: Anmeldungen, `/localsetup` und `/llmhost`

Verwenden Sie `/logins`, um einen Anbieter zu verbinden. Es öffnet denselben Anmeldekatalog, der auch bei der Einrichtung verwendet wird. `/accounts` verwaltet danach die verbundenen Anbieter-Slots.

- **OpenAI:** ChatGPT-Abonnement oder API-Schlüssel.
- **Anthropic:** Claude-Abonnement, Anmeldung über die Console oder API-Schlüssel.
- **OpenRouter:** Zugriff auf den Katalog über OAuth oder einen API-Schlüssel; Modellanfragen schließen Datenerhebung aus und verlangen von Anfang an, dass jeder Parameter unterstützt wird. `/config → OpenRouter routing policy` legt Fallback- und Zero-Data-Retention-Optionen fest; wählen Sie open, um die Richtlinie zu lockern und das Routing OpenRouter zu überlassen.
- **Google Gemini:** Sign in with Google, ein API-Schlüssel oder ein eigener OAuth-Client. Sign in with Google betreibt Gemini mit dem Kontingent des Tarifs, den das Google-Konto hat (ein kostenloses Konto, Google AI Pro oder Google AI Ultra), über den eigenen Antigravity-Client von Google: Prompt, Tool-Schemata und Tool-Ergebnisse gehen unter diesem Client und dem angemeldeten Konto an den Code-Assist-Endpunkt von Google, und `/model` listet das Modellangebot auf, das Google dem Konto bereitstellt. Ein API-Schlüssel oder ein eigener OAuth-Client rechnet stattdessen über ein Cloud-Projekt ab.
- **Hugging Face:** Anmeldung per Gerätecode oder Hub-Token.
- **Kimi (Moonshot):** Anmeldung per Gerätecode oder API-Schlüssel.
- **GLM (Z.AI):** ein Schlüssel für das GLM-Coding-Plan-Abonnement oder ein allgemeiner API-Schlüssel mit nutzungsabhängiger Abrechnung. `/logins zai` speichert beides und merkt sich den Tarif; `ZAI_API_KEY` funktioniert ebenfalls, wobei `ZAI_KEY_PLAN=coding|general` den Tarif angibt (ist die Variable nicht gesetzt, liest Mercury ihn aus der Modellliste des Schlüssels).
- **DeepSeek:** ein API-Schlüssel der DeepSeek-Plattform (`/logins deepseek` oder `DEEPSEEK_API_KEY`).
- **xAI (Grok):** melden Sie sich mit Ihrem Grok-Abonnement (SuperGrok / X Premium) an oder fügen Sie einen API-Schlüssel über `/logins xai` ein.
- **Meta (Muse):** Sign in with Meta (ein Muse-Code-Abonnement, ein Gerätecode in Ihrem Browser) oder ein Model-API-Schlüssel mit nutzungsabhängiger Abrechnung. Sign in with Meta tauscht den Gerätecode gegen die OIDC-Endpunkte von Meta (`https://auth.meta.com/oidc/device/authorization/` und `/oidc/device/token/`) unter der öffentlichen Client-ID von Muse Code aus, sendet das daraus entstehende Konto-Token einmalig an `https://api.meta.ai/muse-code/key`, um den API-Schlüssel des Abonnements zu erzeugen (und für begrenzte `/usage`-Abfragen zu Tarifstufe und Nutzungsfenstern), und schickt bei jeder Modellanfrage nur den erzeugten Schlüssel an `https://api.meta.ai/v1`. Ein eingefügter Model-API-Schlüssel oder `MODEL_API_KEY` / `META_API_KEY` wird nutzungsabhängig abgerechnet.

- **Qwen:** ein QwenCloud-Schlüssel (Token Plan oder nutzungsabhängige Abrechnung) oder ein Alibaba-Cloud-Model-Studio-Schlüssel (nutzungsabhängige Abrechnung, Token Plan oder Coding Plan), der vor dem Speichern am eigenen Endpunkt geprüft wird; ein Tarif-Schlüssel listet die Modelle seines Tarifs auf, Qwen3.8 Max zuerst.
- **MiniMax:** ein Open-Platform-Schlüssel oder ein Schlüssel für ein M-Plan-Abonnement.
- **Together AI** und **Cohere:** API-Schlüssel.
- **Groq**, **Cerebras** und **Fireworks AI:** API-Schlüssel; der Schlüssel jeder Familie kann auch aus einem Befehl stammen, der in `credentials.keyCommands.<family>` angegeben ist.

Mistral, Nous Portal und OpenCode Zen lassen sich ebenfalls über `/logins` verbinden, insgesamt also 20 Anbieterfamilien mit Anmeldung. Lokale Modellserver (Ollama, LM Studio, vLLM und llama.cpp) sowie benutzerdefinierte OpenAI-kompatible Endpunkte funktionieren ohne Anmeldung bei einem Anbieter. Führen Sie `/localsetup` aus, um Ollama zu installieren oder zu starten, ein Modell zu laden, das in Ihren Arbeitsspeicher passt, dessen Kontextfenster festzulegen oder einen laufenden Server von LM Studio, vLLM oder llama.cpp anzubinden ([docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)). Jeder Anbieter verwendet sein eigenes Protokoll, eigene Zugangsdaten und eine eigene Fehlerbehandlung, und Anfragen weichen nie auf einen anderen Anbieter aus. Siehe [docs/ENGINES.md](../ENGINES.md).

`/llmhost` listet die Modelle auf, die Sie hosten können, und zeigt, wo jedes davon gerade laufen kann: auf einer bei Runpod, Vast.ai oder Lambda gemieteten GPU, auf Ihrem eigenen Computer oder einem gespeicherten SSH-Computer (`mercury host`) oder auf einem bestehenden Modellserver. Jede Modellseite zeigt Quantisierungsoptionen, wie sich das GPU-Speicherbudget auf parallele Unterhaltungen aufteilt (`conversations × context`) und die Standardstufe des Thinking (die `/effort` pro Anfrage ändert). GPU-Mieten erfordern eine ausdrückliche Bestätigung des Stundenpreises, und die Einrichtung läuft im Hintergrund weiter, wenn Sie das Popup schließen. Bei Runpod können Sie außerdem Qualität, Kontextaufteilung und Thinking vor dem Mieten oder an einem laufenden Pod anpassen (`Tune`), Gewichte auf einem schnell ladenden Volume ablegen und Verfügbarkeitsprüfungen im 5-Sekunden-Takt einrichten. Vast.ai- und Lambda-Mieten sind neu in 1.0.0-beta.40 und wurden anhand von Fixtures gegen die veröffentlichten APIs der Anbieter geprüft (Live-Mietläufe wurden nicht durchgeführt). Siehe [docs/LLM-HOST.md](../LLM-HOST.md).

Neue Sessions verwenden den zuletzt verbundenen Anbieter und das neueste Modell, das diesem Konto zur Verfügung steht. Modelle, auf die das Konto keinen Zugriff hat, werden übersprungen. Hat dieser Anbieter kein brauchbares Modell, prüft Mercury den als Nächsten zuletzt verbundenen Anbieter. Diese Wahl fällt beim Start der Session; eine fehlgeschlagene Anfrage in einer bestehenden Session bleibt bei ihrem Anbieter.

`/model` erklärt die Auswahl. Ein Familienname wählt das neueste Modell dieser Familie: `/model grok`, `/model deepseek`, `/model kimi` oder `/model glm`. Ist kein Anbieter verbunden, verweisen der Startbildschirm und `/model` auf `/logins`. Mit `/defaultprovider` machen Sie einen Anbieter ausdrücklich zur zuletzt gewählten Option.

Der Zugriff auf die Anbieter unterliegt weiterhin deren eigenen Bedingungen und deren Verfügbarkeit. Die Lizenz von Mercury ersetzt diese Bedingungen nicht.

## Die Headless-CLI: `mercury run`, Docker und JSON-RPC-Runner

Derselbe Build läuft auch ohne die interaktive Oberfläche. `node dist/mercury.mjs --help` listet jedes Flag auf.

`mercury run "<prompt>"` führt einen Prompt ohne Terminal-Oberfläche aus:

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` gibt die Antwort aus; der Grund eines fehlgeschlagenen Turns geht nach stderr.
- `json` gibt die letzte `outcome`-Zeile als ein JSON-Objekt aus.
- `rows` schreibt ein JSON-Objekt pro Zeile: `session`, danach ein `turn` mit seinen Zeilen `text`, `reasoning`, `tool_call`, `tool_result` und `step`, am Ende `outcome`. Wartezeiten, Werkzeugfortschritt, Hintergrundaufgaben und Hinweise haben eigene Zeilen. Jede Zeile enthält `seq`, `timestamp` und `session_id`; Zeilen innerhalb eines Turns tragen zusätzlich dessen `turn`-Nummer. `seq` nummeriert den Stream dieses Laufs ab 1; `turn` zählt die Turns der Session. Ein Lauf, der eine gespeicherte Unterhaltung fortsetzt (`-c`, `-r`, `--fork`), nummeriert seine Turns daher nach den bereits darin enthaltenen, und seine `session`-Zeile nennt die fortgesetzte Unterhaltung in `resume_of`.

Die Zeilentypen der Ausgabe, nach ihrem Feld `type`:

- `session`: die einleitende Zeile mit `version`, `build` (die ersten zwölf Hex-Zeichen des Baums, aus dem das Bundle gebaut wurde, so wie `mercury daemon status` sie ausgibt; fehlt, wenn neben dem Bundle kein Manifest liegt), `resume_of` (bei einem fortgesetzten Lauf die Session-ID der fortgesetzten Unterhaltung; dieselbe ID wie `session_id`, sofern der Lauf nicht geforkt wurde), `cwd`, `model`, `mode`, die `tools`, `mcp_servers`, `commands`, `agents`, `skills` und `extensions` der Session sowie `tools_withheld` (vorhanden, wenn eine Deny-Regel ein Werkzeug unter seinem einfachen Namen zurückhält; jeder Eintrag enthält `tool`, `rule` und `source`).
- `turn`: ein Turn mit dem Status `started` oder `waiting` und seiner `turn_id`; außerdem `model`, `message_ids` und die Anzahl `agents`, sofern bekannt.
- `text`: ein abgeschlossener Textblock mit `message_id`, `block`, `text` und seiner `phase` (`commentary` oder `final_answer`).
- `reasoning`: ein abgeschlossener Reasoning-Block mit `message_id`, `block`, `text` oder `redacted: true`.
- `tool_call`: ein Werkzeugaufruf mit `call_id`, `tool`, `input` sowie seiner `message_id` und seinem `block`.
- `tool_result`: das Ergebnis des Aufrufs mit `call_id`, `status` (`ok`, `error`, `aborted` oder `refused`) und `output`. Ein Aufruf, den das Modell so fehlerhaft formuliert hat, dass er vor der Ausführung abgelehnt wurde (ein unbekanntes Werkzeug, Argumente, die kein gültiges JSON sind oder nicht zum Schema des Werkzeugs passen), erhält trotzdem sein Paar: eine `tool_call`-Zeile mit den Argumenten, wie sie geliefert wurden (`{}`, wenn sie kein Objekt waren), und eine `tool_result`-Zeile mit dem Status `refused`, deren `output` den Grund enthält; danach folgt die Korrektur als `notice`. Ein solcher Aufruf wurde nie ausgeführt und ist keine Verweigerung.
- `tool_update`: Fortschritt eines laufenden Werkzeugs mit `call_id`, `tick`, `source` (`shell`, `powershell`, `mcp` oder `eval`) sowie den Feldern `line`, `elapsed_s`, `lines`, `bytes`, `budget_ms`, `progress` und `total`, soweit der Aufruf sie meldet. Ein Shell- oder PowerShell-Aufruf sendet einen Tick, sobald seine Ausgabe eintrifft (ein Befehl, der nichts ausgibt, sendet nie einen Tick), ein MCP-Aufruf, wenn sein Server Fortschritt meldet, und ein Eval-Aufruf, während seine Zelle läuft; kein anderes Werkzeug sendet Ticks. Ein Browser- oder Crewmate-Aufruf schweigt bis zu seinem Ergebnis.
- `step`: ein Modellaufruf des Haupt-Threads mit `message_id`, `model`, `usage` und `stop`, wenn das Modell angibt, warum es aufgehört hat.
- `outcome`: das Ergebnis des Turns, unten beschrieben.
- `close`: die Notiz für die nächste Session beim Schließen: `state` (`stored`, `skipped` oder `none`), `note_chars` und das `usage` der Modellaufrufe, die sie geschrieben haben, sodass, wer die usage-Werte jeder Zeile aufsummiert, auf den Wert der outcome-Zeile kommt. Wird der Prompt als Argument übergeben, wird die Notiz innerhalb des letzten Turns erbeten, und `close` steht vor dem `outcome` dieses Turns; mit `--input rows` folgt es dem letzten `outcome`, sobald stdin geschlossen wird.
- `wait`: eine Wartezeit auf das Modell mit `state` (`first_byte`, `retry`, `silence`, `loading` oder `done`) und den Werten, die dieser Zustand mitführt, etwa `since_ms`, `attempt` und `of`, `delay_ms`, `reason` und `http_status`.
- `heartbeat`: Der Modellstrom gab nach mindestens einer Sekunde ohne geparstes Ereignis ein Lebenszeichen: Bytes kamen an, die keine Zeile erzeugten. Die Zeile enthält nichts weiter und erscheint höchstens einmal pro Sekunde; wie oft, hängt von der Streaming-Form des Anbieters ab, sodass ein Strom, der zwischen Ereignissen nie pausiert, keine erzeugt.
- `compaction`: eine Kompaktierung mit dem Status `started`, `progress` oder `ended`: `trigger` (`manual`, `auto` oder `overflow`), `stage`, `fill`, `summary_tokens` und am Ende `exit` (`landed`, `cancelled` oder `failed`).
- `mode`: der Berechtigungsmodus hat sich geändert: `mode`.
- `rate_limit`: der Limit-Status des Anbieters: `status` (`allowed`, `warning` oder `rejected`), `window`, `resets_at`, `utilization` und die Felder zur Überschreitung.
- `task`: eine Hintergrundaufgabe mit dem Status `started`, `progress` oder `ended`: `task_id`, `task_type`, `description`, `usage`, `summary`, `status` (`completed`, `failed` oder `stopped`) und `output_file`, sobald sie bekannt sind.
- `notice`: ein `warning` oder `error` für den Leser: `text` sowie ein `code`, etwa `input_refused`.
- `command_output`: die Ausgabe eines Slash-Befehls, der das Modell nie erreicht hat: `command` und `text`.
- `mission_updated`: das Aufgabenregister der Session hat sich geändert; lesen Sie es erneut.
- `samples_updated`: die Samples der Session haben sich geändert; lesen Sie sie erneut.

Mit `--partial` und `--format rows` kommen die Zeilen `block_start`, `text_delta`, `reasoning_delta`, `tool_input_delta` und `retracted` hinzu. Deltas gehören zu `message_id` und `block`; eine `retracted`-Zeile nimmt die Deltas dieser Nachricht zurück. Die abgeschlossene Text- oder Werkzeugzeile ist der vollständige Wert.

Die outcome-Zeile enthält `schema`, `turn_id`, `status`, `steps`, `wall_ms`, `usage`, `models` und `denials`; bei Abschluss zusätzlich `answer`, bei einem Fehler `error` (`message`, `class`, optional `detail`). `stop`, `api_ms`, `cost_usd`, ein angefordertes strukturiertes Ergebnis (`structured`) und `notices` sind enthalten, sofern verfügbar. `wall_ms` ist die verstrichene Zeit des Turns. `api_ms` ist die Summe der Dauern jeder Modellanfrage, die der Turn gestellt hat (einschließlich Wiederholungen und der Anfragen der Crewmates, die parallel zum Haupt-Thread liefen), sodass der Wert `wall_ms` übersteigen kann, wenn Anfragen sich überlappten. `cost_usd` ist der USD-Betrag der bepreisten Anfragen des Turns, unabhängig von deren Status: Eine Anfrage, die Mercury nicht bepreisen kann (kein Tarif hinterlegt, keine Kosten in der Antwort angegeben), trägt nichts bei und bleibt in `models` ohne eigenes `cost_usd` aufgeführt. Das Feld fehlt nur, wenn im Turn nichts bepreist wurde. Bei einer Anmeldung mit einem Claude-Abonnement haben die Anthropic-Anfragen keinen Dollarpreis; daher tragen weder sie noch die Zeile ein `cost_usd`, aber die Usage-Angaben bleiben erhalten. Die Usage-Angaben nennen `input_tokens` (einschließlich Cache-Tokens), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` und, sofern gemeldet, `reasoning_output_tokens`, summiert über den Haupt-Thread und die Crewmates. `models` schlüsselt den Token-Verbrauch nach Modell auf. `steps` zählt nur die Modellaufrufe des Hauptagenten; Modellaufrufe der Crewmates erscheinen als eigene `step`-Zeilen, die mit `parent_call_id` markiert sind.

Der Status lautet `completed`, `blocked`, `refused`, `failed`, `interrupted`, `turn_limit`, `budget_limit`, `time_limit`, `schema_unmet` oder `loop_stopped`. Ein Lauf unter `--max-time` (Sekunden oder `10m`, `1h`) endet mit `time_limit` beim nächsten Schritt, sobald die Zeit abgelaufen ist; der laufende Modellaufruf oder die laufende Werkzeugrunde wird nicht abgebrochen. Ein abgeschlossener Lauf endet mit Exit-Code 0, andere Ergebnisse mit 1 und ein Fehler bei der Nutzung mit 2. SIGINT und SIGTERM führen zu den Exit-Codes 130 und 143, nachdem das Ergebnis des unterbrochenen Turns geschrieben wurde. Ein abgelehnter Werkzeugaufruf wird in `denials` aufgeführt. Wenn die Ablehnung eine Abfrage war, die niemand beantworten konnte (ein Lauf ohne Host in einem Modus, der nachfragt, `--mode dontAsk`, oder eine Abfrage des Hosts, die abgelaufen ist), und kein späterer Werkzeugaufruf im Turn erfolgreich ist, lautet der Status `blocked`: Die Antwort bleibt erhalten, `error` nennt das Werkzeug und wie der Lauf fortgesetzt werden kann (`--allowed-tools`, ein anderer `--mode` oder ein Host, der Abfragen beantwortet), und der Lauf endet mit Exit-Code 1. Gelingt im selben Turn ein späterer Werkzeugaufruf, erholt sich der Turn und endet als `completed` (Exit-Code 0) mit einem Warnhinweis `notice` (`"<Tool> was not approved; the run continued with other tools."`). Eine Ablehnung, die Sie beantwortet haben (durch eine Deny-Regel, einen Hook oder einen Host, der Nein gesagt hat), lässt einen abgeschlossenen Turn abgeschlossen. Ein unbeantworteter Aufruf von `AskUserQuestion` beendet den Lauf ebenfalls als `blocked`, wobei die Frage in `error` zitiert wird; Mercury liest das Ergebnis aus den aufgezeichneten Abfragen des Laufs, nie aus dem Antworttext, sodass eine Frage, die nur im Antworttext steht, als `completed` endet. Ein unbekannter Slash-Befehl wird als `refused` mit demselben Satz gemeldet, den die interaktive Oberfläche ausgibt (`Unknown command: /name · /help lists commands`), und endet mit Exit-Code 1.

`--input rows` setzt `--format rows` voraus und liest pro Zeile ein Eingabeobjekt:

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

Die Eingabetypen sind `prompt` mit `content` (Text- oder Text- und Bildblöcke), `shell` mit `command` und `note` mit `to` (eine Agenten-ID) und `content`. Jeder Typ akzeptiert eine optionale `id`; Prompt- und Shell-Zeilen akzeptieren außerdem `priority` (`now`, `next` oder `later`), `sent_at` und `origin`. Eine abgelehnte Eingabeform erzeugt einen `notice` mit dem Code `input_refused`; fehlerhaftes JSON beendet den Lauf. Diese Zeilen enthalten nur Eingaben; Berechtigungsantworten laufen über das Runner-Protokoll weiter unten.

Verwenden Sie `mercury run -` oder leiten Sie Text per Pipe in `mercury run`, um den gesamten Prompt von stdin zu lesen. Neben einem Prompt-Argument wird geleiteter Text als abgegrenzter Kontext angehängt: Die Pipe wird gelesen, bis sie geschlossen wird oder eine Sekunde lang still war. Ein Strom, der weiterhin Daten liefert, wird daher bis zum Ende gelesen, und eine Pipe, die offen und still bleibt, hält den Lauf nicht auf. Ohne Prompt und mit einem Terminal auf stdin gibt `run` seine Nutzungshinweise aus und endet mit Exit-Code 2.

`--mode <mode>` legt die Berechtigungsstufe fest. `--sovereign` läuft ohne Berechtigungsabfragen, und `--allow-sovereign` macht diese Stufe für einen späteren Wechsel verfügbar. Berechtigungsrichtlinie und Deny-Regeln gelten weiterhin. Ein Root-Benutzer, der den Sovereign-Modus aktiviert, erhält einen Hinweis auf stderr; der Lauf wird fortgesetzt.

Verwenden Sie `-c`, um die letzte Unterhaltung fortzusetzen, `-r`, um nach ID, Titel oder Auswahl fortzusetzen, `-w`, um in einem verwalteten Worktree zu laufen, und `--lean` für eine minimale Session. Ein `run` hat keinen Host, der Berechtigungsabfragen beantwortet: Seine Berechtigungsregeln und sein Modus entscheiden, was laufen darf, und ein Aufruf, der noch eine Freigabe braucht, wird abgelehnt.

### Das Headless-Image

Das `Dockerfile` im Wurzelverzeichnis des Repositorys erstellt ein Linux-x64-Image für CI und Server. Sein Einstiegspunkt ist `mercury`, und sein Standardunterbefehl ist `run`; das Image führt also einen Prompt gegen einen eingebundenen Verzeichnisbaum aus und endet mit dem Exit-Code des Laufs:

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

Das Image enthält das Bundle, dessen Node-24-Laufzeitumgebung (auf `PATH`), die mitgelieferten Such-, Shell-, Debugger-, Sprach- und Bildwerkzeuge, `git` und den Zertifikatsspeicher; kein Eingabebildschirm und kein Anmeldeablauf. Es läuft als Nicht-Root-Benutzer `mercury` mit seinem config home im Container (`MERCURY_CONFIG_DIR`), und `/work` ist sein Arbeitsverzeichnis. Farbe und Maus richten sich nach der eigenen Terminalerkennung des Produkts, und `--user 0` läuft als Root und zeigt den oben genannten einzigen Sovereign-Hinweis.

Ein Anbieterschlüssel wird als Umgebungsvariable übergeben, in genau den Schreibweisen, die das Produkt überall liest: `ANTHROPIC_API_KEY` oder `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` oder `GOOGLE_API_KEY`, `XAI_API_KEY` (und `XAI_MANAGEMENT_API_KEY` für dessen Nutzungszähler), `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY` (und `MISTRAL_ADMIN_API_KEY` für dessen Organisationszähler), `NOUS_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`, `TOGETHER_API_KEY` oder `TOGETHER_AI_API_KEY`, `COHERE_API_KEY` oder `CO_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `DASHSCOPE_API_KEY`, `MODEL_API_KEY` oder `META_API_KEY`, `MERCURY_COMPAT_API_KEY` für einen benutzerdefinierten OpenAI-kompatiblen Endpunkt und `MERCURY_LOCAL_API_KEY` für einen lokalen Server. Ohne Schlüssel lehnt der Lauf in einer Zeile ab und endet mit Exit-Code 1. `docker run -i … mercury run -` liest den Prompt von stdin.

### Eine Session hosten

`mercury runner` stellt eine Session über stdio einem Host bereit: JSON-RPC 2.0, eine Nachricht pro Zeile. Der Host sendet zuerst `initialize` und wartet auf die Antwort, bevor er Arbeit schickt:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

Name und Version des Hosts stehen unter `host`; `capabilities` deklariert `holds_asks`, `elicitation` und `partial_rows`. Jede Anfrage-`id` ist eine positive ganze Zahl: Eine Anfrage, deren `id` etwas anderes ist, wird mit `-32600` und `id: null` beantwortet. Nummerieren Sie Ihre Anfragen daher ab 1.

`queue/add` nimmt dasselbe Prompt-, Shell- oder Notiz-Objekt wie die oben beschriebene Zeileneingabe. Die Ausgabe kommt in `row`-Benachrichtigungen an. `session/facts` liest den Zustand der Session; `session/set_mode` ändert den Berechtigungsmodus sofort; `session/set_model` und `session/set_effort` ändern Modell und Aufwand. Eine Änderung, die während eines laufenden Turns vorgenommen wird, wird bis zum Ende des Turns zurückgehalten: Sie antwortet mit `at: "turn_end"`, danach kündigt `session/applied` sie an. `turn/interrupt` stoppt einen Turn; schließen Sie stdin, um die Session zu beenden.

Berechtigungsabfragen kommen als `permission/request` mit `kind: "tool"` oder `kind: "network"` an. Der Host antwortet mit `outcome: "allow"` oder `outcome: "deny"`; eine Freigabe kann einen bearbeiteten `input` und Berechtigungsregeln (`rules`) enthalten. Eine zurückgezogene Abfrage sendet `$/cancel_request` mit ihrer `request_id`. `holds_asks` gibt dem Host die Zeitsteuerung der Abfrage. Eine MCP-Rückfrage verwendet `elicitation/request` nur, wenn der Host `elicitation` deklariert; andernfalls wird sie mit `cancel` beantwortet.

Eine unbekannte Methode wird mit `-32601` beantwortet, ungültige Parameter mit `-32602`, eine `id`, die keine positive ganze Zahl ist, mit `-32600`, und eine Anfrage vor der Initialisierung mit `-32002`. Eine Regelablehnung ist `-32010`, mit einem Satz in `error.message` und einem Grund in `error.data.kind`, etwa `mode`, `model`, `effort` oder `claim`. Der Runner antwortet auf eine fehlerhafte Zeile mit `-32700` und fährt fort; drei aufeinanderfolgende fehlerhafte Zeilen beenden ihn.

### Weitere Befehle

Zu den verfügbaren Befehlen gehören:

- **`mercury health`**: Diagnosebericht, auch Health-Zertifikat genannt. `--json` liefert den vollständigen Bericht, `--deep` führt die tiefgehende Bestandsaufnahme aus, und `--fix` führt geführte Korrekturen aus.
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**: anmelden (`login [<family>]`), Anbieterfamilien auflisten (`list`), prüfen, ob ein Konto angemeldet ist (`status [<family>]`), abmelden (`logout [<family>]`) oder ein langlebiges Anthropic-Token erzeugen (`mint`).
- **`mercury models [--json]`**: gibt die Modelle aus, die die angemeldeten Konten erreichen (dieselben Angaben wie `mercury://models`).
- **`mercury mcp`**: verwaltet MCP-Server mit `add`, `import`, `list`, `get`, `remove`, `trust-reset` und `serve`.
- **`mercury extensions`**: installiert Erweiterungen und verwaltet ihre Quellen. Aktionen: `list`, `sources`, `add`, `remove`, `refresh`, `install`, `trust`, `enable`, `disable`, `update`, `uninstall`, `fence`, `unfence`, `inspect` und `scaffold`.
- **`mercury roster`**: listet das Agenteninventar auf.
- **`mercury usage`**: gibt die kompakte Zeile mit den Kennzahlen aus, die der Bildschirm `/usage` zeigt; `--json` gibt die gesamte Ablesung aus: die Fenster jedes angemeldeten Anbieters mit verbrauchtem Anteil und Zurücksetzung, die von ihm gemeldeten Kennzahlen und Guthaben, jeweils mit Quelle und Alter, sowie den Verbrauch der Session je Modell, so wie der Bildschirm sie liest (der Leser jedes angemeldeten Anbieters wird einmal abgefragt, wie beim Öffnen).
- **`mercury daemon run|status|stop|restart`**: den Hintergrund-Daemon starten, prüfen, stoppen oder neu starten. Seine Session-Plätze sind `mercury runner`-Kindprozesse; der Daemon sendet deren Prompts und hostet deren Berechtigungsabfragen.
- **`mercury sessions list`** (auch nur `mercury sessions`): listet die gespeicherten Sessions dieses Projekts auf, die neuesten zuerst: die ID, den Zeitpunkt des letzten Schreibens, die Größe, `live`, wenn der Daemon sie gerade hostet, und ihren Titel oder ersten Prompt; `--all` liest jedes Projekt, `--limit <n>` begrenzt die Liste. Die ID ist das, was `mercury --resume <id>` wieder öffnet und `sessions delete` entfernt.
- **`mercury sessions delete <id>`**: löscht eine gespeicherte Session gezielt — ihr Transkript und die daneben aufbewahrten Aufzeichnungen (Belege, Fortsetzungs-Snapshot) — nach einer Rückfrage; `--yes` überspringt die Rückfrage für Skripte. Eine Session, die der Daemon gerade hostet, wird abgelehnt, und eine unbekannte ID wird mit einem Hinweis auf das Roster abgelehnt (`/sessions` innerhalb von Mercury). Gespeicherte Sessions werden ansonsten nie von selbst gelöscht.
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**: betreibt einen lokalen oder einen SSH-Computer als Modellserver für alle Sessions, die das config home teilen (`compat/box-<name>/<model>`), und nutzt dafür eine geprüfte lokale Gewichtsbank oder einen bestätigten Download. Siehe [docs/LLM-HOST.md](../LLM-HOST.md).
- **`mercury lsp list`** und **`mercury lsp install <server>`**: der Katalog der Language-Server; jeder Server ist installiert (mit seiner Binärdatei) oder fehlt (mit seiner Installationsanleitung). `install` zeigt die Anleitung eines Servers, fragt nach, führt genau diese aus (`--yes` überspringt die Rückfrage für Skripte) und meldet, wo die Binärdatei abgelegt wurde. Ein unbekannter Server wird mit dem Roster abgelehnt. Mercury installiert nie selbst einen Language Server; das Öffnen einer Datei startet nur einen Server, der bereits installiert ist.
- **`mercury acp`**: stellt einen Editor über das Agent Client Protocol bereit, mit einem Runner-Kindprozess für jede Session. `mercury bridge install` installiert die VS-Code-Erweiterung; `mercury bridge status` prüft sie; `mercury bridge uninstall` entfernt sie.
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**: verwaltet Engine-Jobs für das Godot-Projekt im aktuellen Verzeichnis. Mercury führt Suiten auf eigenen Headless-Workern aus einer eingefrorenen Projektkopie aus. Der Dienst umfasst ein Kompilierungs-Gate, Captures, Frame-Statistiken, abgeschlossene Profile, Zugriff auf die Job-Warteschlange, Abbruch und Ergebnisse nach ID. Siehe [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md).
- **`mercury image <image>`**: zeigt ein Bild im Terminal an.
- **`mercury install`** und **`mercury update`** (Alias `upgrade`): installiert oder aktualisiert Release-Archive; mit `--json` steht das Dokument unabhängig vom Ergebnis auf stdout, und der Exit-Code zeigt an, ob es fehlgeschlagen ist. Siehe [Installation](#installation).
- **`mercury version`** und **`mercury help [command]`**: geben die Versionszeile oder eine Hilfeseite aus, wie `--version` und `--help`; keiner von beiden startet eine Session.

## Was steckt drin: Mneme-RAG-Gedächtnis, LSP, AST für 23 Sprachen, DAP-Debugger, Websuche und Anbindungen

- **Mneme-Hybrid-RAG-Projektgedächtnis.** Mneme ist standardmäßig aktiv und hält die Fakten jedes Projekts in einfachen Markdown-Themenseiten fest (`Retain`, `Recall`, `Reflect`, `Correct`). Recall kombiniert ein 118 MB großes, lokal auf dem Gerät laufendes semantisches Embedding-Modell BGE (`bge-base-en-v1.5` `q8_0`, MIT-Lizenz, in jedem Release-Archiv für die jeweilige Plattform mitgeliefert; siehe [Optionale Komponenten](#optionale-komponenten)) mit BM25-Wortranking inklusive Stemming, Aktualitätsgewichtung und Zitierverfolgung über Reciprocal Rank Fusion (`k = 60`). Angeheftete Regeln (`pin: true`) werden wörtlich in das Regal der angehefteten Regeln geladen und ändern sich nur auf Ihr Wort hin. Beim Start einer Session bewertet Mercury nicht angeheftete Fakten und frühere Notizen anhand des aktuellen Branches, zuletzt geänderter Dateien und der Übergabenotiz der letzten Session, innerhalb eines eigenen Kontingents für den Start (`memory.startLimit`, Standard 4.000 Zeichen). Prüfungen auf Widersprüche beim Schreiben erkennen Polaritätswechsel, Verneinungen und Zahlenwechsel, bevor ein widersprüchlicher Fakt gespeichert wird. Jede Session schreibt beim Beenden eine Übergabenotiz in eigenen Worten für die Einstiegsseite der nächsten Session, dazu optional einen Eintrag im Session-Journal. `/memory` öffnet das Gedächtniszentrum, und `/memory page` zeigt die Bibliothek in Ihrem Browser als Knoten-Kanten-Graphen. Siehe [docs/MNEME.md](../MNEME.md).
- **LSP-Codeintelligenz, AST-Umschreibungen für 23 Sprachen, DAP-Debugger und `Eval`-Zellen.** Verankerte Lesevorgänge und atomare Änderungen über mehrere Dateien (`ChangeSet`); Abfragen beim Language-Server (`LspRead`) und Refactorings mit Vorschau und anschließendem Anwenden (`LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`); Suche und Umschreibung im Syntaxbaum (`AstSearch`, `AstEdit`) mit den Metavariablen `$NAME` und `$$$NAME` über 23 Grammatiken in den Release-Archiven (16 in jedem `bun install`-Build plus 7 im Grammatik-Pack); persistente Code-Zellen in Python (`python3`) und JavaScript (Node-ES-Modul) (`Eval`); und ein Debugger über das Debug Adapter Protocol (`Debug`), der `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`, `netcoredbg`, `rdbg`, den Debug-Adapter des Dart SDK, `kotlin-debug-adapter`, den Debug-Adapter von elixir-ls und Godot ansteuert. Das Werkzeug `Test` führt über seine Operation `debug` einen fehlschlagenden Python-Test (`pytest`, `unittest`), einen JavaScript- oder TypeScript-Test (`node-test`, `vitest`, `jest`), einen Go-Test (`go test`) oder einen Rust-Test (`cargo test`) direkt in eine `Debug`-Session, in der Sie ihn schrittweise durchlaufen. Siehe [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md), [Änderungstransaktionen](../CHANGE-TRANSACTIONS.md), [Strukturmuster](../STRUCTURAL-PATTERNS.md), [Code-Zellen](../EVAL.md) und [den Debugger](../DEBUGGER.md).
- **`WebSearch` ohne Schlüssel und `WebFetch` als Markdown.** `WebSearch` durchläuft eine Kaskade: zuerst die native Live-Suche des Anbieters, sofern das Modell der Session sie unterstützt (`ProviderSearch`), dann gespeicherte Brave- oder Tavily-Schlüssel, dann offizielle APIs, die anhand der Form der Abfrage gewählt werden (Stack Exchange, npm, PyPI, crates.io, GitHub-Codesuche, Hacker News über Algolia, Wikipedia), dann konfigurierte SearXNG-JSON-APIs (`MERCURY_SEARCH_SEARXNG_INSTANCES`) und schließlich DuckDuckGo-Scraping ohne Schlüssel (standardmäßig aktiv; abschaltbar in `/config` oder mit `MERCURY_SEARCH_KEYLESS=0`). Jede Antwort bleibt unter 2.000 Tokens und nennt die Quelle, die geantwortet hat. `WebFetch` liest öffentliche Seiten als Markdown im Originalwortlaut der Seite, innerhalb eines Budgets von 38.000 Zeichen pro Aufruf (eine Seite, die einen Browser braucht, wird über den gehosteten Reader `r.jina.ai` gelesen, sofern nicht `MERCURY_FETCH_READER=0` gesetzt ist; eine private Netzwerkadresse wird nie an ihn gesendet). Siehe [docs/ENGINES.md](../ENGINES.md).
- **Agenten, anbieterübergreifende Crewmates (`Crewmate`), Worktrees und Datei-Leases.** Zwei eingebaute Agenten (`mercury-crew` für delegierte Arbeit jeder Art und `mercury-scout` für reine Erkundung ohne Schreibzugriff) stehen neben den Agentendefinitionen, die Sie in `/agents` anlegen. Starten Sie Crewmates mit jedem angemeldeten Anbieter, isolieren Sie parallele Arbeit in Checkouts über `git worktree` (`isolation: "worktree"`), koordinieren Sie gemeinsame Dateien mit prozessinternen Datei-Leases des Projekts (`mcp__mercury__lease_take`, `mcp__mercury__lease_release`, `mcp__mercury__lease_list`), und steuern oder setzen Sie Crewmates über Name oder ID mit `SendMessage` und `ResumeCrewmate` fort. Verfolgen Sie Crewmates und Workflow-Läufe in `/crewmates` und `/runs`. Siehe [docs/CREW.md](../CREW.md).
- **Desktop-Steuerung.** Standardmäßig aktiviert, wenn der native Desktop-Treiber verfügbar ist. Das Werkzeug `Computer` erstellt Screenshots und steuert Maus und Tastatur in der Vordergrundanwendung. Mercury prüft die Anwendung vor dem Handeln anhand von Name und Identität und fragt nach einer Freigabe, außer Ihre Berechtigungsregeln, eine Session-Freigabe, die Zugriffseinstellung oder der Berechtigungsmodus erlauben die Aktion bereits. Mercury stoppt bei `Esc`, lässt jeweils nur eine Session den Desktop steuern und hält Screenshots aus der gespeicherten Unterhaltungsdatei heraus. Mit `MERCURY_COMPUTER_USE=0` entfernen Sie das Werkzeug. Siehe [docs/COMPUTER-USE.md](../COMPUTER-USE.md).
- **Whisper-Spracheingabe auf dem Gerät (`/voice`).** `/voice on` lädt beim ersten Einsatz das 60 MB große englische Sprachmodell (`base.en-q5_1`) herunter, prüft dessen SHA-256-Digest und aktiviert das Diktat; `/voice off` deaktiviert es. Halten Sie die Leertaste 1 Sekunde lang gedrückt, um zu sprechen, und lassen Sie sie los, um zu stoppen, oder führen Sie `/voice` ohne weitere Angaben aus, um eine Aufnahme zu starten und zu beenden, solange Voice eingeschaltet ist. Whisper transkribiert auf dem Gerät, sodass Sprachaufnahmen den Rechner nie verlassen; `MERCURY_WHISPER_MODEL` wählt `tiny.en-q5_1`, `small.en-q5_1`, das mehrsprachige `base-q5_1` oder eine lokale `.gguf`-Datei. Siehe [docs/VOICE.md](../VOICE.md).
- **Saturn-Cron und Session-Planer (`/saturn`).** Planen Sie einen Prompt für eine bestehende Session (`CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, `/loop`) oder eine neue Session, die zu einer festen Uhrzeit startet. Zeitpläne können einmalig laufen oder sich wiederholen. Siehe [docs/SATURN.md](../SATURN.md).
- **Anbindungen für VS Code (ACP), Unity, Blender, Godot und Aseprite.** `mercury acp` verbindet sich mit Editoren, die das Agent Client Protocol unterstützen. Die VS-Code-Erweiterung (`mercury bridge install`) führt Mercury über dieses Protokoll im Editor aus: Chat, Sessions, Agenten, Artefakte und Reviews, wobei Auswahl und Diagnosen des Editors jedem Prompt mitgeschickt werden. Separate, ausdrücklich zu aktivierende Integrationen verbinden sich mit laufenden Editoren von Unity (`MERCURY_UNITY=1`), Blender (`MERCURY_BLENDER=1`) und Godot (`MERCURY_GODOT_TOOLS=1`); dazu kommt Stapelzugriff auf Aseprite (`MERCURY_ASEPRITE=1`). Siehe [Unity](../UNITY-BRIDGE.md), [Blender](../BLENDER-BRIDGE.md), [Godot](../VULCAN-GODOT-TOOLS.md) und [Aseprite](../ASEPRITE-BRIDGE.md).
- **Erweiterungen.** Jede Erweiterung hat ein einziges Manifest. Quellen fügen Sie über eine Git-URL, einen lokalen Ordner oder ein Archiv hinzu; sie werden anhand ihres Beitrags-Hashs freigegeben. Siehe [docs/EXTENSIONS.md](../EXTENSIONS.md).
- **MCPs & Skills.** Konfiguration pro Repository dafür, was Sessions laden, mit benannten Voreinstellungen und Steuerungen, die Sie während einer Session ändern können. Siehe [docs/KIT.md](../KIT.md).
- **Diagnose.** Der Health-Check und `/health` erstellen einen Bericht, der auf Diagnosebelegen beruht, mit dem Urteil `certified`, `caution` oder `fault` und überprüften Korrekturen. Siehe [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md).
- **Vertrauen und Berechtigungen.** Workspace-Vertrauen, Berechtigungsregeln und -modi sowie die Befehle, die jede Session ablehnt. Siehe [docs/TRUST.md](../TRUST.md).
- **Apollo Mode**, das Spezifikationsinterview: Beantworten Sie die Fragen des Agenten, um die Spezifikation zu vervollständigen, mit der er einen Prototyp baut. Siehe [docs/APOLLO-MODE.md](../APOLLO-MODE.md).
- **Wiederherstellung.** Atomare Veröffentlichung, journalisierte Vorgänge und Abgleich beim Start. Siehe [docs/DURABILITY.md](../DURABILITY.md).

Laufzeit-Flags sind in `src/substrate/flagRegistry.ts` definiert, werden als `MERCURY_*`-Einstellungen bereitgestellt und bei Bedarf erzeugt. Die Kompatibilität mit Integrationen ist in [docs/COMPATIBILITY.md](../COMPATIBILITY.md) dokumentiert. Das vollständige Dokumentationsverzeichnis ist [docs/README.md](../README.md).

## Slash-Befehle

`/help` listet die verfügbaren interaktiven Befehle auf. Verwenden Sie `/palette` für die Fuzzy-Suche nach Befehlen. Die Tabelle unten gruppiert die standardmäßig aktivierten eingebauten Befehle nach den Kategorien, die in `/help` verwendet werden; die aktuelle Liste enthält außerdem `/samples` unter `current work`, wenn Samples aktiviert ist (`MERCURY_SAMPLES=1` oder die Zeile Samples im Boot Menu), `/showcase`, wenn `MERCURY_DEV_SURFACES=1` gesetzt ist, sowie alle Befehle aus Skills oder Erweiterungen.

| Bereich | Befehle |
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

| Befehl | Funktion |
| --- | --- |
| `/llmhost` | Ein Modell wählen, das Sie bei Runpod, Vast.ai oder Lambda mieten, auf Ihrem Computer betreiben oder an einen bestehenden Server anbinden. |
| `/restart` | Diesen Chat auf den installierten Mercury-Build verschieben; laufende Überwachungen und Hintergrund-Shells werden beendet. |
| `/mcp` | Server prüfen, sich anmelden, die Werkzeuge und Parameter jedes Servers durchsuchen, neu verbinden oder einen Server für diesen Chat umschalten. |

`/mouse off` gibt den Zeiger an das Terminal zurück, damit Text nativ markiert und kopiert werden kann. Die Einstellung wird gespeichert und erscheint in `/config` als Mouse capture.

Ein Pflichtargument beginnt in der Nutzungsangabe eines Skills mit `<…>`. Zum Beispiel brauchen `/update-config` und `/debug` ein Argument. Senden Sie einen dieser Befehle allein, erhalten Sie seine Beschreibung und Nutzung; es startet kein Turn. Wählen Sie ihn in der Typeahead-Liste aus, und Enter legt `/name ` bereit, damit Sie das Argument ergänzen können. `/loop` hat kein Pflichtargument und läuft sofort.

## Ein Problem melden

Für eine kurze Meldung verwenden Sie [das Tester-Formular](https://mercury-cli.ai/report) oder `/bug --short <what you tried>` innerhalb von Mercury. Es fragt nach Ihrem Betriebssystem, nach dem, was Sie versucht haben, und nach dem, was kaputtgegangen ist; ein Health-Dump ist nicht erforderlich.

Führen Sie `/bug <what happened>` innerhalb von Mercury aus, um eine Meldung vorab anzusehen, bevor Sie sie über die angemeldete GitHub CLI (`gh`) einreichen. Ohne `gh` speichert Mercury einen lokalen Entwurf unter dem config home und verweist Sie auf die Issues-Seite des Repositorys.

Sie können auch direkt ein Issue über die Vorlage bug, provider/model oder feature request öffnen. Fügen Sie die Ausgabe von `--version`, Ihr Betriebssystem, Ihr Terminal und die genauen Schritte bei. Fehler- und Anbieterberichte benötigen außerdem `mercury health --json`, bei einem Build aus dem Quellcode `node dist/mercury.mjs health --json`. Ein Transkript des fehlerhaften Bildschirms hilft.

Melden Sie Sicherheitsprobleme vertraulich über den Tab Security des Repositorys und halten Sie sie aus öffentlichen Issues heraus. Siehe [SECURITY.md](../../SECURITY.md). [CONTRIBUTING.md](../../CONTRIBUTING.md) behandelt Issues, Pull Requests und Prüfungen.

## Lizenz

Mercury CLI ist unter der Apache License 2.0 (`Apache-2.0`) in [LICENSE.md](../../LICENSE.md) lizenziert. Die TypeScript- und Python-SDKs in [sdk/](../../sdk/) und [sdk-py/](../../sdk-py/) (`mercury-cli-sdk` auf npm und PyPI) sind ebenfalls unter der Apache License 2.0 (`Apache-2.0`) lizenziert, jeweils nach der LICENSE-Datei, die sie enthalten ([sdk/LICENSE](../../sdk/LICENSE) und [sdk-py/LICENSE](../../sdk-py/LICENSE)).

Für die Nutzung des Namens und der Marken von Mercury gilt die [Markenrichtlinie](../../TRADEMARKS.md). Mitgelieferte Lizenzen von Drittanbietern sind in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) aufgeführt.
