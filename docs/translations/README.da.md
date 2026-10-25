[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI (mercury-cli.ai, npm-pakken `mercury-tech-cli`) kører AI-kodeagenter i din terminal, inde i dine egne git-repositories på macOS, Linux og Windows.

Websted: [mercury-cli.ai](https://mercury-cli.ai) · Repository: [github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI) (`Whq02/MercuryCLI`) · npm: `mercury-tech-cli`

En agent læser og redigerer filer, kører shell-kommandoer, gennemgår tests og debuggere trin for trin og kontrollerer resultaterne. Du vælger modeludbyderen, modellen og hvad agenten må gøre:

- **Multisession-Concourse og isolerede worktrees:** kør flere sessioner side om side på Session Concourse (`/concourse`), og delegér parallelt arbejde til crewmates på tværs af udbydere (`Crewmate`) i isolerede `git worktree`-checkouts med leases på projektfiler, så parallelle agenter ikke overskriver hinanden.
- **20 modeludbydere, `/llmhost` og `/localsetup`:** hold alle 20 udbydere logget ind samtidig (OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot/Kimi, Z.AI/GLM, OpenRouter, Hugging Face, xAI/Grok, Meta/Muse, Mistral, Nous Portal, OpenCode Zen, Qwen, MiniMax, Together AI, Cohere, Groq, Cerebras, Fireworks AI), og skift udbyder og model midt i en chat. Åbn `/llmhost` for at vælge en model, kontrollere dens kvantisering, opdelingen `conversations × context` og thinking-niveauet og køre den på en lejet GPU (Runpod, Vast.ai eller Lambda), på din egen computer (`mercury host`) eller på en eksisterende server. Eller kør `/localsetup` for at installere eller forbinde Ollama sammen med LM Studio, vLLM og llama.cpp.
- **Mneme hybrid RAG-projekthukommelse:** bruger en semantisk embedding-model på 118 MB, BGE (`bge-base-en-v1.5`), der kører lokalt på enheden, sammen med BM25-ordrangering og citatsporing, ordrette fastgjorte regler, branch-bevidst opstartskontekst, modsigelsestjek ved skrivning, overleveringsnoter mellem sessioner og browsergrafen `/memory page`.
- **Værktøjer til compiler, AST og DAP-debugging:** forbinder LSP-kodeintelligens og refaktoreringer med forhåndsvisning (`LspRead`, `LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`), strukturel søgning og omskrivning i AST for 23 sprog med tree-sitter (`AstSearch`, `AstEdit`), en indbygget debugger efter Debug Adapter Protocol (`Debug`) (`debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`) til at træde ind i fejlende Python-, Node-, Go- og Rust-tests, samt vedvarende Python- og JavaScript-celler med `Eval`.
- **`WebSearch` uden nøgle og `WebFetch` som markdown:** søger via udbyderens indbyggede søgning, Brave- eller Tavily-nøgler, officielle API'er (Stack Exchange, npm, PyPI, crates.io, GitHub, Hacker News, Wikipedia), SearXNG og DuckDuckGo uden nøgle, og henter offentlig dokumentation som markdown inden for et kaldebudget på 38.000 tegn.
- **Desktopstyring, Whisper-stemmeindtastning, Saturn-planlægning og editor-broer:** styrer desktopprogrammer (`Computer`), transskriberer push-to-talk-diktat på enheden med Whisper (`/voice`), planlægger gentagne eller enkeltstående sessioner med Saturn (`/saturn`) og forbinder til VS Code via Agent Client Protocol (`mercury acp`) sammen med Unity, Blender, Godot og Aseprite.
- **Videogenerering (`Video`):** send prompts og projektets referencefiler til en konfigureret MiniMax-generator ([docs/VIDEO.md](../VIDEO.md)), og gem den genererede MP4-fil og et valgfrit 1-sekunders PNG-forhåndsvisningsbillede i dit projekt.

Mercury bruges til at bygge Mercury, hvor flere sessioner og modeller kører på tværs af lange opgaver. At holde styr på arbejdet er det svære: hvad der stadig kører, hvad der er ændret, og hvad der kræver en beslutning. Hver session skriver sin egen overleveringsnote, når den er færdig, og den næste session læser den note én gang ved opstart sammen med mine fastgjorte regler. Dermed forhindres kontekstforgiftning mellem sessionerne.

![Én prompt til koordinatoren på sessionstavlen starter to sessioner, hver i sin egen worktree; den ene spørger, før den redigerer, og begge afslutter med ændringer klar til gennemgang](../media/session-board-stream.gif)

Mercury er open source under Apache License 2.0, ligesom SDK'erne i [sdk/](../../sdk/) og [sdk-py/](../../sdk-py/).

## Installation

Releasearkiver findes til Apple silicon og Intel-Macs, Linux x64 og arm64 samt Windows x64 og arm64. Installér `git` separat; hvert arkiv indeholder Node og ripgrep, så en separat Node-installation er unødvendig.

Vælg én installationsmetode:

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS og Linux (x64 og arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows (x64 og arm64), i PowerShell 7
brew install Whq02/mercury/mercury                 # Homebrew: macOS og Linux x64
npm install -g mercury-tech-cli                    # npm; `bun install -g mercury-tech-cli` er den samme pakke
mise use -g npm:mercury-tech-cli                   # mise, gennem npm-pakken
```

Installationsadresserne fører omtrentlige optællinger af scriptanmodninger efter kilde og UTC-dag (gennemførte installationer tælles ikke); tælleren gemmer ingen IP-adresse, user-agent-streng eller cookie.

Åbn en ny terminal, eller kør linjen `export PATH=…`, som shell-installationsscriptet udskriver. Kør derefter `mercury --version` for at kontrollere, at installationen virker, og start `mercury` fra et repository for at begynde med [første kørsel](#første-kørsel). I Windows PowerShell og efter en installation med Homebrew, npm, bun eller mise virker `mercury` i samme terminal.

<details>
<summary>Installationsstier, opdateringer og verificering af releases</summary>

### Forskelle mellem installationsmetoderne

Shell- og PowerShell-installationsprogrammerne henter den nyeste release til din platform, kontrollerer dens SHA-256 mod `SHA256SUMS.txt`, pakker den ud og kører arkivets egen kommando `mercury install`.

Homebrew og npm-pakken er hver låst til en bestemt release og genudgives efter et tag, så de kan halte bagefter den nyeste release. Homebrew-kommandoer bruger det fulde tap-navn `Whq02/mercury/mercury` (det korte `mercury` i `homebrew-core` er et andet program). npm-pakken `mercury-tech-cli` er en launcher, der henter sin låste release; mise installerer den samme pakke. `mercury install --uninstall` fjerner den installerede release og kommando-shimmen, men beholder din konfiguration og dine sessioner (kør også `npm uninstall -g mercury-tech-cli`, hvis du installerede npm-launcheren).

Installationen af Mercury er brugerlokal og kræver ikke administratoradgang. Du kan roligt køre en installationskommando igen.

### Installationsstier

Releaseversioner ligger under config home i `~/.mercury/versions/<version>` (`%USERPROFILE%\.mercury\versions` på Windows). Kommandoen `mercury` installeres i `~/.local/bin` på macOS og Linux eller i `%LOCALAPPDATA%\Mercury\bin` på Windows.

`mercury install` tilføjer kommandoens mappe til PATH én gang: som en markeret linje i din shells opstartsfil eller som en post i Windows-brugerens PATH. En ny terminal tager ændringen automatisk med.

### Opdateringer

Brug `mercury update` med alle installationsmetoder.

Ved en installation med shell- eller PowerShell-installationsprogrammet eller med `mercury install` opdaterer den Mercury på stedet. `--check` tjekker for opdateringer, `--status` viser opdateringsstatus, og `--rollback` går tilbage til den forrige version, som bliver liggende på disken.

Ved Homebrew spørger den, før den kører `brew upgrade Whq02/mercury/mercury`. Standardsvaret er nej; skriv `y` for at godkende. Mercury viser kommandoens output løbende og kontrollerer den installerede version bagefter. Brug `--yes` for at springe spørgsmålet over i scripts.

npm-launcheren bruger det samme release-layout som installationsprogrammerne og videregiver hver kørsel til den installerede release. `mercury update` opdaterer derfor en npm-installation på stedet via Mercurys egen opdateringskanal. `npm update -g mercury-tech-cli` ændrer kun den release, pakken installerer ved sin første kørsel. Det gælder også, når du bruger mise.

`--check` læser den samme releaseliste for alle installationsmetoder og fortæller dig, hvordan du opdaterer din installation. Når en opdatering er tilgængelig, viser startskærmen `vX.Y.Z available · mercury update` én gang i nederste højre hjørne, og chatten viser en midlertidig meddelelse. Sæt `MERCURY_UPDATE_NOTICE=0` for at skjule begge.

Installations- og opdateringsanmodninger henter den offentlige releaseliste og arkiverne anonymt. Du kan køre dem uden konto eller token. Bliver en anonym anmodning afvist, går Mercury i stedet til den GitHub CLI (`gh`), du er logget ind i.

Efter en opdatering kontrollerer Mercury, om kommandoen på din PATH peger på den opdaterede installation. Hvis en anden installation har forrang, eller den opdaterede kommando mangler i PATH, forklarer den problemet og løsningen. `mercury health` rapporterer det samme problem.

### Verificering af releases

Før en release aktiveres, kontrollerer Mercury arkivet mod `SHA256SUMS.txt`. Den kræver også, at nyttelasten er signeret med Mercury-release-nøglen, som står i den indkompilerede tillidsliste, før opdateringen klargøres. En afvist signatur efterlader den aktive installation uændret.

Brug `--allow-unsigned` for at acceptere en usigneret nyttelast. Mercury afviser stadig ukendte signeringsnøgler, ugyldige signeringsblokke og manipuleret indhold. Kommandoens resultat og den lokale optegnelse viser begge, at du tillod en usigneret nyttelast.

Fra 1.0.0-beta.3 signeres arkiver under pakningen, og deres signaturer verificeres før udgivelsen. En verificeret installation tilføjer ingen signaturmeddelelse ved opstart. `mercury health` rapporterer signeringsnøglen `627b54b734ca0e72`.

Arkiverne for 1.0.0-beta.2 er usignerede. Disse installationer rapporterer én gang pr. installation en usigneret herkomst, når du starter Mercury interaktivt uden en kommando eller et flag. Health-checket viser fortsat den status. Det betyder, at arkivmanifestet ikke har nogen signatur; downloadet kontrolleres stadig mod `SHA256SUMS.txt`.

[docs/TRUST.md](../TRUST.md) forklarer verificeringsresultaterne og hvordan du kontrollerer et arkiv manuelt. [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) dækker verificering ved opstart.

### Platformsnoter

Der findes releasearkiver til alle platforme, der er nævnt ovenfor. Enhver anden maskine bygger fra kildekoden.

Arkiver til Intel-Mac findes fra 1.0.0-beta.3. De krydspakkes på en Apple silicon-runner og testes ved opstart under Rosetta, før de udgives. Intel-Mac'er, der bruger 1.0.0-beta.2, skal bygges fra kildekoden.

</details>

## Krav

Releasearkiver indeholder Node 24 LTS. Launcheren, `mercury install` og `mercury update` bruger den medleverede runtime; `git` er det eneste separate krav for selve releasen.

Hvis du vil bygge fra kildekoden, skal du bruge:

- **Node 24 LTS**, i det understøttede interval `>=24.20.0 <25`. `.node-version` fastlåser den patch-version, der bruges til builds og er med i releasearkiverne.
- **bun 1.3.x** til buildet. Den medfølger ikke releases.
- **git**. På Windows kører du PowerShell 7 i Windows Terminal eller i VS Code-terminalen. Se [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md).

Node-minimumsversionen indeholder rettelsen for nodejs/node#56645. Under 24.20.0 afbrydes headless `run`-kommandoer, der kalder et værktøj, ved afslutning på Windows.

Launcherne vælger Node i denne rækkefølge: den eksplicitte `MERCURY_NODE`-binær, den medleverede runtime og derefter en kompatibel Node-installation i PATH. Mangler runtime'en, rapporterer launcheren en fejl.

### Windows-shells

Releasearkiver indeholder Mercurys bash-kompatible shell-motor (`brush`), og på Windows betjener den som standard Bash-værktøjet: Den finder et `.cmd`- eller `.bat`-program som `npm` med sit almindelige navn via PATHEXT, sender `%VAR%` og `^` uændret til en batchfil, kører et program, der er angivet med en relativ sti, efter `cd`, og bevarer shell-tilstanden mellem kald. `bash.exe` fra Git for Windows er ikke påkrævet; hvis den er installeret, kører `MERCURY_SHELL_ENGINE=system` eller `system` under Shell engine i `/config` Bash-værktøjet udelukkende på `bash.exe`.

Læs `shell`-rækken i health-checket for at se, hvilken shell der er aktiv, og hvorfor: den medleverede motor (Windows-standarden, eller aktiveret af pinnen eller indstillingen) eller Git Bash, når motoren er slået fra, eller dens pakke mangler.

På macOS og Linux er systemets shell standard. Sæt `MERCURY_SHELL_ENGINE=brush`, eller vælg `brush` i `/config` under Shell engine, for også at køre Bash-værktøjet på den medleverede motor dér, med vedvarende shell-tilstand.

Et build fra kildekoden uden motorpakken eller Git for Windows starter stadig, men Bash-værktøjet er ikke tilgængeligt. PowerShell-værktøjet er fortsat tilgængeligt, og diagnosen `shell` forklarer, hvordan Bash-understøttelsen gendannes.

## Build fra kildekoden

Mercury bygges med bun og kører på Node 24 LTS. Installér [kravene til build fra kildekoden](#krav), inklusive bun 1.3.x:

```sh
curl -fsSL https://bun.sh/install | bash           # macOS og Linux
powershell -c "irm bun.sh/install.ps1 | iex"       # Windows, i PowerShell 7
bun --version                                      # 1.3.x
```

Kør derefter i en klon af dette repository:

```sh
bun run setup                      # én gang; bun install + de medfølgende pakker
bun run build.ts                   # skriver dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### Terminalunderstøttelse

Fuldskærmsgrænsefladen kræver en rigtig TTY, men har ingen minimumsstørrelse for terminalen. Det fulde layout starter ved 100 kolonner × 26 rækker; mindre vinduer bruger et kompakt layout.

Mercury bruger 24-bit farver, når terminalen annoncerer understøttelse via `COLORTERM=truecolor`, eller når den genkendes som iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal eller VS Code. Andre terminaler bruger 256 farver, herunder Apples Terminal på macOS 15 og ældre.

Rækken Terminal color i health-checket angiver den registrerede farvedybde og årsagen. Sæt `MERCURY_TRUECOLOR=1` for en terminal, der understøtter true colour, men ikke annoncerer det, eller `MERCURY_TRUECOLOR=0` for at tvinge 256 farver.

### Valgfrie komponenter

`setup` henter de medfølgende capability-pakker: pyright, debugpy, js-debug, ekstra grammatikker, platformens Node-runtime og brush. Hvis en download fejler, springes pakken over, og buildet samt de berørte værktøjer rapporterer den manglende komponent. Kører du alene `bun install`, får du et build uden disse pakker.

Hvis du vil bygge stemmeunderstøttelse, kører du `setup` med Rust installeret. Det bygger `native/voice`. Tilføj cmake for også at bygge `native/whisper`. Med Rust installeret bygger `setup` desuden desktop-driver-addonet (`native/desktop`), som værktøjet `Computer` kører igennem. Med Rust installeret bygger `setup` også det lokale embedding-addon (`native/embed`, `bun run scripts/vendor/build-embed.ts`) og henter BGE-modellen på 118 MB (`bun run scripts/vendor/fetch-embed-models.ts --default`); uden cargo springes pakken over, setup siger det, og Mneme-hukommelsesopslag kører kun med ordmatch. Hvert releasearkiv indeholder embedding-pakken bygget til sin platform; på Linux og Windows kører matematikken i en vektoriseret kerne, så et Recall efter betydning tager cirka en tiendedel sekund (et par hundredele på macOS, som bruger Accelerate). Hvis et native build mangler sine værktøjer, springer setup det over, og health-checket rapporterer det manglende addon. Windows-shell-motoren kompileres også på din maskine, fordi upstream ikke leverer en Windows-binær.

Se [Windows-shells](#windows-shells) og [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) for `brush`-shell-motoren.

Buildet skriver kun til `dist/`. Konfiguration og sessioner ligger i `~/.mercury` eller i den mappe, som `MERCURY_CONFIG_DIR` angiver, og oprettes ved første kørsel. På Windows kører du `node dist\mercury.mjs` direkte.

### Installering af et build fra kildekoden som kommando

`scripts/ops/deploy-runtime.sh` udgiver et build fra et rent træ til en ny mappe `<config home>/runtime/builds/<build>` og peger `runtime/current` på den (`runtime/dist` er det ældre navn for det samme link). `scripts/ops/deploy-launcher.sh` installerer launcheren i `<config home>/bin/mercury`. Føj den mappe til PATH; for zsh:

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

Launcheren stopper med en fejl, hvis runtime'en mangler. Den skifter ikke til et andet build. Valget af Node følger rækkefølgen i [Krav](#krav). Til en release-installation kører du `mercury install` eller `mercury update`, som lader kildecheckouts være uændrede; se [Opdateringer](#opdateringer).

[AGENTS.md](../../AGENTS.md) er den korte vejledning i at bygge og køre. [BUILD-NOTES.md](../../BUILD-NOTES.md) dækker buildet mere detaljeret.

## Første kørsel

Ved din første interaktive kørsel vælger du et udseende og logger derefter ind hos en udbyder. Skærmen viser en forhåndsvisning af temaændringer, mens du blader. True Black er standard; de andre muligheder er det mørke oasis-tema og Black and white, som slet ikke bruger farve: terminalens egen tekstfarve på sin egen baggrund, sådan som Mercury ser ud i en terminal uden farver. Du kan ændre det senere med `/appearance`.

Du kan også vælge „sign in later“ for at kigge rundt uden at forbinde en konto. Når en udbydernøgle i dit miljø allerede logger en udbyder ind, bliver du ikke spurgt om login. Derefter minder Guardrails-trinnet dig om at kontrollere Mercurys redigeringer og kommandoer, og om at det, den læser, kan indeholde instruktioner til modellen. I en terminal, som Mercury kan konfigurere (Terminal.app, VS Code-familien, Alacritty, Zed), kan et trin for Terminal keys opsætte tastaturgenveje til ny linje i terminalens egne indstillinger (i Terminal.app på macOS sætter det `Option+Enter` til ny linje og slår terminalklokken fra for alle profiler, hvilket træder i kraft, når Terminal.app er genstartet; i VS Code-familien, Alacritty og Zed skriver det `Shift+Enter` for ny linje). Det er slået fra, indtil du vælger det, og der gemmes en sikkerhedskopi.

Derefter spørger Mercury, om du stoler på den mappe, du har åbnet. Intet, som en workspace-konfiguration beder om, kører, før du giver den tillid. Godkendelsen dækker hele repositoryet; hvis du afviser, afslutter Mercury. Se [docs/TRUST.md](../TRUST.md).

En normal interaktiv start åbner startskærmen. Den har ti menupunkter, hvor Continue Last Session kun vises, når du har en sessionshistorik:

- **New Session in \<folder\>** starter en ny session i den aktuelle mappe.
- **Continue Last Session** vender tilbage til din seneste chat.
- **Boot Menu** konfigurerer kommende sessioner, herunder motion, crewmates og workflows.
- **MCPs & Skills** vælger, hvad den næste session indlæser. Se [docs/KIT.md](../KIT.md).
- **Agents** opretter og redigerer agenter.
- **Health Check** kontrollerer installationen.
- **Saturn Scheduler** planlægger sessioner. Se [docs/SATURN.md](../SATURN.md).
- **Logins** forbinder udbyderkonti.
- **Session Concourse** åbner det aktuelle projekts sessionsliste.
- **Sessions · Projects** lader dig vælge en session eller et repository.

Menupunkter åbner sig over startskærmen, og `Esc` fører dig tilbage til det punkt, du valgte. Sessionslisten åbnes på en separat skærm, som også kan nås med `Shift+→`. Et prompt-argument, `--continue` eller `--resume` fører dig direkte til chatten.

### Motion, crewmates og workflows

Boot Menu'ens sektion Performance indeholder indstillingen Motion: `auto`, `full`, `reduced` eller `off`. Den styrer tomgangsanimationen i grænsefladen og er også tilgængelig i `/config`.

Under Agents bestemmer kontakterne Crewmates og Workflows, om nye sessioner får værktøjerne Crewmate og Workflow. Når du slår en kontakt fra, fjernes det tilsvarende værktøj; forsøg på at starte den slags arbejde giver den samme forklaring. Inde i en session ændrer `/crewmates on|off` og `/workflows on|off` indstillingen ved den næste turgrænse.

## Den daglige arbejdsgang: Session Concourse, git-worktrees og crewmates

### Start en session og isolér worktrees

Tryk på `Enter` på New Session for at oprette en session i den aktuelle mappe med din standardmodel. Mercury åbner sin chat og tilføjer samtidig sessionen til sessionslisten. Bag menuen holder det en proces klar for at mindske arbejdet ved opstart.

At starte en anden session stopper ikke den forrige. Du kan lade en opgave køre og arbejde et andet sted. Start med `--worktree [name]` (eller bed om en `worktree` i chatten, så `EnterWorktree` kører) for at give en session sin egen branch og checkout under `.mercury/worktrees/`. Parallelle crewmates kan også køre i isolerede worktrees og koordinere delte filer med leases på projektfilerne; se [Hvad der er indeholdt](#hvad-der-er-indeholdt-mneme-rag-hukommelse-lsp-ast-for-23-sprog-dap-debugger-websøgning-og-broer) og [docs/CREW.md](../CREW.md).

### Arbejde i chatten

Beskriv arbejdet i almindeligt sprog. Agenten læser, redigerer, kører og kontrollerer kode under den tilladelsestilstand, du har valgt. Værktøjskald vises, mens de kører, enten som kompakte kort eller med fuldt output. Vælg visningen i `/config` under Tool output; indstillingen gemmes til senere opstarter.

Brug `/model` og `/effort` til at justere sessionen. `/permissions` styrer, hvad der kan køre uden godkendelse, og hvad der skal spørge først.

Gennemgå ændringer med `/diff`, efter kilde, fil og hunk. `! <command>` kører en shell-kommando i chatten og viser det seneste output løbende. `/runs` viser kørende shells og crewmates (`/tasks` åbner den samme oversigt), og `/crewmates` åbner den live Crew-visning. Mellem to ture gemmer `/clear` den aktuelle chat og åbner en frisk session, og `/restart` flytter chatten over på et nyinstalleret Mercury-build. `/title` giver chatten et navn, og `/help` viser de tilgængelige kommandoer.

### Skift mellem skærme

`Shift+←` og `Shift+→` skifter mellem de skærme, der er tilgængelige lige nu. En frisk opstart har startskærmen og sessionslisten. Chatskærmen tilføjes, når en session får fokus, og fjernes, når den sidste chat lukkes. Tastehjælpen viser kun de tilgængelige skift.

Når du lukker alle chats, vender du tilbage til startskærmen. Brug `--chat` for kun startskærmen og chatten uden sessionslisten. `--concourse-off` gemmer den præference til kommende opstarter; `--concourse-on` eller `/config` slår den til igen.

### Administration af sessioner på Session Concourse

Åbn sessionslisten med `/concourse` eller `Shift+→` fra startskærmen. Den viser først det aktuelle projekts kørende sessioner, efterfulgt af gemte chats, der ikke kører, nyeste først.

Hver kørende session har en NOW-celle, der viser dens aktuelle aktivitet. Vælg en række og tryk `Enter` for at vende tilbage til chatten, mens de andre sessioner fortsætter med at køre. En session, der er gået ned, bliver på sessionslisten som NEEDS YOU med årsagen, indtil du frigiver den.

[docs/SESSIONS.md](../SESSIONS.md) dækker sessionernes livscyklus.

## Udbydere og modeller: logins, `/localsetup` og `/llmhost`

Brug `/logins` til at forbinde en udbyder. Den åbner det samme login-katalog, som bruges under opsætningen. `/accounts` administrerer de forbundne udbyderpladser bagefter.

- **OpenAI:** ChatGPT-abonnement eller API-nøgle.
- **Anthropic:** Claude-abonnement, Console-login eller API-nøgle.
- **OpenRouter:** kataloget tilgås via OAuth eller en API-nøgle; modelanmodninger afviser dataindsamling og kræver, at alle parametre understøttes fra start. `/config → OpenRouter routing policy` styrer valg af fallback og zero-data-retention; vælg open for at lempe reglen og overlade routingen til OpenRouter.
- **Google Gemini:** Sign in with Google, en API-nøgle eller din egen OAuth-klient. Sign in with Google kører Gemini på kvoten for den plan, Google-kontoen har (en gratis konto, Google AI Pro eller Google AI Ultra), gennem Googles egen Antigravity-klient: prompten, værktøjsskemaerne og værktøjsresultaterne sendes til Googles Code Assist-endpoint under denne klient og den indloggede konto, og `/model` viser den modelliste, Google stiller til rådighed for kontoen. En API-nøgle eller din egen OAuth-klient fakturerer i stedet et Cloud-projekt.
- **Hugging Face:** login med enhedskode eller Hub-token.
- **Kimi (Moonshot):** login med enhedskode eller API-nøgle.
- **GLM (Z.AI):** en nøgle til GLM Coding Plan-abonnementet eller en generel betal-efter-forbrug-API-nøgle. `/logins zai` gemmer begge dele og husker planen; `ZAI_API_KEY` virker også, hvor `ZAI_KEY_PLAN=coding|general` navngiver planen (når den ikke er sat, læser Mercury den fra nøglens egen modelliste).
- **DeepSeek:** en API-nøgle fra DeepSeek-platformen (`/logins deepseek` eller `DEEPSEEK_API_KEY`).
- **xAI (Grok):** log ind med dit Grok-abonnement (SuperGrok / X Premium) eller indsæt en API-nøgle via `/logins xai`.
- **Meta (Muse):** Sign in with Meta (et Muse Code-abonnement, en enhedskode i din browser) eller en Model API-nøgle med betal-efter-forbrug. Sign in with Meta bytter enhedskoden mod Metas OIDC-endpoints (`https://auth.meta.com/oidc/device/authorization/` og `/oidc/device/token/`) under Muse Codes offentlige klient-id, sender det resulterende kontotoken én gang til `https://api.meta.ai/muse-code/key` for at udstede abonnementets API-nøgle (og til afgrænsede `/usage`-læsninger af planens niveau og forbrugsvinduer), og sender kun den udstedte nøgle med hver modelanmodning til `https://api.meta.ai/v1`. En indsat Model API-nøgle eller `MODEL_API_KEY` / `META_API_KEY` faktureres betal-efter-forbrug.

- **Qwen:** en QwenCloud-nøgle (Token Plan eller betal-efter-forbrug) eller en Alibaba Cloud Model Studio-nøgle (betal-efter-forbrug, Token Plan eller Coding Plan), som kontrolleres på sit eget endpoint, før den gemmes; en plan-nøgle lister planens modeller, med Qwen3.8 Max først.
- **MiniMax:** en Open Platform-nøgle eller en nøgle til et M Plan-abonnement.
- **Together AI** og **Cohere:** API-nøgle.
- **Groq**, **Cerebras** og **Fireworks AI:** API-nøgle; enhver familienøgle kan også komme fra en kommando, der er angivet i `credentials.keyCommands.<family>`.

Mistral, Nous Portal og OpenCode Zen forbindes også via `/logins`, så der i alt er 20 udbyderfamilier med login. Lokale modelservere (Ollama, LM Studio, vLLM og llama.cpp) og brugerdefinerede OpenAI-kompatible endpoints virker uden udbyder-login. Kør `/localsetup` for at installere eller starte Ollama, hente en model, der passer i din hukommelse, indstille dens kontekstvindue eller forbinde en kørende LM Studio-, vLLM- eller llama.cpp-server ([docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)). Hver udbyder bruger sin egen protokol, sine egne legitimationsoplysninger og sin egen fejlhåndtering, og forespørgsler falder aldrig tilbage til en anden udbyder. Se [docs/ENGINES.md](../ENGINES.md).

`/llmhost` lister de modeller, du kan hoste, og viser, hvor hver enkelt kan køre lige nu: på en GPU lejet hos Runpod, Vast.ai eller Lambda, på din egen computer eller en gemt SSH-computer (`mercury host`) eller på en eksisterende modelserver. Hver modelside viser kvantiseringsmuligheder, hvordan GPU-hukommelsesbudgettet fordeles på parallelle samtaler (`conversations × context`), og standardniveauet for thinking (som `/effort` ændrer pr. anmodning). GPU-leje kræver en udtrykkelig bekræftelse af timeprisen, og opsætningen fortsætter i baggrunden, hvis du lukker pop-uppen. På Runpod kan du desuden justere kvalitet, kontekstfordeling og thinking, før du lejer, eller på en kørende pod (`Tune`), beholde vægtene på et volumen med hurtig indlæsning og sætte lagerovervågning op med 5 sekunders interval. Vast.ai- og Lambda-leje er nye i 1.0.0-beta.40 og er verificeret mod leverandørernes offentliggjorte API'er med fixtures (live-lejekørsler blev ikke udført). Se [docs/LLM-HOST.md](../LLM-HOST.md).

Nye sessioner bruger den udbyder, du senest har forbundet, og den nyeste model, som kontoen har adgang til. Modeller, kontoen ikke kan få adgang til, springes over. Har den udbyder ingen brugbar model, tjekker Mercury den næste, senest forbundne udbyder. Valget sker, når sessionen starter; en mislykket forespørgsel i en eksisterende session bliver hos sin udbyder.

`/model` forklarer valget. Et familienavn vælger den nyeste model i den familie: `/model grok`, `/model deepseek`, `/model kimi` eller `/model glm`. Er ingen udbyder forbundet, sender startskærmen og `/model` dig til `/logins`. Med `/defaultprovider` kan du udtrykkeligt gøre en udbyder til det seneste valg.

Adgang til udbyderne er fortsat underlagt udbyderens egne vilkår og tilgængelighed. Mercurys licens erstatter ikke dem.

## Den headless CLI: `mercury run`, Docker og JSON-RPC-runner

Det samme build kører uden den interaktive grænseflade. `node dist/mercury.mjs --help` lister hvert flag.

`mercury run "<prompt>"` kører en prompt uden en terminalgrænseflade:

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` udskriver svaret; årsagen til en fejlet tur går til stderr.
- `json` udskriver den sidste `outcome`-række som ét JSON-objekt.
- `rows` skriver ét JSON-objekt pr. linje: `session`, derefter en `turn`-række med sine rækker `text`, `reasoning`, `tool_call`, `tool_result` og `step`, og til sidst `outcome`. Ventetider, værktøjsfremskridt, baggrundsopgaver og meddelelser har deres egne rækker. Hver række indeholder `seq`, `timestamp` og `session_id`; rækker inden for en tur bærer desuden turens `turn`-nummer. `seq` nummererer denne kørsels stream fra 1; `turn` tæller sessionens ture, så en kørsel, der fortsætter en gemt samtale (`-c`, `-r`, `--fork`), nummererer sine ture efter dem, der allerede findes i den, og dens `session`-række navngiver den samtale, den fortsætter, i `resume_of`.

Rækketyperne i outputtet, efter feltet `type`:

- `session`: den åbnende række med `version`, `build` (de første tolv hex-tegn af det træ, bundlen blev bygget af, som `mercury daemon status` udskriver det; mangler, når der ikke ligger et manifest ved siden af bundlen), `resume_of` (ved en fortsat kørsel session-id'et for samtalen, den fortsætter; samme id som `session_id`, medmindre kørslen blev forket), `cwd`, `model`, `mode`, de `tools`, `mcp_servers`, `commands`, `agents`, `skills` og `extensions`, sessionen har, og `tools_withheld` (til stede, når en deny-regel skjuler et værktøj under dets almindelige navn; hver post har `tool`, `rule` og `source`).
- `turn`: en tur med status `started` eller `waiting` og dens `turn_id`; `model`, `message_ids` og antallet `agents`, når det er kendt.
- `text`: en afsluttet tekstblok: `message_id`, `block`, `text` og dens `phase` (`commentary` eller `final_answer`).
- `reasoning`: en afsluttet reasoning-blok: `message_id`, `block`, `text` eller `redacted: true`.
- `tool_call`: et værktøjskald: `call_id`, `tool`, `input`, med sin `message_id` og sin `block`.
- `tool_result`: kaldets resultat: `call_id`, `status` (`ok`, `error`, `aborted` eller `refused`) og `output`. Et kald, som modellen har formet så dårligt, at det blev afvist før udførelsen (et ukendt værktøj, argumenter, der ikke er gyldig JSON, eller som ikke passer til værktøjets skema), får stadig sit par: en `tool_call`-række med argumenterne, som de blev leveret (`{}`, når de ikke var et objekt), og en `tool_result`-række med status `refused`, hvis `output` er årsagen; derefter følger rettelsen som `notice`. Et sådant kald blev aldrig kørt, og det er ikke en afvisning.
- `tool_update`: fremskridt fra et kørende værktøj: `call_id`, `tick`, `source` (`shell`, `powershell`, `mcp` eller `eval`) og de af felterne `line`, `elapsed_s`, `lines`, `bytes`, `budget_ms`, `progress` og `total`, som kaldet rapporterer. Et shell- eller PowerShell-kald tikker, efterhånden som dets output kommer (en kommando, der ikke udskriver noget, tikker aldrig), et MCP-kald, når dets server rapporterer fremskridt, og et Eval-kald, mens dets celle kører; intet andet værktøj tikker; et Browser- eller Crewmate-kald er tavst, indtil dets resultat foreligger.
- `step`: ét modelkald i hovedtråden: `message_id`, `model`, `usage` og `stop`, når modellen har angivet, hvorfor den stoppede.
- `outcome`: turens resultat, beskrevet nedenfor.
- `close`: noten, der efterlades til den næste session ved lukning: `state` (`stored`, `skipped` eller `none`), `note_chars` og `usage` for de modelkald, der skrev den, så en læser, der lægger hver rækkes usage sammen, når frem til outcome'ens værdi. Når prompten gives som argument, bliver noten bedt om inden for den sidste tur, og `close` kommer før den turs `outcome`; med `--input rows` følger den efter den sidste `outcome`, når stdin lukkes.
- `wait`: en ventetid på modellen: `state` (`first_byte`, `retry`, `silence`, `loading` eller `done`) med de tal, som tilstanden bærer, fx `since_ms`, `attempt` og `of`, `delay_ms`, `reason` og `http_status`.
- `heartbeat`: modelstrømmen viste liv efter mindst et sekund uden en parset hændelse: bytes kom ind, der ikke gav nogen række. Rækken indeholder intet andet og kommer højst én gang i sekundet; hvor ofte, afhænger af udbyderens streaming-form, så en strøm, der aldrig holder pause mellem hændelser, udsender ingen.
- `compaction`: en kontekstkomprimering med status `started`, `progress` eller `ended`: `trigger` (`manual`, `auto` eller `overflow`), `stage`, `fill`, `summary_tokens` og ved afslutningen `exit` (`landed`, `cancelled` eller `failed`).
- `mode`: tilladelsestilstanden er ændret: `mode`.
- `rate_limit`: udbyderens grænsetilstand: `status` (`allowed`, `warning` eller `rejected`), `window`, `resets_at`, `utilization` og overskridelsesfelterne.
- `task`: en baggrundsopgave med status `started`, `progress` eller `ended`: `task_id`, `task_type`, `description`, `usage`, `summary`, `status` (`completed`, `failed` eller `stopped`) og `output_file`, efterhånden som de bliver kendt.
- `notice`: en `warning` eller `error` til læseren: `text` og en `code`, fx `input_refused`.
- `command_output`: outputtet fra en slash-kommando, der aldrig nåede modellen: `command` og `text`.
- `mission_updated`: sessionens opgaveregister er ændret; læs det igen.
- `samples_updated`: sessionens samples er ændret; læs dem igen.

Med `--partial` og `--format rows` tilføjes rækkerne `block_start`, `text_delta`, `reasoning_delta`, `tool_input_delta` og `retracted`. Deltas hører til `message_id` og `block`; en `retracted`-række trækker den meddelelses deltas tilbage. Den afsluttede tekst- eller værktøjsrække er den fulde værdi.

Outcome-rækken indeholder `schema`, `turn_id`, `status`, `steps`, `wall_ms`, `usage`, `models` og `denials`, med `answer` ved afslutning og `error` (`message`, `class`, valgfri `detail`) ved fejl. `stop`, `api_ms`, `cost_usd`, et anmodet `structured`-output og `notices` medtages, når de er tilgængelige. `wall_ms` er turens forløbne tid. `api_ms` er summen af varigheden for hver modelanmodning, turen fremsatte (inklusive genforsøg og crewmates' anmodninger, der kørte side om side med hovedtråden), så den kan overstige `wall_ms`, når anmodninger overlappede. `cost_usd` er USD-beløbet for turens prissatte anmodninger, uanset status: en anmodning, Mercury ikke kan prissætte (ingen takst registreret, ingen omkostning angivet i svaret), bidrager intet og efterlader sin model listet i `models` uden et eget `cost_usd`; feltet mangler kun, når intet i turen blev prissat. Ved et login med et Claude-abonnement har Anthropic-anmodningerne ingen dollarpris, så hverken de eller rækken bærer et `cost_usd`, men usage-oplysningerne bliver. Usage angiver `input_tokens` (cachede tokens inkluderet), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` og, når de er rapporteret, `reasoning_output_tokens`, summeret over hovedtråden og crewmates. `models` fordeler token-forbruget pr. model. `steps` tæller kun hovedagentens modelkald; modelkald fra crewmates optræder som deres egne `step`-rækker mærket med `parent_call_id`.

Statussen er `completed`, `blocked`, `refused`, `failed`, `interrupted`, `turn_limit`, `budget_limit`, `time_limit`, `schema_unmet` eller `loop_stopped`. En kørsel under `--max-time` (sekunder, eller `10m`, `1h`) afsluttes med `time_limit` ved næste trin, når tiden er udløbet; modelkaldet eller værktøjsrunden, der er i gang, afbrydes ikke. En fuldført kørsel afslutter med exitkode 0, andre udfald med 1, og en brugsfejl med 2. SIGINT og SIGTERM afslutter med exitkoderne 130 og 143, efter udfaldet for den afbrudte tur er skrevet ud. Et afvist værktøjskald står i `denials`. Når afvisningen var en forespørgsel, som ingen kunne besvare (en kørsel uden en vært i en tilstand, der spørger, `--mode dontAsk`, eller en værts forespørgsel, der udløb), og intet senere værktøjskald i turen lykkes, er kørslens status `blocked`: svaret bevares, `error` nævner værktøjet og hvordan kørslen genoptages (`--allowed-tools`, en anden `--mode`, eller en vært, der besvarer forespørgsler), og kørslen afslutter med exitkode 1. Lykkes et senere værktøjskald i samme tur, kommer turen sig og afsluttes med `completed` (exitkode 0) med en advarsel `notice` (`"<Tool> was not approved; the run continued with other tools."`). En afvisning, du selv har besvaret (via en deny-regel, en hook eller en vært, der sagde nej), lader en fuldført tur forblive fuldført. Et ubesvaret kald af `AskUserQuestion` afslutter også kørslen som `blocked`, med spørgsmålet citeret i `error`. Mercury læser udfaldet ud fra kørslens registrerede forespørgsler, aldrig fra svarteksten, så et spørgsmål, der kun står i svarteksten, afslutter som `completed`. En ukendt slash-kommando bliver `refused` med den samme sætning, som den interaktive skærm viser (`Unknown command: /name · /help lists commands`), og afslutter med exitkode 1.

`--input rows` kræver `--format rows` og læser ét inputobjekt pr. linje:

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

Inputtyperne er `prompt` med `content` (tekstblokke eller tekst- og billedblokke), `shell` med `command` og `note` med `to` (et agent-id) og `content`. Hver accepterer et valgfrit `id`; prompt- og shell-rækker accepterer desuden `priority` (`now`, `next` eller `later`), `sent_at` og `origin`. En afvist inputform giver en `notice` med koden `input_refused`; ugyldig JSON afslutter kørslen. Disse rækker bærer kun input; tilladelsessvar bruger runner-protokollen nedenfor.

Brug `mercury run -`, eller send tekst gennem en pipe ind i `mercury run`, for at læse hele prompten fra stdin. Ved siden af et prompt-argument tilføjes tekst fra pipen som afgrænset kontekst: pipen læses, indtil den lukkes, eller har været stille i et sekund, så en strøm, der bliver ved med at levere, læses til enden, og en pipe, der forbliver åben og stille, holder ikke kørslen oppe. Uden prompt og med en terminal på stdin udskriver `run` sin brugsvejledning og afslutter med exitkode 2.

`--mode <mode>` vælger tilladelsesholdningen. `--sovereign` kører uden tilladelsesspørgsmål, og `--allow-sovereign` gør den holdning tilgængelig for et senere skift. Tilladelsespolitikken og deny-regler gælder stadig. En root-bruger, der går ind i sovereign-tilstand, får én meddelelse på stderr; kørslen fortsætter.

Brug `-c` til at fortsætte den seneste samtale, `-r` til at genoptage efter ID, titel eller valg, `-w` til at køre i en styret worktree og `--lean` til en minimal session. En `run` har ingen vært til at besvare tilladelsesspørgsmål: dens tilladelsesregler og tilstand afgør, hvad der kan køre, og et kald, der stadig kræver godkendelse, afvises.

### Det headless-image

Filen `Dockerfile` i repositoryets rod bygger et Linux x64-image til CI og servere. Dens entrypoint er `mercury`, og dens standardkommando er `run`, så imaget kører én prompt mod et monteret træ og afslutter med kørslens exitkode:

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

Imaget indeholder bundlen, dens Node 24-runtime (på `PATH`), de medleverede værktøjer til søgning, shell, debugger, sprog og billeder, `git` og certifikatlageret; ingen indtastningsskærm og intet loginforløb. Det kører som ikke-root-brugeren `mercury` med sin config home inde i containeren (`MERCURY_CONFIG_DIR`), og `/work` er dens arbejdsmappe. Farve og mus følger produktets egen terminalregistrering, og `--user 0` kører som root med den ene sovereign-meddelelse ovenfor.

En udbyders nøgle kommer som en miljøvariabel, med de samme stavemåder, som produktet læser alle steder: `ANTHROPIC_API_KEY` eller `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` eller `GOOGLE_API_KEY`, `XAI_API_KEY` (og `XAI_MANAGEMENT_API_KEY` til dens forbrugsmåler), `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY` (og `MISTRAL_ADMIN_API_KEY` til dens organisationsmåler), `NOUS_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`, `TOGETHER_API_KEY` eller `TOGETHER_AI_API_KEY`, `COHERE_API_KEY` eller `CO_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `DASHSCOPE_API_KEY`, `MODEL_API_KEY` eller `META_API_KEY`, `MERCURY_COMPAT_API_KEY` til et brugerdefineret OpenAI-kompatibelt endpoint og `MERCURY_LOCAL_API_KEY` til en lokal server. Uden nøgle afviser kørslen i én linje og afslutter med exitkode 1. `docker run -i … mercury run -` læser prompten fra stdin.

### Hosting af en session

`mercury runner` leverer en session til en vært over stdio: JSON-RPC 2.0, én besked pr. linje. Værten sender først `initialize` og venter på svaret, før den sender arbejde:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

Værtens navn og version sendes under `host`; `capabilities` erklærer `holds_asks`, `elicitation` og `partial_rows`. Hver anmodnings `id` er et positivt heltal: en anmodning, hvis `id` er noget andet, besvares med `-32600` og `id: null`, så nummerér anmodningerne fra 1.

`queue/add` tager det samme prompt-, shell- eller note-objekt som rækkeinputtet ovenfor. Output kommer i `row`-notifikationer. `session/facts` læser sessionens tilstand; `session/set_mode` ændrer tilladelsestilstanden med det samme; `session/set_model` og `session/set_effort` ændrer model og indsats, og en ændring, der foretages, mens en tur kører, holdes tilbage, indtil turen slutter: den svarer med `at: "turn_end"`, og derefter annoncerer `session/applied` den. `turn/interrupt` stopper en tur; luk stdin for at afslutte sessionen.

Tilladelsesspørgsmål kommer som `permission/request` med `kind: "tool"` eller `kind: "network"`. Værten svarer med `outcome: "allow"` eller `outcome: "deny"`; et allow kan bære et redigeret `input` og tilladelsesregler (`rules`). Et tilbagetrukket spørgsmål sender `$/cancel_request` med dets `request_id`. `holds_asks` giver værten ansvaret for spørgsmålets timer. Et MCP-spørgsmål bruger `elicitation/request` kun, når værten erklærer `elicitation`; ellers besvares det med `cancel`.

En ukendt metode besvares med `-32601`, ugyldige parametre med `-32602`, et `id`, der ikke er et positivt heltal, med `-32600`, og en anmodning før initialisering med `-32002`. En regelafvisning er `-32010`, med en sætning i `error.message` og en årsag i `error.data.kind`, fx `mode`, `model`, `effort` eller `claim`. Runneren besvarer en misdannet linje med `-32700` og fortsætter; tre på hinanden følgende misdannede linjer afslutter den.

### Andre kommandoer

Blandt de tilgængelige kommandoer er:

- **`mercury health`**: diagnoserapport, også kaldet health-certifikatet. `--json` returnerer hele rapporten, `--deep` kører den dybe beholdningsopgørelse, og `--fix` kører vejledte rettelser.
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**: log ind (`login [<family>]`), vis udbyderfamilier (`list`), tjek om en konto er logget ind (`status [<family>]`), log ud (`logout [<family>]`) eller udsted et langlivet Anthropic-token (`mint`).
- **`mercury models [--json]`**: udskriver de modeller, som de indloggede konti kan nå (de samme fakta som `mercury://models`).
- **`mercury mcp`**: administrerer MCP-servere med `add`, `import`, `list`, `get`, `remove`, `trust-reset` og `serve`.
- **`mercury extensions`**: installerer udvidelser og administrerer deres kilder. Handlinger: `list`, `sources`, `add`, `remove`, `refresh`, `install`, `trust`, `enable`, `disable`, `update`, `uninstall`, `fence`, `unfence`, `inspect` og `scaffold`.
- **`mercury roster`**: lister agentinventaret.
- **`mercury usage`**: udskriver den kompakte tallinje, som `/usage`-skærmen viser; `--json` udskriver hele aflæsningen: hver indloggede udbyders vinduer med brugt andel og nulstilling, de tal og kreditter, den har opgivet, hver med sin kilde og alder, samt sessionens udgifter pr. model, læst på samme måde som skærmen læser den (hver indloggede udbyders læser samplet én gang, som ved åbning).
- **`mercury daemon run|status|stop|restart`**: kører, undersøger, stopper eller genstarter baggrundsdaemonen. Dens sessionspladser er `mercury runner`-underprocesser; daemonen sender deres prompter og er vært for deres tilladelsesspørgsmål.
- **`mercury sessions list`** (også bare `mercury sessions`): lister dette projekts gemte sessioner, nyeste først: id'et, tidspunktet for sidste skrivning, størrelsen, `live`, når daemonen er vært for den nu, og dens titel eller første prompt; `--all` læser hvert projekt, `--limit <n>` begrænser listen. Id'et er det, `mercury --resume <id>` genåbner, og `sessions delete` fjerner.
- **`mercury sessions delete <id>`**: sletter bevidst én gemt session — dens udskrift af samtalen og de optegnelser, der gemmes ved siden af den (kvitteringer, genoptagelsessnapshot) — efter et spørgsmål; `--yes` springer spørgsmålet over for scripts. En session, daemonen er vært for nu, afvises, og et ukendt id afvises med et hint til rosteren (`/sessions` inde i Mercury). Gemte sessioner slettes ellers aldrig af sig selv.
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**: kører en lokal eller SSH-computer som modelserver for alle sessioner, der deler config home (`compat/box-<name>/<model>`), ved hjælp af en verificeret lokal vægtbank eller en bekræftet download. Se [docs/LLM-HOST.md](../LLM-HOST.md).
- **`mercury lsp list`** og **`mercury lsp install <server>`**: kataloget over language servere, hver server installeret (med sin binær) eller fraværende (med sin installationsvejledning); `install` viser en servers vejledning, spørger, kører netop den (`--yes` springer spørgsmålet over for scripts) og rapporterer, hvor binæren blev placeret. En ukendt server afvises med rosteren. Mercury installerer aldrig en language server af sig selv; at åbne en fil starter kun en server, der allerede er installeret.
- **`mercury acp`**: betjener en editor over Agent Client Protocol, med en runner-underproces for hver session. `mercury bridge install` installerer VS Code-udvidelsen; `mercury bridge status` tjekker den; `mercury bridge uninstall` fjerner den.
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**: administrerer engine-jobs for Godot-projektet i den aktuelle mappe. Mercury kører suiter på sine egne headless-workers fra en frosset projektkopi. Tjenesten omfatter en kompileringsgate, optagelser, billedstatistik, afsluttede profiler, adgang til jobkøen, annullering og resultater efter ID. Se [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md).
- **`mercury image <image>`**: viser et billede i terminalen.
- **`mercury install`** og **`mercury update`** (alias `upgrade`): installerer eller opdaterer releasearkiver; med `--json` ligger dokumentet på stdout uanset resultatet, og exitkoden viser, om det mislykkedes. Se [Installation](#installation).
- **`mercury version`** og **`mercury help [command]`**: udskriver versionslinjen eller en hjælpeside, det samme som `--version` og `--help`; ingen af dem starter en session.

## Hvad der er indeholdt: Mneme RAG-hukommelse, LSP, AST for 23 sprog, DAP-debugger, websøgning og broer

- **Mneme hybrid RAG-projekthukommelse.** Mneme er slået til som standard og holder hvert projekts fakta i almindelige markdown-emnesider (`Retain`, `Recall`, `Reflect`, `Correct`). Recall kombinerer en semantisk embedding-model på 118 MB, BGE (`bge-base-en-v1.5` `q8_0`, MIT, medleveret i hvert releasearkiv, bygget til sin platform; se [Valgfrie komponenter](#valgfrie-komponenter)), der kører på enheden, med stammeanalyseret BM25-ordrangering, aktualitetsvægtning og citatsporing via reciprok rangfusion (`k = 60`). Fastgjorte regler (`pin: true`) indlæses ordret på hylden med fastgjorte regler og ændres kun på dit ord. Ved sessionens start vurderer Mercury ikke-fastgjorte fakta og tidligere noter mod din aktuelle branch, nyligt berørte filer og den sidste sessions overleveringsnote inden for et særskilt opstartsbudget (`memory.startLimit`, standard 4.000 tegn). Modsigelseskontrol ved skrivning fanger polaritets-, negations- og taludskiftninger, før et modstridende faktum gemmes. Hver session skriver ved afslutningen en overleveringsnote med egne ord til den næste sessions indgangsside, plus en valgfri post i sessionsjournalen. `/memory` åbner hukommelsescenteret, og `/memory page` tegner biblioteket i din browser som en graf af noder og kanter. Se [docs/MNEME.md](../MNEME.md).
- **LSP-kodeintelligens, AST-omskrivninger for 23 sprog, DAP-debugger og `Eval`-celler.** Forankrede læsninger og atomare ændringer på tværs af flere filer (`ChangeSet`); forespørgsler til language serveren (`LspRead`) og refaktoreringer med forhåndsvisning og derefter anvendelse (`LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`); søgning og omskrivning i syntakstræet (`AstSearch`, `AstEdit`) med metavariablerne `$NAME` og `$$$NAME` på tværs af 23 grammatikker i releasearkiverne (16 i hvert `bun install`-build plus 7 i grammatikpakken); vedvarende Python- (`python3`) og JavaScript-kodeceller (Node ES-modul) (`Eval`); og en debugger efter Debug Adapter Protocol (`Debug`), der styrer `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`, `netcoredbg`, `rdbg`, Dart SDK'ens debug-adapter, `kotlin-debug-adapter`, elixir-ls' debug-adapter og Godot. `Test`-værktøjets operation `debug` fører en fejlende Python-test (`pytest`, `unittest`), JavaScript/TypeScript-test (`node-test`, `vitest`, `jest`), Go-test (`go test`) eller Rust-test (`cargo test`) direkte ind i en `Debug`-session. Se [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md), [ændringstransaktioner](../CHANGE-TRANSACTIONS.md), [strukturelle mønstre](../STRUCTURAL-PATTERNS.md), [kodeceller](../EVAL.md) og [debuggeren](../DEBUGGER.md).
- **`WebSearch` uden nøgle og `WebFetch` som markdown.** `WebSearch` gennemløber en kaskade: først udbyderens egen live-søgning, hvis sessionens model understøtter det (`ProviderSearch`), derefter gemte Brave- eller Tavily-nøgler, derefter officielle API'er, valgt efter forespørgslens form (Stack Exchange, npm, PyPI, crates.io, GitHub-kodesøgning, Hacker News via Algolia, Wikipedia), derefter konfigurerede SearXNG-JSON-API'er (`MERCURY_SEARCH_SEARXNG_INSTANCES`) og til sidst DuckDuckGo-sidescraping uden nøgle (slået til som standard; slå det fra i `/config` eller med `MERCURY_SEARCH_KEYLESS=0`). Hvert svar holder sig under 2.000 tokens og nævner den kilde, der svarede. `WebFetch` læser offentlige sider som markdown med sidens egne ord inden for et kaldebudget på 38.000 tegn (en side, der kræver en browser, læses via den hostede læser `r.jina.ai`, medmindre `MERCURY_FETCH_READER=0` er sat, og en privat netværksadresse sendes aldrig dertil). Se [docs/ENGINES.md](../ENGINES.md).
- **Agenter, crewmates på tværs af udbydere (`Crewmate`), worktrees og fil-leases.** To indbyggede agenter (`mercury-crew` til delegeret arbejde af enhver art og `mercury-scout` til skrivebeskyttet rekognoscering) står ved siden af de agentdefinitioner, du opretter i `/agents`. Start crewmates hos enhver udbyder, du er logget ind hos, isolér parallelt arbejde i `git worktree`-checkouts (`isolation: "worktree"`), koordinér delte filer med in-process projektfil-leases (`mcp__mercury__lease_take`, `mcp__mercury__lease_release`, `mcp__mercury__lease_list`), og styr eller genoptag crewmates med navn eller id via `SendMessage` og `ResumeCrewmate`. Følg crewmates og workflow-kørsler i `/crewmates` og `/runs`. Se [docs/CREW.md](../CREW.md).
- **Computerbrug på skrivebordet.** Slået til som standard, når den native desktop-driver er tilgængelig. Værktøjet `Computer` tager skærmbilleder og styrer mus og tastatur i forgrundsprogrammet. Mercury kontrollerer programmet med navn og identitet, før den handler, og spørger om godkendelse, medmindre dine tilladelsesregler, en sessionsgodkendelse, adgangsindstillingen eller tilladelsestilstanden allerede tillader handlingen. Mercury stopper ved `Esc`, lader kun én session styre desktoppen ad gangen og holder skærmbilleder ude af den gemte samtalefil. Sæt `MERCURY_COMPUTER_USE=0` for at fjerne værktøjet. Se [docs/COMPUTER-USE.md](../COMPUTER-USE.md).
- **Whisper-stemmeindtastning på enheden (`/voice`).** `/voice on` henter den 60 MB store engelske talemodel (`base.en-q5_1`) ved første brug, verificerer dens SHA-256-digest og aktiverer diktering; `/voice off` slår den fra. Hold mellemrum nede i 1 sekund for at tale og slip for at stoppe, eller kør bare `/voice` for at starte og stoppe en optagelse, mens stemme er slået til. Whisper transskriberer på enheden, så stemmelyd aldrig forlader maskinen, og `MERCURY_WHISPER_MODEL` vælger `tiny.en-q5_1`, `small.en-q5_1`, den flersprogede `base-q5_1` eller en lokal `.gguf`-fil. Se [docs/VOICE.md](../VOICE.md).
- **Saturn-cron og session-planlægger (`/saturn`).** Planlæg en prompt til en eksisterende session (`CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, `/loop`) eller planlæg en ny session, der starter på et fastsat tidspunkt. Planer kan køre én gang eller gentages. Se [docs/SATURN.md](../SATURN.md).
- **VS Code (ACP), Unity, Blender, Godot og Aseprite-broer.** `mercury acp` forbinder til editorer, der understøtter Agent Client Protocol. VS Code-udvidelsen (`mercury bridge install`) kører Mercury i editoren over den protokol: chat, sessioner, agenter, artefakter og gennemgange, hvor editorens markering og diagnostik følger med hver prompt. Særskilte integrationer, der skal aktiveres, forbinder til kørende Unity-, Blender- og Godot-editorer (`MERCURY_UNITY=1`, `MERCURY_BLENDER=1` og `MERCURY_GODOT_TOOLS=1`), med batchadgang til Aseprite (`MERCURY_ASEPRITE=1`). Se [Unity](../UNITY-BRIDGE.md), [Blender](../BLENDER-BRIDGE.md), [Godot](../VULCAN-GODOT-TOOLS.md) og [Aseprite](../ASEPRITE-BRIDGE.md).
- **Udvidelser.** Hver udvidelse har ét manifest. Tilføj kilder fra en git-URL, en lokal mappe eller et arkiv, godkendt efter dens bidragshash. Se [docs/EXTENSIONS.md](../EXTENSIONS.md).
- **MCPs & Skills.** Konfiguration pr. repository for, hvad sessioner indlæser, med navngivne forudindstillinger og kontroller, du kan ændre under en session. Se [docs/KIT.md](../KIT.md).
- **Diagnostik.** Health-checket og `/health` udarbejder en rapport, der bygger på diagnostisk dokumentation, med vurderingen `certified`, `caution` eller `fault` og verificerede rettelser. Se [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md).
- **Tillid og tilladelser.** Workspace-tillid, tilladelsesregler og -tilstande samt de kommandoer, som enhver session afviser. Se [docs/TRUST.md](../TRUST.md).
- **Apollo Mode**, specifikationsinterviewet: besvar agentens spørgsmål for at færdiggøre den specifikation, den vil bruge til at bygge en prototype. Se [docs/APOLLO-MODE.md](../APOLLO-MODE.md).
- **Gendannelse.** Atomar udgivelse, journalførte handlinger og afstemning ved opstart. Se [docs/DURABILITY.md](../DURABILITY.md).

Runtime-flagene er defineret i `src/substrate/flagRegistry.ts`, eksponeres som `MERCURY_*`-indstillinger og gengives efter behov. Integrationskompatibilitet er dokumenteret i [docs/COMPATIBILITY.md](../COMPATIBILITY.md). Det fulde dokumentationsindeks er [docs/README.md](../README.md).

## Slash-kommandoer

`/help` lister de tilgængelige interaktive kommandoer. Brug `/palette` til fuzzy-søgning i kommandoer. Tabellen nedenfor grupperer de standardaktiverede indbyggede kommandoer efter de kategorier, der bruges i `/help`; den aktuelle liste inkluderer desuden `/samples` under `current work`, når Samples er aktiveret (`MERCURY_SAMPLES=1` eller rækken Samples i Boot Menu), `/showcase`, når `MERCURY_DEV_SURFACES=1` er sat, og alle skills- eller udvidelseskommandoer.

| Område | Kommandoer |
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

| Kommando | Hvad den gør |
| --- | --- |
| `/llmhost` | Vælg en model, der skal lejes hos Runpod, Vast.ai eller Lambda, køres på din egen computer eller forbindes til en eksisterende server. |
| `/restart` | Flyt denne chat over til det installerede Mercury-build; kørende overvågninger og baggrunds-shells stopper. |
| `/mcp` | Undersøg servere, log ind, gennemse hver servers værktøjer og parametre, forbind igen, eller slå en server til eller fra for denne chat. |

`/mouse off` giver markøren tilbage til terminalen, så tekst kan markeres og kopieres nativt. Præferencen gemmes og vises i `/config` som Mouse capture.

Et påkrævet argument starter med `<…>` i en skills brugsangivelse. For eksempel kræver `/update-config` og `/debug` et argument. Sender du en af dem alene, får du dens beskrivelse og brug; ingen tur starter. Vælger du den i typeahead, og trykker du Enter, står `/name ` klar, så du kan tilføje argumentet. `/loop` har intet påkrævet argument og kører med det samme.

## Indrapportering af et problem

Til en kort rapport bruger du [testerformularen](https://mercury-cli.ai/report) eller `/bug --short <what you tried>` inde i Mercury. Den spørger efter dit OS, hvad du forsøgte, og hvad der gik i stykker; et health-dump er ikke nødvendigt.

Kør `/bug <what happened>` inde i Mercury for at se en forhåndsvisning af en rapport, før du indsender den via den GitHub CLI (`gh`), du er logget ind i. Uden `gh` gemmer Mercury et lokalt udkast under config home og peger dig til repositoryets issues-side.

Du kan også åbne et issue direkte med skabelonen bug, provider/model eller feature request. Medtag outputtet fra `--version`, dit OS, din terminal og de præcise trin. Fejl- og udbyderrapporter kræver desuden `mercury health --json`, eller `node dist/mercury.mjs health --json` for et build fra kildekoden. En udskrift af den skærm, der fejler, hjælper.

Indrapportér sikkerhedsproblemer privat via repositoryets fane Security. Hold dem ude af offentlige issues. Se [SECURITY.md](../../SECURITY.md). [CONTRIBUTING.md](../../CONTRIBUTING.md) dækker issues, pull requests og kontroller.

## Licens

Mercury CLI er licenseret under Apache License 2.0 (`Apache-2.0`) i [LICENSE.md](../../LICENSE.md). TypeScript- og Python-SDK'erne i [sdk/](../../sdk/) og [sdk-py/](../../sdk-py/) (`mercury-cli-sdk` på npm og PyPI) er ligeledes licenseret under Apache License 2.0 (`Apache-2.0`), hver under den LICENSE-fil, de medfølger ([sdk/LICENSE](../../sdk/LICENSE) og [sdk-py/LICENSE](../../sdk-py/LICENSE)).

Brug af Mercurys navn og varemærker er omfattet af [varemærkepolitikken](../../TRADEMARKS.md). Medfølgende tredjepartslicenser er opført i [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
