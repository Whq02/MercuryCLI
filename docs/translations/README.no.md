[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI (mercury-cli.ai, npm-pakken `mercury-tech-cli`) kjører AI-kodeagenter i terminalen din, inne i dine egne git-repositorier på macOS, Linux og Windows.

Nettsted: [mercury-cli.ai](https://mercury-cli.ai) · Repository: [github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI) (`Whq02/MercuryCLI`) · npm: `mercury-tech-cli`

En agent leser og redigerer filer, kjører shell-kommandoer, går gjennom tester og debuggere steg for steg, og sjekker resultatene. Du velger modelleverandøren, modellen og hva agenten har lov til å gjøre:

- **Flere økter på Session Concourse og isolerte worktrees:** kjør flere økter side om side på Session Concourse (`/concourse`), og deleger parallelt arbeid til crewmates på tvers av leverandører (`Crewmate`) i isolerte `git worktree`-utsjekkinger med fil-leaser for prosjektet, slik at parallelle agenter ikke overskriver hverandre.
- **22 modelleverandører, `/llmhost` og `/localsetup`:** hold alle 22 leverandører innlogget samtidig (OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot/Kimi, Z.AI/GLM, OpenRouter, Hugging Face, xAI/Grok, Meta/Muse, Mistral, Nous Portal, OpenCode Zen, Qwen, MiniMax, Together AI, Cohere, Groq, Cerebras, Fireworks AI, Melious AI, OrcaRouter), og bytt leverandør og modell midt i en chat. Åpne `/llmhost` for å velge en modell, sjekke kvantiseringen, fordelingen `conversations × context` og tenkenivået, og kjør den på en leid GPU (Runpod, Vast.ai eller Lambda), på din egen datamaskin (`mercury host`) eller på en eksisterende server. Eller kjør `/localsetup` for å installere eller koble til Ollama sammen med LM Studio, vLLM og llama.cpp.
- **Mneme hybrid RAG-prosjekthukommelse:** bruker en semantisk embedding-modell, BGE (`bge-base-en-v1.5`), på 118 MB som kjører lokalt på enheten, sammen med BM25-ordrangering og sitatsporing, ordrette festede regler, branch-bevisst oppstartskontekst, motsigelseskontroll ved skriving, overleveringsnotater mellom økter og nettlesergrafen `/memory page`.
- **Verktøy for kompilator, AST og DAP-debugging:** kobler LSP-kodeintelligens og refaktoreringer med forhåndsvisning (`LspRead`, `LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`), strukturelt søk og omskriving i AST for 23 språk basert på tree-sitter (`AstSearch`, `AstEdit`), en innebygd debugger etter Debug Adapter Protocol (`Debug`) (`debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`) for å gå inn i feilende Python-, Node-, Go- og Rust-tester steg for steg, og vedvarende Python- og JavaScript-celler med `Eval`.
- **`WebSearch` uten nøkkel og `WebFetch` som markdown:** søker via leverandørens egen søkefunksjon, Brave- eller Tavily-nøkler, offisielle API-er (Stack Exchange, npm, PyPI, crates.io, GitHub, Hacker News, Wikipedia), SearXNG og DuckDuckGo uten nøkkel, og henter offentlig dokumentasjon som markdown innenfor et kallbudsjett på 38 000 tegn.
- **Skrivebordsstyring, Whisper-stemmeinntasting, Saturn-planlegging og editor-broer:** styrer skrivebordsprogrammer (`Computer`), transkriberer push-to-talk-diktering på enheten med Whisper (`/voice`), planlegger gjentakende eller engangsøkter med Saturn (`/saturn`) og kobler til VS Code via Agent Client Protocol (`mercury acp`) sammen med Unity, Blender, Godot og Aseprite.
- **Videogenerering (`Video`):** send prompter og prosjektets referansefiler til en konfigurert MiniMax-generator ([docs/VIDEO.md](../VIDEO.md)), og lagre den genererte MP4-filen og et valgfritt PNG-forhåndsvisningsbilde på 1 sekund i prosjektet ditt.

Mercury brukes til å bygge Mercury, med flere økter og modeller over lange oppgaver. Å holde oversikt over arbeidet er det vanskelige: hva som fortsatt kjører, hva som er endret, og hva som krever en beslutning. Hver økt skriver sitt eget overleveringsnotat når den er ferdig, og neste økt leser notatet én gang ved oppstart, sammen med mine festede regler. Slik forhindres kontekstforgiftning mellom øktene.

![Én prompt til koordinatoren på øktbordet starter to økter, hver i sitt eget worktree; den ene spør før den redigerer, og begge avslutter med endringer klare til gjennomgang](../media/session-board-stream.gif)

Mercury er åpen kildekode under Apache License 2.0, på samme måte som SDK-ene i [sdk/](../../sdk/) og [sdk-py/](../../sdk-py/).

## Installasjon

Utgivelsesarkiver finnes for Apple silicon og Intel-Mac, Linux x64 og arm64, og Windows x64 og arm64. Installer `git` separat; hvert arkiv inkluderer Node og ripgrep, så en egen Node-installasjon er unødvendig.

Velg én installasjonsmetode:

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS og Linux (x64 og arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows (x64 og arm64), i PowerShell 7
brew install Whq02/mercury/mercury                 # Homebrew: macOS og Linux x64
npm install -g mercury-tech-cli                    # npm; `bun install -g mercury-tech-cli` er den samme pakken
mise use -g npm:mercury-tech-cli                   # mise, via npm-pakken
```

Installasjonsadressene holder omtrentlige tellinger av skriptforespørsler etter kilde og UTC-dag (fullførte installasjoner telles ikke); telleren lagrer ingen IP-adresse, user-agent-streng eller informasjonskapsel.

Åpne en ny terminal, eller kjør linjen `export PATH=…` som shell-installasjonsprogrammet skriver ut. Kjør deretter `mercury --version` for å sjekke at installasjonen fungerer, og `mercury` fra et repository for å starte [første kjøring](#første-kjøring). På Windows PowerShell, og etter en installasjon med Homebrew, npm, bun eller mise, fungerer `mercury` i samme terminal.

<details>
<summary>Installasjonsveier, oppdateringer og verifisering av utgivelser</summary>

### Forskjeller mellom installasjonsmetodene

Shell- og PowerShell-installasjonsprogrammene henter den nyeste utgivelsen for plattformen din, sjekker SHA-256-verdien mot `SHA256SUMS.txt`, pakker den ut og kjører arkivets egen kommando `mercury install`.

Homebrew og npm-pakken er hver låst til en bestemt utgivelse og publiseres på nytt etter en tagg, så de kan henge etter den nyeste utgivelsen. Homebrew-kommandoer bruker det fulle tap-navnet `Whq02/mercury/mercury` (den enkle `mercury` i `homebrew-core` er et annet program). npm-pakken `mercury-tech-cli` er en launcher som laster ned den låste utgivelsen; mise installerer den samme pakken. `mercury install --uninstall` fjerner den installerte utgivelsen og kommando-shimen, men beholder konfigurasjonen og øktene dine (kjør også `npm uninstall -g mercury-tech-cli` hvis du installerte npm-launcheren).

Mercurys installasjon er brukerlokal og krever ikke administratortilgang. Du kan trygt kjøre en installasjonskommando på nytt.

### Installasjonsveier

Utgivelsesversjoner ligger under config home i `~/.mercury/versions/<version>` (`%USERPROFILE%\.mercury\versions` på Windows). Kommandoen `mercury` installeres i `~/.local/bin` på macOS og Linux, eller i `%LOCALAPPDATA%\Mercury\bin` på Windows.

`mercury install` legger kommandoens katalog til i PATH én gang: som en markert linje i shell-oppstartsfilen din, eller som et oppslag i Windows-brukerens PATH. En ny terminal plukker opp endringen automatisk.

### Oppdateringer

Bruk `mercury update` med alle installasjonsmetoder.

For en installasjon gjort med shell- eller PowerShell-installasjonsprogrammet, eller med `mercury install`, oppdaterer den Mercury på stedet. `--check` sjekker etter oppdateringer, `--status` viser oppdateringsstatus, og `--rollback` går tilbake til forrige versjon, som blir liggende på disken.

For Homebrew spør den før den kjører `brew upgrade Whq02/mercury/mercury`. Standardsvaret er nei; skriv `y` for å godkjenne. Mercury viser utdata fra kommandoen løpende og sjekker den installerte versjonen etterpå. Bruk `--yes` for å hoppe over spørsmålet i skript.

npm-launcheren bruker det samme utgivelsesoppsettet som installasjonsprogrammene og delegerer hver kjøring til den installerte utgivelsen. `mercury update` oppdaterer derfor en npm-installasjon på stedet, gjennom Mercurys egen oppdateringskanal. `npm update -g mercury-tech-cli` endrer bare utgivelsen pakken installerer ved første kjøring. Dette gjelder også ved bruk av mise.

`--check` leser den samme utgivelseslisten for alle installasjonsmetoder og forteller deg hvordan du oppdaterer din. Når en oppdatering er tilgjengelig, viser hjemskjermen `vX.Y.Z available · mercury update` én gang nederst til høyre, og chatten viser den samme meldingen til du oppdaterer. Sett `MERCURY_UPDATE_NOTICE=0` for å skjule begge.

Forespørsler om installasjon og oppdatering henter den offentlige utgivelseslisten og arkivene anonymt. Du kan kjøre dem uten konto eller token. Hvis en anonym forespørsel avvises, bruker Mercury i stedet den innloggede GitHub CLI-en (`gh`).

Etter en oppdatering sjekker Mercury om kommandoen på PATH-en din peker til den oppdaterte installasjonen. Hvis en annen installasjon har forrang, eller den oppdaterte kommandoen mangler i PATH, forklarer den problemet og løsningen. `mercury health` rapporterer det samme problemet.

### Verifisering av utgivelser

Før en utgivelse aktiveres, sjekker Mercury arkivet mot `SHA256SUMS.txt`. Den krever også at nyttelasten er signert med Mercurys utgivelsesnøkkel, som står i den innkompilerte tillitslisten, før oppdateringen klargjøres. En avvist signatur lar den aktive installasjonen stå uendret.

Bruk `--allow-unsigned` for å godta en usignert nyttelast. Mercury avviser fortsatt ukjente signeringsnøkler, feilformede signeringsblokker og manipulert innhold. Kommandoresultatet og den lokale loggen viser begge at du tillot en usignert nyttelast.

Utgivelsesarkiver er signert. Kjør `mercury health` for å undersøke signaturen til den installerte utgivelsen.

Et arkiv uten utgivelsessignatur merkes som usignert. Installasjon og oppdatering avviser det med mindre du angir `--allow-unsigned`.

[docs/TRUST.md](../TRUST.md) forklarer verifiseringsresultatene og hvordan du sjekker et arkiv manuelt. [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) dekker verifisering ved oppstart.

### Merknader om plattformer

Det finnes utgivelsesarkiver for alle plattformene som er oppført over. Enhver annen maskin bygger fra kildekoden.

Utgivelsesarkiver for Intel-Mac er tilgjengelige.

</details>

## Krav

Utgivelsesarkiver inkluderer Node 24 LTS. Launcheren, `mercury install` og `mercury update` bruker den medfølgende kjøretiden; `git` er det eneste separate kravet for selve utgivelsen.

For å bygge fra kildekoden trenger du:

- **Node 24 LTS**, i det støttede området `>=24.20.0 <25`. `.node-version` låser patch-versjonen som brukes til bygg og er med i utgivelsesarkivene.
- **bun 1.4.4** for bygget. Den følger ikke med utgivelsene.
- **git**. På Windows kjører du PowerShell 7 inne i Windows Terminal eller VS Code-terminalen. Se [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md).

Minimumsversjonen av Node inkluderer rettelsen for nodejs/node#56645. Under 24.20.0 avbrytes headless `run`-kommandoer som kaller et verktøy, ved avslutning på Windows.

Launcherne velger Node i denne rekkefølgen: den eksplisitte `MERCURY_NODE`-binæren, den medfølgende kjøretiden og deretter en kompatibel Node-installasjon i PATH. Mangler kjøretiden, rapporterer launcheren en feil.

### Windows-shell

Utgivelsesarkiver inkluderer Mercurys bash-kompatible shell-motor (`brush`), og på Windows betjener den Bash-verktøyet som standard: Den finner et `.cmd`- eller `.bat`-program som `npm` på navnet alene via PATHEXT, sender `%VAR%` og `^` uendret til en batchfil, kjører et program oppgitt med en relativ sti etter `cd`, og beholder shell-tilstanden mellom kall. `bash.exe` fra Git for Windows er ikke påkrevd; hvis den er installert, kjører `MERCURY_SHELL_ENGINE=system` eller `system` under Shell engine i `/config` Bash-verktøyet kun på `bash.exe`.

Les `shell`-raden i helsesjekken for å se hvilket shell som er aktivt, og hvorfor: den medfølgende motoren (Windows-standarden, eller aktivert av pinnen eller innstillingen), eller Git Bash når motoren er slått av eller pakken mangler.

På macOS og Linux er systemets shell standard. Sett `MERCURY_SHELL_ENGINE=brush`, eller velg `brush` i `/config` under Shell engine, for å kjøre Bash-verktøyet på den medfølgende motoren der også, med vedvarende shell-tilstand.

Et bygg fra kildekoden uten motorpakken eller Git for Windows starter fortsatt, men Bash-verktøyet er utilgjengelig. PowerShell-verktøyet er fortsatt tilgjengelig, og `shell`-diagnosen forklarer hvordan Bash-støtten gjenopprettes.

## Bygg fra kildekoden

Mercury bygges med bun og kjører på Node 24 LTS. Installer [kravene for bygg fra kildekoden](#krav), inkludert bun 1.4.4:

```sh
curl -fsSL https://bun.com/install | bash -s -- bun-v1.4.4           # macOS og Linux
powershell -c "& ([scriptblock]::Create((irm https://bun.com/install.ps1))) -Version 1.4.4"       # Windows, i PowerShell 7
bun --version                                      # 1.4.4
```

Deretter, i en klone av dette repositoryet:

```sh
bun run setup                      # én gang; bun install + de medfølgende pakkene
bun run build.ts                   # skriver dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### Terminalstøtte

Fullskjermgrensesnittet krever et ekte TTY, men har ingen minimumsstørrelse. Det fulle oppsettet starter ved 100 kolonner × 26 rader; mindre vinduer bruker et kompakt oppsett.

Mercury bruker 24-biters farger når terminalen annonserer støtte via `COLORTERM=truecolor`, eller gjenkjennes som iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal eller VS Code. Andre terminaler bruker 256 farger, inkludert Apples Terminal på macOS 15 og tidligere.

Raden Terminal color i helsesjekken viser den oppdagede fargedybden og årsaken. Sett `MERCURY_TRUECOLOR=1` for en terminal som støtter true colour, men ikke annonserer det, eller `MERCURY_TRUECOLOR=0` for å tvinge 256 farger.

### Valgfrie komponenter

`setup` henter de medfølgende kapabilitetspakkene: pyright, debugpy, js-debug, ekstra grammatikker, plattformens Node-kjøretid og brush. Hvis en nedlasting feiler, hoppes pakken over, og bygget og de berørte verktøyene rapporterer den manglende komponenten. Kjører du `bun install` alene, får du et bygg uten disse pakkene.

For å bygge talestøtte kjører du `setup` med Rust installert. Det bygger `native/voice`. Legg til cmake for å bygge `native/whisper` også. Med Rust installert bygger `setup` også desktop-driver-tillegget (`native/desktop`), som verktøyet `Computer` kjører gjennom. Med Rust installert bygger `setup` også det lokale embedding-tillegget (`native/embed`, `bun run scripts/vendor/build-embed.ts`) og henter BGE-modellen på 118 MB (`bun run scripts/vendor/fetch-embed-models.ts --default`); uten cargo hoppes pakken over, setup sier fra om det, og Mneme-minneoppslag kjører kun med ordtreff. Hvert utgivelsesarkiv inneholder embedding-pakken bygget for sin plattform; på Linux og Windows kjører regneoperasjonene i en vektorisert kjerne, slik at et Recall på mening tar omtrent en tidel av et sekund (noen hundredeler på macOS, som bruker Accelerate). Hvis et native bygg mangler verktøyene sine, hopper setup over det, og helsesjekken rapporterer det manglende tillegget. Windows-shell-motoren kompileres også på maskinen din, fordi upstream ikke har en Windows-binær.

Se [Windows-shell](#windows-shell) og [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) for `brush`-shell-motoren.

Bygget skriver bare til `dist/`. Konfigurasjon og økter ligger i `~/.mercury`, eller i katalogen som `MERCURY_CONFIG_DIR` angir, og opprettes ved første kjøring. På Windows kjører du `node dist\mercury.mjs` direkte.

### Installere et bygg fra kildekoden som en kommando

`scripts/ops/deploy-runtime.sh` publiserer et bygg fra et rent tre til en ny mappe `<config home>/runtime/builds/<build>` og peker `runtime/current` mot den (`runtime/dist` er det eldre navnet på samme lenke). `scripts/ops/deploy-launcher.sh` installerer launcheren i `<config home>/bin/mercury`. Legg til den katalogen i PATH; for zsh:

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

Launcheren stopper med en feil hvis kjøretiden mangler. Den bytter ikke til et annet bygg. Valg av Node følger rekkefølgen i [Krav](#krav). For en utgivelsesinstallasjon kjører du `mercury install` eller `mercury update`, som lar kildeutsjekkingene stå uendret; se [Oppdateringer](#oppdateringer).

[AGENTS.md](../../AGENTS.md) er den korte veiledningen for bygging og kjøring. [BUILD-NOTES.md](../../BUILD-NOTES.md) dekker bygget mer detaljert.

## Første kjøring

Ved første interaktive kjøring velger du et utseende og logger deretter inn hos en leverandør. Skjermen viser en forhåndsvisning av temaendringer mens du blar. True Black er standard; de andre alternativene er det mørke oasis-temaet og Black and white, som ikke bruker farge i det hele tatt: terminalens egen tekstfarge på sin egen bakgrunn, slik Mercury ser ut i en terminal uten farge. Du kan endre dette senere med `/appearance`.

Du kan også velge «sign in later» for å se deg rundt uten å koble til en konto. Når en leverandørnøkkel i miljøet ditt allerede logger inn en leverandør, blir ikke innloggingssteget spurt om. Deretter minner Guardrails-steget deg på å sjekke Mercurys endringer og kommandoer, og på at det som leses kan inneholde instruksjoner til modellen. I en terminal Mercury kan konfigurere (Terminal.app, VS Code-familien, Alacritty, Zed), kan et Terminal keys-steg sette opp linjeskift-snarveier i terminalens egne innstillinger (i Terminal.app på macOS setter det `Option+Enter` for linjeskift og demper terminalklokken i alle profiler, noe som tar effekt når Terminal.app er startet på nytt; i VS Code-familien, Alacritty og Zed skriver det `Shift+Enter` for linjeskift). Det er av med mindre du velger det, og en sikkerhetskopi lagres.

Deretter spør Mercury om du stoler på mappen du åpnet. Ingenting en arbeidsområdekonfigurasjon ber om, kjører før du gir den tilliten. Tilliten gjelder hele repositoryet; hvis du avslår, avsluttes Mercury. Se [docs/TRUST.md](../TRUST.md).

En vanlig interaktiv start åpner hjemskjermen. Den har ti menyoppføringer, der Continue Last Session bare vises når du har en øktlogg:

- **New Session in \<folder\>** starter en ny økt i gjeldende mappe.
- **Continue Last Session** går tilbake til den siste chatten din.
- **Boot Menu** konfigurerer kommende økter, inkludert motion, crewmates og workflows.
- **MCPs & Skills** velger hva den neste økten laster. Se [docs/KIT.md](../KIT.md).
- **Agents** oppretter og redigerer agenter.
- **Health Check** sjekker installasjonen.
- **Saturn Scheduler** planlegger økter. Se [docs/SATURN.md](../SATURN.md).
- **Logins** kobler til leverandørkontoer.
- **Session Concourse** åpner gjeldende prosjekts øktliste.
- **Sessions · Projects** lar deg velge en økt eller et repository.

Menyoppføringer åpnes over hjemskjermen, og `Esc` går tilbake til oppføringen du valgte. Øktlisten åpnes på en egen skjerm, også tilgjengelig med `Shift+→`. Et prompt-argument, `--continue` eller `--resume` tar deg direkte til chatten.

### Motion, crewmates og workflows

Performance-seksjonen i Boot Menu inneholder en Motion-innstilling: `auto`, `full`, `reduced` eller `off`. Den styrer tomgangsanimasjonen i grensesnittet og er også tilgjengelig i `/config`.

Under Agents avgjør bryterne Crewmates og Workflows om nye økter får verktøyene Crewmate og Workflow. Slår du av en bryter, fjernes det tilhørende verktøyet; forsøk på å starte den typen arbeid gir samme forklaring. Inne i en økt endrer `/crewmates on|off` og `/workflows on|off` innstillingen ved neste tur-grense.

## Den daglige arbeidsflyten: Session Concourse, git-worktrees og crewmates

### Starte en økt og isolere worktrees

Trykk `Enter` på New Session for å opprette en økt i gjeldende mappe med standardmodellen din. Mercury åpner chatten og legger økten til i øktlisten samtidig. Bak menyen holder den en prosess klar for å redusere oppstartsarbeidet.

Å starte en ny økt stopper ikke den forrige. Du kan la en oppgave kjøre og jobbe andre steder. Start med `--worktree [name]` (eller be om en `worktree` i chatten for å kjøre `EnterWorktree`) for å gi en økt sin egen branch og utsjekking under `.mercury/worktrees/`. Parallelle crewmates kan også kjøre i isolerte worktrees og koordinere delte filer med prosjektets fil-leaser; se [Hva er inni](#hva-er-inni-mneme-rag-minne-lsp-ast-for-23-språk-dap-debugger-websøk-og-broer) og [docs/CREW.md](../CREW.md).

### Arbeide i chatten

Beskriv arbeidet med vanlig språk. Agenten leser, redigerer, kjører og sjekker kode under tillatelsesmodusen du har valgt. Verktøykall vises mens de kjører, enten som kompakte kort eller med full utdata. Velg visningen i `/config` under Tool output; innstillingen lagres til senere oppstarter.

Bruk `/model` og `/effort` for å justere økten. `/permissions` styrer hva som kan kjøre uten godkjenning, og hva som må spørre først.

Gjennomgå endringer med `/diff`, etter kilde, fil og hunk. `! <command>` kjører en shell-kommando i chatten og viser siste utdata fortløpende. `/runs` viser kjørende shell-er og crewmates (`/tasks` åpner den samme oversikten), og `/crewmates` åpner den levende Crew-visningen. Mellom turer lagrer `/clear` gjeldende chat og åpner en fersk økt, og `/restart` flytter chatten over til et nylig installert Mercury-bygg. `/title` gir chatten et navn, og `/help` lister tilgjengelige kommandoer.

### Bytte mellom skjermer

`Shift+←` og `Shift+→` bytter mellom skjermene som er tilgjengelige akkurat nå. En fersk oppstart har hjemskjermen og øktlisten. Chatskjermen legges til når en økt får fokus, og fjernes når den siste chatten lukkes. Tasteveiledningen viser bare de tilgjengelige bevegelsene.

Når du lukker alle chatter, kommer du tilbake til hjemskjermen. Bruk `--chat` for bare hjemskjermen og chatten, uten øktlisten. `--concourse-off` lagrer den innstillingen for fremtidige oppstarter; `--concourse-on` eller `/config` slår den på igjen.

### Administrere økter på Session Concourse

Åpne øktlisten med `/concourse` eller `Shift+→` fra hjemskjermen. Den viser først kjørende økter i gjeldende prosjekt, etterfulgt av lagrede chatter som ikke kjører, nyeste først.

Hver kjørende økt har en NOW-celle som viser gjeldende aktivitet. Velg en rad og trykk `Enter` for å gå tilbake til chatten, mens de andre øktene fortsetter å kjøre. En krasjet økt blir stående i øktlisten som NEEDS YOU, med årsaken, til du frigjør den.

[docs/SESSIONS.md](../SESSIONS.md) dekker øktens livssyklus.

## Leverandører og modeller: innlogginger, `/localsetup` og `/llmhost`

Bruk `/logins` for å koble til en leverandør. Den åpner samme påloggingskatalog som brukes under oppsett. `/accounts` administrerer tilkoblede leverandørplasser etterpå.

- **OpenAI:** ChatGPT-abonnement eller API-nøkkel.
- **Anthropic:** Claude-abonnement, Console-innlogging eller API-nøkkel.
- **OpenRouter:** katalogtilgang via OAuth eller en API-nøkkel; modellforespørsler avviser datainnsamling og krever at alle parametere støttes fra start. `/config → OpenRouter routing policy` setter valg for reserveløsning og zero-data-retention; velg open for å løsne policyen og overlate rutingen til OpenRouter.
- **Google Gemini:** Sign in with Google, en API-nøkkel eller din egen OAuth-klient. Sign in with Google kjører Gemini på kvoten til abonnementet Google-kontoen har (en gratis konto, Google AI Pro eller Google AI Ultra), gjennom Googles egen Antigravity-klient: prompten, verktøyskjemaene og verktøyresultatene sendes til Googles Code Assist-endepunkt under denne klienten og den innloggede kontoen, og `/model` lister modellutvalget Google tilbyr kontoen. En API-nøkkel eller din egen OAuth-klient fakturerer i stedet et Cloud-prosjekt.
- **Hugging Face:** innlogging med enhetskode eller Hub-token.
- **Kimi (Moonshot):** innlogging med enhetskode eller API-nøkkel.
- **GLM (Z.AI):** en nøkkel for GLM Coding Plan-abonnementet eller en vanlig API-nøkkel for betaling etter bruk. `/logins zai` lagrer begge og husker planen; `ZAI_API_KEY` fungerer også, med `ZAI_KEY_PLAN=coding|general` som angir planen (når den ikke er satt, leser Mercury den fra nøkkelens egen modellliste).
- **DeepSeek:** en API-nøkkel fra DeepSeek-plattformen (`/logins deepseek`, eller `DEEPSEEK_API_KEY`).
- **xAI (Grok):** logg inn med Grok-abonnementet ditt (SuperGrok / X Premium), eller lim inn en API-nøkkel via `/logins xai`.
- **Meta (Muse):** Sign in with Meta (et Muse Code-abonnement, en enhetskode i nettleseren din) eller en Model API-nøkkel for betaling etter bruk. Sign in with Meta bytter enhetskoden mot Metas OIDC-endepunkter (`https://auth.meta.com/oidc/device/authorization/` og `/oidc/device/token/`) under Muse Codes offentlige klient-ID, sender det resulterende kontotokenet én gang til `https://api.meta.ai/muse-code/key` for å utstede abonnementets API-nøkkel (og til avgrensede `/usage`-lesinger av planens nivå og bruksvinduer), og sender bare den utstedte nøkkelen med hver modellforespørsel til `https://api.meta.ai/v1`. En innlimt Model API-nøkkel eller `MODEL_API_KEY` / `META_API_KEY` belastes betaling etter bruk.

- **Qwen:** en QwenCloud-nøkkel (Token Plan eller betaling etter bruk) eller en Alibaba Cloud Model Studio-nøkkel (betaling etter bruk, Token Plan eller Coding Plan), sjekket på sitt eget endepunkt før den lagres; en plannøkkel lister modellene i planen, med Qwen3.8 Max først.
- **MiniMax:** en Open Platform-nøkkel eller en M Plan-abonnementsnøkkel.
- **Together AI** og **Cohere:** API-nøkkel.
- **Groq**, **Cerebras** og **Fireworks AI:** API-nøkkel; enhver familienøkkel kan også komme fra en kommando som er oppgitt i `credentials.keyCommands.<family>`.

Mistral, Nous Portal og OpenCode Zen kobles også til via `/logins`, til sammen 22 leverandørfamilier med innlogging. Lokale modelltjenere (Ollama, LM Studio, vLLM og llama.cpp) og egendefinerte OpenAI-kompatible endepunkter fungerer uten leverandørinnlogging. Kjør `/localsetup` for å installere eller starte Ollama, hente en modell som passer i minnet ditt, sette kontekstvinduet, eller koble til en kjørende LM Studio-, vLLM- eller llama.cpp-server ([docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)). Hver leverandør bruker sin egen protokoll, egne legitimasjonsopplysninger og egen feilhåndtering, og forespørsler faller aldri tilbake til en annen leverandør. Se [docs/ENGINES.md](../ENGINES.md).

`/llmhost` lister modellene du kan hoste, og viser hvor hver enkelt kan kjøre akkurat nå: på en GPU leid fra Runpod, Vast.ai eller Lambda, på din egen datamaskin eller en lagret SSH-maskin (`mercury host`), eller på en eksisterende modellserver. Hver modellside viser kvantiseringsvalg, hvordan GPU-minnebudsjettet deles mellom parallelle samtaler (`conversations × context`), og standard tenkenivå (som `/effort` endrer per forespørsel). GPU-leie krever en eksplisitt bekreftelse av timeprisen, og oppsettet fortsetter i bakgrunnen hvis du lukker popup-vinduet. På Runpod kan du i tillegg justere kvalitet, kontekstfordeling og tenkenivå før du leier, eller på en kjørende pod (`Tune`), beholde vektene på et volum med rask innlasting, og sette opp lagerovervåkning med 5 sekunders intervall. Vast.ai- og Lambda-leie er nye i 1.0.0-beta.40 og er verifisert mot leverandørenes publiserte API-er med fixtures (ingen live-leiekjøringer er utført). Se [docs/LLM-HOST.md](../LLM-HOST.md).

Nye økter bruker leverandøren du sist koblet til, og den nyeste modellen kontoen har tilgang til. Modeller kontoen ikke får tilgang til, hoppes over. Har den leverandøren ingen brukbar modell, sjekker Mercury neste leverandør som ble koblet til sist. Dette valget skjer når økten starter; en mislykket forespørsel i en eksisterende økt blir hos sin leverandør.

`/model` forklarer valget. Et familieord velger familiens nyeste modell: `/model grok`, `/model deepseek`, `/model kimi` eller `/model glm`. Uten koblet leverandør sender hjemskjermen og `/model` deg til `/logins`. Med `/defaultprovider` gjør du eksplisitt en leverandør til det siste valget.

Tilgangen til leverandørene er fortsatt underlagt leverandørens egne vilkår og tilgjengelighet. Mercurys lisens erstatter ikke disse.

## Den headless CLI-en: `mercury run`, Docker og JSON-RPC-runner

Samme bygg kjører uten det interaktive grensesnittet. `node dist/mercury.mjs --help` lister hvert flagg.

`mercury run "<prompt>"` kjører en prompt uten terminalgrensesnitt:

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` skriver ut svaret; årsaken til en mislykket tur går til stderr.
- `json` skriver ut den siste `outcome`-raden som ett JSON-objekt.
- `rows` skriver ett JSON-objekt per linje: `session`, deretter en `turn`-rad med radene `text`, `reasoning`, `tool_call`, `tool_result` og `step`, og til slutt `outcome`. Ventetider, verktøyfremdrift, bakgrunnsoppgaver og varsler har egne rader. Hver rad inneholder `seq`, `timestamp` og `session_id`; rader innenfor en tur bærer også turens `turn`-nummer. `seq` nummererer denne kjøringens strøm fra 1; `turn` teller øktens turer, så en kjøring som fortsetter en lagret samtale (`-c`, `-r`, `--fork`) nummererer sine turer etter dem som allerede finnes i den, og `session`-raden navngir samtalen den fortsetter i `resume_of`.

Radtypene i utdataen, etter feltet `type`:

- `session`: den åpnende raden med `version`, `build` (de første tolv heksadesimale tegnene i treet bygget ble laget fra, slik `mercury daemon status` skriver det ut; mangler når det ikke ligger et manifest ved siden av bygget), `resume_of` (ved en fortsatt kjøring session-ID-en til samtalen den fortsetter; samme ID som `session_id` med mindre kjøringen ble forket), `cwd`, `model`, `mode`, `tools`, `mcp_servers`, `commands`, `agents`, `skills` og `extensions` som økten har, og `tools_withheld` (til stede når en deny-regel holder tilbake et verktøy under sitt enkle navn; hver post har `tool`, `rule` og `source`).
- `turn`: en tur med status `started` eller `waiting` og `turn_id`; `model`, `message_ids` og antallet `agents` når det er kjent.
- `text`: en avsluttet tekstblokk: `message_id`, `block`, `text` og `phase` (`commentary` eller `final_answer`).
- `reasoning`: en avsluttet reasoning-blokk: `message_id`, `block`, `text` eller `redacted: true`.
- `tool_call`: et verktøykall: `call_id`, `tool`, `input`, med `message_id` og `block`.
- `tool_result`: resultatet av kallet: `call_id`, `status` (`ok`, `error`, `aborted` eller `refused`) og `output`. Et kall som modellen har formet så dårlig at det ble avvist før kjøring (et ukjent verktøy, argumenter som ikke er gyldig JSON, eller som ikke passer til verktøyets skjema), får likevel sitt par: en `tool_call`-rad med argumentene slik de ble levert (`{}` når de ikke var et objekt), og en `tool_result`-rad med status `refused` der `output` er årsaken; rettelsen `notice` følger etter. Et slikt kall ble aldri kjørt og er ikke et avslag.
- `tool_update`: fremdrift fra et kjørende verktøy: `call_id`, `tick`, `source` (`shell`, `powershell`, `mcp` eller `eval`) og hvilke av `line`, `elapsed_s`, `lines`, `bytes`, `budget_ms`, `progress` og `total` kallet rapporterer. Et shell- eller PowerShell-kall gir et tikk etter hvert som utdataen kommer (en kommando som ikke skriver ut noe, gir aldri et tikk), et MCP-kall når serveren rapporterer fremdrift, og et Eval-kall mens cellen kjører; ingen andre verktøy gir tikk; et Browser- eller Crewmate-kall er stille til resultatet foreligger.
- `step`: ett modellkall i hovedtråden: `message_id`, `model`, `usage` og `stop` når modellen har oppgitt hvorfor den stoppet.
- `outcome`: turens resultat, beskrevet nedenfor.
- `close`: notatet som legges igjen til neste økt ved lukking: `state` (`stored`, `skipped` eller `none`), `note_chars`, og `usage` for modellkallene som skrev det, slik at en leser som summerer hver rads usage kommer frem til outcome-verdien. Med prompten gitt som argument spørres notatet innenfor den siste turen, og `close` kommer før den turens `outcome`; med `--input rows` følger det etter den siste `outcome` når stdin lukkes.
- `wait`: en venting på modellen: `state` (`first_byte`, `retry`, `silence`, `loading` eller `done`) med tallene tilstanden bærer, for eksempel `since_ms`, `attempt` og `of`, `delay_ms`, `reason` og `http_status`.
- `heartbeat`: modellstrømmen ga liv etter minst ett sekund uten en tolket hendelse: byte kom inn som ikke ga noen rad. Raden inneholder ikke noe annet og kommer høyst én gang i sekundet; hvor ofte det skjer, avhenger av leverandørens strømmeform, så en strøm som aldri pauser mellom hendelser, sender ingen.
- `compaction`: en komprimering med status `started`, `progress` eller `ended`: `trigger` (`manual`, `auto` eller `overflow`), `stage`, `fill`, `summary_tokens` og til slutt `exit` (`landed`, `cancelled` eller `failed`).
- `mode`: tillatelsesmodusen er endret: `mode`.
- `rate_limit`: leverandørens grensetilstand: `status` (`allowed`, `warning` eller `rejected`), `window`, `resets_at`, `utilization` og overforbruksfeltene.
- `task`: en bakgrunnsoppgave med status `started`, `progress` eller `ended`: `task_id`, `task_type`, `description`, `usage`, `summary`, `status` (`completed`, `failed` eller `stopped`) og `output_file` etter hvert som de blir kjent.
- `notice`: en `warning` eller `error` for leseren: `text`, og en `code` som `input_refused`.
- `command_output`: utdataen fra en slash-kommando som aldri nådde modellen: `command` og `text`.
- `mission_updated`: øktens oppgaveliste er endret; les den på nytt.
- `samples_updated`: øktens samples er endret; les dem på nytt.

Med `--partial` og `--format rows` legges radene `block_start`, `text_delta`, `reasoning_delta`, `tool_input_delta` og `retracted` til. Deltaene hører til `message_id` og `block`; en `retracted`-rad trekker tilbake meldingens deltaer. Den fullførte tekst- eller verktøyraden er den komplette verdien.

Outcome-raden inneholder `schema`, `turn_id`, `status`, `steps`, `wall_ms`, `usage`, `models` og `denials`, med `answer` ved fullføring og `error` (`message`, `class`, valgfri `detail`) ved feil. `stop`, `api_ms`, `cost_usd`, forespurt `structured`-utdata og `notices` tas med når de er tilgjengelige. `wall_ms` er turens forløpte tid. `api_ms` er summen av varigheten til hver modellforespørsel turen gjorde (inkludert nye forsøk og forespørslene til crewmates som kjørte side om side med hovedtråden), så den kan overstige `wall_ms` når forespørsler overlappet. `cost_usd` er USD-beløpet for turens prisede forespørsler, uansett status: en forespørsel Mercury ikke kan prise (ingen pris registrert, ingen kostnad oppgitt i svaret), bidrar ikke og lar modellen stå oppført i `models` uten en egen `cost_usd`; feltet mangler bare når ingenting i turen ble priset. Ved innlogging med et Claude-abonnement har Anthropic-forespørslene ingen dollarpris, så verken de eller raden bærer en `cost_usd`, men usage-tallene blir likevel. Usage angir `input_tokens` (inkludert cachede tokens), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` og, når de er rapportert, `reasoning_output_tokens`, summert over hovedtråden og crewmates. `models` fordeler token-bruken per modell. `steps` teller bare hovedagentens modellkall; modellkall gjort av crewmates vises som egne `step`-rader merket med `parent_call_id`.

Statusen er `completed`, `blocked`, `refused`, `failed`, `interrupted`, `turn_limit`, `budget_limit`, `time_limit`, `schema_unmet` eller `loop_stopped`. En kjøring under `--max-time` (sekunder, eller `10m`, `1h`) avsluttes med `time_limit` ved neste steg når tiden er ute; modellkallet eller verktøyrunden som pågår, avbrytes ikke. En fullført kjøring avsluttes med exitkode 0, andre utfall med 1, og en bruksfeil med 2. SIGINT og SIGTERM avsluttes med exitkodene 130 og 143, etter at utfallet for den avbrutte turen er skrevet ut. Et avvist verktøykall står oppført i `denials`. Når avvisningen var en forespørsel ingen kunne svare på (en kjøring uten vert i en modus som spør, `--mode dontAsk`, eller en verts forespørsel som utløp), og ingen senere verktøykall i turen lykkes, er statusen `blocked`: svaret beholdes, `error` nevner verktøyet og hvordan kjøringen kan fortsette (`--allowed-tools`, en annen `--mode`, eller en vert som svarer på forespørsler), og kjøringen avsluttes med exitkode 1. Lykkes et senere verktøykall i samme tur, kommer turen seg og avsluttes med `completed` (exitkode 0) med et varsel `notice` (`"<Tool> was not approved; the run continued with other tools."`). En avvisning du svarte på (gjennom en deny-regel, en hook, eller en vert som sa nei), lar en fullført tur forbli fullført. Et ubesvart `AskUserQuestion`-kall avslutter også kjøringen som `blocked`, med spørsmålet sitert i `error`; Mercury leser utfallet fra kjøringens registrerte forespørsler, aldri fra svarteksten, så et spørsmål som bare står i svarteksten, avsluttes som `completed`. En ukjent slash-kommando er `refused` med samme setning som det interaktive skjermbildet gir (`Unknown command: /name · /help lists commands`), og avsluttes med exitkode 1.

`--input rows` krever `--format rows` og leser ett inputobjekt per linje:

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

Input-typene er `prompt` med `content` (tekstblokker eller tekst- og bildeblokker), `shell` med `command` og `note` med `to` (en agent-ID) og `content`. Hver godtar en valgfri `id`; prompt- og shell-rader godtar også `priority` (`now`, `next` eller `later`), `sent_at` og `origin`. En avvist inputform gir en `notice` med koden `input_refused`; ugyldig JSON avslutter kjøringen. Disse radene bærer bare input; tillatelsessvar bruker runner-protokollen nedenfor.

Bruk `mercury run -`, eller send tekst gjennom en pipe inn i `mercury run`, for å lese hele prompten fra stdin. Ved siden av et prompt-argument legges tekst fra pipen til som avgrenset kontekst: pipen leses til den lukkes eller har vært stille i ett sekund, slik at en strøm som fortsetter å levere, leses til slutten, og en pipe som forblir åpen og stille, holder ikke kjøringen oppe. Uten prompt og med en terminal på stdin skriver `run` ut bruksinformasjonen og avsluttes med exitkode 2.

`--mode <mode>` velger tillatelsesholdningen. `--sovereign` kjører uten tillatelsesspørsmål, og `--allow-sovereign` gjør holdningen tilgjengelig for et senere bytte. Tillatelsespolitikken og deny-regler gjelder fortsatt. En root-bruker som går inn i sovereign-modus, får ett varsel på stderr; kjøringen fortsetter.

Bruk `-c` for å fortsette den siste samtalen, `-r` for å gjenoppta etter ID, tittel eller valg, `-w` for å kjøre i et administrert worktree, og `--lean` for en minimal økt. En `run` har ingen vert som kan svare på tillatelsesspørsmål: tillatelsesreglene og modusen avgjør hva som kan kjøre, og et kall som fortsatt trenger godkjenning, nektes.

### Headless-bildet

Filen `Dockerfile` i rotkatalogen til repositoryet bygger et Linux x64-image for CI og servere. Inngangspunktet er `mercury`, og standardkommandoen er `run`, så imaget kjører én prompt mot et montert tre og avslutter med kjøringens exitkode:

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

Imaget inneholder bundlen, Node 24-kjøretiden (på `PATH`), de medfølgende verktøyene for søk, shell, debugger, språk og bilder, `git` og sertifikatlageret; ingen velkomstskjerm og ingen innloggingsflyt. Det kjører som ikke-root-brukeren `mercury` med sin config home i containeren (`MERCURY_CONFIG_DIR`), og `/work` er arbeidskatalogen. Farger og mus følger produktets egen terminalgjenkjenning, og `--user 0` kjører som root med det ene sovereign-varselet over.

En leverandørnøkkel kommer som en miljøvariabel, med de samme skrivemåtene som produktet leser overalt: `ANTHROPIC_API_KEY` eller `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` eller `GOOGLE_API_KEY`, `XAI_API_KEY` (og `XAI_MANAGEMENT_API_KEY` for forbruksmåleren), `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY` (og `MISTRAL_ADMIN_API_KEY` for organisasjonsmåleren), `NOUS_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`, `TOGETHER_API_KEY` eller `TOGETHER_AI_API_KEY`, `COHERE_API_KEY` eller `CO_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `DASHSCOPE_API_KEY`, `MODEL_API_KEY` eller `META_API_KEY`, `MERCURY_COMPAT_API_KEY` for et egendefinert OpenAI-kompatibelt endepunkt og `MERCURY_LOCAL_API_KEY` for en lokal server. Uten nøkkel avviser kjøringen i én linje og avsluttes med exitkode 1. `docker run -i … mercury run -` leser prompten fra stdin.

### Være vert for en økt

`mercury runner` leverer en økt til en vert over stdio: JSON-RPC 2.0, én melding per linje. Verten sender `initialize` først og venter på svaret før den sender arbeid:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

Vertens navn og versjon sendes under `host`; `capabilities` erklærer `holds_asks`, `elicitation` og `partial_rows`. Hver forespørsels `id` er et positivt heltall: en forespørsel der `id` er noe annet, besvares med `-32600` og `id: null`, så nummerer forespørslene fra 1.

`queue/add` tar det samme prompt-, shell- eller note-objektet som rad-inputen ovenfor. Utdata kommer i `row`-varsler. `session/facts` leser øktens tilstand; `session/set_mode` endrer tillatelsesmodusen med én gang; `session/set_model` og `session/set_effort` endrer modell og innsats, og en endring gjort mens en tur kjører, holdes tilbake til turen er ferdig: den svarer med `at: "turn_end"`, og deretter kunngjør `session/applied` den. `turn/interrupt` stopper en tur; lukk stdin for å avslutte økten.

Tillatelsesspørsmål kommer som `permission/request` med `kind: "tool"` eller `kind: "network"`. Verten svarer med `outcome: "allow"` eller `outcome: "deny"`; en allow kan bære redigert `input` og tillatelsesregler (`rules`). Et tilbaketrukket spørsmål sender `$/cancel_request` med sin `request_id`. `holds_asks` gir verten ansvaret for spørsmålets klokke. Et MCP-spørsmål bruker `elicitation/request` bare når verten erklærer `elicitation`; ellers besvares det med `cancel`.

En ukjent metode besvares med `-32601`, ugyldige parametere med `-32602`, en `id` som ikke er et positivt heltall med `-32600`, og en forespørsel før initialisering med `-32002`. En regelavvisning er `-32010`, med en setning i `error.message` og en grunn i `error.data.kind`, for eksempel `mode`, `model`, `effort` eller `claim`. Runneren svarer på en feilformet linje med `-32700` og fortsetter; tre feilformede linjer på rad avslutter den.

### Andre kommandoer

Blant de tilgjengelige kommandoene er:

- **`mercury health`**: diagnoserapport, også kalt helsesertifikatet. `--json` returnerer hele rapporten, `--deep` kjører den dype beholdningsoversikten, og `--fix` kjører veiledede rettelser.
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**: logg inn (`login [<family>]`), list leverandørfamilier (`list`), sjekk om en konto er innlogget (`status [<family>]`), logg ut (`logout [<family>]`) eller utsted et langlivet Anthropic-token (`mint`).
- **`mercury models [--json]`**: skriver ut modellene de innloggede kontoene når (de samme fakta som `mercury://models`).
- **`mercury mcp`**: administrer MCP-servere med `add`, `import`, `list`, `get`, `remove`, `trust-reset` og `serve`.
- **`mercury extensions`**: installerer utvidelser og administrerer kildene deres. Handlinger: `list`, `sources`, `add`, `remove`, `refresh`, `install`, `trust`, `enable`, `disable`, `update`, `uninstall`, `fence`, `unfence`, `inspect` og `scaffold`.
- **`mercury roster`**: lister agentbeholdningen.
- **`mercury usage`**: skriver ut den kompakte linjen med tall som `/usage`-skjermen viser; `--json` skriver ut hele avlesningen: hver innlogget leverandørs vinduer med brukt andel og tilbakestilling, tallene og kredittene den har oppgitt, hver med kilde og alder, samt øktens forbruk per modell, lest slik skjermen leser det (hver innlogget leverandørs leser samplet én gang, som ved åpning).
- **`mercury daemon run|status|stop|restart`**: kjør, undersøk, stopp eller start bakgrunnsdaemonen på nytt. Øktplassene er `mercury runner`-underprosesser; daemonen sender promptene deres og er vert for deres tillatelsesspørsmål.
- **`mercury sessions list`** (også bare `mercury sessions`): lister dette prosjektets lagrede økter, nyeste først: ID-en, tidspunktet for sist skrevet, størrelsen, `live` når daemonen er vert for den nå, og tittelen eller første prompt; `--all` leser alle prosjekter, `--limit <n>` begrenser listen. ID-en er det `mercury --resume <id>` åpner igjen, og `sessions delete` fjerner.
- **`mercury sessions delete <id>`**: sletter én lagret økt med vilje — utskriften av samtalen og postene som lagres ved siden av den (kvitteringer, gjenopptakelsessnapshot) — etter et spørsmål; `--yes` hopper over spørsmålet for skript. En økt daemonen er vert for nå, avvises, og en ukjent ID avvises med et hint til rosteren (`/sessions` inne i Mercury). Lagrede økter slettes ellers aldri av seg selv.
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**: kjører en lokal eller SSH-maskin som modelltjener for alle økter som deler config home (`compat/box-<name>/<model>`), ved hjelp av en verifisert lokal vektbank eller en bekreftet nedlasting. Se [docs/LLM-HOST.md](../LLM-HOST.md).
- **`mercury lsp list`** og **`mercury lsp install <server>`**: katalogen over språkservere, med hver server installert (med sin binær) eller ikke til stede (med sin installasjonsveiledning); `install` viser en servers veiledning, spør, kjører nettopp den (`--yes` hopper over spørsmålet for skript) og rapporterer hvor binæren havnet. En ukjent server avvises med rosteren. Mercury installerer aldri en språkserver av seg selv; å åpne en fil starter bare en server som allerede er installert.
- **`mercury acp`**: betjener en editor over Agent Client Protocol, med en runner-underprosess for hver økt. `mercury bridge install` installerer VS Code-utvidelsen; `mercury bridge status` sjekker den; `mercury bridge uninstall` fjerner den.
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**: administrerer motorjobber for Godot-prosjektet i gjeldende katalog. Mercury kjører suiter på sine egne headless-arbeidere fra en frossen prosjektkopi. Tjenesten inkluderer en kompileringsport, opptak, bildestatistikk, fullførte profiler, tilgang til jobbkøen, kansellering og resultater etter ID. Se [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md).
- **`mercury image <image>`**: viser et bilde i terminalen.
- **`mercury install`** og **`mercury update`** (alias `upgrade`): installerer eller oppdaterer utgivelsesarkiver; med `--json` ligger dokumentet på stdout uansett utfall, og exitkoden viser om det mislyktes. Se [Installasjon](#installasjon).
- **`mercury version`** og **`mercury help [command]`**: skriver ut versjonslinjen eller en hjelpeside, det samme som `--version` og `--help`; ingen av dem starter en økt.

## Hva er inni: Mneme RAG-minne, LSP, AST for 23 språk, DAP-debugger, websøk og broer

- **Mneme hybrid RAG-prosjekthukommelse.** Mneme er på som standard og lagrer hvert prosjekts fakta i vanlige markdown-emnesider (`Retain`, `Recall`, `Reflect`, `Correct`). Recall kombinerer en semantisk embedding-modell på 118 MB, BGE (`bge-base-en-v1.5` `q8_0`, MIT, med i hvert utgivelsesarkiv og bygget for sin plattform; se [Valgfrie komponenter](#valgfrie-komponenter)), som kjører på enheten, med BM25-ordrangering med stamming, aktualitetsvekting og sitatsporing via reciprocal rank fusion (`k = 60`). Festede regler (`pin: true`) lastes ordrett inn på hylla for festede regler og endres bare etter ditt ord. Ved øktstart vurderer Mercury ufestede fakta og tidligere notater mot din gjeldende branch, nylig berørte filer og forrige økts overleveringsnotat innenfor et eget oppstartsbudsjett (`memory.startLimit`, standard 4 000 tegn). Motsigelsessjekker ved skriving fanger polaritets-, negasjons- og tallendringer før en motstridende påstand lagres. Hver økt skriver et overleveringsnotat med egne ord ved avslutning, til neste økts inngangsside, pluss en valgfri journalpost. `/memory` åpner minnesenteret, og `/memory page` tegner biblioteket i nettleseren din som en graf av noder og kanter. Se [docs/MNEME.md](../MNEME.md).
- **LSP-kodeintelligens, AST-omskrivinger for 23 språk, DAP-debugger og `Eval`-celler.** Forankrede lesinger og atomiske endringer på tvers av flere filer (`ChangeSet`); språkserverspørringer (`LspRead`) og refaktoreringer med forhåndsvisning og deretter anvendelse (`LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`); søk og omskriving i syntakstreet (`AstSearch`, `AstEdit`) med metavariablene `$NAME` og `$$$NAME` på tvers av 23 grammatikker i utgivelsesarkivene (16 i hvert `bun install`-bygg pluss 7 i grammatikkpakken); vedvarende Python- (`python3`) og JavaScript-kodeceller (Node ES-modul) (`Eval`); og en debugger etter Debug Adapter Protocol (`Debug`) som styrer `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`, `netcoredbg`, `rdbg`, Dart SDK-ens debug-adapter, `kotlin-debug-adapter`, debug-adapteren til elixir-ls og Godot. Verktøyet `Test` bruker operasjonen `debug` til å føre en feilende Python- (`pytest`, `unittest`), JavaScript/TypeScript- (`node-test`, `vitest`, `jest`), Go- (`go test`) eller Rust-test (`cargo test`) rett inn i en `Debug`-økt. Se [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md), [endringstransaksjoner](../CHANGE-TRANSACTIONS.md), [strukturelle mønstre](../STRUCTURAL-PATTERNS.md), [kodeceller](../EVAL.md) og [debuggeren](../DEBUGGER.md).
- **`WebSearch` uten nøkkel og `WebFetch` som markdown.** `WebSearch` går gjennom en kaskade: først leverandørens eget live-søk når sessionsmodellen støtter det (`ProviderSearch`), deretter lagrede Brave- eller Tavily-nøkler, deretter offisielle API-er valgt etter spørringens form (Stack Exchange, npm, PyPI, crates.io, GitHub-kodesøk, Hacker News via Algolia, Wikipedia), deretter konfigurerte SearXNG JSON-API-er (`MERCURY_SEARCH_SEARXNG_INSTANCES`), og til slutt DuckDuckGo-sideskraping uten nøkkel (på som standard; slå av i `/config` eller med `MERCURY_SEARCH_KEYLESS=0`). Hvert svar holder seg under 2 000 tokens og nevner kilden som svarte. `WebFetch` leser offentlige sider som markdown med sidens egne ord innenfor et kallbudsjett på 38 000 tegn (en side som krever en nettleser, leses via den hostede leseren `r.jina.ai` med mindre `MERCURY_FETCH_READER=0`, og en privat nettverksadresse sendes aldri dit). Se [docs/ENGINES.md](../ENGINES.md).
- **Agenter, crewmates på tvers av leverandører (`Crewmate`), worktrees og fil-leaser.** To innebygde agenter (`mercury-crew` for delegert arbeid av alle slag og `mercury-scout` for skrivebeskyttet rekognosering) står ved siden av agentdefinisjonene du lager i `/agents`. Start crewmates hos en hvilken som helst innlogget leverandør, isoler parallelt arbeid i `git worktree`-utsjekkinger (`isolation: "worktree"`), koordiner delte filer med prosessinterne prosjektfil-leaser (`mcp__mercury__lease_take`, `mcp__mercury__lease_release`, `mcp__mercury__lease_list`), og styr eller gjenoppta crewmates etter navn eller ID med `SendMessage` og `ResumeCrewmate`. Følg crewmates og workflow-kjøringer i `/crewmates` og `/runs`. Se [docs/CREW.md](../CREW.md).
- **Skrivebordsstyring.** Slått på som standard når den native skrivebordsdriveren er tilgjengelig. Verktøyet `Computer` tar skjermbilder og styrer mus og tastatur i forgrunnsprogrammet. Mercury sjekker programmet etter navn og identitet før den handler, og ber om godkjenning med mindre tillatelsesreglene dine, en øktgodkjenning, tilgangsinnstillingen eller tillatelsesmodusen allerede tillater handlingen. Mercury stopper ved `Esc`, lar bare én økt styre skrivebordet om gangen, og holder skjermbilder utenfor den lagrede samtalefilen. Sett `MERCURY_COMPUTER_USE=0` for å fjerne verktøyet. Se [docs/COMPUTER-USE.md](../COMPUTER-USE.md).
- **Whisper-stemmeinntasting på enheten (`/voice`).** `/voice on` laster ned den 60 MB store engelske talemodellen (`base.en-q5_1`) ved første bruk, verifiserer SHA-256-digesten og slår på diktering; `/voice off` slår den av. Hold mellomromstasten i 1 sekund for å snakke og slipp for å stoppe, eller kjør bare `/voice` for å starte og stoppe et opptak mens stemme er på. Whisper transkriberer på enheten, så lydopptak forlater aldri maskinen, og `MERCURY_WHISPER_MODEL` velger `tiny.en-q5_1`, `small.en-q5_1`, den flerspråklige `base-q5_1` eller en lokal `.gguf`-fil. Se [docs/VOICE.md](../VOICE.md).
- **Saturn-cron og øktplanlegger (`/saturn`).** Planlegg en prompt for en eksisterende økt (`CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, `/loop`) eller planlegg en ny økt som starter på et fastsatt tidspunkt. Planer kan kjøre én gang eller gjentas. Se [docs/SATURN.md](../SATURN.md).
- **VS Code (ACP), Unity, Blender, Godot og Aseprite-broer.** `mercury acp` kobler til editorer som støtter Agent Client Protocol. VS Code-utvidelsen (`mercury bridge install`) kjører Mercury i editoren over den protokollen: chat, økter, agenter, artefakter og gjennomganger, med editorens markering og diagnostikk med på hver prompt. Egne, valgfrie integrasjoner kobler til kjørende Unity-, Blender- og Godot-editorer (`MERCURY_UNITY=1`, `MERCURY_BLENDER=1` og `MERCURY_GODOT_TOOLS=1`), med batchtilgang til Aseprite (`MERCURY_ASEPRITE=1`). Se [Unity](../UNITY-BRIDGE.md), [Blender](../BLENDER-BRIDGE.md), [Godot](../VULCAN-GODOT-TOOLS.md) og [Aseprite](../ASEPRITE-BRIDGE.md).
- **Utvidelser.** Hver utvidelse har ett manifest. Legg til kilder fra en git-URL, en lokal mappe eller et arkiv, godkjent etter bidragshashen. Se [docs/EXTENSIONS.md](../EXTENSIONS.md).
- **MCPs & Skills.** Konfigurasjon per repository for hva økter laster, med navngitte forhåndsinnstillinger og kontroller du kan endre under en økt. Se [docs/KIT.md](../KIT.md).
- **Diagnostikk.** Helsesjekken og `/health` lager en rapport basert på diagnostisk grunnlag, med vurderingen `certified`, `caution` eller `fault` og verifiserte rettelser. Se [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md).
- **Tillit og tillatelser.** Arbeidsområdetillit, tillatelsesregler og -moduser, og kommandoene som hver økt avviser. Se [docs/TRUST.md](../TRUST.md).
- **Apollo Mode**, spesifikasjonsintervjuet: svar på agentens spørsmål for å fullføre spesifikasjonen den vil bruke til å bygge en prototype. Se [docs/APOLLO-MODE.md](../APOLLO-MODE.md).
- **Gjenoppretting.** Atomisk publisering, journalførte operasjoner og avstemming ved oppstart. Se [docs/DURABILITY.md](../DURABILITY.md).

Runtime-flaggene er definert i `src/substrate/flagRegistry.ts`, eksponeres som `MERCURY_*`-innstillinger og vises ved behov. Integrasjonskompatibilitet er dokumentert i [docs/COMPATIBILITY.md](../COMPATIBILITY.md). Den fulle dokumentasjonsindeksen er [docs/README.md](../README.md).

## Slash-kommandoer

`/help` lister de tilgjengelige interaktive kommandoene. Bruk `/palette` for fuzzy-søk etter kommandoer. Tabellen under grupperer de standard aktiverte innebygde kommandoene etter kategoriene som brukes i `/help`; den gjeldende listen inkluderer også `/samples` under `current work` når Samples er aktivert (`MERCURY_SAMPLES=1` eller raden Samples i Boot Menu), `/showcase` når `MERCURY_DEV_SURFACES=1` er satt, og eventuelle skills- eller utvidelseskommandoer.

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

| Kommando | Hva den gjør |
| --- | --- |
| `/llmhost` | Velg en modell å leie hos Runpod, Vast.ai eller Lambda, kjøre på din egen datamaskin eller koble til en eksisterende server. |
| `/restart` | Flytt denne chatten til det installerte Mercury-bygget; kjørende overvåkinger og bakgrunns-shell-er stopper. |
| `/mcp` | Undersøk servere, logg inn, bla gjennom verktøyene og parameterne til hver server, koble til på nytt, eller slå en server av eller på for denne chatten. |

`/mouse off` gir musepekeren tilbake til terminalen, slik at tekst kan markeres og kopieres med terminalen selv. Innstillingen lagres og vises i `/config` som Mouse capture.

Et påkrevd argument starter med `<…>` i en skills bruksbeskrivelse. For eksempel trenger `/update-config` og `/debug` et argument. Sender du en av dem alene, får du beskrivelsen og bruken; ingen tur starter. Velger du den i typeahead og trykker Enter, står `/name ` klar, slik at du kan legge til argumentet. `/loop` har ikke et påkrevd argument og kjører med en gang.

## Rapportere et problem

For en kort rapport bruker du [testerskjemaet](https://mercury-cli.ai/report) eller `/bug --short <what you tried>` inne i Mercury. Det spør etter operativsystemet ditt, hva du prøvde og hva som gikk galt; en helsedump trengs ikke.

Kjør `/bug <what happened>` inne i Mercury for å forhåndsvise en rapport før du sender den gjennom den innloggede GitHub CLI-en (`gh`). Uten `gh` lagrer Mercury et lokalt utkast under config home og peker deg til repositoryets issues-side.

Du kan også åpne en issue direkte med malen for bug, provider/model eller feature request. Ta med utdataen fra `--version`, operativsystemet ditt, terminalen din og de nøyaktige stegene. Feil- og leverandørrapporter trenger også `mercury health --json`, eller `node dist/mercury.mjs health --json` for et bygg fra kildekoden. Et utdrag av den feilende skjermen hjelper.

Rapporter sikkerhetsproblemer privat via repositoryets fane Security. Hold dem utenfor offentlige issues. Se [SECURITY.md](../../SECURITY.md). [CONTRIBUTING.md](../../CONTRIBUTING.md) dekker issues, pull requests og kontroller.

## Lisens

Mercury CLI er lisensiert under Apache License 2.0 (`Apache-2.0`) i [LICENSE.md](../../LICENSE.md). TypeScript- og Python-SDK-ene i [sdk/](../../sdk/) og [sdk-py/](../../sdk-py/) (`mercury-cli-sdk` på npm og PyPI) er også lisensiert under Apache License 2.0 (`Apache-2.0`), hver under LICENSE-filen de har med seg ([sdk/LICENSE](../../sdk/LICENSE) og [sdk-py/LICENSE](../../sdk-py/LICENSE)).

Bruk av Mercurys navn og varemerker dekkes av [varemerkepolicyen](../../TRADEMARKS.md). Medfølgende tredjepartslisenser er listet i [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
