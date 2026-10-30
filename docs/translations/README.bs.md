[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI (mercury-cli.ai, npm paket `mercury-tech-cli`) pokreće AI agente za programiranje u vašem terminalu, unutar vaših vlastitih git repozitorija na macOS-u, Linux-u i Windows-u.

Web stranica: [mercury-cli.ai](https://mercury-cli.ai) · Repozitorij: [github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI) (`Whq02/MercuryCLI`) · npm: `mercury-tech-cli`

Agent čita i uređuje datoteke, izvršava shell naredbe, korača kroz testove i debugere te provjerava rezultate. Vi birate dobavljača modela, model i to šta agent smije da radi:

- **Više sesija u Session Concourse-u i izolovani worktree-ovi:** pokrenite više sesija jednu pored druge u Session Concourse-u (`/concourse`) i delegirajte paralelni rad crewmate-ovima od različitih dobavljača (`Crewmate`) u izolovanim `git worktree` kopijama, uz zakupe datoteka projekta (file leases) da se paralelni agenti međusobno ne bi prepisivali.
- **22 dobavljača modela, `/llmhost` i `/localsetup`:** držite svih 22 dobavljača prijavljeno istovremeno (OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot/Kimi, Z.AI/GLM, OpenRouter, Hugging Face, xAI/Grok, Meta/Muse, Mistral, Nous Portal, OpenCode Zen, Qwen, MiniMax, Together AI, Cohere, Groq, Cerebras, Fireworks AI, Melious AI, OrcaRouter) i mijenjajte dobavljača i model usred razgovora. Otvorite `/llmhost` da odaberete model, provjerite njegovu kvantizaciju, raspodjelu `conversations × context` i nivo razmišljanja, pa ga pokrenite na iznajmljenom GPU-u (Runpod, Vast.ai ili Lambda), na vašem računaru (`mercury host`) ili na postojećem serveru. Ili pokrenite `/localsetup` da instalirate Ollamu ili je povežete uz LM Studio, vLLM i llama.cpp.
- **Mneme hibridna RAG memorija projekta:** koristi semantički embedding model BGE od 118 MB koji radi na uređaju (`bge-base-en-v1.5`), uz rangiranje riječi po BM25 i praćenje citata, doslovno zakačena pravila, početni kontekst svjestan grane, provjere proturječnosti u trenutku upisa, bilješke za predaju između sesija i graf u pregledniku (`/memory page`).
- **Alati za kompajler, AST i DAP debugiranje:** povezuje LSP inteligenciju koda i refaktoriranje uz pregled (`LspRead`, `LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`), pretragu i prepisivanje strukture tree-sitter AST-a za 23 jezika (`AstSearch`, `AstEdit`), ugrađeni debugger Debug Adapter Protocol (`Debug`) (`debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`) za korak-po-korak ulazak u neuspjele testove u Pythonu, Node-u, Go-u i Rust-u, te trajne `Eval` ćelije u Pythonu i JavaScriptu.
- **`WebSearch` bez ključa i `WebFetch` u markdownu:** pretražuje kroz nativnu pretragu dobavljača, ključeve Brave ili Tavily, zvanične API-je (Stack Exchange, npm, PyPI, crates.io, GitHub, Hacker News, Wikipedia), SearXNG i DuckDuckGo bez ključa, te preuzima javnu dokumentaciju u markdownu u okviru budžeta od 38.000 znakova po pozivu.
- **Upravljanje desktop aplikacijama, Whisper glas, Saturn zakazivanje i mostovi ka uređivačima:** upravlja desktop aplikacijama (`Computer`), na uređaju prepisuje glasovni diktat po principu push-to-talk uz Whisper (`/voice`), zakazuje ponavljajuće ili jednokratne sesije uz Saturn (`/saturn`) i povezuje se s VS Code-om preko Agent Client Protocol-a (`mercury acp`), kao i s Unity-jem, Blenderom, Godotom i Asepriteom.
- **Generisanje videa (`Video`):** pošaljite promptove i referentne datoteke projekta konfigurisanom MiniMax generatoru ([docs/VIDEO.md](../VIDEO.md)) i u svom projektu sačuvajte generisani MP4 i opcionalni PNG kadar pregleda sa 1. sekunde.

Mercury se koristi za izgradnju Mercury-ja, pokrećući više sesija i modela tokom dugih zadataka. Najteže je pratiti taj rad: šta se još izvršava, šta se promijenilo i šta traži odluku. Svaka sesija na kraju piše vlastitu bilješku za predaju, a sljedeća sesija je pri pokretanju jednom čita zajedno s mojim zakačenim pravilima, čime se sprječava zagađivanje konteksta između sesija.

![Jedan prompt koordinatoru na tabli sesija pokreće dvije sesije, svaku u vlastitom worktree-u; jedna pita prije uređivanja, a obje završavaju sa spremnim promjenama za pregled](../media/session-board-stream.gif)

Mercury je otvorenog koda (open source) pod licencom Apache License 2.0, kao i SDK-ovi u [sdk/](../../sdk/) i [sdk-py/](../../sdk-py/).

## Instalacija

Arhive izdanja dostupne su za Mac računare sa Apple silicon i Intel čipovima, za Linux x64 i arm64, te za Windows x64 i arm64. Instalirajte `git` zasebno; svaka arhiva sadrži Node i ripgrep, pa zasebna instalacija Node-a nije potrebna.

Odaberite jedan način instalacije:

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS i Linux (x64 i arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows (x64 i arm64), u PowerShell 7
brew install Whq02/mercury/mercury                 # Homebrew: macOS i Linux x64
npm install -g mercury-tech-cli                    # npm; `bun install -g mercury-tech-cli` je isti paket
mise use -g npm:mercury-tech-cli                   # mise, preko npm paketa
```

Adrese za instalaciju čuvaju približne brojeve zahtjeva skripti po izvoru i UTC danu (završene instalacije se ne broje); brojač ne pohranjuje IP adresu, user-agent string niti kolačić (cookie).

Otvorite novi terminal ili pokrenite liniju `export PATH=…` koju ispiše shell instalater, zatim pokrenite `mercury --version` da provjerite instalaciju, a `mercury` iz repozitorija da pokrenete [prvo pokretanje](#prvo-pokretanje). U Windows PowerShell-u, kao i nakon instalacije preko Homebrew-a, npm-a, bun-a ili mise, `mercury` radi u istom terminalu.

<details>
<summary>Putanje instalacije, ažuriranja i provjera izdanja</summary>

### Razlike između načina instalacije

Instalateri za shell i PowerShell preuzimaju najnovije izdanje za vašu platformu, provjeravaju njegov SHA-256 u odnosu na `SHA256SUMS.txt`, raspakuju ga i pokreću naredbu `mercury install` koja dolazi uz arhivu.

I Homebrew i npm paket vezani su za određeno izdanje i ponovo se objavljuju nakon oznake (tag), pa mogu kasniti za najnovijim izdanjem. Homebrew naredbe koriste puni naziv tapa `Whq02/mercury/mercury` (goli `mercury` u `homebrew-core` je drugi program). Npm paket `mercury-tech-cli` je launcher koji preuzima svoje vezano izdanje; mise instalira isti paket. `mercury install --uninstall` uklanja instalirano izdanje i command shim, a zadržava vašu konfiguraciju i sesije (ako ste instalirali npm launcher, pokrenite i `npm uninstall -g mercury-tech-cli`).

Instalacija Mercury-ja je lokalna za korisnika i ne zahtijeva administratorski pristup. Naredbu za instalaciju možete bez rizika pokrenuti ponovo.

### Putanje instalacije

Izdanja se nalaze u matičnom direktoriju konfiguracije, u `~/.mercury/versions/<version>` (`%USERPROFILE%\.mercury\versions` na Windows-u). Naredba `mercury` instalira se u `~/.local/bin` na macOS-u i Linux-u, odnosno u `%LOCALAPPDATA%\Mercury\bin` na Windows-u.

`mercury install` dodaje direktorij naredbe u PATH jednom: zaštićenu liniju u vašoj startnoj datoteci shella ili unos u korisnički PATH na Windows-u. Novi terminal automatski preuzima tu promjenu.

### Ažuriranja

Koristite `mercury update` uz bilo koji način instalacije.

Kod instalacije napravljene shell ili PowerShell instalaterom, odnosno naredbom `mercury install`, ova naredba ažurira Mercury na mjestu. `--check` provjerava ažuriranja, `--status` prikazuje stanje ažuriranja, a `--rollback` vraća prethodnu verziju, koja ostaje na disku.

Za Homebrew, prije pokretanja `brew upgrade Whq02/mercury/mercury` traži potvrdu. Podrazumijevani odgovor je ne; unesite `y` da potvrdite. Mercury prikazuje izlaz naredbe uživo i poslije provjerava instaliranu verziju. Koristite `--yes` da preskočite upit u skriptama.

Npm launcher koristi isti raspored izdanja kao i instalateri i svako pokretanje prosljeđuje instaliranom izdanju. Zato `mercury update` ažurira npm instalaciju na mjestu, kroz Mercury-jev vlastiti kanal za ažuriranje. `npm update -g mercury-tech-cli` mijenja samo izdanje koje paket instalira pri prvom pokretanju. Ovo važi i kada koristite mise.

`--check` čita istu listu izdanja za svaki način instalacije i kaže vam kako da ažurirate svoju. Kada je ažuriranje dostupno, početni ekran jednom prikaže `vX.Y.Z available · mercury update` u donjem desnom uglu, a razgovor prikazuje istu obavijest dok ne ažurirate. Postavite `MERCURY_UPDATE_NOTICE=0` da sakrijete oboje.

Zahtjevi za instalaciju i ažuriranje anonimno preuzimaju javnu listu izdanja i arhive. Možete ih pokrenuti bez naloga ili tokena. Ako anonimni zahtjev bude odbijen, Mercury provjerava prijavljeni GitHub CLI (`gh`).

Nakon ažuriranja Mercury provjerava da li naredba u vašem PATH-u pokazuje na ažuriranu instalaciju. Ako prednost ima neka druga instalacija, ili ažurirana naredba nedostaje u PATH-u, objašnjava problem i rješenje. `mercury health` prijavljuje isti problem.

### Provjera izdanja

Prije aktiviranja izdanja Mercury provjerava njegovu arhivu u odnosu na `SHA256SUMS.txt`. Takođe zahtijeva paket potpisan ključem za izdanja Mercury-ja, koji se nalazi u ugrađenoj listi povjerenja, prije nego što pripremi ažuriranje. Odbijen potpis ostavlja aktivnu instalaciju nepromijenjenom.

Koristite `--allow-unsigned` da prihvatite nepotpisani paket. Mercury i dalje odbija nepoznate ključeve za potpisivanje, neispravne blokove potpisa i izmijenjen sadržaj. Rezultat naredbe i njen lokalni zapis pokazuju da ste dozvolili nepotpisani paket.

Arhive izdanja su potpisane. Pokrenite `mercury health` da pregledate potpis instaliranog izdanja.

Arhiva bez potpisa izdanja označena je kao nepotpisana. Instalacija i ažuriranje je odbijaju osim ako proslijedite `--allow-unsigned`.

[docs/TRUST.md](../TRUST.md) objašnjava rezultate provjere i kako ručno provjeriti arhivu. [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) pokriva provjeru pri pokretanju.

### Napomene o platformama

Arhive izdanja postoje za svaku platformu navedenu iznad. Svaka druga mašina gradi iz izvornog koda.

Arhive izdanja za Intel Mac računare su dostupne.

</details>

## Zahtjevi

Arhive izdanja uključuju Node 24 LTS. Launcher, `mercury install` i `mercury update` koriste to ugrađeno izvršno okruženje; `git` je jedini zasebni zahtjev za samo izdanje.

Za izgradnju iz izvornog koda potrebno je:

- **Node 24 LTS**, u podržanom rasponu `>=24.20.0 <25`. `.node-version` fiksira zakrpu (patch) koja se koristi za izgradnju i uključena je u arhive izdanja.
- **bun 1.4.4** za izgradnju. Nije uključen u izdanja.
- **git**. Na Windows-u pokrenite PowerShell 7 unutar Windows Terminal-a ili terminala VS Code-a. Pogledajte [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md).

Minimalna verzija Node-a uključuje ispravku za nodejs/node#56645. Ispod 24.20.0, `run` naredbe bez interfejsa koje pozivaju alat prekidaju se pri izlasku na Windows-u.

Launcher-i biraju Node ovim redoslijedom: eksplicitno navedeni binarni fajl `MERCURY_NODE`, ugrađeno izvršno okruženje, pa zatim kompatibilna instalacija Node-a u PATH-u. Ako izvršno okruženje nedostaje, launcher prijavljuje grešku.

### Windows ljuske

Arhive izdanja uključuju Mercury-jev shell engine kompatibilan s bash-om (`brush`), a na Windows-u on podrazumijevano služi alatu Bash: pronalazi program `.cmd` ili `.bat`, kao što je `npm`, po njegovom običnom imenu preko PATHEXT-a, prosljeđuje `%VAR%` i `^` batch datoteci nepromijenjeno, pokreće program naveden relativnom putanjom nakon `cd` i zadržava stanje shell-a između poziva. `bash.exe` iz Git for Windows nije potreban; kada je instaliran, `MERCURY_SHELL_ENGINE=system` ili `system` u `/config` pod Shell engine pokreću alat Bash isključivo preko `bash.exe`.

Pročitajte red `shell` u provjeri stanja da vidite koja je ljuska aktivna i zašto: ugrađeni engine (podrazumijevani na Windows-u, ili aktiviran fiksiranjem ili postavkom), ili Git Bash kada je engine isključen ili mu paket nedostaje.

Na macOS-u i Linux-u sistemska ljuska je podrazumijevana; postavite `MERCURY_SHELL_ENGINE=brush` ili odaberite `brush` u `/config` pod Shell engine da alat Bash radi i tamo na ugrađenom engine-u, uz trajno stanje ljuske.

Izgradnja iz izvornog koda bez paketa engine-a ili Git for Windows-a i dalje se pokreće, ali alat Bash nije dostupan. Alat PowerShell ostaje dostupan, a dijagnostika `shell` objašnjava kako vratiti podršku za Bash.

## Izgradnja iz izvornog koda

Mercury se gradi pomoću bun-a i radi na Node-u 24 LTS. Instalirajte [zahtjeve za izgradnju iz izvornog koda](#zahtjevi), uključujući bun 1.4.4:

```sh
curl -fsSL https://bun.com/install | bash -s -- bun-v1.4.4           # macOS i Linux
powershell -c "& ([scriptblock]::Create((irm https://bun.com/install.ps1))) -Version 1.4.4"       # Windows, u PowerShell 7
bun --version                                      # 1.4.4
```

Zatim, u klonu ovog repozitorija:

```sh
bun run setup                      # jednom; bun install + ugrađeni paketi
bun run build.ts                   # piše dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### Podrška za terminal

Interfejs preko cijelog ekrana zahtijeva pravi TTY, ali nema minimalnu veličinu terminala. Potpuni raspored počinje od 100 kolona sa 26 redova; manji prozori koriste kompaktni raspored.

Mercury koristi 24-bitne boje kada terminal oglasi podršku preko `COLORTERM=truecolor` ili je prepoznat kao iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal ili VS Code. Ostali terminali koriste 256 boja, uključujući Apple-ov Terminal na macOS-u 15 i starijim.

Red Terminal color u provjeri stanja prijavljuje otkrivenu dubinu boja i razlog. Postavite `MERCURY_TRUECOLOR=1` za terminal koji podržava prave boje, ali to ne oglašava, ili `MERCURY_TRUECOLOR=0` da prisilite 256 boja.

### Opcionalne komponente

`setup` preuzima ugrađene pakete mogućnosti: pyright, debugpy, js-debug, dodatne gramatike, Node izvršno okruženje za platformu i brush. Ako preuzimanje ne uspije, taj paket se preskače, a izgradnja i pogođeni alati prijavljuju nedostajuću komponentu. Samo pokretanje `bun install` daje izgradnju bez tih paketa.

Da biste izgradili podršku za glas, pokrenite `setup` s instaliranim Rust-om. To gradi `native/voice`. Dodajte cmake da izgradite i `native/whisper`. Uz instalirani Rust, `setup` takođe gradi dodatak drajvera za desktop (`native/desktop`) kroz koji radi alat `Computer`. Uz instalirani Rust, `setup` takođe gradi lokalni dodatak za embedding (`native/embed`, `bun run scripts/vendor/build-embed.ts`) i preuzima BGE model od 118 MB (`bun run scripts/vendor/fetch-embed-models.ts --default`); bez cargo-a paket se preskače, setup to kaže, a pretraga Mneme memorije radi samo na poklapanju riječi. Svaka arhiva izdanja sadrži embedding paket izgrađen za njenu platformu; na Linux-u i Windows-u računanje izvršava vektorizovani kernel, pa Recall po značenju traje otprilike desetinu sekunde (nekoliko stotinki na macOS-u, koji koristi Accelerate). Ako nativnoj izgradnji nedostaju potrebni alati, setup je preskače, a provjera stanja prijavljuje nedostajući dodatak. Shell engine za Windows se takođe kompajlira na vašoj mašini, jer upstream nema Windows binarnu datoteku.

Pogledajte [Windows ljuske](#windows-ljuske) i [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) za shell engine `brush`.

Izgradnja piše samo u `dist/`. Konfiguracija i sesije nalaze se u `~/.mercury`, ili u direktoriju koji postavlja `MERCURY_CONFIG_DIR`, i kreiraju se pri prvom pokretanju. Na Windows-u pokrenite direktno `node dist\mercury.mjs`.

### Instaliranje izgradnje iz izvornog koda kao naredbe

`scripts/ops/deploy-runtime.sh` objavljuje izgradnju iz čistog stabla u novi direktorij `<config home>/runtime/builds/<build>` i usmjerava `runtime/current` na njega (`runtime/dist` je stariji naziv za istu vezu). `scripts/ops/deploy-launcher.sh` instalira launcher u `<config home>/bin/mercury`. Dodajte taj direktorij u PATH; za zsh:

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

Launcher se zaustavlja s greškom ako izvršno okruženje nedostaje. Ne prebacuje se na drugu izgradnju. Izbor Node-a slijedi redoslijed opisan u [Zahtjevi](#zahtjevi). Za instalaciju izdanja pokrenite `mercury install` ili `mercury update`, koje ostavljaju izvorne kopije nepromijenjenima; pogledajte [Ažuriranja](#ažuriranja).

[AGENTS.md](../../AGENTS.md) je kratki vodič za izgradnju i pokretanje. [BUILD-NOTES.md](../../BUILD-NOTES.md) detaljnije opisuje izgradnju.

## Prvo pokretanje

Pri prvom interaktivnom pokretanju odaberite izgled, zatim se prijavite kod dobavljača. Ekran pregleda promjene teme dok pregledate opcije. True Black je podrazumijevani; ostale opcije su tema oasis dark i Black and white, koja uopšte ne boji: boja teksta terminala na njegovoj vlastitoj pozadini, kako Mercury izgleda na terminalu bez boja. Ovo možete promijeniti kasnije pomoću `/appearance`.

Takođe možete odabrati „sign in later” da pogledate bez povezivanja naloga. Kada ključ dobavljača u vašem okruženju već prijavi dobavljača, korak prijave se ne nudi. Zatim korak Guardrails podsjeća da provjerite Mercury-jeve izmjene i naredbe, te da sadržaj koji čita može sadržavati instrukcije za model. U terminalu koji Mercury zna da konfiguriše (Terminal.app, porodica VS Code, Alacritty, Zed), korak Terminal keys može konfigurisati prečice za novi red u postavkama samog terminala (na macOS-u, u Terminal.app, postavlja `Option+Enter` za novi red i utišava zvono terminala u svim profilima, što stupa na snagu nakon ponovnog pokretanja Terminal.app-a; u porodici VS Code, Alacritty i Zed upisuje `Shift+Enter` za novi red). Isključen je dok ga ne odaberete, a čuva se rezervna kopija.

Zatim vas Mercury pita da li vjerujete direktoriju koji ste otvorili. Ništa što zatraži konfiguracija radnog prostora ne pokreće se prije nego što dodijelite to povjerenje. Dodjela obuhvata cijeli repozitorij; odbijanje zatvara Mercury. Pogledajte [docs/TRUST.md](../TRUST.md).

Uobičajeno interaktivno pokretanje otvara početni ekran. Ima deset stavki menija, pri čemu se Continue Last Session pojavljuje tek kada imate historiju sesija:

- **New Session in \<folder\>** pokreće novu sesiju u trenutnom direktoriju.
- **Continue Last Session** vraća vas u posljednji razgovor.
- **Boot Menu** konfiguriše buduće sesije, uključujući motion, crewmates i workflows.
- **MCPs & Skills** bira šta će sljedeća sesija učitati. Pogledajte [docs/KIT.md](../KIT.md).
- **Agents** kreira i uređuje agente.
- **Health Check** provjerava instalaciju.
- **Saturn Scheduler** zakazuje sesije. Pogledajte [docs/SATURN.md](../SATURN.md).
- **Logins** povezuje naloge dobavljača.
- **Session Concourse** otvara listu sesija tekućeg projekta.
- **Sessions · Projects** omogućava da odaberete sesiju ili repozitorij.

Stavke menija otvaraju se preko početnog ekrana, a `Esc` vas vraća na stavku koju ste odabrali. Lista sesija otvara se na zasebnom ekranu, dostupnom i pomoću `Shift+→`. Argument prompta, `--continue` ili `--resume` vode vas direktno do razgovora.

### Motion, crewmates i workflows

Odjeljak Performance u Boot Menu-ju sadrži postavku Motion: `auto`, `full`, `reduced` ili `off`. Ona upravlja animacijom u mirovanju u interfejsu i dostupna je i u `/config`.

Pod Agents, prekidači Crewmates i Workflows određuju da li nove sesije dobijaju alate Crewmate i Workflow. Isključivanje prekidača uklanja odgovarajući alat; pokušaji pokretanja te vrste posla vraćaju isto objašnjenje. Unutar sesije, `/crewmates on|off` i `/workflows on|off` mijenjaju postavku na početku sljedeće ture (turn).

## Svakodnevni tok: Session Concourse, git worktree-ovi i crewmate-ovi

### Pokretanje sesije i izolovanje worktree-ova

Pritisnite `Enter` na New Session da kreirate sesiju u trenutnom direktoriju s podrazumijevanim modelom. Mercury otvara svoj razgovor i istovremeno ga dodaje na listu sesija. Iza menija drži spreman proces kako bi smanjio posao pri pokretanju.

Pokretanje druge sesije ne zaustavlja prethodnu. Možete ostaviti zadatak da radi i raditi negdje drugo. Pokrenite s `--worktree [name]` (ili zatražite `worktree` u razgovoru da se izvrši `EnterWorktree`) da bi sesija dobila vlastitu granu i kopiju pod `.mercury/worktrees/`. Paralelni crewmate-ovi takođe mogu raditi u izolovanim worktree-ovima i koordinisati zajedničke datoteke pomoću zakupa datoteka projekta; pogledajte [Šta sadrži](#šta-sadrži-mneme-rag-memorija-lsp-ast-za-23-jezika-dap-debugger-pretraga-weba-i-mostovi) i [docs/CREW.md](../CREW.md).

### Rad u razgovoru

Opišite posao običnim jezikom. Agent čita, uređuje, pokreće i provjerava kod u skladu s odabranim načinom dozvola. Pozivi alata pojavljuju se dok se izvršavaju, bilo kao kompaktne kartice ili s punim izlazom. Prikaz odaberite u `/config`, pod Tool output; postavka se čuva za naredna pokretanja.

Koristite `/model` i `/effort` za podešavanje sesije. `/permissions` kontroliše šta može da se izvrši bez odobrenja, a šta mora prvo da pita.

Pregledajte izmjene pomoću `/diff`, po izvoru, datoteci i hunku. `! <command>` pokreće shell naredbu u razgovoru uz prikaz posljednjih redova izlaza uživo. `/runs` prikazuje aktivne shell-ove i crewmate-ove (`/tasks` otvara istu tablu), a `/crewmates` otvara prikaz Crew uživo. Između tura, `/clear` čuva trenutni razgovor i otvara novu sesiju, a `/restart` prebacuje razgovor na novoinstaliranu verziju Mercury-ja. `/title` imenuje razgovor, a `/help` navodi dostupne naredbe.

### Kretanje između ekrana

`Shift+←` i `Shift+→` prelaze između ekrana koji su trenutno dostupni. Novo pokretanje ima početni ekran i listu sesija. Ekran razgovora dodaje se kada je sesija u fokusu, a uklanja se kada se zatvori posljednji razgovor. Savjeti o tipkama prikazuju samo dostupna kretanja.

Zatvaranje svih razgovora vraća vas na početni ekran. Koristite `--chat` za samo početni ekran i razgovor, bez liste sesija. `--concourse-off` čuva tu postavku za buduća pokretanja; `--concourse-on` ili `/config` je ponovo uključuje.

### Upravljanje sesijama u Session Concourse-u

Listu sesija otvorite pomoću `/concourse` ili `Shift+→` s početnog ekrana. Prvo prikazuje aktivne sesije tekućeg projekta, a zatim sačuvane razgovore koji nisu aktivni, od najnovijeg.

Svaka aktivna sesija ima ćeliju NOW koja prikazuje njenu trenutnu aktivnost. Odaberite red i pritisnite `Enter` da se vratite u razgovor, dok ostale sesije nastavljaju da rade. Sesija koja je pala ostaje na listi kao NEEDS YOU, s razlogom, dok je ne oslobodite.

[docs/SESSIONS.md](../SESSIONS.md) pokriva životni ciklus sesija.

## Dobavljači i modeli: prijave, `/localsetup` i `/llmhost`

Koristite `/logins` da povežete dobavljača. Otvara se isti katalog prijava kao i tokom podešavanja. `/accounts` kasnije upravlja povezanim slotovima dobavljača.

- **OpenAI:** pretplata ChatGPT ili API ključ.
- **Anthropic:** pretplata Claude, prijava u Console ili API ključ.
- **OpenRouter:** pristup katalogu preko OAuth-a ili API ključa; zahtjevi za modele odbijaju prikupljanje podataka i od početka traže svaki parametar. `/config → OpenRouter routing policy` postavlja izbore rezervnog dobavljača i nečuvanja podataka; odaberite open da olabavite politiku i prepustite usmjeravanje OpenRouter-u.
- **Google Gemini:** Sign in with Google, API ključ ili vlastiti OAuth klijent. Sign in with Google pokreće Gemini na kvoti plana koji ima Google nalog (besplatni nalog, Google AI Pro ili Google AI Ultra) preko Googleovog klijenta Antigravity: prompt, šeme alata i rezultati alata šalju se Googleovoj Code Assist krajnjoj tački pod tim klijentom i prijavljenim nalogom, a `/model` prikazuje listu modela koje Google nudi nalogu. API ključ ili vlastiti OAuth klijent umjesto toga naplaćuju Cloud projekat.
- **Hugging Face:** prijava uređajnim kodom ili Hub token.
- **Kimi (Moonshot):** prijava uređajnim kodom ili API ključ.
- **GLM (Z.AI):** ključ GLM Coding Plan pretplate ili opšti API ključ s plaćanjem po upotrebi. `/logins zai` čuva bilo koji od njih i bilježi plan; `ZAI_API_KEY` takođe radi, a `ZAI_KEY_PLAN=coding|general` imenuje plan (ako nije postavljen, Mercury ga čita iz liste modela samog ključa).
- **DeepSeek:** API ključ s DeepSeek platforme (`/logins deepseek` ili `DEEPSEEK_API_KEY`).
- **xAI (Grok):** prijavite se svojom Grok pretplatom (SuperGrok / X Premium) ili nalijepite API ključ preko `/logins xai`.
- **Meta (Muse):** Sign in with Meta (pretplata Muse Code, kod uređaja u pregledniku) ili Model API ključ s plaćanjem po upotrebi. Sign in with Meta razmjenjuje kod uređaja s Meta OIDC krajnjim tačkama (`https://auth.meta.com/oidc/device/authorization/` i `/oidc/device/token/`) pod javnim identifikatorom klijenta Muse Code, jednom šalje dobijeni token naloga na `https://api.meta.ai/muse-code/key` da kreira API ključ pretplate (i na ograničena čitanja `/usage` za nivo plana i prozore korištenja), a na svaki zahtjev za model prema `https://api.meta.ai/v1` šalje samo kreirani ključ. Nalijepljeni Model API ključ ili `MODEL_API_KEY` / `META_API_KEY` naplaćuju se po upotrebi.

- **Qwen:** ključ QwenCloud (Token Plan ili plaćanje po upotrebi) ili ključ Alibaba Cloud Model Studio (plaćanje po upotrebi, Token Plan ili Coding Plan), provjeren na vlastitoj krajnjoj tački prije pohranjivanja; ključ plana navodi modele tog plana, a Qwen3.8 Max je prvi.
- **MiniMax:** ključ Open Platform ili ključ pretplate M Plan.
- **Together AI** i **Cohere:** API ključ.
- **Groq**, **Cerebras** i **Fireworks AI:** API ključ; ključ svake porodice može doći i iz naredbe navedene u `credentials.keyCommands.<family>`.

Mistral, Nous Portal i OpenCode Zen takođe se povezuju preko `/logins`, što čini ukupno 22 porodica dobavljača za prijavu. Lokalni serveri modela (Ollama, LM Studio, vLLM i llama.cpp) i prilagođene krajnje tačke kompatibilne s OpenAI rade bez prijave kod dobavljača. Pokrenite `/localsetup` da instalirate ili pokrenete Ollamu, preuzmete model koji staje u vašu memoriju, podesite njegov prozor konteksta ili povežete pokrenuti LM Studio, vLLM ili llama.cpp server ([docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)). Svaki dobavljač koristi vlastiti protokol, vjerodajnice i obradu grešaka, a zahtjevi nikada ne prelaze na drugog dobavljača. Pogledajte [docs/ENGINES.md](../ENGINES.md).

`/llmhost` navodi modele koje možete hostovati i pokazuje gdje svaki od njih može raditi u ovom trenutku: na GPU-u iznajmljenom kod Runpod-a, Vast.ai-ja ili Lambda-e, na vašem računaru ili sačuvanom SSH računaru (`mercury host`), ili na postojećem serveru modela. Svaka stranica modela prikazuje opcije kvantizacije, kako se budžet GPU memorije dijeli među paralelnim razgovorima (`conversations × context`) i podrazumijevani nivo razmišljanja (koji `/effort` mijenja po zahtjevu). Iznajmljivanje GPU-a zahtijeva izričitu potvrdu satne cijene, a podešavanje se nastavlja u pozadini ako zatvorite iskačući prozor. Na Runpod-u takođe možete podesiti kvalitet, raspodjelu konteksta i razmišljanje prije iznajmljivanja ili na pokrenutom podu (`Tune`), držati težine na volumenu za brzo učitavanje i postaviti praćenje zaliha na svakih 5 sekundi. Iznajmljivanja na Vast.ai i Lambda nova su u 1.0.0-beta.40 i provjerena su prema objavljenim API-jima dobavljača na fiksturama (iznajmljivanja uživo nisu izvedena). Pogledajte [docs/LLM-HOST.md](../LLM-HOST.md).

Nove sesije koriste dobavljača kojeg ste najnovije povezali i najnoviji model dostupan tom nalogu. Modeli kojima nalog nema pristup se preskaču. Ako taj dobavljač nema nijedan upotrebljiv model, Mercury provjerava sljedećeg dobavljača koji je najnovije povezan. Ovaj izbor se dešava pri pokretanju sesije; neuspjeli zahtjev u postojećoj sesiji ostaje kod svog dobavljača.

`/model` objašnjava izbor. Naziv porodice bira najnoviji model te porodice: `/model grok`, `/model deepseek`, `/model kimi` ili `/model glm`. Bez povezanog dobavljača, početni ekran i `/model` upućuju na `/logins`. `/defaultprovider` vam omogućava da izričito odredite dobavljača kao posljednji izbor.

Pristup dobavljačima i dalje zavisi od njihovih vlastitih uslova i dostupnosti. Mercury-jeva licenca ih ne zamjenjuje.

## CLI bez interfejsa: `mercury run`, Docker i JSON-RPC runner

Ista izgradnja radi bez interaktivnog interfejsa. `node dist/mercury.mjs --help` navodi sve zastavice.

`mercury run "<prompt>"` pokreće prompt bez terminalnog interfejsa:

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` ispisuje odgovor; razlog neuspjele ture ide na stderr.
- `json` ispisuje posljednji red `outcome` kao jedan JSON objekat.
- `rows` zapisuje po jedan JSON objekat po redu: `session`, zatim `turn` i njegovi redovi `text`, `reasoning`, `tool_call`, `tool_result` i `step`, koji se završavaju s `outcome`. Čekanja, napredak alata, zadaci u pozadini i obavještenja imaju svoje redove. Svaki red nosi `seq`, `timestamp` i `session_id`; redovi unutar ture nose i njen broj `turn`. `seq` numeriše tok ovog pokretanja od 1; `turn` broji ture sesije, pa pokretanje koje nastavlja sačuvani razgovor (`-c`, `-r`, `--fork`) numeriše svoju turu nakon tura koje su već u njemu, a njegov red `session` u `resume_of` imenuje razgovor koji nastavlja.

Vrste redova izlaza, prema polju `type`:

- `session`: red otvaranja: `version`, `build` (prvih dvanaest heksadecimalnih znakova stabla iz kojeg je bundle izgrađen, kako ih ispisuje `mercury daemon status`; izostaje kada pored bundle-a nema manifesta), `resume_of` (u nastavljenom pokretanju, ID sesije razgovora koji nastavlja; isti kao `session_id`, osim ako je pokretanje bilo forkovano), `cwd`, `model`, `mode`, `tools`, `mcp_servers`, `commands`, `agents`, `skills` i `extensions` koje sesija ima, te `tools_withheld` (prisutan kada pravilo odbijanja uskraćuje alat po njegovom golom imenu: svaki unos ima `tool`, `rule` i `source`).
- `turn`: tura u stanju `started` ili `waiting`, s njenim `turn_id`; `model`, `message_ids` i broj `agents` kada je poznat.
- `text`: ustaljen tekstualni blok: `message_id`, `block`, `text` i njegova `phase` (`commentary` ili `final_answer`).
- `reasoning`: ustaljen blok razmišljanja: `message_id`, `block`, `text`, ili `redacted: true`.
- `tool_call`: poziv alata: `call_id`, `tool`, `input`, s njegovim `message_id` i `block`.
- `tool_result`: rezultat poziva: `call_id`, `status` (`ok`, `error`, `aborted` ili `refused`) i `output`. Poziv koji je model oblikovao toliko loše da je odbijen prije izvršavanja (nepoznat alat, argumenti koji nisu ispravan JSON ili ne odgovaraju šemi alata) i dalje dobija svoj par: red `tool_call` s argumentima kako su isporučeni (`{}` kada nisu bili objekat) i red `tool_result` sa statusom `refused`, čiji `output` navodi razlog; slijedi `notice` s ispravkom. Takav poziv nikada nije izvršen i nije odbijanje.
- `tool_update`: napredak pokrenutog alata: `call_id`, `tick`, `source` (`shell`, `powershell`, `mcp` ili `eval`), te bilo koje od polja `line`, `elapsed_s`, `lines`, `bytes`, `budget_ms`, `progress` i `total` koja poziv prijavi. Poziv shell-a ili PowerShell-a šalje tick dok njegov izlaz stiže (naredba koja ništa ne ispisuje nikada ne šalje tick), MCP poziv kada njegov server prijavi napredak, a Eval poziv dok njegova ćelija radi. Nijedan drugi alat ne šalje tick-ove; poziv Browser-a ili Crewmate-a ćuti do rezultata.
- `step`: jedan poziv modela glavne niti: `message_id`, `model`, `usage`, i `stop` kada je model rekao zašto se zaustavio.
- `outcome`: rezultat ture, opisan u nastavku.
- `close`: bilješka ostavljena sljedećoj sesiji pri zatvaranju: `state` (`stored`, `skipped` ili `none`), `note_chars` i `usage` poziva modela koji su je napisali, tako da čitalac koji zbraja potrošnju svih redova dolazi do one iz rezultata ture. Kada je prompt zadan kao argument, bilješka se traži unutar posljednje ture i `close` prethodi `outcome`-u te ture; uz `--input rows` slijedi posljednji `outcome` kada se stdin zatvori.
- `wait`: čekanje na model: `state` (`first_byte`, `retry`, `silence`, `loading` ili `done`) s vrijednostima koje to stanje nosi, kao što su `since_ms`, `attempt` i `of`, `delay_ms`, `reason` i `http_status`.
- `heartbeat`: tok modela je pokazao život nakon najmanje jedne sekunde bez obrađenog događaja: stigli su bajtovi koji nisu proizveli nijedan red. Red ne nosi ništa drugo i dolazi najviše jednom u sekundi; koliko često zavisi od oblika strimovanja dobavljača, pa tok koji nikada ne pravi pauzu između događaja ne šalje nijedan.
- `compaction`: sažimanje u stanju `started`, `progress` ili `ended`: `trigger` (`manual`, `auto` ili `overflow`), `stage`, `fill`, `summary_tokens` i, na kraju, `exit` (`landed`, `cancelled` ili `failed`).
- `mode`: promijenjen je način dozvola: `mode`.
- `rate_limit`: stanje ograničenja dobavljača: `status` (`allowed`, `warning` ili `rejected`), `window`, `resets_at`, `utilization` i polja prekoračenja.
- `task`: zadatak u pozadini u stanju `started`, `progress` ili `ended`: `task_id`, `task_type`, `description`, `usage`, `summary`, `status` (`completed`, `failed` ili `stopped`) i `output_file` kako postanu poznati.
- `notice`: upozorenje `warning` ili greška `error` za čitaoca: `text`, i `code`, kao što je `input_refused`.
- `command_output`: izlaz slash naredbe koja nikada nije stigla do modela: `command` i `text`.
- `mission_updated`: evidencija zadataka sesije se promijenila; pročitajte je ponovo.
- `samples_updated`: uzorci sesije su se promijenili; pročitajte ih ponovo.

`--partial` uz `--format rows` dodaje redove `block_start`, `text_delta`, `reasoning_delta`, `tool_input_delta` i `retracted`. Delte pripadaju `message_id` i `block`; red `retracted` povlači delte te poruke. Ustaljeni red teksta ili alata je potpuna vrijednost.

Rezultat sadrži `schema`, `turn_id`, `status`, `steps`, `wall_ms`, `usage`, `models` i `denials`, s `answer` pri završetku i `error` (`message`, `class`, opciono `detail`) pri neuspjehu. `stop`, `api_ms`, `cost_usd`, traženi `structured` izlaz i `notices` uključeni su kada su dostupni. `wall_ms` je proteklo vrijeme ture. `api_ms` je zbir trajanja svakog zahtjeva modelu koji je tura napravila (uključujući ponovne pokušaje i zahtjeve crewmate-ova koji su radili uporedo s glavnom niti), pa može biti veći od `wall_ms` kada su se zahtjevi preklapali. `cost_usd` je iznos u USD za zaračunate zahtjeve ture, bez obzira na status: zahtjev koji Mercury ne može da cijeni (nema cijene u zapisu, nema navedenog troška u odgovoru) ništa ne dodaje tom iznosu i ostavlja svoj model na listi `models` bez vlastitog `cost_usd`; polje izostaje samo kada ništa u turi nije bilo zaračunato. Pri prijavi pretplatom Claude, Anthropic zahtjevi nemaju cijenu u dolarima, pa ni oni ni red ne nose `cost_usd`; potrošnja ostaje. Potrošnja navodi `input_tokens` (uključujući keširane tokene), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` i, kada se prijavi, `reasoning_output_tokens`, zbrojeno za glavnu nit i crewmate-ove. `models` raščlanjuje potrošnju tokena po modelu. `steps` broji samo pozive modela glavnog agenta; pozivi modela koje prave crewmate-ovi pojavljuju se kao njihovi vlastiti redovi `step`, označeni s `parent_call_id`.

Status je `completed`, `blocked`, `refused`, `failed`, `interrupted`, `turn_limit`, `budget_limit`, `time_limit`, `schema_unmet` ili `loop_stopped`. Pokretanje pod `--max-time` (u sekundama, ili `10m`, `1h`) završava se statusom `time_limit` na sljedećem koraku kada istekne vrijeme; poziv modela ili runda alata koja je u toku se ne prekida. Završeno pokretanje izlazi s kodom 0, ostali ishodi s kodom 1, a greška pri upotrebi s kodom 2. SIGINT i SIGTERM izlaze s kodovima 130 i 143 nakon što se ishod prekinute ture upiše. Odbijen poziv alata navodi se u `denials`. Kada je odbijanje bilo pitanje na koje niko nije mogao da odgovori (pokretanje bez hosta u načinu koji pita, `--mode dontAsk`, ili pitanje hosta koje je isteklo) i nijedan kasniji poziv alata u turi ne uspije, pokretanje ima status `blocked`: odgovor se čuva, `error` imenuje alat i način nastavka (`--allowed-tools`, drugi `--mode` ili host koji odgovara na pitanja), a pokretanje izlazi s kodom 1. Ako kasniji poziv alata u istoj turi uspije, tura se oporavlja i završava kao `completed` (kod 0) uz upozorenje `notice` (`"<Tool> was not approved; the run continued with other tools."`). Odbijanje na koje ste odgovorili (preko pravila odbijanja, hook-a ili hosta koji je rekao ne) ostavlja završenu turu završenom. Neodgovoreni poziv `AskUserQuestion` takođe završava pokretanje kao `blocked`, a pitanje se navodi u `error`; Mercury čita ishod iz zabilježenih pitanja pokretanja, nikada iz teksta odgovora, pa pitanje napisano samo u odgovoru završava kao `completed`. Nepoznata slash naredba ima status `refused` s istom rečenicom koju daje interaktivni ekran (`Unknown command: /name · /help lists commands`) i izlazi s kodom 1.

`--input rows` zahtijeva `--format rows` i čita po jedan ulazni objekat po redu:

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

Vrste ulaza su `prompt` s `content` (tekstualni ili tekst/slika blokovi), `shell` s `command` i `note` s `to` (ID agenta) i `content`. Svaka prima opcionalni `id`; redovi prompt i shell takođe primaju `priority` (`now`, `next` ili `later`), `sent_at` i `origin`. Odbijen oblik ulaza proizvodi `notice` s kodom `input_refused`; neispravan JSON prekida pokretanje. Ovi redovi nose samo ulaz; odgovori na dozvole koriste protokol runnera opisan u nastavku.

Upotrijebite `mercury run -` ili proslijedite tekst u `mercury run` putem cjevovoda (pipe) da bi se cijeli prompt pročitao sa stdin-a. Uz argument prompta, tekst iz cjevovoda se dodaje kao ograničen kontekst: cjevovod se čita dok se ne zatvori ili dok jednu sekundu ne ćuti, pa se tok koji i dalje isporučuje čita do kraja, a cjevovod koji ostane otvoren i tih ne zadržava pokretanje. Bez prompta i uz terminal na stdin-u, `run` ispisuje svoju upotrebu i izlazi s kodom 2.

`--mode <mode>` bira način dozvola. `--sovereign` radi bez upita za dozvole, a `--allow-sovereign` čini taj način dostupnim za kasnije prebacivanje. Politika dozvola i pravila odbijanja i dalje važe. Korisnik root koji ulazi u sovereign način dobija jedno obavještenje na stderr; pokretanje se nastavlja.

Koristite `-c` da nastavite najnoviji razgovor, `-r` da nastavite po ID-u, naslovu ili izboru, `-w` da radite u upravljanom worktree-u, a `--lean` za minimalnu sesiju. `run` nema host koji bi odgovarao na zahtjeve za dozvole: o tome šta može da se izvrši odlučuju njegova pravila dozvola i način rada, a poziv kojem je i dalje potrebno odobrenje biva odbijen.

### Slika bez interfejsa

`Dockerfile` u korijenu repozitorija gradi Linux x64 sliku za CI i servere. Njena ulazna tačka je `mercury`, a podrazumijevana komanda `run`, pa slika pokreće jedan prompt nad montiranim stablom i izlazi s kodom pokretanja:

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

Slika sadrži bundle, njegovo Node 24 izvršno okruženje (na `PATH`-u), ugrađene alate za pretragu, shell, debugiranje, jezike i slike, `git` i skladište certifikata; nema ekrana za unos niti toka prijave. Pokreće se kao korisnik bez root prava `mercury`, s matičnim direktorijem konfiguracije unutar kontejnera (`MERCURY_CONFIG_DIR`), a `/work` je njen radni direktorij. Boje i miš prate vlastitu detekciju terminala proizvoda, a `--user 0` pokreće kao root uz jedno sovereign obavještenje opisano iznad.

Ključ dobavljača stiže kao varijabla okruženja, s istim pisanjem koje proizvod svuda čita: `ANTHROPIC_API_KEY` ili `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` ili `GOOGLE_API_KEY`, `XAI_API_KEY` (i `XAI_MANAGEMENT_API_KEY` za njegov brojač potrošnje), `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY` (i `MISTRAL_ADMIN_API_KEY` za njegov brojač organizacije), `NOUS_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`, `TOGETHER_API_KEY` ili `TOGETHER_AI_API_KEY`, `COHERE_API_KEY` ili `CO_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `DASHSCOPE_API_KEY`, `MODEL_API_KEY` ili `META_API_KEY`, `MERCURY_COMPAT_API_KEY` za prilagođenu krajnju tačku kompatibilnu s OpenAI i `MERCURY_LOCAL_API_KEY` za lokalni server. Bez ključa, pokretanje odbija u jednoj liniji i izlazi s kodom 1. `docker run -i … mercury run -` čita prompt sa stdin-a.

### Hostovanje sesije

`mercury runner` služi sesiju hostu preko stdio-a: JSON-RPC 2.0, jedna poruka po redu. Host prvo šalje `initialize` i čeka odgovor prije nego što pošalje posao:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

Ime i verzija hosta prenose se pod `host`; `capabilities` deklariše `holds_asks`, `elicitation` i `partial_rows`. Svaki `id` zahtjeva je pozitivan cijeli broj: zahtjev čiji je `id` bilo šta drugo dobija odgovor `-32600` uz `id: null`, zato brojite zahtjeve od 1.

`queue/add` prihvata isti objekat prompta, shell-a ili note kao ulazni redovi iznad. Izlaz stiže u `row` notifikacijama. `session/facts` čita stanje sesije; `session/set_mode` odmah mijenja način dozvola; `session/set_model` i `session/set_effort` mijenjaju model i napor, a promjena napravljena dok tura radi zadržava se do kraja ture: odgovara s `at: "turn_end"`, pa `session/applied` to objavljuje. `turn/interrupt` zaustavlja turu; zatvorite stdin da završite sesiju.

Zahtjevi za dozvole stižu kao `permission/request`, s `kind: "tool"` ili `kind: "network"`. Host odgovara s `outcome: "allow"` ili `outcome: "deny"`; allow može nositi izmijenjen `input` i `rules` dozvola. Povučen zahtjev šalje `$/cancel_request` s njegovim `request_id`. `holds_asks` daje hostu vlasništvo nad satom zahtjeva. MCP pitanje koristi `elicitation/request` samo kada host deklariše `elicitation`; inače se na njega odgovara s `cancel`.

Nepoznata metoda dobija odgovor `-32601`, neispravni parametri `-32602`, `id` koji nije pozitivan cijeli broj `-32600`, a zahtjev prije inicijalizacije `-32002`. Odbijanje pravilom je `-32010`, s rečenicom u `error.message` i razlogom u `error.data.kind`, kao što su `mode`, `model`, `effort` ili `claim`. Runner odgovara na neispravan red s `-32700` i nastavlja; tri uzastopna neispravna reda ga prekidaju.

### Ostale naredbe

Dostupne naredbe uključuju:

- **`mercury health`**: dijagnostički izvještaj, nazvan i certifikat stanja. `--json` vraća cijeli izvještaj, `--deep` pokreće dubinski pregled, a `--fix` pokreće vođene popravke.
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**: prijava (`login [<family>]`), prikaz porodica dobavljača (`list`), provjera da li je nalog prijavljen (`status [<family>]`), odjava (`logout [<family>]`) ili kreiranje dugotrajnog Anthropic tokena (`mint`).
- **`mercury models [--json]`**: ispisuje modele kojima prijavljeni nalozi imaju pristup (iste činjenice kao `mercury://models`).
- **`mercury mcp`**: upravlja MCP serverima pomoću `add`, `import`, `list`, `get`, `remove`, `trust-reset` i `serve`.
- **`mercury extensions`**: instalira ekstenzije i upravlja njihovim izvorima. Radnje: `list`, `sources`, `add`, `remove`, `refresh`, `install`, `trust`, `enable`, `disable`, `update`, `uninstall`, `fence`, `unfence`, `inspect` i `scaffold`.
- **`mercury roster`**: ispisuje inventar agenata.
- **`mercury usage`**: ispisuje kompaktnu liniju s brojkama koju prikazuje ekran `/usage`; `--json` ispisuje cijelo očitavanje: prozore svakog prijavljenog dobavljača s iskorištenim i resetom, brojke i kredite koje je naveo, svaki sa svojim izvorom i starošću, te potrošnju sesije po modelu, očitanu onako kako je očitava ekran (čitač svakog prijavljenog dobavljača uzorkuje se jednom, kao pri otvaranju).
- **`mercury daemon run|status|stop|restart`**: pokreće, provjerava, zaustavlja ili ponovo pokreće daemon u pozadini. Njegova mjesta za sesije su podređeni procesi `mercury runner`; daemon šalje njihove promptove i hostuje njihove zahtjeve za dozvole.
- **`mercury sessions list`** (takođe samo `mercury sessions`): ispisuje sačuvane sesije ovog projekta, od najnovije: ID, vrijeme posljednjeg upisa, veličinu, `live` kada ih daemon sada hostuje, te naslov ili prvi prompt; `--all` čita sve projekte, a `--limit <n>` ograničava listu. ID je ono što `mercury --resume <id>` ponovo otvara, a `sessions delete` uklanja.
- **`mercury sessions delete <id>`**: namjerno briše jednu sačuvanu sesiju — njen transkript i zapise uz nju (potvrde, snimak za nastavak) — nakon pitanja; `--yes` preskače pitanje za skripte. Sesija koju daemon sada hostuje se odbija, a nepoznat ID se odbija uz savjet da pogledate inventar (`/sessions` unutar Mercury-ja). Sačuvane sesije se inače nikada ne brišu same od sebe.
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**: pokreće lokalni ili SSH računar kao server modela za sve sesije koje dijele matični direktorij konfiguracije (`compat/box-<name>/<model>`), koristeći provjeren lokalni skup težina ili potvrđeno preuzimanje. Pogledajte [docs/LLM-HOST.md](../LLM-HOST.md).
- **`mercury lsp list`** i **`mercury lsp install <server>`**: katalog jezičkih servera; svaki server je instaliran (s binarnom datotekom) ili nedostaje (s uputstvom za instalaciju). `install` prikazuje uputstvo za server, pita, izvršava upravo to (`--yes` preskače pitanje za skripte) i javlja gdje je binarna datoteka smještena. Nepoznat server se odbija uz listu znanih servera. Mercury nikada sam ne instalira jezički server; otvaranje datoteke pokreće samo server koji je već instaliran.
- **`mercury acp`**: služi editoru preko Agent Client Protocol-a, s podređenim runnerom za svaku sesiju. `mercury bridge install` instalira ekstenziju za VS Code; `mercury bridge status` je provjerava; `mercury bridge uninstall` je uklanja.
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**: upravlja poslovima engine-a za Godot projekat u trenutnom direktoriju. Mercury pokreće skupove testova na vlastitim radnicima bez interfejsa, iz zamrznute kopije projekta. Usluga obuhvata kontrolnu tačku za kompilaciju, snimke, statistiku kadrova, ustaljene profile, pristup redu poslova, otkazivanje i rezultate po ID-u. Pogledajte [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md).
- **`mercury image <image>`**: prikazuje sliku u terminalu.
- **`mercury install`** i **`mercury update`** (alias `upgrade`): instaliraju ili ažuriraju arhive izdanja; uz `--json` dokument je na stdout-u bez obzira na ishod, a izlazni kod pokazuje da li je došlo do greške. Pogledajte [Instalacija](#instalacija).
- **`mercury version`** i **`mercury help [command]`**: ispisuju liniju verzije ili stranicu pomoći, isto kao `--version` i `--help`; nijedno od njih ne pokreće sesiju.

## Šta sadrži: Mneme RAG memorija, LSP, AST za 23 jezika, DAP debugger, pretraga weba i mostovi

- **Hibridna RAG memorija projekta Mneme.** Mneme je podrazumijevano uključena i čuva činjenice svakog projekta na običnim markdown stranicama tema (`Retain`, `Recall`, `Reflect`, `Correct`). Recall spaja semantički embedding model BGE od 118 MB koji radi na uređaju (`bge-base-en-v1.5` `q8_0`, MIT, uključen u svaku arhivu izdanja i izgrađen za njenu platformu; pogledajte [Opcionalne komponente](#opcionalne-komponente)) s rangiranjem riječi BM25 uz korijenovanje (stemming), ponderisanjem po svježini i praćenjem citata putem recipročne fuzije rangova (`k = 60`). Zakačena pravila (`pin: true`) učitavaju se doslovno na zakačenu policu i mijenjaju se samo na vašu riječ. Pri pokretanju sesije, Mercury boduje nezakačene činjenice i ranije bilješke prema vašoj trenutnoj grani, nedavno dirnutim datotekama i bilješci za predaju posljednje sesije, u okviru posebnog početnog budžeta (`memory.startLimit`, podrazumijevano 4.000 znakova). Provjere proturječnosti u trenutku upisa hvataju promjene polariteta, negacije i brojeva prije nego što se sukobljena činjenica sačuva. Svaka sesija pri izlasku piše bilješku za predaju vlastitim riječima za ulaznu stranicu sljedeće sesije, uz opcioni unos u dnevnik sesije. `/memory` otvara centar memorije, a `/memory page` iscrtava biblioteku u vašem pregledniku kao graf čvorova i veza. Pogledajte [docs/MNEME.md](../MNEME.md).
- **LSP inteligencija koda, prepisivanja AST-a za 23 jezika, DAP debugger i `Eval` ćelije.** Čitanja sa sidrima i atomične izmjene više datoteka (`ChangeSet`); upiti ka jezičkom serveru (`LspRead`) i refaktoriranja s pregledom pa primjenom (`LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`); pretraga i prepisivanje stabla sintakse (`AstSearch`, `AstEdit`) s metavarijablama `$NAME` i `$$$NAME` kroz 23 gramatike u arhivama izdanja (16 u svakoj `bun install` izgradnji plus 7 u paketu gramatika); trajne ćelije koda u Pythonu (`python3`) i JavaScriptu (Node ES modul) (`Eval`); te debugger Debug Adapter Protocol (`Debug`) koji upravlja s `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`, `netcoredbg`, `rdbg`, adapterom za debugiranje iz Dart SDK-a, `kotlin-debug-adapter`, elixir-ls adapterom za debugiranje i Godot-om. U alatu `Test`, operacija `debug` prebacuje neuspjeli test u Pythonu (`pytest`, `unittest`), JavaScriptu/TypeScriptu (`node-test`, `vitest`, `jest`), Go-u (`go test`) ili Rustu (`cargo test`) direktno u sesiju `Debug`, u kojoj se kroz njega korača. Pogledajte [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md), [transakcije promjena](../CHANGE-TRANSACTIONS.md), [strukturalne šablone](../STRUCTURAL-PATTERNS.md), [ćelije koda](../EVAL.md) i [debugger](../DEBUGGER.md).
- **`WebSearch` bez ključa i `WebFetch` u markdownu.** `WebSearch` prolazi kroz jednu kaskadu: najprije nativna pretraga uživo kod dobavljača, ako model sesije to podržava (`ProviderSearch`), zatim sačuvani ključevi za Brave ili Tavily, pa zvanični API-ji izabrani prema obliku upita (Stack Exchange, npm, PyPI, crates.io, pretraga koda na GitHub-u, Hacker News Algolia, Wikipedia), zatim konfigurisani SearXNG JSON API-ji (`MERCURY_SEARCH_SEARXNG_INSTANCES`), te scraping stranica DuckDuckGo bez ključa (podrazumijevano uključeno; isključite ga u `/config` ili preko `MERCURY_SEARCH_KEYLESS=0`). Svaki odgovor ostaje ispod 2.000 tokena i imenuje izvor koji je odgovorio. `WebFetch` čita javne stranice kao markdown, vlastitim riječima stranice, u okviru budžeta od 38.000 znakova po pozivu (stranica kojoj je potreban pretraživač čita se preko hostovanog čitača `r.jina.ai`, osim ako je `MERCURY_FETCH_READER=0`, a adresa privatne mreže se nikada ne šalje tamo). Pogledajte [docs/ENGINES.md](../ENGINES.md).
- **Agenti, crewmate-ovi kod više dobavljača (`Crewmate`), worktree-ovi i zakupi datoteka.** Dva ugrađena agenta (`mercury-crew` za delegirani posao svake vrste i `mercury-scout` za izviđanje samo za čitanje) nalaze se uz definicije agenata koje kreirate u `/agents`. Pokrećite crewmate-ove na bilo kojem prijavljenom dobavljaču, izolujte paralelni rad u `git worktree` kopijama (`isolation: "worktree"`), koordinišite zajedničke datoteke pomoću zakupa datoteka projekta unutar procesa (`mcp__mercury__lease_take`, `mcp__mercury__lease_release`, `mcp__mercury__lease_list`), a crewmate-ove usmjeravajte i nastavljajte po imenu ili ID-u pomoću `SendMessage` i `ResumeCrewmate`. Pratite crewmate-ove i pokretanja workflow-a u `/crewmates` i `/runs`. Pogledajte [docs/CREW.md](../CREW.md).
- **Upravljanje računarom (desktop).** Uključeno podrazumijevano kada je dostupan nativni desktop drajver. Alat `Computer` pravi snimke ekrana i upravlja mišem i tastaturom u aplikaciji u prvom planu. Mercury provjerava aplikaciju po imenu i identitetu prije nego što djeluje, traži odobrenje osim ako vaša pravila dozvola, odobrenje u sesiji, postavka pristupa ili način dozvola već dozvoljavaju tu radnju, zaustavlja se na `Esc`, dopušta da samo jedna sesija upravlja desktopom istovremeno, a snimke ekrana drži van sačuvane datoteke razgovora. Postavite `MERCURY_COMPUTER_USE=0` da uklonite alat. Pogledajte [docs/COMPUTER-USE.md](../COMPUTER-USE.md).
- **Glasovni unos Whisper na uređaju (`/voice`).** `/voice on` preuzima engleski govorni model od 60 MB (`base.en-q5_1`) pri prvoj upotrebi, provjerava njegov SHA-256 otisak i uključuje diktiranje; `/voice off` ga isključuje. Držite razmaknicu 1 s da govorite, a pustite da zaustavite, ili pokrenite samo `/voice` da započnete i zaustavite snimak dok je glas uključen. Whisper transkribuje na uređaju, pa se glasovni zvuk nikada ne šalje izvan računara, a `MERCURY_WHISPER_MODEL` bira `tiny.en-q5_1`, `small.en-q5_1`, višejezični `base-q5_1` ili lokalnu `.gguf` datoteku. Pogledajte [docs/VOICE.md](../VOICE.md).
- **Saturn cron i planer sesija (`/saturn`).** Zakažite prompt za postojeću sesiju (`CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, `/loop`) ili zakažite novu sesiju da počne u zadatom vremenu. Raspored se može izvršiti jednom ili se ponavljati. Pogledajte [docs/SATURN.md](../SATURN.md).
- **Mostovi ka VS Code (ACP), Unity, Blenderu, Godot-u i Aseprite-u.** `mercury acp` povezuje se s editorima koji podržavaju Agent Client Protocol. Ekstenzija za VS Code (`mercury bridge install`) pokreće Mercury unutar editora preko tog protokola: razgovor, sesije, agenti, artefakti i pregledi, uz to što selekcija i dijagnostika editora idu uz svaki prompt. Zasebne integracije, koje se uključuju namjerno, povezuju se s pokrenutim editorima Unity (`MERCURY_UNITY=1`), Blender (`MERCURY_BLENDER=1`) i Godot (`MERCURY_GODOT_TOOLS=1`), uz pristup Aseprite-u u paketnom režimu (`MERCURY_ASEPRITE=1`). Pogledajte [Unity](../UNITY-BRIDGE.md), [Blender](../BLENDER-BRIDGE.md), [Godot](../VULCAN-GODOT-TOOLS.md) i [Aseprite](../ASEPRITE-BRIDGE.md).
- **Ekstenzije.** Svaka ekstenzija ima jedan manifest. Dodajte izvore iz git URL-a, lokalnog direktorija ili arhive, odobrene hešom svojih doprinosa. Pogledajte [docs/EXTENSIONS.md](../EXTENSIONS.md).
- **MCPs & Skills.** Konfiguracija po repozitoriju za ono što sesije učitavaju, s imenovanim presetima i kontrolama koje možete mijenjati tokom sesije. Pogledajte [docs/KIT.md](../KIT.md).
- **Dijagnostika.** Provjera stanja i `/health` izrađuju izvještaj potkrijepljen dijagnostičkim dokazima, s presudom `certified`, `caution` ili `fault` i provjerenim popravkama. Pogledajte [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md).
- **Povjerenje i dozvole.** Povjerenje prema radnom prostoru, pravila i načini dozvola te naredbe koje svaka sesija odbija. Pogledajte [docs/TRUST.md](../TRUST.md).
- **Apollo Mode**, intervju o specifikaciji: odgovarajte na pitanja agenta da dovršite specifikaciju koju će koristiti za izradu prototipa. Pogledajte [docs/APOLLO-MODE.md](../APOLLO-MODE.md).
- **Oporavak.** Atomično objavljivanje, operacije zabilježene u dnevniku i usklađivanje pri pokretanju. Pogledajte [docs/DURABILITY.md](../DURABILITY.md).

Zastavice izvršavanja definisane su u `src/substrate/flagRegistry.ts`, izlažu se kao postavke `MERCURY_*` i prikazuju na zahtjev. Kompatibilnost integracija opisana je u [docs/COMPATIBILITY.md](../COMPATIBILITY.md). Potpun indeks dokumentacije nalazi se u [docs/README.md](../README.md).

## Slash naredbe

`/help` navodi dostupne interaktivne naredbe. Koristite `/palette` za pretragu naredbi po fuzzy principu. Tabela ispod grupiše podrazumijevano uključene ugrađene naredbe prema kategorijama koje koristi `/help`; živa lista takođe uključuje `/samples` pod `current work` kada je Samples uključen (`MERCURY_SAMPLES=1` ili red Samples u Boot Menu-ju), `/showcase` kada je postavljeno `MERCURY_DEV_SURFACES=1`, te sve skille i naredbe ekstenzija.

| Oblast | Naredbe |
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

| Naredba | Šta radi |
| --- | --- |
| `/imagesetup` | Postavite lokalne modele za slike i video. |
| `/llmhost` | Odaberite model za iznajmljivanje na Runpod-u, Vast.ai-ju ili Lambda-i, pokrenite ga na vašem računaru ili povežite postojeći server. |
| `/restart` | Premješta ovaj razgovor na instaliranu verziju Mercury-ja; pokrenuti monitori i pozadinske ljuske se zaustavljaju. |
| `/mcp` | Pregledajte servere, prijavite se, pregledajte alate i parametre svakog servera, ponovo se povežite ili uključite i isključite server za ovaj razgovor. |

`/mouse off` vraća pokazivač terminalu za izvorno označavanje i kopiranje teksta. Postavka se čuva i u `/config` se pojavljuje kao Mouse capture.

Obavezni argument u upotrebi skill-a počinje s `<…>`. Na primjer, `/update-config` i `/debug` traže argument. Ako pošaljete samo jednu od njih, dobićete njen opis i upotrebu; tura ne počinje. Ako je odaberete iz padajućeg prijedloga (typeahead) i pritisnete Enter, `/name ` ostaje spreman da dodate argument. `/loop` nema obavezni argument i pokreće se odmah.

## Prijavljivanje problema

Za kratak izvještaj koristite [formular za testere](https://mercury-cli.ai/report) ili `/bug --short <what you tried>` unutar Mercury-ja. Traži vaš operativni sistem, šta ste pokušali i šta je pošlo po zlu; izvještaj o stanju nije potreban.

Pokrenite `/bug <what happened>` unutar Mercury-ja da pregledate izvještaj prije nego što ga pošaljete preko prijavljenog GitHub CLI-ja (`gh`). Bez `gh`, Mercury čuva lokalni nacrt u matičnom direktoriju konfiguracije i upućuje vas na stranicu problema repozitorija.

Problem možete otvoriti i direktno, koristeći šablon bug, provider/model ili feature request. Navedite ispis `--version`, operativni sistem, terminal i tačne korake. Izvještajima o greškama i dobavljačima takođe su potrebni `mercury health --json`, ili `node dist/mercury.mjs health --json` za izgradnju iz izvornog koda. Od pomoći je i prepis ekrana na kojem se greška javlja.

Sigurnosne probleme prijavljujte privatno, preko kartice Security repozitorija. Držite ih van javnih problema. Pogledajte [SECURITY.md](../../SECURITY.md). [CONTRIBUTING.md](../../CONTRIBUTING.md) pokriva probleme, pull request-ove i provjere.

## Licenca

Mercury CLI je licenciran pod Apache License 2.0 (`Apache-2.0`) u [LICENSE.md](../../LICENSE.md). TypeScript i Python SDK-ovi u [sdk/](../../sdk/) i [sdk-py/](../../sdk-py/) (`mercury-cli-sdk` na npm-u i PyPI-ju) takođe su licencirani pod Apache License 2.0 (`Apache-2.0`), svaki prema LICENSE datoteci koju nosi ([sdk/LICENSE](../../sdk/LICENSE) i [sdk-py/LICENSE](../../sdk-py/LICENSE)).

Upotreba imena i zaštitnih znakova Mercury-ja uređena je [politikom zaštitnih znakova](../../TRADEMARKS.md). Ugrađene licence trećih strana navedene su u [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
