[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI (mercury-cli.ai, pakiet npm `mercury-tech-cli`) uruchamia agentów kodowania AI w terminalu, wewnątrz twoich własnych repozytoriów git, na macOS, Linux i Windows.

Strona: [mercury-cli.ai](https://mercury-cli.ai) · Repozytorium: [github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI) (`Whq02/MercuryCLI`) · npm: `mercury-tech-cli`

Agent czyta i edytuje pliki, uruchamia polecenia powłoki, przechodzi krok po kroku przez testy i debuggery, a następnie sprawdza wyniki. Ty wybierasz dostawcę modeli, model i to, co agent może robić:

- **Wiele sesji w Session Concourse i izolowane worktree:** uruchamiaj kilka sesji obok siebie w Session Concourse (`/concourse`) i deleguj równoległą pracę crewmate'om od różnych dostawców (`Crewmate`) w izolowanych kopiach roboczych `git worktree`, z dzierżawami plików projektu, dzięki którym równolegli agenci nie nadpisują sobie nawzajem pracy.
- **20 dostawców modeli, `/llmhost` i `/localsetup`:** utrzymuj wszystkich 20 dostawców zalogowanych jednocześnie (OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot/Kimi, Z.AI/GLM, OpenRouter, Hugging Face, xAI/Grok, Meta/Muse, Mistral, Nous Portal, OpenCode Zen, Qwen, MiniMax, Together AI, Cohere, Groq, Cerebras, Fireworks AI) i zmieniaj dostawcę oraz model w trakcie czatu. Otwórz `/llmhost`, aby wybrać model, sprawdzić jego kwantyzację, podział `conversations × context` i poziom myślenia, a następnie uruchomić go na wynajętym GPU (Runpod, Vast.ai lub Lambda), na własnym komputerze (`mercury host`) albo na istniejącym serwerze. Albo uruchom `/localsetup`, aby zainstalować Ollama lub podłączyć ją obok LM Studio, vLLM i llama.cpp.
- **Pamięć projektu Mneme, hybrydowy RAG:** używa działającego lokalnie semantycznego modelu embeddingów BGE o rozmiarze 118 MB (`bge-base-en-v1.5`) z rankingiem słów BM25, śledzeniem cytowań, przypiętymi regułami zapisanymi dosłownie, kontekstem startowym zależnym od gałęzi, kontrolami sprzeczności w chwili zapisu, notatkami przekazania między sesjami oraz przeglądarką grafu `/memory page`.
- **Narzędzia kompilatora, AST i debugowania DAP:** łączy inteligencję kodu LSP i refaktoryzacje z podglądem (`LspRead`, `LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`), wyszukiwanie i przepisywanie drzewa składni tree-sitter dla 23 języków (`AstSearch`, `AstEdit`), wbudowany debugger Debug Adapter Protocol (`Debug`) (`debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`) do krokowego wchodzenia w nieudane testy w Pythonie, Node, Go i Rust oraz trwałe komórki `Eval` w Pythonie i JavaScripcie.
- **`WebSearch` bez klucza i `WebFetch` w markdownie:** wyszukuje przez natywne wyszukiwanie dostawcy, klucze Brave lub Tavily, oficjalne API (Stack Exchange, npm, PyPI, crates.io, GitHub, Hacker News, Wikipedia), SearXNG i bezkluczowe DuckDuckGo, a publiczną dokumentację pobiera w formacie markdown w limicie 38 000 znaków na jedno wywołanie.
- **Sterowanie aplikacjami na komputerze, głos Whisper, planowanie Saturn i mostki do edytorów:** steruje aplikacjami desktopowymi (`Computer`), transkrybuje lokalnie dyktowanie głosem w trybie push-to-talk za pomocą Whisper (`/voice`), planuje cykliczne lub jednorazowe sesje za pomocą Saturn (`/saturn`) i łączy się z VS Code przez Agent Client Protocol (`mercury acp`) oraz z Unity, Blenderem, Godotem i Asepritem.
- **Generowanie wideo (`Video`):** wysyłaj prompty i pliki referencyjne projektu do skonfigurowanego generatora MiniMax ([docs/VIDEO.md](../VIDEO.md)), a następnie zapisuj w projekcie wygenerowany plik MP4 oraz opcjonalną klatkę podglądu PNG z 1. sekundy.

Mercury służy do budowania samego Mercury: uruchamia wiele sesji i modeli podczas długich zadań. Trudne jest śledzenie tej pracy: co jeszcze działa, co się zmieniło i co wymaga decyzji. Każda sesja zapisuje własną notatkę przekazania po zakończeniu, a następna sesja odczytuje ją raz na starcie razem z moimi przypiętymi regułami, co zapobiega zatruwaniu kontekstu między sesjami.

![Jeden prompt wysłany do koordynatora na tablicy sesji uruchamia dwie sesje, każda we własnym worktree; jedna pyta przed edycją, a obie kończą z gotowymi do przeglądu zmianami](../media/session-board-stream.gif)

Mercury ma dostępny kod źródłowy na licencji Business Source License 1.1, a SDK w [sdk/](../../sdk/) i [sdk-py/](../../sdk-py/) są objęte licencją Apache License 2.0. Warunki użytku produkcyjnego znajdziesz w sekcji [Licencja](#licencja).

## Instalacja

Archiwa wydań są dostępne dla komputerów Mac z procesorami Apple silicon i Intel, dla Linuksa x64 i arm64 oraz dla Windows x64 i arm64. Zainstaluj `git` osobno; każde archiwum zawiera Node i ripgrep, więc osobna instalacja Node nie jest potrzebna.

Wybierz jedną metodę instalacji:

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS i Linux (x64 i arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows (x64 i arm64), w PowerShell 7
brew install Whq02/mercury/mercury                 # Homebrew: macOS i Linux x64
npm install -g mercury-tech-cli                    # npm; `bun install -g mercury-tech-cli` to ten sam pakiet
mise use -g npm:mercury-tech-cli                   # mise, przez pakiet npm
```

Adresy instalacji przechowują przybliżone liczniki żądań skryptów według źródła i dnia UTC (zakończone instalacje nie są liczone); licznik nie przechowuje adresu IP, ciągu user-agent ani plików cookie.

Otwórz nowy terminal albo uruchom wiersz `export PATH=…` wypisany przez instalator powłoki, a następnie sprawdź instalację poleceniem `mercury --version`. Z poziomu repozytorium uruchom `mercury`, aby rozpocząć [pierwsze uruchomienie](#pierwsze-uruchomienie). W Windows PowerShell oraz po instalacji przez Homebrew, npm, bun lub mise polecenie `mercury` działa w tym samym terminalu.

<details>
<summary>Ścieżki instalacji, aktualizacje i weryfikacja wydań</summary>

### Różnice między metodami instalacji

Instalatory powłoki i PowerShell pobierają najnowsze wydanie dla twojej platformy, sprawdzają jego SHA-256 względem `SHA256SUMS.txt`, rozpakowują je i uruchamiają polecenie `mercury install` dołączone do archiwum.

Zarówno formuła Homebrew, jak i pakiet npm są przypięte do konkretnego wydania i publikowane ponownie po utworzeniu tagu, dlatego mogą być opóźnione względem najnowszego wydania. Polecenia Homebrew używają pełnej nazwy tapa `Whq02/mercury/mercury` (samo `mercury` w `homebrew-core` to inny program). Pakiet npm `mercury-tech-cli` jest launcherem, który pobiera przypięte wydanie; mise instaluje ten sam pakiet. `mercury install --uninstall` usuwa zainstalowane wydanie i shim polecenia, zachowując konfigurację i sesje (jeśli zainstalowano launcher npm, uruchom także `npm uninstall -g mercury-tech-cli`).

Instalacja Mercury działa w zakresie użytkownika i nie wymaga uprawnień administratora. Polecenie instalacji możesz bezpiecznie uruchomić ponownie.

### Ścieżki instalacji

Wydania znajdują się w katalogu konfiguracyjnym, w `~/.mercury/versions/<version>` (`%USERPROFILE%\.mercury\versions` w Windows). Polecenie `mercury` jest instalowane w `~/.local/bin` na macOS i Linuksie albo w `%LOCALAPPDATA%\Mercury\bin` w Windows.

`mercury install` dodaje katalog polecenia do PATH jednorazowo: chronioną linię w pliku startowym powłoki albo wpis w PATH użytkownika Windows. Nowy terminal uwzględnia tę zmianę automatycznie.

### Aktualizacje

Używaj `mercury update` przy dowolnej metodzie instalacji.

W przypadku instalacji wykonanej instalatorem powłoki lub PowerShell albo poleceniem `mercury install` polecenie aktualizuje Mercury w miejscu. `--check` sprawdza dostępność aktualizacji, `--status` pokazuje stan aktualizacji, a `--rollback` przywraca poprzednie wydanie, które pozostaje na dysku.

W przypadku Homebrew polecenie pyta o zgodę przed uruchomieniem `brew upgrade Whq02/mercury/mercury`. Domyślna odpowiedź to nie; wpisz `y`, aby zatwierdzić. Mercury na bieżąco wyświetla wyjście polecenia, a następnie sprawdza zainstalowaną wersję. Użyj `--yes`, aby pominąć pytanie w skryptach.

Launcher npm korzysta z tego samego układu wydań co instalatory i przekazuje każde uruchomienie zainstalowanemu wydaniu. `mercury update` aktualizuje więc instalację npm w miejscu, przez własny kanał aktualizacji Mercury. `npm update -g mercury-tech-cli` zmienia tylko wydanie, które pakiet instaluje przy pierwszym uruchomieniu. Dotyczy to także mise.

`--check` czyta tę samą listę wydań dla każdej metody instalacji i wskazuje, jak zaktualizować twoją. Gdy aktualizacja jest dostępna, ekran główny raz pokazuje w prawym dolnym rogu `vX.Y.Z available · mercury update`, a czat wyświetla tymczasowe powiadomienie. Ustaw `MERCURY_UPDATE_NOTICE=0`, aby ukryć oba.

Żądania instalacji i aktualizacji pobierają publiczną listę wydań i archiwa anonimowo. Możesz je uruchomić bez konta i tokenu. Jeśli anonimowe żądanie zostanie odrzucone, Mercury sprawdza zalogowany GitHub CLI (`gh`).

Po aktualizacji Mercury sprawdza, czy polecenie w PATH wskazuje zaktualizowaną instalację. Jeśli pierwszeństwo ma inna instalacja albo zaktualizowanego polecenia brakuje w PATH, wyjaśnia problem i sposób naprawy. `mercury health` pokazuje ten sam problem.

### Weryfikacja wydań

Przed aktywacją wydania Mercury sprawdza jego archiwum względem `SHA256SUMS.txt`. Wymaga też ładunku podpisanego kluczem wydań Mercury, obecnym na liście zaufanych kluczy wbudowanej w program, zanim przygotuje aktualizację. Odrzucony podpis pozostawia aktywną instalację bez zmian.

Użyj `--allow-unsigned`, aby zaakceptować niepodpisany ładunek. Mercury nadal odrzuca nieznane klucze podpisujące, uszkodzone bloki podpisu i zmienioną zawartość. Wynik polecenia i jego lokalny zapis pokazują, że zaakceptowano niepodpisany ładunek.

Od wersji 1.0.0-beta.3 archiwa są podpisywane podczas pakowania, a ich podpisy są weryfikowane przed publikacją. Zweryfikowana instalacja nie wyświetla przy starcie żadnej informacji o podpisie. `mercury health` podaje klucz podpisu `627b54b734ca0e72`.

Archiwa wersji 1.0.0-beta.2 nie są podpisane. Te instalacje zgłaszają niepodpisane pochodzenie raz na instalację, gdy uruchamiasz Mercury interaktywnie bez polecenia ani flagi. Kontrola stanu nadal pokazuje ten status. Oznacza on, że manifest archiwum nie ma podpisu; pobranie jest mimo to sprawdzane względem `SHA256SUMS.txt`.

[docs/TRUST.md](../TRUST.md) wyjaśnia wyniki weryfikacji i sposób ręcznego sprawdzenia archiwum. [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) opisuje weryfikację przy starcie.

### Uwagi o platformach

Archiwa wydań istnieją dla każdej wymienionej platformy. Każda inna maszyna buduje Mercury ze źródeł.

Archiwa dla Intel Mac są dostępne od wersji 1.0.0-beta.3. Są pakowane krzyżowo na runnerze z Apple silicon i testowane przy starcie w Rosetta przed publikacją. Intel Mac korzystające z wersji 1.0.0-beta.2 wymagają budowania ze źródeł.

</details>

## Wymagania

Archiwa wydań zawierają Node 24 LTS. Launcher, `mercury install` i `mercury update` używają tego dołączonego środowiska uruchomieniowego; `git` jest jedynym osobnym wymaganiem samego wydania.

Aby zbudować Mercury ze źródeł, potrzebujesz:

- **Node 24 LTS** w obsługiwanym zakresie `>=24.20.0 <25`. Plik `.node-version` przypina wersję poprawkową używaną do budowania, która jest dołączana do archiwów wydań.
- **bun 1.3.x** do budowania. Nie jest dołączany do wydań.
- **git**. W Windows uruchom PowerShell 7 w Windows Terminal lub w terminalu VS Code. Zobacz [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md).

Minimalna wersja Node zawiera poprawkę nodejs/node#56645. Poniżej 24.20.0 polecenia `run` bez interfejsu, które wywołują narzędzie, przerywają się przy wyjściu w Windows.

Launchery wybierają Node w tej kolejności: jawnie wskazany plik binarny `MERCURY_NODE`, dołączone środowisko uruchomieniowe, a następnie zgodna instalacja Node w PATH. Jeśli środowiska uruchomieniowego brakuje, launcher zgłasza błąd.

### Powłoki Windows

Archiwa wydań zawierają silnik powłoki zgodny z bash (`brush`), a w Windows domyślnie obsługuje on narzędzie Bash: znajduje program `.cmd` lub `.bat`, taki jak `npm`, po samej nazwie dzięki PATHEXT, przekazuje `%VAR%` i `^` do pliku wsadowego bez zmian, uruchamia program wskazany ścieżką względną po `cd` i zachowuje stan powłoki między wywołaniami. `bash.exe` z Git for Windows nie jest wymagany; jeśli jest zainstalowany, `MERCURY_SHELL_ENGINE=system` albo `system` w `/config`, w ustawieniu Shell engine, uruchamia narzędzie Bash wyłącznie na `bash.exe`.

Wiersz `shell` w kontroli stanu pokazuje, która powłoka jest aktywna i dlaczego: dołączony silnik (domyślny w Windows albo po przypięciu lub ustawieniu) czy Git Bash, gdy silnik został wyłączony albo jego pakiet jest nieobecny.

Na macOS i Linuksie domyślna jest powłoka systemowa. Ustaw `MERCURY_SHELL_ENGINE=brush` albo wybierz `brush` w `/config`, w ustawieniu Shell engine, aby także tam narzędzie Bash działało na dołączonym silniku, z trwałym stanem powłoki.

Budowanie ze źródeł bez pakietu silnika ani Git for Windows uruchamia się, ale narzędzie Bash jest niedostępne. Narzędzie PowerShell pozostaje dostępne, a diagnostyka `shell` wyjaśnia, jak przywrócić obsługę Bash.

## Budowanie ze źródeł

Mercury buduje się przy użyciu bun i działa na Node 24 LTS. Zainstaluj [wymagania do budowania ze źródeł](#wymagania), w tym bun 1.3.x:

```sh
curl -fsSL https://bun.sh/install | bash           # macOS i Linux
powershell -c "irm bun.sh/install.ps1 | iex"       # Windows, w PowerShell 7
bun --version                                      # 1.3.x
```

Następnie w klonie tego repozytorium:

```sh
bun run setup                      # raz; bun install + dołączone pakiety
bun run build.ts                   # zapisuje dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### Obsługa terminala

Interfejs pełnoekranowy wymaga prawdziwego TTY, ale nie ma minimalnego rozmiaru terminala. Pełny układ zaczyna się od 100 kolumn na 26 wierszy; mniejsze okna używają układu kompaktowego.

Mercury używa 24-bitowych kolorów, gdy terminal zgłasza ich obsługę przez `COLORTERM=truecolor` albo gdy zostanie rozpoznany jako iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal lub VS Code. Inne terminale używają 256 kolorów, w tym Terminal Apple w macOS 15 i wcześniejszych.

Wiersz Terminal color w kontroli stanu podaje wykrytą głębię kolorów i jej przyczynę. Ustaw `MERCURY_TRUECOLOR=1` dla terminala obsługującego prawdziwe kolory, który tego nie zgłasza, albo `MERCURY_TRUECOLOR=0`, aby wymusić 256 kolorów.

### Opcjonalne komponenty

`setup` pobiera dołączone pakiety możliwości: pyright, debugpy, js-debug, dodatkowe gramatyki, środowisko uruchomieniowe Node dla danej platformy oraz brush. Jeśli pobieranie się nie powiedzie, ten pakiet jest pomijany, a budowanie i dotknięte nim narzędzia zgłaszają brakujący komponent. Samo `bun install` daje kompilację bez tych pakietów.

Aby zbudować obsługę głosu, uruchom `setup` z zainstalowanym Rust. Buduje to `native/voice`. Dodaj cmake, aby zbudować także `native/whisper`. Z zainstalowanym Rust `setup` buduje też dodatek sterownika pulpitu (`native/desktop`), z którego korzysta narzędzie `Computer`. Z zainstalowanym Rust `setup` buduje również lokalny dodatek embeddingów (`native/embed`, `bun run scripts/vendor/build-embed.ts`) i pobiera model BGE o rozmiarze 118 MB (`bun run scripts/vendor/fetch-embed-models.ts --default`). Bez cargo pakiet jest pomijany, setup o tym informuje, a wyszukiwanie w pamięci Mneme działa tylko na dopasowaniu słów. Każde archiwum wydania zawiera pakiet embeddingów zbudowany dla jego platformy. W Linuksie i Windows obliczenia wykonuje jądro wektorowe, więc wywołanie Recall po znaczeniu trwa około jednej dziesiątej sekundy (kilka setnych na macOS, który używa Accelerate). Jeśli w natywnej kompilacji brakuje wymaganych narzędzi, setup ją pomija, a kontrola stanu zgłasza brakujący dodatek. Silnik powłoki Windows także jest budowany na twojej maszynie, ponieważ upstream nie dostarcza pliku binarnego dla Windows.

Zobacz [Powłoki Windows](#powłoki-windows) oraz [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) w sprawie silnika powłoki `brush`.

Budowanie zapisuje wyłącznie do `dist/`. Konfiguracja i sesje znajdują się w `~/.mercury` albo w katalogu ustawionym przez `MERCURY_CONFIG_DIR` i są tworzone przy pierwszym uruchomieniu. W Windows uruchom bezpośrednio `node dist\mercury.mjs`.

### Instalowanie kompilacji ze źródeł jako polecenia

`scripts/ops/deploy-runtime.sh` publikuje kompilację z czystego drzewa do nowego folderu `<config home>/runtime/builds/<build>` i ustawia `runtime/current`, aby wskazywał na ten folder (`runtime/dist` to starsza nazwa tego samego dowiązania). `scripts/ops/deploy-launcher.sh` instaluje launcher w `<config home>/bin/mercury`. Dodaj ten katalog do PATH; dla zsh:

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

Launcher zatrzymuje się z błędem, jeśli środowiska uruchomieniowego brakuje. Nie przełącza się na inną kompilację. Wybór Node przebiega w kolejności opisanej w [Wymagania](#wymagania). W przypadku instalacji wydania uruchom `mercury install` lub `mercury update`, które pozostawiają katalogi źródłowe bez zmian; zobacz [Aktualizacje](#aktualizacje).

[AGENTS.md](../../AGENTS.md) to krótki przewodnik po budowaniu i uruchamianiu. [BUILD-NOTES.md](../../BUILD-NOTES.md) opisuje budowanie szczegółowo.

## Pierwsze uruchomienie

Przy pierwszym interaktywnym uruchomieniu wybierz wygląd, a następnie zaloguj się do dostawcy. Ekran podgląda zmiany motywu podczas przeglądania opcji. True Black jest domyślny; pozostałe opcje to motyw oasis dark oraz Black and white, który nie nadaje żadnego koloru: kolor tekstu terminala na jego własnym tle, tak jak Mercury wygląda w terminalu bez kolorów. Możesz to zmienić później poleceniem `/appearance`.

Możesz też wybrać „sign in later”, aby rozejrzeć się bez łączenia konta. Gdy klucz dostawcy w twoim środowisku już loguje dostawcę, krok logowania nie jest proponowany. Następnie krok Guardrails przypomina, że warto sprawdzać zmiany i polecenia Mercury, oraz że to, co odczytuje, może zawierać instrukcje dla modelu. W terminalu, który Mercury potrafi skonfigurować (Terminal.app, rodzina VS Code, Alacritty, Zed), krok Terminal keys może ustawić skróty nowej linii w ustawieniach samego terminala. W Terminal.app na macOS ustawia `Option+Enter` jako nową linię i wycisza dzwonek terminala we wszystkich profilach; zmiana działa po ponownym uruchomieniu Terminal.app. W rodzinie VS Code, Alacritty i Zed zapisuje `Shift+Enter` jako nową linię. Krok jest wyłączony, dopóki go nie wybierzesz, a kopia zapasowa jest zachowywana.

Następnie Mercury pyta, czy ufasz folderowi, który otworzyłeś. Nic, o co prosi konfiguracja obszaru roboczego, nie uruchamia się przed udzieleniem tego zaufania. Zgoda obejmuje całe repozytorium; odmowa kończy działanie Mercury. Zobacz [docs/TRUST.md](../TRUST.md).

Zwykłe interaktywne uruchomienie otwiera ekran główny. Ma dziesięć pozycji menu; Continue Last Session pojawia się dopiero po zapisaniu historii sesji:

- **New Session in \<folder\>** rozpoczyna nową sesję w bieżącym folderze.
- **Continue Last Session** wraca do ostatniego czatu.
- **Boot Menu** konfiguruje przyszłe sesje, w tym motion, crewmates i workflows.
- **MCPs & Skills** wybiera, co załaduje następna sesja. Zobacz [docs/KIT.md](../KIT.md).
- **Agents** tworzy i edytuje agentów.
- **Health Check** sprawdza instalację.
- **Saturn Scheduler** planuje sesje. Zobacz [docs/SATURN.md](../SATURN.md).
- **Logins** łączy konta dostawców.
- **Session Concourse** otwiera listę sesji bieżącego projektu.
- **Sessions · Projects** pozwala wybrać sesję albo repozytorium.

Pozycje menu otwierają się nad ekranem głównym, a `Esc` wraca do wybranej pozycji. Lista sesji otwiera się na osobnym ekranie, dostępnym także przez `Shift+→`. Argument promptu, `--continue` lub `--resume` prowadzi bezpośrednio do czatu.

### Motion, crewmates i workflows

Sekcja Performance w Boot Menu zawiera ustawienie Motion: `auto`, `full`, `reduced` lub `off`. Steruje ono animacją interfejsu w stanie bezczynności i jest dostępne także w `/config`.

W sekcji Agents przełączniki Crewmates i Workflows decydują, czy nowe sesje dostają narzędzia Crewmate i Workflow. Wyłączenie przełącznika usuwa odpowiednie narzędzie; próby uruchomienia tego typu pracy zwracają to samo wyjaśnienie. W sesji `/crewmates on|off` i `/workflows on|off` zmieniają to ustawienie na granicy następnej tury.

## Codzienny rytm: Session Concourse, worktree git i crewmates

### Rozpoczynanie sesji i izolowanie worktree

Naciśnij `Enter` na New Session, aby utworzyć sesję w bieżącym folderze z domyślnym modelem. Mercury otwiera czat i jednocześnie dodaje sesję do listy sesji. Za menu trzyma gotowy proces, aby skrócić czas uruchomienia.

Rozpoczęcie kolejnej sesji nie zatrzymuje poprzedniej. Możesz zostawić zadanie w tle i pracować gdzie indziej. Uruchom z `--worktree [name]` (albo poproś w czacie o `worktree`, aby wykonać `EnterWorktree`), aby sesja dostała własną gałąź i kopię roboczą w `.mercury/worktrees/`. Równolegli crewmates także mogą działać w izolowanych worktree i koordynować wspólne pliki dzierżawami plików projektu; zobacz [Co zawiera](#co-zawiera-pamięć-rag-mneme-lsp-ast-dla-23-języków-debugger-dap-wyszukiwanie-w-sieci-i-mostki) oraz [docs/CREW.md](../CREW.md).

### Praca w czacie

Opisz pracę zwykłym językiem. Agent czyta, edytuje, uruchamia i sprawdza kod w ramach wybranego trybu uprawnień. Wywołania narzędzi pojawiają się w miarę ich uruchamiania, jako zwarte karty albo z pełnym wyjściem. Sposób wyświetlania wybierzesz w `/config`, w sekcji Tool output; ustawienie zostaje zapisane na kolejne uruchomienia.

Użyj `/model` i `/effort`, aby dostosować sesję. `/permissions` określa, co może działać bez zatwierdzenia, a co musi najpierw zapytać.

Zmiany przejrzysz poleceniem `/diff`, według źródła, pliku i hunka. `! <command>` uruchamia polecenie powłoki w czacie z bieżącym podglądem wyjścia. `/runs` wyświetla działające powłoki i crewmates (`/tasks` otwiera tę samą tablicę), a `/crewmates` otwiera widok Crew na żywo. Między turami `/clear` zapisuje bieżący czat i otwiera świeżą sesję, a `/restart` przenosi czat na nowo zainstalowaną wersję Mercury. `/title` nadaje czatowi nazwę, a `/help` wyświetla dostępne polecenia.

### Przechodzenie między ekranami

`Shift+←` i `Shift+→` przełączają się między ekranami dostępnymi w danej chwili. Świeże uruchomienie pokazuje ekran główny i listę sesji. Ekran czatu jest dodawany, gdy sesja otrzyma fokus, i usuwany, gdy zamknie się ostatni czat. Podpowiedzi klawiszy pokazują tylko dostępne przejścia.

Zamknięcie wszystkich czatów przenosi na ekran główny. Użyj `--chat`, aby mieć tylko ekran główny i czat, bez listy sesji. `--concourse-off` zapisuje tę preferencję na przyszłe uruchomienia; `--concourse-on` lub `/config` ją ponownie włącza.

### Zarządzanie sesjami w Session Concourse

Listę sesji otwórz poleceniem `/concourse` albo `Shift+→` z ekranu głównego. Najpierw pokazuje działające sesje bieżącego projektu, a następnie zapisane czaty, które nie działają, od najnowszego.

Każda działająca sesja ma komórkę NOW z jej bieżącą aktywnością. Zaznacz wiersz i naciśnij `Enter`, aby wrócić do czatu, a pozostałe sesje działają dalej. Sesja, która uległa awarii, pozostaje na liście jako NEEDS YOU wraz z przyczyną, aż ją zwolnisz.

[docs/SESSIONS.md](../SESSIONS.md) opisuje cykl życia sesji.

## Dostawcy i modele: logowania, `/localsetup` i `/llmhost`

Użyj `/logins`, aby połączyć dostawcę. Otwiera to ten sam katalog logowania, którego używa konfiguracja. `/accounts` zarządza później połączonymi slotami dostawców.

- **OpenAI:** subskrypcja ChatGPT albo klucz API.
- **Anthropic:** subskrypcja Claude, logowanie do Console albo klucz API.
- **OpenRouter:** dostęp do katalogu przez OAuth albo klucz API; żądania do modeli nie zezwalają na zbieranie danych i od początku wymagają obsługi wszystkich parametrów. `/config → OpenRouter routing policy` ustawia wybór zapasowego modelu i zerowej retencji danych; wybierz open, aby złagodzić politykę i pozostawić routing OpenRouterowi.
- **Google Gemini:** Sign in with Google, klucz API albo własny klient OAuth. Sign in with Google uruchamia Gemini w ramach limitu planu, który posiada konto Google (konto darmowe, Google AI Pro lub Google AI Ultra), przez własnego klienta Antigravity firmy Google: prompt, schematy narzędzi i wyniki narzędzi trafiają do punktu końcowego Code Assist Google w ramach tego klienta i zalogowanego konta, a `/model` wyświetla listę modeli, które Google udostępnia temu kontu. Klucz API albo własny klient OAuth zamiast tego rozlicza projekt Cloud.
- **Hugging Face:** logowanie kodem urządzenia albo token Hub.
- **Kimi (Moonshot):** logowanie kodem urządzenia albo klucz API.
- **GLM (Z.AI):** klucz subskrypcji GLM Coding Plan albo ogólny klucz API rozliczany za użycie. `/logins zai` zapisuje dowolny z nich i rejestruje plan; działa też `ZAI_API_KEY`, a `ZAI_KEY_PLAN=coding|general` wskazuje plan (gdy nie jest ustawiony, Mercury odczytuje go z listy modeli przypisanej do klucza).
- **DeepSeek:** klucz API z platformy DeepSeek (`/logins deepseek` albo `DEEPSEEK_API_KEY`).
- **xAI (Grok):** zaloguj się subskrypcją Grok (SuperGrok / X Premium) albo wklej klucz API przez `/logins xai`.
- **Meta (Muse):** Sign in with Meta (subskrypcja Muse Code, kod urządzenia w przeglądarce) albo klucz Model API rozliczany za użycie. Sign in with Meta wymienia kod urządzenia w punktach OIDC Meta (`https://auth.meta.com/oidc/device/authorization/` i `/oidc/device/token/`) pod publicznym identyfikatorem klienta Muse Code, wysyła uzyskany token konta raz na `https://api.meta.ai/muse-code/key`, aby wygenerować klucz API subskrypcji (oraz w ograniczonych odczytach `/usage` dla poziomu planu i okien użycia), a na każde żądanie modelu wysyła pod `https://api.meta.ai/v1` wyłącznie wygenerowany klucz. Wklejony klucz Model API albo `MODEL_API_KEY` / `META_API_KEY` rozlicza się za użycie.

- **Qwen:** klucz QwenCloud (Token Plan lub rozliczany za użycie) albo klucz Alibaba Cloud Model Studio (rozliczany za użycie, Token Plan lub Coding Plan), sprawdzany na własnym punkcie końcowym przed zapisaniem; klucz planu wyświetla modele tego planu, z Qwen3.8 Max na pierwszym miejscu.
- **MiniMax:** klucz Open Platform albo klucz subskrypcji M Plan.
- **Together AI** i **Cohere:** klucz API.
- **Groq**, **Cerebras** i **Fireworks AI:** klucz API; klucz każdej rodziny może też pochodzić z polecenia wskazanego w `credentials.keyCommands.<family>`.

Mistral, Nous Portal i OpenCode Zen również łączą się przez `/logins`, co daje łącznie 20 rodzin dostawców z logowaniem. Lokalne serwery modeli (Ollama, LM Studio, vLLM i llama.cpp) oraz własne punkty końcowe zgodne z OpenAI działają bez logowania do dostawcy. Uruchom `/localsetup`, aby zainstalować lub uruchomić Ollama, pobrać model mieszczący się w pamięci, ustawić jego okno kontekstu albo podłączyć działający serwer LM Studio, vLLM lub llama.cpp ([docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)). Każdy dostawca używa własnego protokołu, własnych poświadczeń i własnej obsługi błędów, a żądania nigdy nie przełączają się na innego dostawcę. Zobacz [docs/ENGINES.md](../ENGINES.md).

`/llmhost` wyświetla modele, które możesz hostować, i pokazuje, gdzie każdy z nich może działać w tej chwili: na GPU wynajętym w Runpod, Vast.ai lub Lambda, na własnym komputerze albo na zapisanym komputerze SSH (`mercury host`), albo na istniejącym serwerze modeli. Każda strona modelu pokazuje opcje kwantyzacji, sposób podziału budżetu pamięci GPU między równoległe rozmowy (`conversations × context`) oraz domyślny poziom myślenia (który `/effort` zmienia dla każdego żądania). Wynajęcie GPU wymaga wyraźnego potwierdzenia ceny godzinowej, a konfiguracja działa dalej w tle, jeśli zamkniesz wyskakujące okno. W Runpod możesz też dostroić jakość, podział kontekstu i myślenie przed wynajęciem albo na działającym podzie (`Tune`), trzymać wagi na woluminie o szybkim ładowaniu oraz ustawiać 5-sekundowe monitory dostępności. Wynajmy Vast.ai i Lambda są nowością w 1.0.0-beta.40 i zostały zweryfikowane względem opublikowanych API dostawców na fixture'ach (wynajmów na żywo nie przeprowadzono). Zobacz [docs/LLM-HOST.md](../LLM-HOST.md).

Nowe sesje używają ostatnio połączonego dostawcy i najnowszego modelu dostępnego temu kontu. Modele, do których konto nie ma dostępu, są pomijane. Jeśli ten dostawca nie ma żadnego użytecznego modelu, Mercury sprawdza następnego w kolejności ostatniego połączenia. Ten wybór następuje w chwili startu sesji; nieudane żądanie w istniejącej sesji pozostaje u swojego dostawcy.

`/model` wyjaśnia wybór. Nazwa rodziny wybiera najnowszy model tej rodziny: `/model grok`, `/model deepseek`, `/model kimi` lub `/model glm`. Gdy nie jest połączony żaden dostawca, ekran główny i `/model` kierują do `/logins`. `/defaultprovider` pozwala jawnie ustawić dostawcę jako ostatni wybór.

Dostęp do dostawców nadal podlega ich własnym warunkom i dostępności. Licencja Mercury ich nie zastępuje.

## CLI bez interfejsu: `mercury run`, Docker i runner JSON-RPC

Ta sama kompilacja działa bez interaktywnego interfejsu. `node dist/mercury.mjs --help` wyświetla wszystkie flagi.

`mercury run "<prompt>"` uruchamia prompt bez interfejsu terminala:

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` wypisuje odpowiedź; przyczyna nieudanej tury trafia na stderr.
- `json` wypisuje ostatni wiersz `outcome` jako jeden obiekt JSON.
- `rows` zapisuje jeden obiekt JSON na wiersz: `session`, następnie `turn` i jego wiersze `text`, `reasoning`, `tool_call`, `tool_result` i `step`, zakończone `outcome`. Oczekiwania, postęp narzędzi, zadania w tle i powiadomienia mają własne wiersze. Każdy wiersz zawiera `seq`, `timestamp` i `session_id`; wiersze w obrębie tury zawierają też jej numer `turn`. `seq` numeruje strumień tego uruchomienia od 1; `turn` liczy tury sesji, więc uruchomienie kontynuujące zapisaną rozmowę (`-c`, `-r`, `--fork`) numeruje swoją turę po turach już w niej obecnych, a jego wiersz `session` wskazuje w `resume_of` rozmowę, którą kontynuuje.

Typy wierszy wyjściowych według pola `type`:

- `session`: wiersz otwarcia: `version`, `build` (pierwsze dwanaście znaków szesnastkowych drzewa, z którego zbudowano bundle, tak jak wypisuje je `mercury daemon status`; brak, gdy obok bundle nie ma manifestu), `resume_of` (w kontynuowanym uruchomieniu identyfikator sesji rozmowy, którą kontynuuje; taki sam jak `session_id`, chyba że uruchomienie zostało rozgałęzione), `cwd`, `model`, `mode`, `tools`, `mcp_servers`, `commands`, `agents`, `skills` i `extensions` sesji oraz `tools_withheld` (obecne, gdy reguła odmowy wstrzymuje narzędzie po jego gołej nazwie: każdy wpis ma `tool`, `rule` i `source`).
- `turn`: tura w stanie `started` lub `waiting`, z jej `turn_id`; `model`, `message_ids` oraz liczba `agents`, gdy jest znana.
- `text`: ustalony blok tekstu: `message_id`, `block`, `text` oraz jego `phase` (`commentary` lub `final_answer`).
- `reasoning`: ustalony blok rozumowania: `message_id`, `block`, `text` albo `redacted: true`.
- `tool_call`: wywołanie narzędzia: `call_id`, `tool`, `input`, z jego `message_id` i `block`.
- `tool_result`: wynik wywołania: `call_id`, `status` (`ok`, `error`, `aborted` lub `refused`) oraz `output`. Wywołanie ukształtowane przez model tak źle, że zostało odrzucone przed wykonaniem (nieznane narzędzie, argumenty, które nie są poprawnym JSON-em albo nie pasują do schematu narzędzia), również dostaje swoją parę: wiersz `tool_call` z argumentami w postaci, w jakiej zostały dostarczone (`{}`, gdy nie były obiektem), oraz wiersz `tool_result` ze statusem `refused`, którego `output` podaje przyczynę; po nim następuje `notice` z korektą. Takie wywołanie nigdy nie zostało uruchomione i nie jest odmową.
- `tool_update`: postęp działającego narzędzia: `call_id`, `tick`, `source` (`shell`, `powershell`, `mcp` lub `eval`) oraz te z pól `line`, `elapsed_s`, `lines`, `bytes`, `budget_ms`, `progress` i `total`, które wywołanie podaje. Wywołanie shell lub PowerShell wysyła tick w miarę napływu wyjścia (polecenie, które nic nie wypisuje, nigdy nie wysyła ticka); wywołanie MCP wysyła je, gdy jego serwer zgłasza postęp, a wywołanie Eval podczas działania komórki. Żadne inne narzędzie nie wysyła ticków; wywołanie Browser albo Crewmate milczy aż do wyniku.
- `step`: jedno wywołanie modelu wątku głównego: `message_id`, `model`, `usage` oraz `stop`, gdy model podał przyczynę zatrzymania.
- `outcome`: wynik tury, opisany poniżej.
- `close`: notatka zostawiona następnej sesji przy zamknięciu: `state` (`stored`, `skipped` lub `none`), `note_chars` oraz `usage` wywołań modelu, które ją zapisały, dzięki czemu czytelnik sumujący zużycie ze wszystkich wierszy otrzymuje wartość z wyniku tury. Gdy prompt podano jako argument, notatka jest pytana w obrębie ostatniej tury i `close` poprzedza `outcome` tej tury; przy `--input rows` pojawia się po ostatnim `outcome`, gdy stdin się zamknie.
- `wait`: oczekiwanie na model: `state` (`first_byte`, `retry`, `silence`, `loading` lub `done`) wraz z wartościami, które niesie dany stan, np. `since_ms`, `attempt` i `of`, `delay_ms`, `reason` i `http_status`.
- `heartbeat`: strumień modelu dał znak życia po co najmniej sekundzie bez przetworzonego zdarzenia: dotarły bajty, które nie wytworzyły wiersza. Wiersz niesie wyłącznie to i pojawia się najwyżej raz na sekundę; jak często, zależy od kształtu strumieniowania dostawcy, więc strumień, który nigdy nie robi przerwy między zdarzeniami, nie wysyła ich wcale.
- `compaction`: kompaktowanie w stanie `started`, `progress` lub `ended`: `trigger` (`manual`, `auto` lub `overflow`), `stage`, `fill`, `summary_tokens` oraz na końcu `exit` (`landed`, `cancelled` lub `failed`).
- `mode`: zmienił się tryb uprawnień: `mode`.
- `rate_limit`: stan limitu dostawcy: `status` (`allowed`, `warning` lub `rejected`), `window`, `resets_at`, `utilization` oraz pola przekroczenia.
- `task`: zadanie w tle w stanie `started`, `progress` lub `ended`: `task_id`, `task_type`, `description`, `usage`, `summary`, `status` (`completed`, `failed` lub `stopped`) oraz `output_file`, w miarę jak stają się znane.
- `notice`: ostrzeżenie `warning` albo błąd `error` dla czytelnika: `text` oraz `code`, np. `input_refused`.
- `command_output`: wyjście polecenia slash, które nigdy nie trafiło do modelu: `command` i `text`.
- `mission_updated`: rejestr zadań sesji się zmienił; odczytaj go ponownie.
- `samples_updated`: próbki sesji się zmieniły; odczytaj je ponownie.

`--partial` z `--format rows` dodaje wiersze `block_start`, `text_delta`, `reasoning_delta`, `tool_input_delta` i `retracted`. Delty należą do `message_id` i `block`; wiersz `retracted` wycofuje delty tej wiadomości. Ustalony wiersz tekstu lub narzędzia zawiera pełną wartość.

Wynik zawiera `schema`, `turn_id`, `status`, `steps`, `wall_ms`, `usage`, `models` i `denials`, z `answer` po ukończeniu oraz `error` (`message`, `class` i opcjonalnie `detail`) po niepowodzeniu. `stop`, `api_ms`, `cost_usd`, zażądane wyjście `structured` i `notices` są dołączane, gdy są dostępne. `wall_ms` to czas, jaki upłynął w turze. `api_ms` to suma czasów trwania każdego żądania modelu wykonanego w turze (łącznie z ponowieniami i żądaniami crewmates, które działały równolegle z wątkiem głównym), więc może przekroczyć `wall_ms`, gdy żądania się nakładały. `cost_usd` to kwota w USD za wycenione żądania tury, niezależnie od statusu: żądanie, którego Mercury nie potrafi wycenić (brak stawki w zapisie, brak kosztu w odpowiedzi), nic do tej kwoty nie dodaje i zostawia swój model na liście `models` bez własnego `cost_usd`; pole jest nieobecne tylko wtedy, gdy nic w turze nie zostało wycenione. Przy logowaniu subskrypcją Claude żądania Anthropic nie mają ceny w dolarach, więc ani one, ani wiersz nie niosą `cost_usd`; zużycie pozostaje. Zużycie obejmuje `input_tokens` (wliczając tokeny z pamięci podręcznej), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` oraz, gdy jest raportowane, `reasoning_output_tokens`, zsumowane dla wątku głównego i crewmates. `models` rozbija zużycie tokenów na modele. `steps` liczy tylko wywołania modelu głównego agenta; wywołania modelu wykonane przez crewmates pojawiają się jako ich własne wiersze `step`, oznaczone `parent_call_id`.

Statusem jest `completed`, `blocked`, `refused`, `failed`, `interrupted`, `turn_limit`, `budget_limit`, `time_limit`, `schema_unmet` lub `loop_stopped`. Uruchomienie z `--max-time` (w sekundach albo w formacie `10m`, `1h`) kończy się statusem `time_limit` na następnym kroku po upływie czasu; trwające wywołanie modelu ani runda narzędzi nie są przerywane. Ukończone uruchomienie kończy się kodem 0, pozostałe wyniki kodem 1, a błąd użycia kodem 2. SIGINT i SIGTERM kończą się kodami 130 i 143, gdy wynik przerwanej tury został zapisany. Odrzucone wywołanie narzędzia jest wymienione w `denials`. Gdy odmowa dotyczyła pytania, na które nikt nie mógł odpowiedzieć (uruchomienie bez hosta w trybie, który pyta, `--mode dontAsk`, albo pytanie hosta, które wygasło), i żadne późniejsze wywołanie narzędzia w turze się nie powiodło, uruchomienie ma status `blocked`: odpowiedź zostaje zachowana, `error` wskazuje narzędzie i sposób wznowienia (`--allowed-tools`, inny `--mode` albo host, który odpowiada na pytania), a uruchomienie kończy się kodem 1. Jeśli późniejsze wywołanie narzędzia w tej samej turze się powiedzie, tura się odzyskuje i kończy się jako `completed` (kod 0) z ostrzeżeniem `notice` (`"<Tool> was not approved; the run continued with other tools."`). Odmowa, na którą odpowiedziałeś (przez regułę odmowy, hook albo host, który powiedział nie), pozostawia ukończoną turę ukończoną. Wywołanie `AskUserQuestion` bez odpowiedzi również kończy uruchomienie jako `blocked`, z pytaniem zacytowanym w `error`; Mercury odczytuje wynik z zarejestrowanych pytań uruchomienia, nigdy z tekstu odpowiedzi, więc pytanie zapisane tylko w odpowiedzi kończy się jako `completed`. Nieznane polecenie slash ma status `refused` z tym samym zdaniem, co ekran interaktywny (`Unknown command: /name · /help lists commands`), i kończy się kodem 1.

`--input rows` wymaga `--format rows` i czyta jeden obiekt wejściowy na wiersz:

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

Typami wejścia są `prompt` z `content` (bloki tekstu lub tekst/obraz), `shell` z `command` oraz `note` z `to` (identyfikatorem agenta) i `content`. Każdy przyjmuje opcjonalne `id`; wiersze prompt i shell przyjmują też `priority` (`now`, `next` lub `later`), `sent_at` i `origin`. Odrzucony kształt wejścia tworzy `notice` z kodem `input_refused`; źle sformatowany JSON kończy uruchomienie. Te wiersze niosą wyłącznie wejście; odpowiedzi na pytania o uprawnienia korzystają z protokołu runnera opisanego niżej.

Użyj `mercury run -` albo przekaż tekst potokiem do `mercury run`, aby odczytać cały prompt ze stdin. Obok argumentu promptu tekst z potoku jest dopisywany jako ograniczony kontekst: potok jest czytany, aż się zamknie albo przez sekundę nie będzie przesyłał danych, więc strumień, który wciąż dostarcza dane, jest czytany do końca, a potok, który pozostaje otwarty i milczy, nie wstrzymuje uruchomienia. Bez promptu i z terminalem na stdin `run` wypisuje swoje użycie i kończy się kodem 2.

`--mode <mode>` wybiera postawę uprawnień. `--sovereign` działa bez pytań o uprawnienia, a `--allow-sovereign` udostępnia tę postawę do późniejszej zmiany. Polityka uprawnień i reguły odmowy nadal obowiązują. Użytkownik root, który wchodzi w tryb sovereign, dostaje jedno powiadomienie na stderr; uruchomienie trwa dalej.

Użyj `-c`, aby kontynuować najnowszą rozmowę, `-r`, aby wznowić po identyfikatorze, tytule lub z wyboru, `-w`, aby działać w zarządzanym worktree, a `--lean` dla minimalnej sesji. `run` nie ma hosta, który odpowiadałby na pytania o uprawnienia: o tym, co może działać, decydują reguły uprawnień i tryb, a wywołanie, które nadal wymaga zatwierdzenia, zostaje odrzucone.

### Obraz bez interfejsu

`Dockerfile` w katalogu głównym repozytorium buduje obraz Linux x64 dla CI i serwerów. Jego punktem wejścia jest `mercury`, a domyślnym poleceniem `run`, więc obraz uruchamia jeden prompt na podłączonym drzewie plików i kończy się kodem uruchomienia:

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

Obraz zawiera bundle, jego środowisko uruchomieniowe Node 24 (w `PATH`), dołączone narzędzia do wyszukiwania, powłoki, debugowania, języków i obrazów, `git` oraz magazyn certyfikatów; nie ma ekranu wejściowego ani przepływu logowania. Działa jako nieuprzywilejowany użytkownik `mercury`, z katalogiem konfiguracyjnym w kontenerze (`MERCURY_CONFIG_DIR`), a `/work` jest jego katalogiem roboczym. Kolory i mysz zależą od wykrywania terminala właściwego dla produktu, a `--user 0` uruchamia jako root z jednym powiadomieniem sovereign opisanym wyżej.

Klucz dostawcy przekazywany jest jako zmienna środowiskowa, w tej samej pisowni, którą produkt czyta wszędzie: `ANTHROPIC_API_KEY` lub `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` lub `GOOGLE_API_KEY`, `XAI_API_KEY` (i `XAI_MANAGEMENT_API_KEY` dla jego licznika użycia), `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY` (i `MISTRAL_ADMIN_API_KEY` dla jego licznika organizacji), `NOUS_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`, `TOGETHER_API_KEY` lub `TOGETHER_AI_API_KEY`, `COHERE_API_KEY` lub `CO_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `DASHSCOPE_API_KEY`, `MODEL_API_KEY` lub `META_API_KEY`, `MERCURY_COMPAT_API_KEY` dla własnego punktu końcowego zgodnego z OpenAI oraz `MERCURY_LOCAL_API_KEY` dla lokalnego serwera. Bez klucza uruchomienie odmawia w jednym wierszu i kończy się kodem 1. `docker run -i … mercury run -` odczytuje prompt ze stdin.

### Hostowanie sesji

`mercury runner` udostępnia sesję hostowi przez stdio: JSON-RPC 2.0, jedna wiadomość na wiersz. Host wysyła najpierw `initialize` i czeka na odpowiedź, zanim wyśle pracę:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

Nazwa i wersja hosta są przekazywane w `host`; `capabilities` deklaruje `holds_asks`, `elicitation` i `partial_rows`. Każdy `id` żądania jest dodatnią liczbą całkowitą: żądanie, którego `id` jest czymkolwiek innym, otrzymuje odpowiedź `-32600` z `id: null`, więc numeruj żądania od 1.

`queue/add` przyjmuje ten sam obiekt prompt, shell lub note co wejście wierszowe powyżej. Wyjście przychodzi w powiadomieniach `row`. `session/facts` odczytuje stan sesji; `session/set_mode` zmienia tryb uprawnień od razu; `session/set_model` i `session/set_effort` zmieniają model i poziom wysiłku, a zmiana dokonana w trakcie działania tury jest wstrzymana do jej końca: odpowiada wtedy `at: "turn_end"`, a `session/applied` ją ogłasza. `turn/interrupt` zatrzymuje turę; zamknij stdin, aby zakończyć sesję.

Pytania o uprawnienia przychodzą jako `permission/request`, z `kind: "tool"` lub `kind: "network"`. Host odpowiada `outcome: "allow"` albo `outcome: "deny"`; allow może nieść zmienione `input` i `rules` uprawnień. Wycofane pytanie wysyła `$/cancel_request` z jego `request_id`. `holds_asks` oddaje hostowi zegar pytania. Pytanie MCP używa `elicitation/request` tylko wtedy, gdy host zadeklaruje `elicitation`; w przeciwnym razie otrzymuje odpowiedź `cancel`.

Nieznana metoda otrzymuje odpowiedź `-32601`, nieprawidłowe parametry `-32602`, `id`, który nie jest dodatnią liczbą całkowitą, `-32600`, a żądanie przed inicjalizacją `-32002`. Odmowa reguły to `-32010`, ze zdaniem w `error.message` i powodem w `error.data.kind`, takim jak `mode`, `model`, `effort` lub `claim`. Runner odpowiada na źle sformatowany wiersz `-32700` i działa dalej; trzy kolejne źle sformatowane wiersze go kończą.

### Inne polecenia

Dostępne polecenia obejmują:

- **`mercury health`**: raport diagnostyczny, nazywany też certyfikatem stanu. `--json` zwraca pełny raport, `--deep` uruchamia szczegółowy przegląd, a `--fix` uruchamia naprawy z przewodnikiem.
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**: zalogowanie (`login [<family>]`), wyświetlenie rodzin dostawców (`list`), sprawdzenie, czy konto jest zalogowane (`status [<family>]`), wylogowanie (`logout [<family>]`) albo wygenerowanie długotrwałego tokenu Anthropic (`mint`).
- **`mercury models [--json]`**: wypisuje modele, do których mają dostęp zalogowane konta (te same dane co `mercury://models`).
- **`mercury mcp`**: zarządza serwerami MCP poleceniami `add`, `import`, `list`, `get`, `remove`, `trust-reset` i `serve`.
- **`mercury extensions`**: instaluje rozszerzenia i zarządza ich źródłami. Działania: `list`, `sources`, `add`, `remove`, `refresh`, `install`, `trust`, `enable`, `disable`, `update`, `uninstall`, `fence`, `unfence`, `inspect` i `scaffold`.
- **`mercury roster`**: wyświetla inwentarz agentów.
- **`mercury usage`**: wypisuje zwięzłą linię z liczbami, którą pokazuje ekran `/usage`; `--json` wypisuje cały odczyt: okna każdego zalogowanego dostawcy z wykorzystaniem i resetem, podane przez niego liczby i kredyty, każdy ze swoim źródłem i wiekiem, a także wydatki sesji na model, odczytane tak, jak czyta je ekran (czytnik każdego zalogowanego dostawcy jest próbkowany raz, jak przy otwarciu).
- **`mercury daemon run|status|stop|restart`**: uruchamia, sprawdza, zatrzymuje lub restartuje demona działającego w tle. Jego miejsca sesji (seats) to procesy potomne `mercury runner`; demon wysyła ich prompty i obsługuje ich pytania o uprawnienia.
- **`mercury sessions list`** (także samo `mercury sessions`): wyświetla zapisane sesje tego projektu, od najnowszej: identyfikator, czas ostatniego zapisu, rozmiar, `live`, gdy demon hostuje ją w tej chwili, oraz tytuł lub pierwszy prompt; `--all` odczytuje wszystkie projekty, a `--limit <n>` ogranicza listę. Identyfikator to ten, który `mercury --resume <id>` ponownie otwiera, a `sessions delete` usuwa.
- **`mercury sessions delete <id>`**: celowo usuwa jedną zapisaną sesję — jej transkrypcję i zapisy trzymane obok (pokwitowania, migawkę wznowienia) — po pytaniu; `--yes` pomija pytanie w skryptach. Sesja, którą demon hostuje w tej chwili, zostaje odrzucona, a nieznany identyfikator zostaje odrzucony ze wskazówką do inwentarza (`/sessions` w Mercury). Zapisane sesje poza tym nigdy nie są usuwane same z siebie.
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**: uruchamia komputer lokalny albo dostępny przez SSH jako serwer modeli dla wszystkich sesji współdzielących katalog konfiguracyjny (`compat/box-<name>/<model>`), korzystając z zweryfikowanego lokalnego zbioru wag albo potwierdzonego pobrania. Zobacz [docs/LLM-HOST.md](../LLM-HOST.md).
- **`mercury lsp list`** i **`mercury lsp install <server>`**: katalog serwerów językowych; każdy serwer jest zainstalowany (wraz z plikiem binarnym) albo nieobecny (wraz ze wskazówką instalacji). `install` pokazuje wskazówkę dla serwera, pyta o zgodę, uruchamia dokładnie ją (`--yes` pomija pytanie w skryptach) i podaje, gdzie trafił plik binarny. Nieznany serwer zostaje odrzucony, a Mercury podaje listę znanych serwerów. Mercury nigdy nie instaluje serwera językowego samodzielnie; otwarcie pliku uruchamia tylko serwer, który jest już zainstalowany.
- **`mercury acp`**: udostępnia edytor przez Agent Client Protocol, z procesem potomnym runnera dla każdej sesji. `mercury bridge install` instaluje rozszerzenie VS Code; `mercury bridge status` je sprawdza; `mercury bridge uninstall` je usuwa.
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**: zarządza zadaniami silnika dla projektu Godot w bieżącym katalogu. Mercury uruchamia zestawy testów na własnych workerach bez interfejsu, z zamrożonej kopii projektu. Usługa obejmuje bramkę kompilacji, przechwytywanie obrazu, statystyki klatek, ustalone profile, dostęp do kolejki zadań, anulowanie i wyniki według identyfikatora. Zobacz [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md).
- **`mercury image <image>`**: wyświetla obraz w terminalu.
- **`mercury install`** i **`mercury update`** (alias `upgrade`): instalują albo aktualizują archiwa wydań; z `--json` dokument trafia na stdout niezależnie od werdyktu, a kod wyjścia mówi, czy operacja się nie powiodła. Zobacz [Instalacja](#instalacja).
- **`mercury version`** i **`mercury help [command]`**: wypisują wiersz wersji albo stronę pomocy, tak samo jak `--version` i `--help`; żadne z nich nie uruchamia sesji.

## Co zawiera: pamięć RAG Mneme, LSP, AST dla 23 języków, debugger DAP, wyszukiwanie w sieci i mostki

- **Hybrydowa pamięć projektu RAG Mneme.** Mneme jest domyślnie włączona i przechowuje fakty każdego projektu w zwykłych stronach tematycznych w markdownie (`Retain`, `Recall`, `Reflect`, `Correct`). Recall łączy lokalny model semantycznych embeddingów BGE o rozmiarze 118 MB (`bge-base-en-v1.5` `q8_0`, MIT, dołączony do każdego archiwum wydania i zbudowany dla jego platformy; zobacz [Opcjonalne komponenty](#opcjonalne-komponenty)) z rankingiem słów BM25 po sprowadzeniu do formy podstawowej (stemming), ważeniem według świeżości i śledzeniem cytowań przez wzajemną fuzję rankingów (`k = 60`). Przypięte reguły (`pin: true`) ładują się dosłownie na przypięty regał i zmieniają się tylko na twoje polecenie. Na starcie sesji Mercury ocenia nieprzypięte fakty i wcześniejsze notatki względem bieżącej gałęzi, ostatnio zmienianych plików i notatki przekazania z ostatniej sesji, w ramach osobnego limitu startowego (`memory.startLimit`, domyślnie 4 000 znaków). Kontrole sprzeczności w chwili zapisu wychwytują zmiany polaryzacji, negacji i liczb, zanim sprzeczny fakt zostanie zapisany. Każda sesja przy wyjściu zapisuje własnymi słowami notatkę przekazania dla strony wejściowej następnej sesji, a dodatkowo opcjonalny wpis dziennika sesji. `/memory` otwiera centrum pamięci, a `/memory page` rysuje bibliotekę w przeglądarce jako graf węzłów i krawędzi. Zobacz [docs/MNEME.md](../MNEME.md).
- **Inteligencja kodu LSP, przepisywanie AST dla 23 języków, debugger DAP i komórki `Eval`.** Odczyty z kotwicami i atomowe edycje wielu plików (`ChangeSet`); zapytania do serwera językowego (`LspRead`) oraz refaktoryzacje z podglądem i zastosowaniem (`LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`); wyszukiwanie i przepisywanie drzewa składni (`AstSearch`, `AstEdit`) z metazmiennymi `$NAME` i `$$$NAME` dla 23 gramatyk w archiwach wydań (16 w każdym buildzie `bun install` plus 7 w pakiecie gramatyk); trwałe komórki kodu w Pythonie (`python3`) i JavaScripcie (moduł ES Node) (`Eval`); oraz debugger Debug Adapter Protocol (`Debug`) sterujący `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`, `netcoredbg`, `rdbg`, adapterem debugowania Dart SDK, `kotlin-debug-adapter`, adapterem debugowania elixir-ls i Godotem. W narzędziu `Test` operacja `debug` przenosi nieudany test w Pythonie (`pytest`, `unittest`), JavaScript/TypeScript (`node-test`, `vitest`, `jest`), Go (`go test`) lub Rust (`cargo test`) bezpośrednio do sesji `Debug`. Zobacz [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md), [transakcje zmian](../CHANGE-TRANSACTIONS.md), [wzorce strukturalne](../STRUCTURAL-PATTERNS.md), [komórki kodu](../EVAL.md) oraz [debugger](../DEBUGGER.md).
- **`WebSearch` bez klucza i `WebFetch` w markdownie.** `WebSearch` przechodzi jedną kaskadą: najpierw natywne wyszukiwanie na żywo dostawcy, jeśli model sesji je obsługuje (`ProviderSearch`), następnie zapisane klucze Brave lub Tavily, potem oficjalne API wybierane według kształtu zapytania (Stack Exchange, npm, PyPI, crates.io, wyszukiwanie kodu GitHub, Hacker News Algolia, Wikipedia), następnie skonfigurowane API JSON SearXNG (`MERCURY_SEARCH_SEARXNG_INSTANCES`), a na końcu bezkluczowe scrapowanie stron DuckDuckGo (domyślnie włączone; wyłączysz je w `/config` albo przez `MERCURY_SEARCH_KEYLESS=0`). Każda odpowiedź mieści się w 2 000 tokenów i wskazuje źródło, które odpowiedziało. `WebFetch` czyta publiczne strony jako markdown, we własnych słowach strony, w ramach budżetu 38 000 znaków na wywołanie (strona wymagająca przeglądarki jest czytana przez hostowany czytnik `r.jina.ai`, chyba że `MERCURY_FETCH_READER=0`, a adres prywatnej sieci nigdy do niego nie trafia). Zobacz [docs/ENGINES.md](../ENGINES.md).
- **Agenci, crewmates od wielu dostawców (`Crewmate`), worktree i dzierżawy plików.** Dwaj wbudowani agenci (`mercury-crew` do delegowanej pracy każdego rodzaju i `mercury-scout` do rozpoznania tylko do odczytu) stoją obok definicji agentów, które tworzysz w `/agents`. Uruchamiaj crewmates na dowolnym zalogowanym dostawcy, izoluj równoległą pracę w kopiach `git worktree` (`isolation: "worktree"`), koordynuj wspólne pliki dzierżawami plików projektu działającymi w procesie (`mcp__mercury__lease_take`, `mcp__mercury__lease_release`, `mcp__mercury__lease_list`), a crewmates kieruj i wznawiaj po nazwie lub identyfikatorze za pomocą `SendMessage` i `ResumeCrewmate`. Śledź crewmates i uruchomienia workflow w `/crewmates` i `/runs`. Zobacz [docs/CREW.md](../CREW.md).
- **Sterowanie komputerem (desktop).** Włączone domyślnie, gdy dostępny jest natywny sterownik pulpitu. Narzędzie `Computer` wykonuje zrzuty ekranu i steruje myszą oraz klawiaturą w aplikacji działającej na pierwszym planie. Mercury sprawdza aplikację po nazwie i tożsamości przed działaniem, prosi o zgodę, chyba że twoje reguły uprawnień, przyznanie w sesji, ustawienie dostępu albo tryb uprawnień już pozwalają na tę czynność, zatrzymuje się na `Esc`, pozwala sterować pulpitem tylko jednej sesji naraz i nie zapisuje zrzutów ekranu w zapisanym pliku rozmowy. Ustaw `MERCURY_COMPUTER_USE=0`, aby usunąć narzędzie. Zobacz [docs/COMPUTER-USE.md](../COMPUTER-USE.md).
- **Wprowadzanie głosu Whisper lokalnie (`/voice`).** `/voice on` pobiera przy pierwszym użyciu angielski model mowy o rozmiarze 60 MB (`base.en-q5_1`), weryfikuje jego skrót SHA-256 i włącza dyktowanie; `/voice off` je wyłącza. Przytrzymaj spację przez 1 s, aby mówić, a zwolnij, aby zatrzymać, albo uruchom samo `/voice`, aby rozpocząć i zakończyć nagranie, gdy głos jest włączony. Whisper transkrybuje lokalnie, więc dźwięk nigdy nie opuszcza komputera; `MERCURY_WHISPER_MODEL` wybiera `tiny.en-q5_1`, `small.en-q5_1`, wielojęzyczny `base-q5_1` albo lokalny plik `.gguf`. Zobacz [docs/VOICE.md](../VOICE.md).
- **Harmonogram cron i planista sesji Saturn (`/saturn`).** Zaplanuj prompt dla istniejącej sesji (`CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, `/loop`) albo zaplanuj nową sesję, która wystartuje o określonej godzinie. Harmonogramy mogą działać raz albo się powtarzać. Zobacz [docs/SATURN.md](../SATURN.md).
- **Mostki do VS Code (ACP), Unity, Blender, Godot i Aseprite.** `mercury acp` łączy się z edytorami obsługującymi Agent Client Protocol. Rozszerzenie VS Code (`mercury bridge install`) uruchamia Mercury w edytorze przez ten protokół: czat, sesje, agentów, artefakty i recenzje, a zaznaczenie i diagnostyki edytora trafiają razem z każdym promptem. Osobne integracje, włączane świadomie, łączą się z działającymi edytorami Unity (`MERCURY_UNITY=1`), Blender (`MERCURY_BLENDER=1`) i Godot (`MERCURY_GODOT_TOOLS=1`), a Aseprite jest dostępny w trybie wsadowym (`MERCURY_ASEPRITE=1`). Zobacz [Unity](../UNITY-BRIDGE.md), [Blender](../BLENDER-BRIDGE.md), [Godot](../VULCAN-GODOT-TOOLS.md) i [Aseprite](../ASEPRITE-BRIDGE.md).
- **Rozszerzenia.** Każde rozszerzenie ma jeden manifest. Dodawaj źródła z adresu URL git, lokalnego folderu lub archiwum; są one zatwierdzane przez skrót (hash) swoich wkładów. Zobacz [docs/EXTENSIONS.md](../EXTENSIONS.md).
- **MCPs & Skills.** Konfiguracja dla każdego repozytorium określająca, co ładują sesje, z nazwanymi presetami i elementami sterującymi, które można zmienić w trakcie sesji. Zobacz [docs/KIT.md](../KIT.md).
- **Diagnostyka.** Kontrola stanu i `/health` tworzą raport oparty na dowodach diagnostycznych, z werdyktem `certified`, `caution` lub `fault` oraz sprawdzonymi naprawami. Zobacz [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md).
- **Zaufanie i uprawnienia.** Zaufanie do obszaru roboczego, reguły i tryby uprawnień oraz polecenia, których każda sesja odmawia. Zobacz [docs/TRUST.md](../TRUST.md).
- **Apollo Mode**, wywiad specyfikacyjny: odpowiadaj na pytania agenta, aby uzupełnić specyfikację, z której zbuduje prototyp. Zobacz [docs/APOLLO-MODE.md](../APOLLO-MODE.md).
- **Odzyskiwanie.** Atomowa publikacja, operacje zapisane w dzienniku i uzgadnianie przy starcie. Zobacz [docs/DURABILITY.md](../DURABILITY.md).

Flagi uruchomieniowe są zdefiniowane w `src/substrate/flagRegistry.ts`, udostępniane jako ustawienia `MERCURY_*` i renderowane na żądanie. Zgodność integracji jest opisana w [docs/COMPATIBILITY.md](../COMPATIBILITY.md). Pełny indeks dokumentacji znajduje się w [docs/README.md](../README.md).

## Polecenia slash

`/help` wyświetla dostępne polecenia interaktywne. Użyj `/palette`, aby wyszukać polecenie rozmytym dopasowaniem. Poniższa tabela grupuje domyślnie włączone wbudowane polecenia według kategorii używanych w `/help`; lista na żywo zawiera też `/samples` w sekcji `current work`, gdy Samples jest włączone (`MERCURY_SAMPLES=1` albo wiersz Samples w Boot Menu), `/showcase`, gdy ustawiono `MERCURY_DEV_SURFACES=1`, oraz wszystkie skille i polecenia rozszerzeń.

| Obszar | Polecenia |
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

| Polecenie | Co robi |
| --- | --- |
| `/llmhost` | Wybierz model do wynajęcia w Runpod, Vast.ai lub Lambda, uruchom go na własnym komputerze albo podłącz istniejący serwer. |
| `/restart` | Przenosi ten czat na zainstalowaną wersję Mercury; działające obserwatory i powłoki w tle się zatrzymują. |
| `/mcp` | Sprawdź serwery, zaloguj się, przeglądaj narzędzia i parametry każdego serwera, połącz ponownie albo przełącz serwer dla tego czatu. |

`/mouse off` oddaje wskaźnik terminalowi, aby można było natywnie zaznaczać i kopiować tekst. Preferencja jest zapisywana i pojawia się w `/config` jako Mouse capture.

Wymagany argument zaczyna się od `<…>` w opisie użycia skilla. Na przykład `/update-config` i `/debug` wymagają argumentu. Gdy wyślesz jedno z nich samo, otrzymasz jego opis i sposób użycia; tura się nie rozpoczyna. Wybranie go w podpowiedziach i naciśnięcie Enter pozostawia `/name ` gotowe do dopisania argumentu. `/loop` nie ma wymaganego argumentu i uruchamia się od razu.

## Zgłaszanie problemu

Do krótkiego zgłoszenia użyj [formularza testera](https://mercury-cli.ai/report) albo `/bug --short <what you tried>` w Mercury. Formularz pyta o system operacyjny, co próbowano i co się zepsuło; zrzut kontroli stanu nie jest potrzebny.

Uruchom `/bug <what happened>` w Mercury, aby podejrzeć zgłoszenie przed wysłaniem go przez zalogowany GitHub CLI (`gh`). Bez `gh` Mercury zapisuje lokalny szkic w katalogu konfiguracyjnym i wskazuje stronę zgłoszeń repozytorium.

Możesz też otworzyć zgłoszenie bezpośrednio, korzystając z szablonu bug, provider/model albo feature request. Dołącz wynik `--version`, system, terminal i dokładne kroki. Zgłoszenia błędów i dostawców wymagają też `mercury health --json`, a dla kompilacji ze źródeł `node dist/mercury.mjs health --json`. Pomocna jest transkrypcja niedziałącego ekranu.

Zgłaszaj problemy bezpieczeństwa prywatnie, przez zakładkę Security repozytorium. Nie umieszczaj ich w publicznych zgłoszeniach. Zobacz [SECURITY.md](../../SECURITY.md). [CONTRIBUTING.md](../../CONTRIBUTING.md) opisuje zgłoszenia, pull requesty i kontrole.

## Licencja

Mercury CLI jest objęty licencją Business Source License 1.1 (`BUSL-1.1`) wraz z Mercury Community Production Grant zawartym w [LICENSE.md](../../LICENSE.md). Zestawy SDK w TypeScript i Pythonie w [sdk/](../../sdk/) oraz [sdk-py/](../../sdk-py/) (`mercury-cli-sdk` w npm i PyPI) są objęte osobną licencją Apache License 2.0 (`Apache-2.0`), określoną przez plik LICENSE, który każdy z nich zawiera ([sdk/LICENSE](../../sdk/LICENSE) i [sdk-py/LICENSE](../../sdk-py/LICENSE)), i nie wchodzą w skład Licensed Work (dzieła objętego licencją).

Mercury ma dostępny kod źródłowy na licencji Business Source License 1.1 z Mercury Community Production Grant. Licencja znajduje się w [LICENSE.md](../../LICENSE.md), wraz z towarzyszącymi jej [warunkami produkcyjnymi](../../MERCURY-COMMUNITY-PRODUCTION-TERMS.md) i [polityką znaku towarowego](../../TRADEMARKS.md). Decydujący jest tekst licencji; niniejszy dokument jest tylko streszczeniem.

Możesz czytać, kopiować, modyfikować i forkować kod źródłowy. Osoby fizyczne i organizacje poniżej obu progów społecznościowych mogą używać Mercury w produkcji bezpłatnie, aby tworzyć i sprzedawać własne produkty, także komercyjne. Zarówno skonsolidowany roczny przychód, jak i łączne zewnętrzne finansowanie muszą być niższe niż US$1 000 000.

Uprawniony użytkownik, który osiągnie któryś z progów, otrzymuje 90-dniowy okres karencji. Po jego upływie każda nowa praca nad produktem, w tym istotne nowe funkcje, wymaga licencji komercyjnej. Produkty, które były już w produkcji w chwili osiągnięcia progu, można nadal utrzymywać przy użyciu wersji Mercury uzyskanych przed zakończeniem okresu karencji, z zastrzeżeniem warunków utrzymania określonych w licencji.

Sprzedaż, white-labelling lub hostowanie samego Mercury dla osób trzecich albo oferowanie jego substytutu wymaga licencji komercyjnej, niezależnie od przychodów lub finansowania.

Każda wersja przechodzi na Apache License 2.0 w swoim własnym dniu Change Date (dacie zmiany), trzy lata po wydaniu tej wersji.

Licencje komercyjne oraz zgodę na użycie znaku towarowego znajdziesz na stronie [mercury-cli.ai/licensing](https://mercury-cli.ai/licensing). Dołączone licencje innych podmiotów są wymienione w [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
