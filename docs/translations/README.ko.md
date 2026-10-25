[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI(mercury-cli.ai, npm 패키지 `mercury-tech-cli`)는 macOS, Linux, Windows에서 사용자의 터미널과 사용자 자신의 git 저장소 안에 AI 코딩 에이전트를 실행합니다.

웹사이트: [mercury-cli.ai](https://mercury-cli.ai) · 저장소: [github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI) (`Whq02/MercuryCLI`) · npm: `mercury-tech-cli`

에이전트는 파일을 읽고 수정하며, 셸 명령을 실행하고, 테스트와 디버거를 단계별로 진행하고, 결과를 확인합니다. 모델 제공자, 모델, 에이전트에게 허용할 작업 범위는 사용자가 선택합니다:

- **멀티 세션 Concourse와 격리된 워크트리:** Session Concourse(`/concourse`)에서 여러 세션을 나란히 실행하고, 병렬 작업을 교차 제공자 crewmate(크루메이트, `Crewmate`)에게 격리된 `git worktree` 체크아웃과 프로젝트 파일 리스를 사용해 위임합니다. 병렬 에이전트끼리 서로 덮어쓰지 않도록 하기 위해서입니다.
- **모델 제공자 20개, `/llmhost`와 `/localsetup`:** 20개 제공자(OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot/Kimi, Z.AI/GLM, OpenRouter, Hugging Face, xAI/Grok, Meta/Muse, Mistral, Nous Portal, OpenCode Zen, Qwen, MiniMax, Together AI, Cohere, Groq, Cerebras, Fireworks AI)에 모두 동시에 로그인해 둘 수 있으며, 채팅 중에도 제공자와 모델을 바꿀 수 있습니다. `/llmhost`를 열면 모델을 고르고, 양자화, `conversations × context` 분할, 사고(thinking) 수준을 확인한 뒤, 임대한 GPU(Runpod, Vast.ai 또는 Lambda), 사용자의 컴퓨터(`mercury host`), 또는 기존 서버에서 실행할 수 있습니다. `/localsetup`을 실행하면 LM Studio, vLLM, llama.cpp와 함께 Ollama를 설치하거나 연결할 수 있습니다.
- **Mneme 하이브리드 RAG 프로젝트 메모리:** 기기 내에서 실행되는 118 MB BGE 시맨틱 임베딩 모델(`bge-base-en-v1.5`)을 사용하며, BM25 단어 순위와 인용 추적, 원문 그대로의 고정 규칙(pinned rules), 브랜치를 인식하는 시작 컨텍스트, 쓰기 시점의 모순 검사, 세션 인계 노트, 그리고 `/memory page` 브라우저 그래프를 제공합니다.
- **컴파일러, AST, DAP 디버깅 도구:** LSP 코드 인텔리전스와 미리보기로 확인하는 리팩터링(`LspRead`, `LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`), 23개 언어를 지원하는 tree-sitter AST 구조 검색과 재작성(`AstSearch`, `AstEdit`), 실패하는 Python, Node, Go, Rust 테스트를 단계별로 따라가는 내장 Debug Adapter Protocol(`Debug`) 디버거(`debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`), 그리고 지속되는 Python 및 JavaScript `Eval` 셀을 제공합니다.
- **키 없이 사용하는 `WebSearch`와 마크다운 `WebFetch`:** 제공자 고유 검색, Brave 또는 Tavily 키, 공식 API(Stack Exchange, npm, PyPI, crates.io, GitHub, Hacker News, Wikipedia), SearXNG, 키가 필요 없는 DuckDuckGo로 검색하고, 공개 문서를 호출당 38,000자 예산 안에서 마크다운으로 가져옵니다.
- **데스크톱 컴퓨터 사용, Whisper 음성, Saturn 스케줄링, 에디터 브리지:** 데스크톱 애플리케이션(`Computer`)을 제어하고, Whisper로 푸시투토크 음성 받아쓰기를 기기 내에서 변환하며(`/voice`), Saturn으로 반복 또는 일회성 세션을 예약하고(`/saturn`), Agent Client Protocol(`mercury acp`)로 VS Code와 연결하고, Unity, Blender, Godot, Aseprite와도 연결합니다.
- **동영상 생성(`Video`):** 설정된 MiniMax 생성기([docs/VIDEO.md](../VIDEO.md))로 프롬프트와 프로젝트 참조 파일을 보내고, 생성된 MP4와 선택 사항인 1초짜리 PNG 미리보기 프레임을 프로젝트에 저장합니다.

Mercury는 Mercury 자체를 만드는 데 사용되며, 긴 작업에 걸쳐 여러 세션과 모델을 실행합니다. 그 작업을 추적하는 것이 가장 어려운 부분입니다. 아직 실행 중인 것, 바뀐 것, 결정이 필요한 것을 파악해야 하기 때문입니다. 각 세션은 끝날 때 자체 인계 노트를 작성하고, 다음 세션은 시작할 때 그 노트를 제가 고정해 둔 규칙(pinned rules)과 함께 한 번 읽어, 세션 사이의 컨텍스트 오염을 막습니다.

![세션 보드의 코디네이터에게 프롬프트 한 번을 보내면 각각 자체 워크트리에서 세션 두 개가 시작됩니다. 한쪽은 편집하기 전에 확인을 요청하고, 두 세션 모두 검토할 수 있는 변경 사항을 준비한 채 끝납니다.](../media/session-board-stream.gif)

Mercury는 Apache License 2.0에 따른 오픈 소스이며, [sdk/](../../sdk/)와 [sdk-py/](../../sdk-py/)의 SDK도 마찬가지입니다.

## 설치

Apple silicon 및 Intel Mac, Linux x64 및 arm64, Windows x64 및 arm64용 릴리스 아카이브를 제공합니다. `git`은 별도로 설치합니다. 각 아카이브에는 Node와 ripgrep이 포함되어 있으므로 Node를 따로 설치할 필요는 없습니다.

설치 방법 중 하나를 선택합니다:

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS 및 Linux(x64 및 arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows(x64 및 arm64), PowerShell 7에서 실행
brew install Whq02/mercury/mercury                 # Homebrew: macOS 및 Linux x64
npm install -g mercury-tech-cli                    # npm; `bun install -g mercury-tech-cli`도 같은 패키지입니다
mise use -g npm:mercury-tech-cli                   # mise, npm 패키지를 통해
```

설치 주소는 출처별, UTC 날짜별로 스크립트 요청 횟수를 대략적으로 집계합니다(완료된 설치는 집계하지 않습니다). 집계 카운터는 IP 주소, user-agent 문자열, 쿠키를 저장하지 않습니다.

새 터미널을 열거나 셸 설치 프로그램이 출력하는 `export PATH=…` 줄을 실행한 뒤, `mercury --version`으로 설치를 확인합니다. 저장소에서 `mercury`를 실행하여 [첫 실행](#첫-실행)을 시작합니다. Windows PowerShell에서, 그리고 Homebrew, npm, bun 또는 mise로 설치한 뒤에는 `mercury`가 같은 터미널에서 동작합니다.

<details>
<summary>설치 경로, 업데이트 및 릴리스 검증</summary>

### 설치 방법의 차이

셸 설치 프로그램과 PowerShell 설치 프로그램은 플랫폼에 맞는 최신 릴리스를 가져오고, SHA-256을 `SHA256SUMS.txt`와 대조한 뒤, 압축을 풀고, 아카이브에 들어 있는 `mercury install` 명령을 실행합니다.

Homebrew와 npm 패키지는 각각 특정 릴리스에 고정되어 있고 태그 이후에 다시 배포되므로 최신 릴리스보다 늦을 수 있습니다. Homebrew 명령은 전체 탭 이름 `Whq02/mercury/mercury`를 사용합니다(탭 이름 없이 쓴 `mercury`는 `homebrew-core`의 다른 프로그램입니다). npm 패키지 `mercury-tech-cli`는 고정된 릴리스를 내려받는 런처이며, mise도 같은 패키지를 설치합니다. `mercury install --uninstall`은 설치된 릴리스와 명령 셈(shim)을 제거하고 설정과 세션은 남겨 둡니다(npm 런처를 설치했다면 `npm uninstall -g mercury-tech-cli`도 실행합니다).

Mercury는 사용자 로컬에 설치되며 관리자 권한이 필요하지 않습니다. 설치 명령은 안전하게 다시 실행할 수 있습니다.

### 설치 경로

릴리스 버전은 설정 홈 아래 `~/.mercury/versions/<version>`에 저장됩니다(Windows에서는 `%USERPROFILE%\.mercury\versions`). `mercury` 명령은 macOS와 Linux에서는 `~/.local/bin`에, Windows에서는 `%LOCALAPPDATA%\Mercury\bin`에 설치됩니다.

`mercury install`은 명령이 있는 디렉터리를 PATH에 한 번 추가합니다. 셸 시작 파일에 가드가 붙은 줄 하나를 추가하거나, Windows 사용자 PATH에 항목 하나를 넣습니다. 새 터미널을 열면 변경 사항이 자동으로 적용됩니다.

### 업데이트

어떤 설치 방법을 사용하든 `mercury update`를 사용합니다.

셸 또는 PowerShell 설치 프로그램으로 설치했거나 `mercury install`로 설치했다면, Mercury를 제자리에서 업데이트합니다. `--check`는 업데이트를 확인하고, `--status`는 업데이트 상태를 보고하며, `--rollback`은 디스크에 남아 있는 이전 버전으로 되돌립니다.

Homebrew의 경우, `brew upgrade Whq02/mercury/mercury`를 실행하기 전에 묻습니다. 기본 답변은 아니요이며, 승인하려면 `y`를 입력합니다. Mercury는 명령의 출력을 스트리밍으로 보여 주고, 실행이 끝나면 설치된 버전을 확인합니다. 스크립트에서 이 확인 절차를 건너뛰려면 `--yes`를 사용합니다.

npm 런처는 설치 프로그램과 같은 릴리스 구조를 사용하며, 각 실행을 설치된 릴리스에 위임합니다. 따라서 `mercury update`는 Mercury 자체 업데이트 채널을 통해 npm 설치도 제자리에서 업데이트합니다. `npm update -g mercury-tech-cli`는 패키지가 첫 실행 때 설치하는 릴리스만 바꿉니다. mise를 사용할 때도 마찬가지입니다.

`--check`는 모든 설치 방법에서 같은 릴리스 목록을 읽고, 설치 방법에 맞는 업데이트 방법을 알려 줍니다. 업데이트가 있으면 홈 화면 오른쪽 아래 모서리에 `vX.Y.Z available · mercury update`가 한 번 표시되고, 채팅에는 임시 알림이 나타납니다. 두 표시를 모두 숨기려면 `MERCURY_UPDATE_NOTICE=0`을 설정합니다.

설치와 업데이트 요청은 공개 릴리스 목록과 아카이브를 익명으로 가져옵니다. 계정이나 토큰 없이도 실행할 수 있습니다. 익명 요청이 거부되면 Mercury는 로그인된 GitHub CLI(`gh`)를 확인합니다.

업데이트 후 Mercury는 PATH의 명령이 업데이트된 설치본을 가리키는지 확인합니다. 다른 설치본이 우선하거나 업데이트된 명령이 PATH에 없으면 문제와 해결 방법을 설명합니다. `mercury health`도 같은 문제를 보고합니다.

### 릴리스 검증

릴리스를 활성화하기 전에 Mercury는 아카이브를 `SHA256SUMS.txt`와 대조해 확인합니다. 또한 업데이트를 스테이징하기 전에, 컴파일 시 포함된 신뢰 목록(trust roster)의 Mercury 릴리스 키로 서명된 페이로드를 요구합니다. 서명이 거부되면 활성 설치본은 바뀌지 않습니다.

서명되지 않은 페이로드를 허용하려면 `--allow-unsigned`를 사용합니다. 그래도 Mercury는 알 수 없는 서명 키, 잘못된 서명 블록, 변조된 내용을 계속 거부합니다. 명령 결과와 로컬 기록에는 서명되지 않은 페이로드를 허용했다는 점이 모두 표시됩니다.

1.0.0-beta.3부터 아카이브는 패키징 중에 서명되고, 게시 전에 서명이 검증됩니다. 검증된 설치본은 시작할 때 서명 알림을 추가로 표시하지 않습니다. `mercury health`는 서명 키 `627b54b734ca0e72`를 보고합니다.

1.0.0-beta.2 아카이브에는 서명이 없습니다. 이 설치본은 명령이나 플래그 없이 Mercury를 대화형으로 시작하면 설치당 한 번 서명되지 않은 출처(unsigned provenance)를 알립니다. 헬스 체크는 계속 그 상태를 표시합니다. 이는 아카이브 매니페스트에 서명이 없다는 뜻이며, 내려받은 파일은 여전히 `SHA256SUMS.txt`와 대조해 확인됩니다.

[docs/TRUST.md](../TRUST.md)는 검증 결과와 아카이브를 직접 확인하는 방법을 설명합니다. [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md)는 시작 시 검증을 다룹니다.

### 플랫폼 참고 사항

위에 나열된 모든 플랫폼에는 릴리스 아카이브가 있습니다. 그 밖의 머신은 소스에서 빌드합니다.

Intel Mac용 아카이브는 1.0.0-beta.3부터 제공됩니다. 이 아카이브는 Apple silicon 러너에서 교차 패키징되며, 게시 전에 Rosetta 환경에서 시작 시 테스트됩니다. 1.0.0-beta.2를 사용하는 Intel Mac에는 소스 빌드가 필요합니다.

</details>

## 요구 사항

릴리스 아카이브에는 Node 24 LTS가 포함되어 있습니다. 런처, `mercury install`, `mercury update`는 이 번들 런타임을 사용하며, 릴리스 자체에 별도로 필요한 것은 `git`뿐입니다.

소스에서 빌드하려면 다음이 필요합니다:

- **Node 24 LTS**(지원 범위 `>=24.20.0 <25`). `.node-version`은 빌드에 사용되고 릴리스 아카이브에 포함되는 패치 버전을 고정합니다.
- **bun 1.3.x**: 빌드용입니다. 릴리스에는 포함되지 않습니다.
- **git**. Windows에서는 Windows Terminal 또는 VS Code 터미널 안에서 PowerShell 7을 실행합니다. 자세한 내용은 [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md)를 참조합니다.

Node 최소 버전에는 nodejs/node#56645 수정이 포함되어 있습니다. 24.20.0 미만에서는 도구를 호출하는 헤드리스 `run` 명령이 Windows에서 종료될 때 중단됩니다.

런처는 다음 순서로 Node를 고릅니다. 명시적인 `MERCURY_NODE` 바이너리, 번들 런타임, 그리고 PATH에 있는 호환 Node 설치 순서입니다. 런타임이 없으면 런처가 오류를 보고합니다.

### Windows 셸

릴리스 아카이브에는 Mercury의 bash 호환 셸 엔진(`brush`)이 포함되며, Windows에서는 기본적으로 이 엔진이 Bash 도구를 제공합니다. 이 엔진은 PATHEXT를 통해 `.cmd` 또는 `.bat` 프로그램(`npm` 등)을 이름만으로 찾고, `%VAR%`와 `^`를 배치 파일에 그대로 전달하며, `cd` 다음에 상대 경로로 지정된 프로그램을 실행하고, 호출 사이에도 셸 상태를 유지합니다. Git for Windows의 `bash.exe`는 필요하지 않습니다. 설치되어 있는 경우 `MERCURY_SHELL_ENGINE=system`을 지정하거나 `system`을 `/config`의 Shell engine 항목에서 선택하면, Bash 도구는 `bash.exe`만으로 실행됩니다.

어떤 셸이 활성화되어 있고 그 이유가 무엇인지는 헬스 체크의 `shell` 행에서 확인합니다. 활성화된 것은 번들 엔진(Windows 기본값이거나 고정 설정 또는 사용자 설정으로 켜진 경우)이거나, 엔진이 꺼졌거나 팩이 없을 때의 Git Bash입니다.

macOS와 Linux에서는 시스템 셸이 기본값입니다. 이 환경에서도 Bash 도구를 번들 엔진에서 실행하고 셸 상태를 유지하려면 `MERCURY_SHELL_ENGINE=brush`를 설정하거나, `brush`를 `/config`의 Shell engine 항목에서 선택합니다.

엔진 팩이나 Git for Windows가 없는 소스 빌드도 시작은 되지만 Bash 도구는 사용할 수 없습니다. PowerShell 도구는 계속 사용할 수 있으며, `shell` 진단 항목이 Bash 지원을 복구하는 방법을 설명합니다.

## 소스에서 빌드

Mercury는 bun으로 빌드하며 Node 24 LTS에서 실행됩니다. bun 1.3.x를 포함한 [소스 빌드 요구 사항](#요구-사항)을 설치합니다:

```sh
curl -fsSL https://bun.sh/install | bash           # macOS 및 Linux
powershell -c "irm bun.sh/install.ps1 | iex"       # Windows, PowerShell 7에서 실행
bun --version                                      # 1.3.x
```

그다음, 이 저장소를 클론한 디렉터리에서 다음을 실행합니다:

```sh
bun run setup                      # 한 번만 실행; bun install + 번들 팩
bun run build.ts                   # dist/mercury.mjs와 dist/manifest.json을 생성
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### 터미널 지원

전체 화면 인터페이스에는 실제 TTY가 필요하지만, 최소 터미널 크기는 정해져 있지 않습니다. 전체 레이아웃은 100열 × 26행부터 시작하며, 더 작은 창에서는 압축 레이아웃을 사용합니다.

Mercury는 터미널이 `COLORTERM=truecolor`로 지원을 알리거나, iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal, VS Code로 인식되면 24비트 색상을 사용합니다. 그 밖의 터미널은 macOS 15 이하의 Apple Terminal을 포함하여 256색을 사용합니다.

헬스 체크의 Terminal color 행은 감지된 색상 깊이와 그 이유를 보고합니다. 트루컬러를 지원하지만 알리지 않는 터미널에는 `MERCURY_TRUECOLOR=1`을, 256색을 강제하려면 `MERCURY_TRUECOLOR=0`을 설정합니다.

### 선택 구성 요소

`setup`은 번들 기능 팩을 내려받습니다. 여기에는 pyright, debugpy, js-debug, 추가 문법(grammar), 플랫폼용 Node 런타임, brush가 포함됩니다. 내려받기가 실패하면 해당 팩은 건너뛰고, 빌드와 영향을 받은 도구가 누락된 구성 요소를 보고합니다. `bun install`만 실행하면 이 팩이 없는 빌드가 만들어집니다.

음성 지원을 빌드하려면 Rust가 설치된 상태에서 `setup`을 실행합니다. 그러면 `native/voice`가 빌드됩니다. `native/whisper`도 빌드하려면 cmake를 설치합니다. Rust가 설치되어 있으면 `setup`은 데스크톱 드라이버 애드온(`native/desktop`)도 빌드하며, `Computer` 도구는 이를 통해 실행됩니다. 또한 Rust가 설치되어 있으면 `setup`은 로컬 임베딩 애드온(`native/embed`, `bun run scripts/vendor/build-embed.ts`)을 빌드하고, 118 MB BGE 모델(`bun run scripts/vendor/fetch-embed-models.ts --default`)을 내려받습니다. cargo가 없으면 해당 팩은 건너뛰며, setup이 이를 알리고, Mneme 메모리 조회는 단어 일치만 사용합니다. 모든 릴리스 아카이브에는 해당 플랫폼용으로 빌드된 임베딩 팩이 들어 있습니다. Linux와 Windows에서는 수치 연산이 벡터화된 커널로 실행되므로, 의미 기반 Recall은 약 10분의 1초가 걸립니다(Accelerate를 사용하는 macOS에서는 백분의 몇 초 정도입니다). 네이티브 빌드에 필요한 도구가 없으면 setup은 그 빌드를 건너뛰고, 헬스 체크가 누락된 애드온을 보고합니다. Windows 셸 엔진은 상류(upstream)에 Windows용 바이너리가 없으므로 사용자의 머신에서도 컴파일됩니다.

`brush` 셸 엔진은 [Windows 셸](#windows-셸)과 [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md)을 참조합니다.

빌드는 `dist/`에만 씁니다. 설정과 세션은 `~/.mercury`, 또는 `MERCURY_CONFIG_DIR`로 지정한 디렉터리에 저장되며, 처음 실행할 때 만들어집니다. Windows에서는 `node dist\mercury.mjs`를 직접 실행합니다.

### 소스 빌드를 명령으로 설치하기

`scripts/ops/deploy-runtime.sh`는 깨끗한 트리의 빌드를 새 `<config home>/runtime/builds/<build>` 폴더에 게시하고, `runtime/current`가 그 폴더를 가리키게 합니다(`runtime/dist`는 같은 링크의 이전 이름입니다). `scripts/ops/deploy-launcher.sh`는 런처를 `<config home>/bin/mercury`에 설치합니다. 그 디렉터리를 PATH에 추가합니다. zsh에서는 다음과 같습니다:

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

런타임이 없으면 런처는 오류와 함께 중지됩니다. 다른 빌드로 전환하지는 않습니다. Node 선택은 [요구 사항](#요구-사항)에 나온 순서를 따릅니다. 릴리스 설치라면 `mercury install` 또는 `mercury update`를 실행합니다. 이 명령들은 소스 체크아웃을 그대로 둡니다. 자세한 내용은 [업데이트](#업데이트)를 참조합니다.

[AGENTS.md](../../AGENTS.md)는 짧은 빌드 및 실행 안내서입니다. [BUILD-NOTES.md](../../BUILD-NOTES.md)는 빌드를 더 자세히 다룹니다.

## 첫 실행

처음 대화형으로 실행하면 외관(appearance)을 고른 다음 제공자에 로그인합니다. 화면은 둘러보는 동안 테마 변경 사항을 미리 보여 줍니다. 기본값은 True Black이며, 다른 선택지는 oasis 다크 테마와 Black and white입니다. Black and white는 색을 전혀 칠하지 않고 터미널 자체의 글자색과 배경색만 사용합니다. 색을 지원하지 않는 터미널에서 Mercury가 보이는 방식과 같습니다. 이 설정은 나중에 `/appearance`로 바꿀 수 있습니다.

계정을 연결하지 않고 둘러보려면 "sign in later"를 선택할 수도 있습니다. 환경에 있는 제공자 키로 이미 로그인된 제공자가 있으면 로그인 단계는 묻지 않습니다. 다음으로 Guardrails 단계가 Mercury의 편집과 명령을 확인하라고 상기시키며, Mercury가 읽는 내용에 모델을 위한 지시가 들어 있을 수 있다는 점도 알려 줍니다. Mercury가 구성 방법을 아는 터미널(Terminal.app, VS Code 계열, Alacritty, Zed)에서는 Terminal keys 단계가 터미널 자체 설정에 줄바꿈 키 바인딩을 구성할 수 있습니다(macOS의 Terminal.app에서는 줄바꿈으로 `Option+Enter`를 설정하고 모든 프로필의 터미널 벨을 끕니다. 이 변경은 Terminal.app을 다시 시작한 뒤 적용되며, VS Code 계열, Alacritty, Zed에서는 줄바꿈으로 `Shift+Enter`를 기록합니다). 이 단계는 사용자가 선택하지 않으면 꺼져 있으며, 백업이 보관됩니다.

다음으로 Mercury는 연 폴더를 신뢰하는지 묻습니다. 작업 공간 구성이 요청한 것은 그 신뢰를 허용하기 전에는 아무것도 실행되지 않습니다. 허용은 저장소 전체에 적용되며, 거부하면 Mercury가 종료됩니다. 자세한 내용은 [docs/TRUST.md](../TRUST.md)를 참조합니다.

일반적인 대화형 실행은 홈 화면을 엽니다. 메뉴 항목은 모두 10개이며, Continue Last Session은 세션 기록이 생긴 뒤에만 나타납니다:

- **New Session in \<folder\>** 현재 폴더에서 새 세션을 시작합니다.
- **Continue Last Session** 가장 최근 채팅으로 돌아갑니다.
- **Boot Menu** 모션, crewmate, 워크플로를 포함해 이후 세션을 구성합니다.
- **MCPs & Skills** 다음 세션이 로드할 항목을 선택합니다. [docs/KIT.md](../KIT.md)를 참조합니다.
- **Agents** 에이전트를 만들고 편집합니다.
- **Health Check** 설치 상태를 점검합니다.
- **Saturn Scheduler** 세션을 예약합니다. [docs/SATURN.md](../SATURN.md)를 참조합니다.
- **Logins** 제공자 계정을 연결합니다.
- **Session Concourse** 현재 프로젝트의 세션 목록을 엽니다.
- **Sessions · Projects** 세션이나 저장소를 선택할 수 있습니다.

메뉴 항목은 홈 화면 위에 열리며, `Esc`를 누르면 선택했던 항목으로 돌아갑니다. 세션 목록은 별도의 화면에 열리며, `Shift+→`로도 열 수 있습니다. 프롬프트 인수, `--continue` 또는 `--resume`을 사용하면 채팅으로 바로 이동합니다.

### 모션, crewmate, 워크플로

Boot Menu의 Performance 섹션에는 Motion 설정이 있으며, 값은 `auto`, `full`, `reduced`, `off` 중 하나입니다. 이 설정은 인터페이스의 유휴 애니메이션을 제어하며, `/config`에서도 지정할 수 있습니다.

Agents 아래의 Crewmates와 Workflows 스위치는 새 세션이 Crewmate와 Workflow 도구를 받을지 결정합니다. 스위치를 끄면 해당 도구가 제거되며, 그 유형의 작업을 생성하려고 하면 같은 설명이 돌아옵니다. 세션 안에서는 `/crewmates on|off`와 `/workflows on|off`로 다음 턴 경계에서 설정을 바꿀 수 있습니다.

## 일상 작업 흐름: Session Concourse, git 워크트리, crewmate

### 세션 시작과 워크트리 격리

New Session에서 `Enter`를 누르면 기본 모델로 현재 폴더에 세션이 만들어집니다. Mercury는 채팅을 열고, 같은 시점에 세션 목록에도 추가합니다. 시작 작업을 줄이기 위해 메뉴 뒤에서 프로세스를 미리 준비해 둡니다.

다른 세션을 시작해도 이전 세션은 멈추지 않습니다. 작업을 실행 상태로 둔 채 다른 곳에서 일할 수 있습니다. `--worktree [name]`으로 실행하면(또는 채팅에서 `worktree`를 요청해 `EnterWorktree`를 실행하면), 세션에 `.mercury/worktrees/` 아래의 자체 브랜치와 체크아웃이 주어집니다. 병렬 crewmate도 격리된 워크트리에서 실행할 수 있으며, 프로젝트 파일 리스로 공유 파일을 조율합니다. 자세한 내용은 [내부 구성](#내부-구성-mneme-rag-메모리-lsp-23개-언어-ast-dap-디버거-웹-검색-및-브리지)과 [docs/CREW.md](../CREW.md)를 참조합니다.

### 채팅에서 작업하기

작업 내용을 일상 언어로 설명합니다. 에이전트는 선택한 권한 모드에 따라 코드를 읽고, 편집하고, 실행하고, 확인합니다. 도구 호출은 실행되는 동안 간결한 카드 형태 또는 전체 출력과 함께 표시됩니다. 표시 방식은 `/config`의 Tool output 항목에서 고를 수 있으며, 그 설정은 이후 실행에도 저장됩니다.

`/model`과 `/effort`로 세션을 조정합니다. `/permissions`는 승인 없이 실행할 수 있는 것과 먼저 물어야 하는 것을 제어합니다.

`/diff`로 변경 사항을 출처, 파일, hunk 기준으로 검토합니다. `! <command>`는 채팅에서 셸 명령을 실행하고 출력의 끝부분을 실시간으로 보여 줍니다. `/runs`는 실행 중인 셸과 crewmate를 보여 주며(`/tasks`로도 같은 보드를 엽니다), `/crewmates`는 실시간 Crew 보기를 엽니다. 턴 사이에 `/clear`는 현재 채팅을 저장하고 새 세션을 열며, `/restart`는 채팅을 새로 설치된 Mercury 빌드로 옮깁니다. `/title`은 채팅의 이름을 정하고, `/help`는 사용 가능한 명령을 나열합니다.

### 화면 사이 이동

`Shift+←`와 `Shift+→`로 현재 사용할 수 있는 화면 사이를 이동합니다. 처음 실행하면 홈 화면과 세션 목록이 나타납니다. 채팅 화면은 세션에 포커스가 가면 추가되고, 마지막 채팅이 닫히면 제거됩니다. 키 안내에는 사용할 수 있는 이동만 표시됩니다.

모든 채팅을 닫으면 홈 화면으로 돌아갑니다. 세션 목록 없이 홈 화면과 채팅만 쓰려면 `--chat`을 사용합니다. `--concourse-off`는 이 설정을 이후 실행에도 저장하며, `--concourse-on` 또는 `/config`로 다시 켤 수 있습니다.

### Session Concourse에서 세션 관리하기

홈 화면에서 `/concourse` 또는 `Shift+→`로 세션 목록을 엽니다. 목록에는 먼저 현재 프로젝트에서 실행 중인 세션이 나타나고, 그다음 실행 중이 아닌 저장된 채팅이 최신순으로 나타납니다.

실행 중인 각 세션에는 현재 활동을 보여 주는 NOW 셀이 있습니다. 행을 선택하고 `Enter`를 누르면, 다른 세션은 계속 실행되는 상태에서 채팅으로 돌아갑니다. 비정상 종료된 세션은 그 이유와 함께 세션 목록에 NEEDS YOU로 남아 있으며, 사용자가 해제할 때까지 유지됩니다.

[docs/SESSIONS.md](../SESSIONS.md)는 세션의 수명 주기를 다룹니다.

## 제공자와 모델: 로그인, `/localsetup`, `/llmhost`

`/logins`로 제공자를 연결합니다. 설정 중에 쓰는 것과 같은 로그인 카탈로그가 열립니다. 나중에는 `/accounts`에서 연결된 제공자 슬롯을 관리합니다.

- **OpenAI:** ChatGPT 구독 또는 API 키.
- **Anthropic:** Claude 구독, Console 로그인 또는 API 키.
- **OpenRouter:** OAuth 또는 API 키로 카탈로그에 접근합니다. 모델 요청은 데이터 수집을 거부하고 처음부터 모든 파라미터를 요구합니다. `/config → OpenRouter routing policy`에서 폴백과 데이터 보존 없음(zero-data-retention) 선택을 설정하며, open을 고르면 정책을 완화하고 라우팅을 OpenRouter에 맡깁니다.
- **Google Gemini:** Sign in with Google, API 키, 또는 직접 만든 OAuth 클라이언트를 사용합니다. Sign in with Google은 Google 계정이 가진 요금제(무료 계정, Google AI Pro 또는 Google AI Ultra)의 할당량으로 Gemini를 실행하며, 이때 Google 고유의 Antigravity 클라이언트를 사용합니다. 프롬프트, 도구 스키마, 도구 결과는 그 클라이언트와 로그인한 계정으로 Google의 Code Assist 엔드포인트에 전송되며, `/model`에는 Google이 그 계정에 제공하는 모델 목록이 표시됩니다. API 키나 자체 OAuth 클라이언트를 사용하면 대신 Cloud 프로젝트에 과금됩니다.
- **Hugging Face:** 기기 코드 로그인 또는 Hub 토큰.
- **Kimi (Moonshot):** 기기 코드 로그인 또는 API 키.
- **GLM (Z.AI):** GLM Coding Plan 구독 키 또는 일반 종량제 API 키. `/logins zai`는 둘 중 하나를 저장하고 요금제를 기록합니다. `ZAI_API_KEY`도 동작하며, `ZAI_KEY_PLAN=coding|general`로 요금제를 지정합니다(설정하지 않으면 Mercury가 키 자체의 모델 목록에서 요금제를 읽습니다).
- **DeepSeek:** DeepSeek 플랫폼의 API 키(`/logins deepseek` 또는 `DEEPSEEK_API_KEY`).
- **xAI (Grok):** Grok 구독(SuperGrok / X Premium)으로 로그인하거나, `/logins xai`를 통해 API 키를 붙여 넣습니다.
- **Meta (Muse):** Sign in with Meta(Muse Code 구독, 브라우저의 기기 코드) 또는 종량제 Model API 키. Sign in with Meta는 Muse Code의 공개 클라이언트 ID로 Meta의 OIDC 엔드포인트(`https://auth.meta.com/oidc/device/authorization/` 및 `/oidc/device/token/`)에서 기기 코드를 교환합니다. 그 결과 얻은 계정 토큰은 `https://api.meta.ai/muse-code/key`로 한 번만 보내 구독용 API 키를 발급받는 데 쓰고(요금제의 등급과 사용 구간을 읽기 위해 제한된 `/usage` 조회에도 사용합니다), 이후 모든 모델 요청에는 발급된 키만 `https://api.meta.ai/v1`로 보냅니다. 붙여 넣은 Model API 키나 `MODEL_API_KEY` / `META_API_KEY`는 종량제로 과금됩니다.

- **Qwen:** QwenCloud 키(Token Plan 또는 종량제) 또는 Alibaba Cloud Model Studio 키(종량제, Token Plan 또는 Coding Plan). 저장하기 전에 자체 엔드포인트에서 검사하며, 요금제 키이면 그 요금제의 모델 목록이 표시되고 Qwen3.8 Max가 맨 앞에 옵니다.
- **MiniMax:** Open Platform 키 또는 M Plan 구독 키.
- **Together AI** 및 **Cohere:** API 키.
- **Groq**, **Cerebras** 및 **Fireworks AI:** API 키이며, 어떤 계열이든 키를 `credentials.keyCommands.<family>`에 지정된 명령에서 가져올 수도 있습니다.

Mistral, Nous Portal, OpenCode Zen도 `/logins`로 연결할 수 있으며, 로그인 제공자 계열은 모두 20개입니다. 로컬 모델 서버(Ollama, LM Studio, vLLM, llama.cpp)와 사용자 지정 OpenAI 호환 엔드포인트는 제공자 로그인 없이 사용할 수 있습니다. `/localsetup`을 실행하면 Ollama를 설치하거나 시작하고, 메모리에 맞는 모델을 내려받고, 컨텍스트 창을 설정하거나, 실행 중인 LM Studio, vLLM 또는 llama.cpp 서버에 연결할 수 있습니다([docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)). 각 제공자는 고유한 프로토콜, 자격 증명, 오류 처리를 사용하며, 요청이 다른 제공자로 넘어가는(폴백) 일은 없습니다. 자세한 내용은 [docs/ENGINES.md](../ENGINES.md)를 참조합니다.

`/llmhost`는 호스팅할 수 있는 모델을 나열하고, 각 모델을 지금 어디에서 실행할 수 있는지 보여 줍니다. 대상은 Runpod, Vast.ai 또는 Lambda에서 임대한 GPU, 사용자의 컴퓨터 또는 저장된 SSH 컴퓨터(`mercury host`), 또는 기존 모델 서버입니다. 각 모델 페이지에는 양자화 옵션, GPU 메모리 예산이 병렬 대화에 어떻게 나뉘는지(`conversations × context`), 그리고 기본 사고 수준(`/effort`로 요청마다 변경)이 표시됩니다. GPU 임대에는 명시적인 시간당 가격 확인이 필요하며, 팝업을 닫아도 설정은 백그라운드에서 계속됩니다. Runpod에서는 임대하기 전이나 실행 중인 pod에서 품질, 컨텍스트 분할, 사고 수준을 조정할 수 있고(`Tune`), 가중치를 빠르게 로드되는 볼륨에 보관할 수 있으며, 5초 간격의 재고 감시도 설정할 수 있습니다. Vast.ai와 Lambda 임대 기능은 1.0.0-beta.40에서 새로 추가되었으며, 공급업체가 공개한 API를 기준으로 테스트 픽스처에서 검증되었습니다(실제 임대 실행은 수행되지 않았습니다). 자세한 내용은 [docs/LLM-HOST.md](../LLM-HOST.md)를 참조합니다.

새 세션은 가장 최근에 연결한 제공자와, 그 계정이 사용할 수 있는 최신 모델을 사용합니다. 계정이 접근할 수 없는 모델은 건너뜁니다. 해당 제공자에 사용할 수 있는 모델이 없으면 Mercury는 그다음으로 가장 최근에 연결한 제공자를 확인합니다. 이 선택은 세션을 시작할 때 이루어지며, 기존 세션에서 실패한 요청은 원래 제공자에 머무릅니다.

`/model`은 선택 내용을 설명합니다. 계열 이름을 쓰면 그 계열의 가장 최신 모델이 선택됩니다. 예를 들어 `/model grok`, `/model deepseek`, `/model kimi`, `/model glm`이 있습니다. 연결된 제공자가 없으면 홈 화면과 `/model`이 `/logins`로 안내합니다. `/defaultprovider`로 제공자를 명시적으로 가장 최근의 선택으로 지정할 수 있습니다.

제공자 접근은 여전히 해당 제공자의 약관과 가용성에 따릅니다. Mercury의 라이선스는 그 약관을 대체하지 않습니다.

## 헤드리스 CLI: `mercury run`, Docker, JSON-RPC 러너

같은 빌드를 대화형 인터페이스 없이 실행할 수 있습니다. `node dist/mercury.mjs --help`는 모든 플래그를 나열합니다.

`mercury run "<prompt>"`는 터미널 UI 없이 프롬프트를 실행합니다:

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text`는 답변을 출력합니다. 실패한 턴의 이유는 stderr로 출력됩니다.
- `json`은 마지막 `outcome` 행을 JSON 객체 하나로 출력합니다.
- `rows`는 한 줄에 JSON 객체 하나씩 씁니다: `session`, 그다음 `turn`과 그 `text`, `reasoning`, `tool_call`, `tool_result`, `step` 행이 이어지며, 마지막은 `outcome`입니다. 대기, 도구 진행 상황, 백그라운드 작업, 알림도 각각 자체 행을 가집니다. 모든 행에는 `seq`, `timestamp`, `session_id`가 있으며, 턴 안의 행에는 턴 번호 `turn`도 있습니다. `seq`는 이번 실행의 스트림을 1부터 번호 매기고, `turn`은 세션의 턴을 셉니다. 따라서 저장된 대화를 이어 가는 실행(`-c`, `-r`, `--fork`)은 이미 들어 있는 턴 뒤에서 턴 번호를 매기며, 그 `session` 행은 `resume_of`에 이어 가는 대화를 적습니다.

출력 행의 종류는 `type` 필드로 구분합니다:

- `session`: 시작 행입니다. `version`, `build`(번들을 빌드한 트리의 처음 12자리 16진수 문자로, `mercury daemon status`가 출력하는 값과 같습니다. 번들 옆에 매니페스트가 없으면 생략됩니다), `resume_of`(이어 가는 실행에서는 이어 가는 대화의 세션 ID이며, 포크한 실행이 아니라면 `session_id`와 같습니다), `cwd`, `model`, `mode`, 세션이 가진 `tools`, `mcp_servers`, `commands`, `agents`, `skills`, `extensions`, 그리고 deny 규칙이 도구를 그 이름만으로 제외한 경우에만 있는 `tools_withheld`(각 항목은 `tool`, `rule`, `source`를 가집니다)를 포함합니다.
- `turn`: `started` 또는 `waiting` 상태의 턴이며 `turn_id`를 가집니다. 알려진 경우 `model`, `message_ids`, `agents` 개수도 포함됩니다.
- `text`: 확정된 텍스트 블록입니다. `message_id`, `block`, `text`와 `phase`(`commentary` 또는 `final_answer`)를 가집니다.
- `reasoning`: 확정된 추론 블록입니다. `message_id`, `block`, `text` 또는 `redacted: true`를 가집니다.
- `tool_call`: 도구 호출입니다. `call_id`, `tool`, `input`을 가지며, 함께 `message_id`와 `block`이 있습니다.
- `tool_result`: 호출의 결과입니다. `call_id`, `status`(`ok`, `error`, `aborted` 또는 `refused`), `output`을 가집니다. 모델이 구성을 잘못해 실행 전에 거부된 호출(알 수 없는 도구, 올바른 JSON이 아니거나 도구의 스키마에 맞지 않는 인수)도 짝을 받습니다. 전달된 인수를 담은 `tool_call` 행(인수가 객체가 아니었다면 `{}`)과, `tool_result` 행(status는 `refused`이고 `output`에 거부 이유가 담김)이 만들어지며, 그다음에 정정 `notice`가 이어집니다. 이런 호출은 실행되지 않았으며 거부(denial)도 아닙니다.
- `tool_update`: 실행 중인 도구의 진행 상황입니다. `call_id`, `tick`, `source`(`shell`, `powershell`, `mcp` 또는 `eval`)를 가지며, 호출이 보고하는 `line`, `elapsed_s`, `lines`, `bytes`, `budget_ms`, `progress`, `total` 중 해당하는 값도 포함됩니다. 셸 또는 PowerShell 호출은 출력이 도착할 때마다 tick을 냅니다(아무것도 출력하지 않는 명령은 tick을 내지 않습니다). MCP 호출은 서버가 진행 상황을 보고할 때, Eval 호출은 셀이 실행되는 동안 tick을 냅니다. 그 밖의 도구는 tick을 내지 않으며, Browser 또는 Crewmate 호출은 결과가 나올 때까지 아무것도 내지 않습니다.
- `step`: 메인 스레드의 모델 호출 한 번입니다. `message_id`, `model`, `usage`를 가지며, 모델이 멈춘 이유를 알려 준 경우 `stop`도 있습니다.
- `outcome`: 턴의 결과이며, 아래에서 설명합니다.
- `close`: 종료 시 다음 세션을 위해 남긴 노트입니다. `state`(`stored`, `skipped` 또는 `none`), `note_chars`, 그리고 노트를 작성한 모델 호출의 `usage`를 가집니다. 따라서 모든 행의 usage를 더하면 outcome의 usage와 맞습니다. 프롬프트를 인수로 주면 노트는 마지막 턴 안에서 요청되며, `close`는 그 턴의 `outcome` 앞에 옵니다. `--input rows`를 쓰면 표준 입력이 닫힌 뒤 마지막 `outcome` 다음에 옵니다.
- `wait`: 모델을 기다리는 상태입니다. `state`(`first_byte`, `retry`, `silence`, `loading` 또는 `done`)와 그 상태가 가진 수치를 가집니다. 예를 들어 `since_ms`, `attempt`와 `of`, `delay_ms`, `reason`, `http_status`가 있습니다.
- `heartbeat`: 모델 스트림이 최소 1초 동안 해석된 이벤트 없이도 살아 있음을 보였습니다. 즉, 행을 만들지 않은 바이트가 도착했습니다. 이 행은 다른 내용을 담지 않으며 최대 1초에 한 번 나옵니다. 얼마나 자주 나오는지는 제공자의 스트리밍 방식에 따라 다르므로, 이벤트 사이에 멈추지 않는 스트림은 이 행을 내지 않습니다.
- `compaction`: 컴팩션이 `started`, `progress`, `ended` 상태로 진행됩니다. `trigger`(`manual`, `auto` 또는 `overflow`), `stage`, `fill`, `summary_tokens`를 가지며, 끝날 때는 `exit`(`landed`, `cancelled` 또는 `failed`)도 있습니다.
- `mode`: 권한 모드가 바뀌었습니다. `mode`를 가집니다.
- `rate_limit`: 제공자의 한도 상태입니다. `status`(`allowed`, `warning` 또는 `rejected`), `window`, `resets_at`, `utilization`과 초과 사용(overage) 필드를 가집니다.
- `task`: 백그라운드 작업이 `started`, `progress`, `ended` 상태로 진행됩니다. `task_id`, `task_type`, `description`, `usage`, `summary`, `status`(`completed`, `failed` 또는 `stopped`)를 가지며, `output_file`은 알려지는 대로 채워집니다.
- `notice`: 독자에게 전하는 `warning` 또는 `error`입니다. `text`와 `code`(예: `input_refused`)를 가집니다.
- `command_output`: 모델에 전달되지 않은 슬래시 명령의 출력입니다. `command`와 `text`를 가집니다.
- `mission_updated`: 세션의 작업 장부가 바뀌었습니다. 다시 읽어야 합니다.
- `samples_updated`: 세션의 샘플이 바뀌었습니다. 다시 읽어야 합니다.

`--partial`을 `--format rows`와 함께 쓰면 `block_start`, `text_delta`, `reasoning_delta`, `tool_input_delta`, `retracted` 행이 추가됩니다. 델타는 `message_id`와 `block`에 속하며, `retracted` 행은 해당 메시지의 델타를 철회합니다. 확정된 text 행 또는 tool 행이 완전한 값입니다.

outcome에는 `schema`, `turn_id`, `status`, `steps`, `wall_ms`, `usage`, `models`, `denials`가 있으며, 완료되면 `answer`가, 실패하면 `error`(`message`, `class`, 선택적 `detail`)가 붙습니다. `stop`, `api_ms`, `cost_usd`, 요청한 `structured` 출력, `notices`는 사용할 수 있을 때 포함됩니다. `wall_ms`는 턴의 경과 시간입니다. `api_ms`는 턴이 보낸 모든 모델 요청 소요 시간의 합입니다(재시도와, 메인 스레드와 함께 실행된 crewmate의 요청도 포함하므로 요청이 겹치면 `wall_ms`보다 커질 수 있습니다). `cost_usd`는 상태와 관계없이, 턴에서 가격이 매겨진 요청의 USD 합계입니다. Mercury가 가격을 매길 수 없는 요청(등록된 요금이 없거나 응답에 비용이 적혀 있지 않은 경우)은 이 값에 아무것도 더하지 않으며, 그 모델은 `models`에 자체 `cost_usd` 없이 그대로 나열됩니다. 이 필드는 턴에서 가격이 매겨진 것이 하나도 없을 때만 빠집니다. Claude 구독 로그인에서는 Anthropic 요청에 달러 가격이 없으므로, 그 요청도 해당 행도 `cost_usd`를 가지지 않으며, usage는 그대로 남습니다. usage에는 `input_tokens`(캐시된 토큰 포함), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, 그리고 보고된 경우 `reasoning_output_tokens`가 있으며, 메인 스레드와 crewmate를 합산한 값입니다. `models`는 토큰 사용량을 모델별로 나눕니다. `steps`는 메인 에이전트의 모델 호출만 셉니다. crewmate가 한 모델 호출은 자체 `step` 행(`parent_call_id` 표시 포함)으로 나타납니다.

status는 `completed`, `blocked`, `refused`, `failed`, `interrupted`, `turn_limit`, `budget_limit`, `time_limit`, `schema_unmet`, `loop_stopped` 중 하나입니다. `--max-time`(초 단위, 또는 `10m`, `1h`)으로 실행하면 시간이 다 된 뒤 다음 단계에서 `time_limit`으로 끝나며, 진행 중인 모델 호출이나 도구 라운드는 잘리지 않습니다. 완료된 실행은 종료 코드 0으로 끝나고, 그 밖의 결과는 1, 사용 오류는 2로 끝납니다. SIGINT와 SIGTERM은 중단된 턴의 outcome이 출력(flush)된 뒤 각각 130과 143으로 종료합니다. 거부된 도구 호출은 `denials`에 나열됩니다. 거부가 아무도 답할 수 없었던 승인 요청이었고(승인을 묻는 모드인데 호스트가 없는 경우, `--mode dontAsk`, 또는 호스트의 승인 요청이 만료된 경우), 같은 턴의 이후 도구 호출이 성공하지 않으면 실행은 `blocked`가 됩니다. 이때 답변은 보존되고, `error`에는 도구 이름과 재개 방법(`--allowed-tools`, 다른 `--mode`, 또는 승인 요청에 답하는 호스트)이 적히며, 실행은 종료 코드 1로 끝납니다. 같은 턴의 이후 도구 호출이 성공하면 턴은 복구되어 `completed`(종료 코드 0)로 끝나며, 경고 `notice`(`"<Tool> was not approved; the run continued with other tools."`)가 붙습니다. 사용자가 직접 답한 거부(deny 규칙, 훅, 또는 거절한 호스트를 통한 거부)는 완료된 턴을 그대로 완료 상태로 둡니다. 응답되지 않은 `AskUserQuestion` 호출도 실행을 `blocked`로 끝내며, 질문은 `error`에 인용됩니다. Mercury는 결과를 응답 텍스트가 아니라 실행이 기록한 질의(ask)에서 읽으므로, 응답 텍스트에만 적힌 질문은 실행을 `completed`로 끝냅니다. 알 수 없는 슬래시 명령은 `refused`로 끝나며, 대화형 화면이 보여 주는 것과 같은 문장(`Unknown command: /name · /help lists commands`)을 출력하고 종료 코드 1로 끝납니다.

`--input rows`는 `--format rows`가 필요하며, 한 줄에 입력 객체 하나씩 읽습니다:

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

입력 유형은 다음과 같습니다. `prompt`(텍스트 또는 텍스트/이미지 블록인 `content` 포함), `shell`(`command` 포함), `note`(에이전트 ID인 `to`와 `content` 포함)입니다. 모든 항목은 선택 사항인 `id`를 받을 수 있으며, prompt와 shell 행은 `priority`(`now`, `next` 또는 `later`), `sent_at`, `origin`도 받습니다. 거부된 입력 형태는 `notice`(코드 `input_refused`)를 만들고, 형식이 잘못된 JSON은 실행을 끝냅니다. 이 행들은 입력만 담으며, 권한 응답은 아래의 러너 프로토콜을 사용합니다.

`mercury run -`를 사용하거나 텍스트를 `mercury run`으로 파이프하면 표준 입력에서 프롬프트 전체를 읽습니다. 프롬프트 인수와 함께 쓰면 파이프로 받은 텍스트가 구분된 컨텍스트로 덧붙습니다. 파이프는 닫히거나 1초 동안 조용해질 때까지 읽으므로, 계속 데이터를 보내는 스트림은 끝까지 읽히고, 열린 채 조용히 있는 파이프는 실행을 붙잡아 두지 않습니다. 프롬프트가 없고 표준 입력이 터미널이면 `run`은 사용법을 출력하고 종료 코드 2로 끝납니다.

`--mode <mode>`는 권한 태세(posture)를 고릅니다. `--sovereign`은 권한 확인 없이 실행하며, `--allow-sovereign`은 나중에 전환할 수 있도록 그 태세를 사용 가능하게 합니다. 권한 정책과 deny 규칙은 여전히 적용됩니다. root 사용자가 sovereign 모드에 들어가면 stderr로 알림이 한 번 표시되며, 실행은 계속됩니다.

`-c`는 가장 최근 대화를 이어 가고, `-r`은 ID, 제목 또는 선택기로 재개하며, `-w`는 관리형 워크트리에서 실행하고, `--lean`은 최소 세션을 만듭니다. `run`에는 권한 질의에 답할 호스트가 없습니다. 무엇을 실행할 수 있는지는 권한 규칙과 모드가 정하며, 여전히 승인이 필요한 호출은 거부됩니다.

### 헤드리스 이미지

저장소 루트의 `Dockerfile`은 CI와 서버용 Linux x64 이미지를 빌드합니다. 진입점은 `mercury`이고 기본 명령은 `run`이므로, 이 이미지는 마운트된 트리에 대해 프롬프트 하나를 실행하고 실행의 종료 코드로 끝납니다:

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

이미지에는 번들, Node 24 런타임(`PATH`에 있음), 포함된 검색, 셸, 디버거, 언어 및 이미지 도구, `git`, 인증서 저장소가 들어 있습니다. 진입 화면과 로그인 흐름은 없습니다. 이미지는 root가 아닌 사용자 `mercury`로 실행되며, 설정 홈은 컨테이너 안(`MERCURY_CONFIG_DIR`)에 있고, `/work`가 작업 디렉터리입니다. 색상과 마우스는 제품 고유의 터미널 감지를 따르며, `--user 0`으로 실행하면 root로 동작하면서 위에서 설명한 sovereign 알림이 함께 표시됩니다.

제공자 키는 환경 변수로 전달하며, 철자는 제품 전체에서 읽는 것과 같습니다. `ANTHROPIC_API_KEY` 또는 `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` 또는 `GOOGLE_API_KEY`, `XAI_API_KEY`(사용량 미터용 `XAI_MANAGEMENT_API_KEY` 포함), `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY`(조직 미터용 `MISTRAL_ADMIN_API_KEY` 포함), `NOUS_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`, `TOGETHER_API_KEY` 또는 `TOGETHER_AI_API_KEY`, `COHERE_API_KEY` 또는 `CO_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `DASHSCOPE_API_KEY`, `MODEL_API_KEY` 또는 `META_API_KEY`, 사용자 지정 OpenAI 호환 엔드포인트용 `MERCURY_COMPAT_API_KEY`, 로컬 서버용 `MERCURY_LOCAL_API_KEY`입니다. 키가 없으면 실행은 한 줄짜리 거부 메시지를 내고 종료 코드 1로 끝납니다. `docker run -i … mercury run -`는 표준 입력에서 프롬프트를 읽습니다.

### 세션 호스팅하기

`mercury runner`는 stdio를 통해 세션을 호스트에 제공합니다. 메시지는 JSON-RPC 2.0이며 한 줄에 메시지 하나입니다. 호스트는 먼저 `initialize`를 보내고, 작업을 보내기 전에 응답을 기다립니다:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

호스트의 이름과 버전은 `host` 아래에 담기고, `capabilities`는 `holds_asks`, `elicitation`, `partial_rows`를 선언합니다. 모든 요청의 `id`는 양의 정수여야 합니다. `id`가 그 밖의 값인 요청에는 `-32600`(`id: null` 포함)으로 응답하므로, 요청 번호는 1부터 매깁니다.

`queue/add`는 위의 행 입력과 같은 prompt, shell 또는 note 객체를 받습니다. 출력은 `row` 알림으로 도착합니다. `session/facts`는 세션의 상태를 읽고, `session/set_mode`는 권한 모드를 즉시 바꿉니다. `session/set_model`과 `session/set_effort`는 모델과 사고 수준(effort)을 바꾸며, 턴이 실행 중일 때 한 변경은 턴이 끝날 때까지 보류됩니다. 이때 응답에는 `at: "turn_end"`이 담기고, 그다음 `session/applied`가 이를 알립니다. `turn/interrupt`는 턴을 중단하며, stdin을 닫으면 세션이 끝납니다.

권한 질의는 `permission/request`로 도착하며, `kind: "tool"` 또는 `kind: "network"`가 함께 옵니다. 호스트는 `outcome: "allow"` 또는 `outcome: "deny"`로 응답합니다. allow에는 수정된 `input`과 권한 `rules`가 함께 올 수 있습니다. 철회된 질의는 `$/cancel_request`를 해당 `request_id`와 함께 보냅니다. `holds_asks`는 질의의 타이머를 호스트가 맡게 합니다. MCP 질문은 `elicitation/request`를 사용하며(호스트가 `elicitation`을 선언한 경우에만), 그렇지 않으면 `cancel`로 응답합니다.

알 수 없는 메서드에는 `-32601`, 잘못된 매개변수에는 `-32602`, 양의 정수가 아닌 `id`에는 `-32600`, 초기화 전의 요청에는 `-32002`로 응답합니다. 규칙에 의한 거부는 `-32010`이며, `error.message`에는 문장이, `error.data.kind`에는 `mode`, `model`, `effort`, `claim` 같은 이유가 담깁니다. 러너는 형식이 잘못된 줄에 `-32700`으로 응답하고 계속 실행하며, 연속으로 세 줄이 잘못되면 실행을 끝냅니다.

### 기타 명령

사용할 수 있는 명령에는 다음이 포함됩니다:

- **`mercury health`**: 진단 보고서입니다(health certificate라고도 합니다). `--json`은 전체 보고서를 반환하고, `--deep`은 상세 인벤토리를 실행하며, `--fix`는 안내된 수정을 실행합니다.
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**: 로그인(`login [<family>]`), 제공자 계열 목록 보기(`list`), 계정의 로그인 여부 확인(`status [<family>]`), 로그아웃(`logout [<family>]`), 또는 장기 사용 Anthropic 토큰 발급(`mint`)을 수행합니다.
- **`mercury models [--json]`**: 로그인된 계정이 접근할 수 있는 모델을 출력합니다(`mercury://models`와 같은 정보).
- **`mercury mcp`**: `add`, `import`, `list`, `get`, `remove`, `trust-reset`, `serve`로 MCP 서버를 관리합니다.
- **`mercury extensions`**: 확장을 설치하고 그 소스를 관리합니다. 동작은 다음과 같습니다: `list`, `sources`, `add`, `remove`, `refresh`, `install`, `trust`, `enable`, `disable`, `update`, `uninstall`, `fence`, `unfence`, `inspect`, `scaffold`.
- **`mercury roster`**: 에이전트 목록을 보여 줍니다.
- **`mercury usage`**: `/usage` 화면이 보여 주는 간결한 수치 한 줄을 출력합니다. `--json`은 전체 값을 출력하며, 여기에는 로그인된 각 제공자의 사용 구간(사용량과 초기화 시점 포함), 제공자가 밝힌 수치와 크레딧(각각 출처와 경과 시간 포함), 모델별 세션 지출이 들어 있습니다. 화면이 읽는 방식과 같은 방식으로 읽으며, 로그인된 각 제공자의 리더는 화면을 열 때와 마찬가지로 한 번씩 샘플링됩니다.
- **`mercury daemon run|status|stop|restart`**: 백그라운드 데몬을 실행, 상태 확인, 중지, 재시작합니다. 데몬의 세션 좌석(seat)은 `mercury runner` 자식 프로세스이며, 데몬이 그 프롬프트를 보내고 권한 질의를 호스팅합니다.
- **`mercury sessions list`**(또는 인수 없는 `mercury sessions`): 이 프로젝트의 저장된 세션을 최신순으로 나열합니다. 각 항목에는 ID, 마지막으로 쓰인 시각, 크기, 데몬이 지금 호스팅 중이면 `live`, 제목 또는 첫 프롬프트가 표시됩니다. `--all`은 모든 프로젝트를 읽고, `--limit <n>`은 목록 개수를 제한합니다. ID는 `mercury --resume <id>`로 다시 열고 `sessions delete`로 삭제하는 값입니다.
- **`mercury sessions delete <id>`**: 저장된 세션 하나를 의도적으로 삭제합니다. 전사본(transcript)과 옆에 보관된 기록(영수증, 재개 스냅샷)도 함께 삭제되며, 확인 질문을 한 뒤 삭제합니다. 스크립트에서는 `--yes`로 질문을 건너뜁니다. 데몬이 지금 호스팅하는 세션은 거부되며, 알 수 없는 ID는 목록(roster)을 안내하는 힌트와 함께 거부됩니다(Mercury 안에서는 `/sessions`). 그 밖에 저장된 세션은 스스로 삭제되지 않습니다.
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**: 같은 설정 홈을 공유하는 모든 세션을 위해 로컬 또는 SSH 컴퓨터를 모델 서버로 실행합니다(`compat/box-<name>/<model>`). 검증된 로컬 가중치 뱅크나 확인된 다운로드를 사용합니다. [docs/LLM-HOST.md](../LLM-HOST.md)를 참조합니다.
- **`mercury lsp list`** 및 **`mercury lsp install <server>`**: 언어 서버 카탈로그를 보여 줍니다. 각 서버는 설치됨(바이너리 포함) 또는 없음(설치 방법 포함)으로 표시됩니다. `install`은 서버의 설치 방법을 보여 주고, 확인을 묻고, 그 명령을 정확히 그대로 실행하며(`--yes`는 스크립트에서 질문을 건너뜁니다), 바이너리가 놓인 위치를 보고합니다. 알 수 없는 서버는 목록(roster)과 함께 거부됩니다. Mercury는 언어 서버를 스스로 설치하지 않습니다. 파일을 열면 이미 설치된 서버만 시작됩니다.
- **`mercury acp`**: Agent Client Protocol을 통해 에디터에 서비스를 제공하며, 세션마다 runner 자식 프로세스를 하나씩 둡니다. `mercury bridge install`은 VS Code 확장을 설치하고, `mercury bridge status`는 상태를 확인하며, `mercury bridge uninstall`은 이를 제거합니다.
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**: 현재 디렉터리의 Godot 프로젝트에 대한 엔진 작업을 관리합니다. Mercury는 고정된 프로젝트 사본을 기반으로 자체 헤드리스 워커에서 스위트(suite)를 실행합니다. 이 서비스에는 컴파일 게이트, 캡처, 프레임 통계, 안정된 프로파일, 작업 큐 접근, 취소, ID별 결과가 포함됩니다. [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md)를 참조합니다.
- **`mercury image <image>`**: 터미널에서 이미지를 표시합니다.
- **`mercury install`** 및 **`mercury update`**(별칭 `upgrade`): 릴리스 아카이브를 설치하거나 업데이트합니다. `--json`을 쓰면 판정 결과와 상관없이 문서가 stdout에 출력되며, 실패 여부는 종료 코드로 알 수 있습니다. [설치](#설치)를 참조합니다.
- **`mercury version`** 및 **`mercury help [command]`**: 버전 한 줄 또는 도움말 페이지를 출력하며, `--version`, `--help`와 같습니다. 어느 쪽도 세션을 시작하지 않습니다.

## 내부 구성: Mneme RAG 메모리, LSP, 23개 언어 AST, DAP 디버거, 웹 검색 및 브리지

- **Mneme 하이브리드 RAG 프로젝트 메모리.** Mneme은 기본으로 켜져 있으며, 프로젝트마다의 사실을 일반 마크다운 주제 페이지에 보관합니다(`Retain`, `Recall`, `Reflect`, `Correct`). Recall은 기기 내에서 실행되는 118 MB BGE 시맨틱 임베딩 모델(`bge-base-en-v1.5` `q8_0`, MIT 라이선스, 모든 릴리스 아카이브에 포함되며 각 플랫폼용으로 빌드됨; [선택 구성 요소](#선택-구성-요소) 참조)을 사용하고, 어간 추출(stemming)을 거친 BM25 단어 순위, 최신성 가중치, 상호 순위 융합(reciprocal rank fusion, `k = 60`)을 통한 인용 추적과 결합합니다. 고정 규칙(`pin: true`)은 고정 선반(pinned shelf)에 원문 그대로 로드되며, 사용자가 말한 경우에만 바뀝니다. 세션이 시작되면 Mercury는 고정되지 않은 사실과 이전 노트를 현재 브랜치, 최근에 수정한 파일, 지난 세션의 인계 노트를 기준으로 점수화합니다. 이 작업은 전용 시작 한도(`memory.startLimit`, 기본값 4,000자) 안에서 이루어집니다. 쓰기 시점의 모순 검사는 충돌하는 사실을 저장하기 전에 극성, 부정, 숫자 뒤집힘을 잡아냅니다. 각 세션은 종료할 때 자기 말로 된 인계 노트를 작성해 다음 세션의 진입 페이지에 남기며, 선택 사항으로 세션 저널 항목도 기록합니다. `/memory`는 메모리 센터를 열고, `/memory page`는 라이브러리를 브라우저에서 노드와 간선으로 된 그래프로 그립니다. [docs/MNEME.md](../MNEME.md)를 참조합니다.
- **LSP 코드 인텔리전스, 23개 언어 AST 재작성, DAP 디버거, `Eval` 셀.** 앵커(anchor) 기반 읽기와 원자적인 여러 파일 편집(`ChangeSet`), 언어 서버 질의(`LspRead`), 미리보기 후 적용하는 리팩터링(`LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`)을 제공합니다. 구문 트리 검색과 재작성(`AstSearch`, `AstEdit`)은 `$NAME`과 `$$$NAME` 메타 변수를 사용하며, 릴리스 아카이브의 23개 문법(grammar)을 지원합니다(모든 `bun install` 빌드의 16개와 문법 팩의 7개). 지속되는 Python(`python3`) 및 JavaScript(Node ES 모듈) 코드 셀(`Eval`)도 있습니다. Debug Adapter Protocol 디버거(`Debug`)는 `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`, `netcoredbg`, `rdbg`, Dart SDK의 디버그 어댑터, `kotlin-debug-adapter`, elixir-ls 디버그 어댑터, Godot을 구동합니다. `Test` 도구의 `debug` 동작은 실패한 Python(`pytest`, `unittest`), JavaScript/TypeScript(`node-test`, `vitest`, `jest`), Go(`go test`), Rust(`cargo test`) 테스트를 곧바로 `Debug` 세션에 넣어 단계별로 실행합니다. [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md), [변경 트랜잭션](../CHANGE-TRANSACTIONS.md), [구조 패턴](../STRUCTURAL-PATTERNS.md), [코드 셀](../EVAL.md), [디버거](../DEBUGGER.md)를 참조합니다.
- **키 없이 사용하는 `WebSearch`와 마크다운 `WebFetch`.** `WebSearch`는 정해진 순서의 단계를 따릅니다. 먼저 세션 모델이 지원하면 제공자 고유의 실시간 검색(`ProviderSearch`)을 쓰고, 그다음 저장된 Brave 또는 Tavily 키, 질의 형태에 따라 선택되는 공식 API(Stack Exchange, npm, PyPI, crates.io, GitHub 코드 검색, Hacker News Algolia, Wikipedia), 설정된 SearXNG JSON API(`MERCURY_SEARCH_SEARXNG_INSTANCES`)를 사용합니다. 마지막으로 키가 필요 없는 DuckDuckGo 페이지 스크래핑을 사용합니다(기본으로 켜져 있으며, `/config`에서 끄거나 `MERCURY_SEARCH_KEYLESS=0`으로 끌 수 있습니다). 모든 답변은 2,000 토큰 이하로 유지되며, 답변한 출처를 밝힙니다. `WebFetch`는 38,000자 호출 예산 안에서 공개 페이지를 페이지 자체의 표현 그대로 마크다운으로 읽습니다(브라우저가 필요한 페이지는 호스팅된 리더 `r.jina.ai`를 통해 읽으며, `MERCURY_FETCH_READER=0`을 설정한 경우는 제외됩니다. 사설 네트워크 주소는 이 리더로 전송되지 않습니다). [docs/ENGINES.md](../ENGINES.md)를 참조합니다.
- **에이전트, 교차 제공자 crewmate(`Crewmate`), 워크트리, 파일 리스.** 내장 에이전트 두 개(`mercury-crew`: 위임된 모든 종류의 작업용, `mercury-scout`: 읽기 전용 정찰용)가 `/agents`에서 만드는 에이전트 정의 옆에 함께 있습니다. 로그인된 제공자라면 어디에서든 crewmate를 실행할 수 있고, 병렬 작업은 `git worktree` 체크아웃(`isolation: "worktree"`)으로 격리합니다. 공유 파일은 프로세스 내 프로젝트 파일 리스(`mcp__mercury__lease_take`, `mcp__mercury__lease_release`, `mcp__mercury__lease_list`)로 조율합니다. `SendMessage`와 `ResumeCrewmate`로 이름이나 ID를 기준으로 crewmate에 지시하거나 재개할 수 있습니다. `/crewmates`와 `/runs`에서 crewmate와 워크플로 실행을 따라갈 수 있습니다. [docs/CREW.md](../CREW.md)를 참조합니다.
- **데스크톱 컴퓨터 사용.** 네이티브 데스크톱 드라이버를 사용할 수 있으면 기본으로 켜집니다. `Computer` 도구는 스크린샷을 캡처하고, 전경 애플리케이션의 마우스와 키보드를 제어합니다. Mercury는 행동하기 전에 이름과 정체를 기준으로 애플리케이션을 확인하고, 사용자의 권한 규칙, 세션 허용, 접근 설정 또는 권한 모드가 이미 그 동작을 허용하지 않는 한 승인을 요청합니다. `Esc`를 누르면 멈추며, 한 번에 한 세션만 데스크톱을 제어하도록 하고, 스크린샷은 저장된 대화 파일에 남기지 않습니다. 도구를 제거하려면 `MERCURY_COMPUTER_USE=0`을 설정합니다. [docs/COMPUTER-USE.md](../COMPUTER-USE.md)를 참조합니다.
- **기기 내 Whisper 음성 입력(`/voice`).** `/voice on`은 처음 사용할 때 60 MB 영어 음성 모델(`base.en-q5_1`)을 내려받고, SHA-256 다이제스트를 검증한 뒤 받아쓰기를 켭니다. `/voice off`는 받아쓰기를 끕니다. 스페이스를 1초 동안 누르고 있으면 말하기 시작하고, 놓으면 멈춥니다. 또는 음성이 켜진 상태에서 인수 없이 `/voice`를 실행해 테이크(take)를 시작하고 멈출 수 있습니다. Whisper는 기기 안에서 변환하므로 음성 오디오는 기기 밖으로 나가지 않으며, `MERCURY_WHISPER_MODEL`로 `tiny.en-q5_1`, `small.en-q5_1`, 다국어 `base-q5_1`, 또는 로컬 `.gguf` 파일을 고를 수 있습니다. [docs/VOICE.md](../VOICE.md)를 참조합니다.
- **Saturn 크론 및 세션 스케줄러(`/saturn`).** 기존 세션에 프롬프트를 예약하거나(`CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, `/loop`), 정해진 시각에 시작하는 새 세션을 예약합니다. 예약은 한 번 실행하거나 반복할 수 있습니다. [docs/SATURN.md](../SATURN.md)를 참조합니다.
- **VS Code(ACP), Unity, Blender, Godot, Aseprite 브리지.** `mercury acp`는 Agent Client Protocol을 지원하는 에디터에 연결합니다. VS Code 확장(`mercury bridge install`)은 그 프로토콜을 통해 에디터 안에서 Mercury를 실행합니다. 채팅, 세션, 에이전트, 아티팩트, 리뷰를 다루며, 에디터의 선택 영역과 진단 정보가 각 프롬프트에 함께 실립니다. 별도의 선택적 통합 기능은 실행 중인 Unity(`MERCURY_UNITY=1`), Blender(`MERCURY_BLENDER=1`), Godot(`MERCURY_GODOT_TOOLS=1`) 에디터에 연결하며, Aseprite(`MERCURY_ASEPRITE=1`)에는 일괄 처리 방식으로 접근합니다. [Unity](../UNITY-BRIDGE.md), [Blender](../BLENDER-BRIDGE.md), [Godot](../VULCAN-GODOT-TOOLS.md), [Aseprite](../ASEPRITE-BRIDGE.md)를 참조합니다.
- **확장.** 각 확장에는 매니페스트가 하나씩 있습니다. 소스는 git URL, 로컬 폴더 또는 아카이브에서 추가하며, 기여(contributions) 해시로 승인됩니다. [docs/EXTENSIONS.md](../EXTENSIONS.md)를 참조합니다.
- **MCPs & Skills.** 세션이 로드하는 항목을 저장소별로 설정하며, 이름이 붙은 프리셋과 세션 중에 바꿀 수 있는 컨트롤을 제공합니다. [docs/KIT.md](../KIT.md)를 참조합니다.
- **진단.** 헬스 체크와 `/health`는 진단 증거에 근거한 보고서를 만들며, 판정은 `certified`, `caution`, `fault` 중 하나입니다. 검증된 수정 방법도 제공합니다. [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md)를 참조합니다.
- **신뢰와 권한.** 작업 공간 신뢰, 권한 규칙과 모드, 그리고 모든 세션이 거부하는 명령. [docs/TRUST.md](../TRUST.md)를 참조합니다.
- **Apollo Mode**, 사양 인터뷰: 에이전트의 질문에 답해 프로토타입을 만드는 데 쓸 사양을 완성합니다. [docs/APOLLO-MODE.md](../APOLLO-MODE.md)를 참조합니다.
- **복구.** 원자적 게시, 저널에 기록되는 작업, 시작 시 조정(reconciliation). [docs/DURABILITY.md](../DURABILITY.md)를 참조합니다.

런타임 플래그는 `src/substrate/flagRegistry.ts`에 정의되며, `MERCURY_*` 설정으로 노출되고 필요할 때 렌더링됩니다. 통합 호환성은 [docs/COMPATIBILITY.md](../COMPATIBILITY.md)에 문서화되어 있습니다. 전체 문서 색인은 [docs/README.md](../README.md)에 있습니다.

## 슬래시 명령

`/help`는 사용할 수 있는 대화형 명령을 나열합니다. 퍼지 명령 검색에는 `/palette`를 사용합니다. 아래 표는 `/help`에서 쓰는 범주에 따라 기본으로 켜진 내장 명령을 묶습니다. 실시간 목록에는 `/samples`(`current work` 아래에 표시되며, `MERCURY_SAMPLES=1` 또는 Boot Menu의 Samples 행으로 Samples가 켜져 있을 때), `/showcase`(`MERCURY_DEV_SURFACES=1`이 설정되어 있을 때), 그리고 모든 스킬 또는 확장 명령도 포함됩니다.

| 영역 | 명령 |
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

| 명령 | 기능 |
| --- | --- |
| `/llmhost` | Runpod, Vast.ai 또는 Lambda에서 임대할 모델을 고르거나, 사용자의 컴퓨터에서 실행하거나, 기존 서버를 연결합니다. |
| `/restart` | 이 채팅을 설치된 Mercury 빌드로 옮깁니다. 실행 중인 watch와 백그라운드 셸은 중지됩니다. |
| `/mcp` | 서버를 점검하고, 로그인하고, 각 서버의 도구와 매개변수를 살펴보고, 다시 연결하거나, 이 채팅에서 서버를 켜거나 끕니다. |

`/mouse off`는 마우스 포인터를 터미널에 돌려주어 네이티브 텍스트 선택과 복사가 가능하게 합니다. 이 설정은 저장되며 `/config`에 Mouse capture 항목으로 나타납니다.

스킬 사용법에서 필수 인수는 `<…>`로 시작합니다. 예를 들어 `/update-config`와 `/debug`는 인수가 필요합니다. 인수 없이 명령만 보내면 설명과 사용법이 표시되며, 턴은 시작되지 않습니다. 자동 완성(typeahead) 목록에서 고르고 Enter를 누르면 `/name `이 입력된 상태로 남아 인수를 추가할 수 있습니다. `/loop`에는 필수 인수가 없으며 바로 실행됩니다.

## 문제 보고하기

간단히 보고하려면 [테스터 양식](https://mercury-cli.ai/report)이나 Mercury 안의 `/bug --short <what you tried>`를 사용합니다. 운영체제, 시도한 내용, 고장 난 내용을 묻습니다. 헬스 덤프(health dump)는 필요하지 않습니다.

Mercury 안에서 `/bug <what happened>`를 실행하면, 로그인된 GitHub CLI(`gh`)로 제출하기 전에 보고서를 미리 볼 수 있습니다. `gh`가 없으면 Mercury는 설정 홈 아래에 로컬 초안을 저장하고, 저장소의 이슈 페이지를 안내합니다.

버그, 제공자/모델, 기능 요청 템플릿 중 하나를 사용해 이슈를 직접 열 수도 있습니다. `--version` 출력, 운영체제, 터미널, 정확한 재현 단계를 포함합니다. 버그 및 제공자 보고에는 `mercury health --json`도 필요하며, 소스 빌드라면 `node dist/mercury.mjs health --json`을 사용합니다. 실패한 화면의 전사본이 도움이 됩니다.

보안 문제는 저장소의 Security 탭을 통해 비공개로 보고합니다. 공개 이슈로 올리지 않습니다. [SECURITY.md](../../SECURITY.md)를 참조합니다. [CONTRIBUTING.md](../../CONTRIBUTING.md)는 이슈, 풀 리퀘스트, 검사를 다룹니다.

## 라이선스

Mercury CLI는 [LICENSE.md](../../LICENSE.md)에 있는 Apache License 2.0(`Apache-2.0`)에 따라 라이선스가 부여됩니다. [sdk/](../../sdk/) 및 [sdk-py/](../../sdk-py/)의 TypeScript 및 Python SDK(npm과 PyPI의 `mercury-cli-sdk`)도 Apache License 2.0(`Apache-2.0`)에 따라 라이선스되며, 각 SDK에 포함된 LICENSE 파일([sdk/LICENSE](../../sdk/LICENSE), [sdk-py/LICENSE](../../sdk-py/LICENSE))을 따릅니다.

Mercury 이름과 표장의 사용에는 [상표 정책](../../TRADEMARKS.md)이 적용됩니다. 번들로 포함된 제3자 라이선스는 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)에 나열되어 있습니다.
