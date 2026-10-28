[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI（mercury-cli.ai，npm 套件 `mercury-tech-cli`）在終端機中執行 AI 程式設計代理人，工作於你自己的 git 儲存庫內，支援 macOS、Linux 與 Windows。

網站：[mercury-cli.ai](https://mercury-cli.ai) · 儲存庫：[github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI)（`Whq02/MercuryCLI`）· npm：`mercury-tech-cli`

代理人會讀取與編輯檔案、執行 shell 指令、逐步執行測試與偵錯器，並檢查結果。你可以選擇模型供應商、模型，以及允許代理人執行哪些操作：

- **多工作階段 Concourse 與隔離的工作樹：** 可在 Session Concourse（`/concourse`）上並排執行多個工作階段，並將平行工作委派給跨供應商的 crewmate（`Crewmate`）。它們會在隔離的 `git worktree` 檢出副本中工作，並透過專案檔案租約，讓平行的代理人不會互相覆寫。
- **20 個模型供應商、`/llmhost` 與 `/localsetup`：** 可同時保持全部 20 個供應商都已登入（OpenAI、Anthropic、Google Gemini、DeepSeek、Moonshot/Kimi、Z.AI/GLM、OpenRouter、Hugging Face、xAI/Grok、Meta/Muse、Mistral、Nous Portal、OpenCode Zen、Qwen、MiniMax、Together AI、Cohere、Groq、Cerebras、Fireworks AI），並可在對話中切換供應商與模型。開啟 `/llmhost` 即可選擇模型、檢視其量化方式、`conversations × context` 的切分方式與思考層級，然後在租用的 GPU（Runpod、Vast.ai 或 Lambda）上、在你自己的電腦（`mercury host`）上，或在既有的伺服器上執行。也可以執行 `/localsetup`，安裝或連接 Ollama，並與 LM Studio、vLLM 與 llama.cpp 並列使用。
- **Mneme 混合 RAG 專案記憶：** 使用裝置端的 118 MB BGE 語意嵌入模型（`bge-base-en-v1.5`），並包含 BM25 詞彙排序與引用追蹤、逐字保留的釘選規則、感知分支的啟動上下文、寫入時的矛盾檢查、工作階段交接筆記，以及 `/memory page` 瀏覽器圖譜。
- **編譯器、AST 與 DAP 偵錯工具：** 連接 LSP 程式碼智慧與可預覽的重構（`LspRead`、`LspRename`、`LspMoveSymbol`、`LspMoveFile`、`LspCodeAction`、`LspFormat`），支援 23 種語言的 tree-sitter AST 結構搜尋與改寫（`AstSearch`、`AstEdit`），並提供內建的 Debug Adapter Protocol（`Debug`）偵錯器（`debugpy`、`js-debug`、`lldb`、`gdb`、`dlv`），用於單步進入失敗的 Python、Node、Go 與 Rust 測試，另有可持續保存狀態的 Python 與 JavaScript `Eval` 儲存格。
- **無需金鑰的 `WebSearch` 與 Markdown 格式的 `WebFetch`：** 透過供應商原生搜尋、Brave 或 Tavily 金鑰、官方 API（Stack Exchange、npm、PyPI、crates.io、GitHub、Hacker News、Wikipedia）、SearXNG，以及無需金鑰的 DuckDuckGo 進行搜尋，並在 38,000 字元的單次呼叫預算內，以 Markdown 格式擷取公開文件。
- **桌面電腦操作、Whisper 語音、Saturn 排程與編輯器橋接：** 控制桌面應用程式（`Computer`），在裝置端以 Whisper 轉寫按住說話的語音聽寫（`/voice`），以 Saturn 排程週期性或一次性的工作階段（`/saturn`），並透過 Agent Client Protocol（`mercury acp`）連接 VS Code；Unity、Blender、Godot 與 Aseprite 也有對應的橋接。
- **影片生成（`Video`）：** 將提示詞與專案參考檔案傳送給已設定的 MiniMax 生成器（[docs/VIDEO.md](../VIDEO.md)），並將生成的 MP4，以及可選的 1 秒 PNG 預覽影格儲存到你的專案中。

Mercury 被用來建置 Mercury 本身，同時執行多個工作階段與模型來完成長時間任務。難處在於追蹤這些工作：哪些仍在執行、哪些已經變更，以及哪些需要決策。每個工作階段結束時都會寫下自己的交接筆記；下一個工作階段啟動時，會讀取一次該筆記，並與我的釘選規則一併載入，從而防止工作階段之間的上下文汙染。

![在工作階段看板上向協調者發出一則提示，即可啟動兩個工作階段，各自在獨立的工作樹中執行；其中一個會先詢問再編輯，兩個工作階段完成後都會準備好可供審閱的變更](../media/session-board-stream.gif)

Mercury 以 Apache License 2.0 開源授權，[sdk/](../../sdk/) 與 [sdk-py/](../../sdk-py/) 中的 SDK 亦同。

## 安裝

發行壓縮檔提供 Apple silicon 與 Intel 版 Mac、Linux x64 與 arm64，以及 Windows x64 與 arm64。`git` 需另行安裝；每個壓縮檔都內建 Node 與 ripgrep，因此無須另外安裝 Node。

選擇一種安裝方式：

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS 與 Linux（x64 與 arm64）
irm https://mercury-cli.ai/install.ps1 | iex        # Windows（x64 與 arm64），在 PowerShell 7 中執行
brew install Whq02/mercury/mercury                 # Homebrew：macOS 與 Linux x64
npm install -g mercury-tech-cli                    # npm；`bun install -g mercury-tech-cli` 為同一個套件
mise use -g npm:mercury-tech-cli                   # mise，透過 npm 套件安裝
```

安裝位址會依來源與 UTC 日期保留指令碼請求的大致次數（已完成的安裝不計入）；計數器不會儲存 IP 位址、User-Agent 字串或 Cookie。

開啟新的終端機，或執行 shell 安裝程式印出的 `export PATH=…` 那一行，然後執行 `mercury --version` 檢查版本，並在某個儲存庫中執行 `mercury`，開始[首次執行](#首次執行)。在 Windows PowerShell 中，以及透過 Homebrew、npm、bun 或 mise 安裝之後，`mercury` 可直接在同一個終端機中使用。

<details>
<summary>安裝路徑、更新與發行版本驗證</summary>

### 各安裝方式的差異

shell 與 PowerShell 安裝程式會為你的平台取得最新發行版本，以 `SHA256SUMS.txt` 檢查其 SHA-256，解壓縮後執行壓縮檔內附的 `mercury install` 指令。

Homebrew 與 npm 套件各自固定在特定版本，且會在打上標籤（tag）後重新發佈，因此可能落後於最新版本。Homebrew 指令使用完整的 tap 名稱 `Whq02/mercury/mercury`（不帶 tap 名稱的 `mercury` 在 `homebrew-core` 中是另一個程式）。npm 套件 `mercury-tech-cli` 是一個啟動器，會下載其固定的發行版本；mise 安裝的是同一個套件。`mercury install --uninstall` 會移除已安裝的發行版本與指令 shim，同時保留你的設定與工作階段（若你安裝的是 npm 啟動器，也請執行 `npm uninstall -g mercury-tech-cli`）。

Mercury 的安裝僅限目前的使用者，無需系統管理員權限。你可以放心地重新執行安裝指令。

### 安裝路徑

發行版本存放於設定目錄下的 `~/.mercury/versions/<version>`（Windows 上為 `%USERPROFILE%\.mercury\versions`）。`mercury` 指令安裝於 macOS 與 Linux 的 `~/.local/bin`，或 Windows 的 `%LOCALAPPDATA%\Mercury\bin`。

`mercury install` 只會將指令所在目錄加入 PATH 一次：在你的 shell 啟動檔中加入一行受保護的設定，或在 Windows 使用者 PATH 中新增一項。新開的終端機會自動套用此變更。

### 更新

無論採用哪種安裝方式，都可以使用 `mercury update`。

若是透過 shell 或 PowerShell 安裝程式、或 `mercury install` 完成的安裝，它會就地更新 Mercury。`--check` 檢查更新，`--status` 回報更新狀態，`--rollback` 還原到上一個版本，該版本仍保留在磁碟上。

若是 Homebrew 安裝，它會先詢問，才會執行 `brew upgrade Whq02/mercury/mercury`。預設答案為否；輸入 `y` 即可核准。Mercury 會即時顯示指令的輸出，並在之後檢查已安裝的版本。在指令碼中可使用 `--yes` 略過提示。

npm 啟動器採用與安裝程式相同的發行版本目錄配置，並會將每次執行交給已安裝的發行版本。因此 `mercury update` 會透過 Mercury 自己的更新通道，就地更新 npm 安裝。`npm update -g mercury-tech-cli` 只會改變該套件在首次執行時安裝的發行版本。使用 mise 時亦同。

`--check` 會對所有安裝方式讀取同一份版本清單，並告訴你如何更新自己的安裝。有可用更新時，首頁右下角會顯示一次 `vX.Y.Z available · mercury update`，對話中也會一直顯示同一則通知，直到你更新為止。設定 `MERCURY_UPDATE_NOTICE=0` 可同時隱藏兩者。

安裝與更新請求會以匿名方式取得公開的版本清單與壓縮檔，因此無需帳戶或 token 即可執行。若匿名請求遭拒，Mercury 會改為查詢已登入的 GitHub CLI（`gh`）。

更新後，Mercury 會檢查 PATH 上的指令是否指向已更新的安裝。若另一個安裝的優先順序較高，或已更新的指令不在 PATH 上，它會說明問題與修正方法。`mercury health` 會回報相同的問題。

### 發行版本驗證

在啟用發行版本之前，Mercury 會以 `SHA256SUMS.txt` 檢查其壓縮檔。在暫存更新之前，它也要求酬載（payload）由內建信任清單中的 Mercury 發行簽章金鑰簽署。遭拒絕的簽章不會改變目前啟用中的安裝。

使用 `--allow-unsigned` 可接受未簽署的酬載。Mercury 仍會拒絕未知的簽章金鑰、格式錯誤的簽章區塊，以及遭竄改的內容。指令結果與本機紀錄都會顯示你允許了未簽署的酬載。

從 1.0.0-beta.3 起，壓縮檔會在打包時簽署，並在發佈前驗證簽章。已通過驗證的安裝在啟動時不會顯示簽章提示。`mercury health` 會回報簽章金鑰 `627b54b734ca0e72`。

1.0.0-beta.2 的壓縮檔未簽署。當你不帶指令或旗標、以互動方式啟動 Mercury 時，這類安裝每次只會回報一次未簽署的來源資訊。健康檢查會持續顯示該狀態。這代表壓縮檔的清單沒有簽章；下載內容仍會以 `SHA256SUMS.txt` 檢查。

[docs/TRUST.md](../TRUST.md) 說明驗證結果，以及如何手動檢查壓縮檔。[docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) 說明啟動時的驗證。

### 平台說明

上述列出的每個平台都有發行壓縮檔。其他機器則需要從原始碼建置。

Intel 版 Mac 的壓縮檔從 1.0.0-beta.3 起提供。它們在 Apple silicon 執行器上交叉打包，並在發佈前於 Rosetta 下測試啟動。使用 1.0.0-beta.2 的 Intel 版 Mac 需要從原始碼建置。

</details>

## 環境需求

發行壓縮檔內建 Node 24 LTS。啟動器、`mercury install` 與 `mercury update` 都會使用這個內建執行階段；就發行版本本身而言，`git` 是唯一需要另行安裝的需求。

從原始碼建置需要以下條件：

- **Node 24 LTS**，支援範圍為 `>=24.20.0 <25`。`.node-version` 會固定建置時所用、並隨發行壓縮檔一併提供的修補版本。
- **bun 1.3.x**，用於建置。發行版本不包含 bun。
- **git**。在 Windows 上，請於 Windows Terminal 或 VS Code 終端機中執行 PowerShell 7。參見 [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md)。

Node 的最低版本已包含 nodejs/node#56645 的修正。低於 24.20.0 時，在 Windows 上呼叫工具的無頭 `run` 指令會在結束時中止。

啟動器依下列順序選擇 Node：明確指定的 `MERCURY_NODE` 執行檔、內建執行階段，然後是 PATH 上相容的 Node 安裝。若執行階段遺失，啟動器會回報錯誤。

### Windows 中的 shell

發行壓縮檔內建與 bash 相容的 shell 引擎（`brush`）。在 Windows 上，預設由它為 Bash 工具提供服務：它會透過 PATHEXT 以名稱找到 `.cmd` 或 `.bat` 程式（例如 `npm`），將 `%VAR%` 與 `^` 原樣傳給批次檔，在 `cd` 之後執行以相對路徑指定的程式，並在呼叫之間保留 shell 狀態。不需要 Git for Windows 的 `bash.exe`；若已安裝，請設定 `MERCURY_SHELL_ENGINE=system`，或選擇 `system`（於 `/config` 的 Shell engine 項目下），即可讓 Bash 工具只透過 `bash.exe` 執行。

請查看健康檢查的 `shell` 列，了解目前啟用的是哪個 shell，以及原因：是內建引擎（Windows 預設值，或由釘選或設定啟用），還是在引擎已關閉或其元件套件缺少時使用的 Git Bash。

在 macOS 與 Linux 上，預設使用系統 shell；若要讓此處的 Bash 工具也在內建引擎上執行，並保留持續性的 shell 狀態，請設定 `MERCURY_SHELL_ENGINE=brush`，或選擇 `brush`（於 `/config` 的 Shell engine 項目下）。

沒有引擎元件套件、也沒有 Git for Windows 的原始碼建置仍可啟動，但 Bash 工具無法使用。PowerShell 工具仍可使用，`shell` 診斷會說明如何恢復 Bash 支援。

## 從原始碼建置

Mercury 使用 bun 建置，並在 Node 24 LTS 上執行。請先安裝[原始碼建置所需的需求](#環境需求)，包括 bun 1.3.x：

```sh
curl -fsSL https://bun.sh/install | bash           # macOS 與 Linux
powershell -c "irm bun.sh/install.ps1 | iex"       # Windows，在 PowerShell 7 中執行
bun --version                                      # 1.3.x
```

接著，在本儲存庫的複本中執行：

```sh
bun run setup                      # 只需執行一次；bun install 加上內建的元件套件
bun run build.ts                   # 寫入 dist/mercury.mjs 與 dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### 終端機支援

全螢幕介面需要真正的 TTY，但對終端機大小沒有最小限制。完整版面從 100 欄 × 26 列開始；較小的視窗則使用精簡版面。

當終端機透過 `COLORTERM=truecolor` 宣告支援，或被辨識為 iTerm2、Ghostty、WezTerm、Kitty、Windows Terminal 或 VS Code 時，Mercury 會使用 24 位元色彩。其他終端機使用 256 色，包括 macOS 15 及更早版本上的 Apple Terminal。

健康檢查的 Terminal color 列會回報偵測到的色彩深度與原因。若終端機支援真彩色但未宣告，請設定 `MERCURY_TRUECOLOR=1`；若要強制使用 256 色，則設定 `MERCURY_TRUECOLOR=0`。

### 選用元件

`setup` 會取得內建的能力元件套件：pyright、debugpy、js-debug、額外的語法（grammar）、平台的 Node 執行階段，以及 brush。若下載失敗，該元件套件會被略過，建置與受影響的工具會回報缺少的元件。單獨執行 `bun install` 所建出的版本不包含這些元件套件。

要建置語音支援，請在已安裝 Rust 的情況下執行 `setup`，這會建置 `native/voice`。若也要建置 `native/whisper`，請另外安裝 cmake。已安裝 Rust 時，`setup` 也會建置桌面驅動原生外掛（`native/desktop`），供 `Computer` 工具透過它執行。同樣在已安裝 Rust 的情況下，`setup` 還會建置本機嵌入原生外掛（`native/embed`，`bun run scripts/vendor/build-embed.ts`），並取得 118 MB 的 BGE 模型（`bun run scripts/vendor/fetch-embed-models.ts --default`）；若沒有 cargo，該元件套件會被略過，setup 會說明此事，而 Mneme 的記憶查找則只做詞彙比對。每個發行壓縮檔都附帶為其平台建置的嵌入元件套件。在 Linux 與 Windows 上，數學運算由向量化核心執行，因此依語意進行一次 Recall 約需十分之一秒（在使用 Accelerate 的 macOS 上約為數百分之一秒）。若原生建置缺少所需工具，setup 會略過它，健康檢查會回報缺少的原生外掛。由於上游沒有提供 Windows 二進位檔，Windows 的 shell 引擎也會在你的機器上編譯。

關於 `brush` shell 引擎，請參見 [Windows 中的 shell](#windows-中的-shell) 與 [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md)。

建置只會寫入 `dist/`。設定與工作階段存放於 `~/.mercury`，或存放於 `MERCURY_CONFIG_DIR` 指定的目錄，並於首次執行時建立。在 Windows 上，請直接執行 `node dist\mercury.mjs`。

### 將原始碼建置安裝為指令

`scripts/ops/deploy-runtime.sh` 會將乾淨工作樹的建置發佈到新的 `<config home>/runtime/builds/<build>` 資料夾，並讓 `runtime/current` 指向該處（`runtime/dist` 是同一個連結的舊名稱）。`scripts/ops/deploy-launcher.sh` 會將啟動器安裝到 `<config home>/bin/mercury`。請將該目錄加入 PATH；以 zsh 為例：

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

若執行階段遺失，啟動器會報錯並停止，不會切換到其他建置。Node 的選擇順序見[環境需求](#環境需求)。發行版本安裝請執行 `mercury install` 或 `mercury update`；它們不會更動原始碼複本。參見[更新](#更新)。

[AGENTS.md](../../AGENTS.md) 是簡短的建置與執行指南。[BUILD-NOTES.md](../../BUILD-NOTES.md) 更詳細地說明建置。

## 首次執行

首次以互動方式執行時，請先選擇外觀，然後登入供應商。瀏覽主題時，畫面會預覽主題變更。預設為 True Black；其他選項是 oasis dark 主題，以及完全不使用色彩的 Black and white：它使用終端機自身的前景與背景色，也就是 Mercury 在不支援色彩的終端機上的樣子。之後可以用 `/appearance` 變更此設定。

你也可以選擇「sign in later」，先不連結帳戶，隨意看看。若環境中的供應商金鑰已登入某供應商，就不會再詢問登入步驟。接著，Guardrails 步驟會提醒你檢查 Mercury 的編輯與指令，並說明它讀取的內容可能夾帶給模型的指令。在 Mercury 知道如何設定的終端機（Terminal.app、VS Code 系列、Alacritty、Zed）中，Terminal keys 步驟可以在終端機自身的設定中設定換行快速鍵（在 macOS 的 Terminal.app 上，它會把 `Option+Enter` 設為換行，並在所有設定檔中關閉終端機響鈴，該變更會在重新啟動 Terminal.app 後生效；在 VS Code 系列、Alacritty 與 Zed 中，則會寫入 `Shift+Enter` 作為換行）。除非你選擇啟用，否則此功能預設關閉，並會保留備份。

接著，Mercury 會詢問你是否信任所開啟的資料夾。在你授予信任之前，工作區設定要求的任何內容都不會執行。此授權涵蓋整個儲存庫；若拒絕，Mercury 會結束。參見 [docs/TRUST.md](../TRUST.md)。

一般的互動式啟動會開啟首頁。首頁有十個選單項目，其中 Continue Last Session 只有在有工作階段紀錄後才會出現：

- **New Session in \<folder\>** 在目前的資料夾中啟動新的工作階段。
- **Continue Last Session** 返回你最近的對話。
- **Boot Menu** 設定之後的工作階段，包括動態效果、crewmate 與工作流程。
- **MCPs & Skills** 選擇下一個工作階段要載入的內容。參見 [docs/KIT.md](../KIT.md)。
- **Agents** 建立與編輯代理人。
- **Health Check** 檢查安裝狀態。
- **Saturn Scheduler** 排程工作階段。參見 [docs/SATURN.md](../SATURN.md)。
- **Logins** 連結供應商帳戶。
- **Session Concourse** 開啟目前專案的工作階段清單。
- **Sessions · Projects** 讓你選擇工作階段或儲存庫。

選單項目會開在首頁上方，按 `Esc` 會返回你剛才選擇的項目。工作階段清單會在獨立畫面中開啟，也可以用 `Shift+→` 開啟。提示詞引數、`--continue` 或 `--resume` 會直接帶你進入對話。

### 動態效果、crewmate 與工作流程

Boot Menu 的 Performance 區段包含 Motion 設定：`auto`、`full`、`reduced` 或 `off`。它控制介面中的閒置動畫，也可以在 `/config` 中設定。

在 Agents 下，Crewmates 與 Workflows 開關決定新工作階段是否會取得 Crewmate 與 Workflow 工具。關閉開關會移除對應的工具；嘗試啟動該類工作時，會回傳相同的說明。在工作階段中，`/crewmates on|off` 與 `/workflows on|off` 會在下一個輪次邊界變更設定。

## 日常流程：Session Concourse、git 工作樹與 crewmate

### 啟動工作階段並隔離工作樹

在 New Session 上按 `Enter`，即可用預設模型在目前的資料夾中建立工作階段。Mercury 會同時開啟對話，並將其加入工作階段清單。它也會在選單後方預先保留一個程序，以減少啟動時的工作量。

啟動另一個工作階段不會停止先前的工作階段。你可以讓某個工作持續執行，然後到別處工作。使用 `--worktree [name]` 啟動（或在對話中要求 `worktree` 以執行 `EnterWorktree`），即可讓工作階段在 `.mercury/worktrees/` 下擁有自己的分支與檢出副本。平行的 crewmate 也可以在隔離的工作樹中執行，並透過專案檔案租約協調共用檔案；參見[內建內容](#內建內容mneme-rag-記憶lsp23-種語言-astdap-偵錯器網路搜尋與橋接)與 [docs/CREW.md](../CREW.md)。

### 在對話中工作

用平實的語言描述你的工作即可。代理人會在你選定的權限模式下讀取、編輯、執行並檢查程式碼。工具呼叫會在執行時顯示，可以是精簡的卡片，也可以顯示完整輸出。請在 `/config` 的 Tool output 下選擇顯示方式；此設定會保存，供之後的啟動使用。

使用 `/model` 與 `/effort` 調整工作階段。`/permissions` 控制哪些操作無需核准即可執行，哪些操作必須先詢問。

使用 `/diff` 依來源、檔案與變更區塊（hunk）檢視變更。`! <command>` 會在對話中執行 shell 指令，並即時顯示輸出的末尾。`/runs` 顯示正在執行的 shell 與 crewmate（`/tasks` 會開啟同一個面板），`/crewmates` 則開啟即時的 Crew 檢視。在輪次之間，`/clear` 會儲存目前的對話並開啟新的工作階段，`/restart` 則會把對話移到新安裝的 Mercury 版本上。`/title` 為對話命名，`/help` 列出可用的指令。

### 在畫面之間切換

`Shift+←` 與 `Shift+→` 會在目前可用的畫面之間移動。剛啟動時會有首頁與工作階段清單。聚焦某個工作階段時會加入對話畫面，最後一個對話關閉時會移除。按鍵提示只顯示可用的移動方式。

關閉所有對話會返回首頁。使用 `--chat` 只顯示首頁與對話，不顯示工作階段清單。`--concourse-off` 會為之後的啟動保存此偏好；`--concourse-on` 或 `/config` 可將其重新開啟。

### 在 Session Concourse 上管理工作階段

在首頁按 `/concourse` 或 `Shift+→` 即可開啟工作階段清單。清單會先顯示目前專案中正在執行的工作階段，接著依由新到舊的順序，顯示未在執行的已保存對話。

每個正在執行的工作階段都有一個 NOW 儲存格，顯示其目前的活動。選取一列並按 `Enter`，即可返回該對話，其他工作階段會繼續執行。當機的工作階段會以 NEEDS YOU 狀態留在工作階段清單上，並顯示原因，直到你將其釋放為止。

[docs/SESSIONS.md](../SESSIONS.md) 說明工作階段的生命週期。

## 供應商與模型：登入、`/localsetup` 與 `/llmhost`

使用 `/logins` 連結供應商。它會開啟與設定時相同的登入目錄。之後可以用 `/accounts` 管理已連結的供應商插槽。

- **OpenAI：** ChatGPT 訂閱或 API 金鑰。
- **Anthropic：** Claude 訂閱、Console 登入或 API 金鑰。
- **OpenRouter：** 透過 OAuth 或 API 金鑰存取模型目錄；模型請求會拒絕資料收集，並從一開始就要求所有參數都必須受支援。`/config → OpenRouter routing policy` 用來設定後備（fallback）與零資料保留（zero-data-retention）選項；選擇 open 可放寬政策，把路由交給 OpenRouter 處理。
- **Google Gemini：** 可使用 Sign in with Google、API 金鑰，或你自己的 OAuth 用戶端登入。Sign in with Google 會透過 Google 自家的 Antigravity 用戶端，使用 Google 帳戶所持方案（免費帳戶、Google AI Pro 或 Google AI Ultra）的配額執行 Gemini：提示詞、工具結構描述（tool schemas）與工具結果，會在該用戶端與已登入帳戶的身分下傳送至 Google 的 Code Assist 端點；`/model` 則會列出 Google 為該帳戶提供的模型清單。API 金鑰或你自己的 OAuth 用戶端則改為向 Cloud 專案計費。
- **Hugging Face：** 裝置碼登入或 Hub token。
- **Kimi（Moonshot）：** 裝置碼登入或 API 金鑰。
- **GLM（Z.AI）：** 可使用 GLM Coding Plan 訂閱金鑰，或一般隨用隨付的 API 金鑰。`/logins zai` 會保存其中任一種並記錄方案；`ZAI_API_KEY` 也可使用，並可用 `ZAI_KEY_PLAN=coding|general` 指定方案（未設定時，Mercury 會從該金鑰自己的模型清單讀取）。
- **DeepSeek：** 來自 DeepSeek 平台的 API 金鑰（`/logins deepseek`，或 `DEEPSEEK_API_KEY`）。
- **xAI（Grok）：** 以你的 Grok 訂閱（SuperGrok / X Premium）登入，或透過 `/logins xai` 貼上 API 金鑰。
- **Meta（Muse）：** 可使用 Sign in with Meta（Muse Code 訂閱，在瀏覽器中輸入裝置碼）登入，或使用隨用隨付的 Model API 金鑰。Sign in with Meta 會以 Muse Code 的公開用戶端 ID，用裝置碼向 Meta 的 OIDC 端點（`https://auth.meta.com/oidc/device/authorization/` 與 `/oidc/device/token/`）交換憑證，並將所得的帳戶 token 只傳送一次至 `https://api.meta.ai/muse-code/key`，以產生該訂閱的 API 金鑰（並在有限次數的 `/usage` 讀取中取得方案等級與用量視窗）；之後每次模型請求，都只會把產生的金鑰傳送至 `https://api.meta.ai/v1`。貼上的 Model API 金鑰，或 `MODEL_API_KEY` / `META_API_KEY`，則為隨用隨付計費。

- **Qwen：** 可使用 QwenCloud 金鑰（Token Plan 或隨用隨付），或阿里雲 Model Studio 金鑰（隨用隨付、Token Plan 或 Coding Plan）。金鑰在儲存前會先於其自身端點上驗證；方案金鑰會列出該方案的模型，並把 Qwen3.8 Max 排在最前面。
- **MiniMax：** Open Platform 金鑰或 M Plan 訂閱金鑰。
- **Together AI** 與 **Cohere：** API 金鑰。
- **Groq**、**Cerebras** 與 **Fireworks AI：** API 金鑰；任何供應商系列的金鑰，也可以來自 `credentials.keyCommands.<family>` 所指定的指令。

Mistral、Nous Portal 與 OpenCode Zen 也能透過 `/logins` 連結，總計 20 個登入供應商系列。本機模型伺服器（Ollama、LM Studio、vLLM 與 llama.cpp）以及自訂的 OpenAI 相容端點，無需供應商登入即可使用。執行 `/localsetup` 可安裝或啟動 Ollama、拉取適合你記憶體容量的模型、設定其上下文視窗，或連接正在執行的 LM Studio、vLLM 或 llama.cpp 伺服器（[docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)）。每個供應商都使用自己的協定、憑證與錯誤處理方式，請求絕不會改由其他供應商處理。參見 [docs/ENGINES.md](../ENGINES.md)。

`/llmhost` 會列出你可以代管的模型，並顯示每個模型目前可在何處執行：在從 Runpod、Vast.ai 或 Lambda 租用的 GPU 上、在你自己的電腦或已儲存的 SSH 電腦（`mercury host`）上，或在既有的模型伺服器上。每個模型頁面都會顯示量化選項、GPU 顯示記憶體預算如何分配給平行對話（`conversations × context`），以及預設的思考層級（`/effort` 可依請求變更）。租用 GPU 需要明確確認每小時價格；若你關閉彈出視窗，設定會在背景繼續進行。在 Runpod 上，你還可以在租用前或在執行中的 pod 上（`Tune`）調整品質、上下文分配與思考設定，將權重保存在快速載入的磁碟區上，並設定 5 秒級的庫存監看。Vast.ai 與 Lambda 的租用功能是 1.0.0-beta.40 的新增功能，已依各廠商公開的 API 在測試用固定資料（fixtures）上驗證（未執行實際租用）。參見 [docs/LLM-HOST.md](../LLM-HOST.md)。

新工作階段會使用你最近連結的供應商，以及該帳戶可用的最新模型。帳戶無法存取的模型會被略過。若該供應商沒有可用的模型，Mercury 會檢查次近連結的供應商。此選擇在工作階段啟動時進行；既有工作階段中失敗的請求，仍會留在其原來的供應商上。

`/model` 會說明目前的選擇。輸入系列名稱即可選出該系列最新的模型：`/model grok`、`/model deepseek`、`/model kimi` 或 `/model glm`。若未連結任何供應商，首頁與 `/model` 會引導你前往 `/logins`。`/defaultprovider` 可明確地把某供應商設為最近的選擇。

供應商的存取仍受其自身條款與可用性約束。Mercury 的授權條款不會取代這些條款。

## 無頭 CLI：`mercury run`、Docker 與 JSON-RPC runner

同一個建置無需互動介面即可執行。`node dist/mercury.mjs --help` 會列出所有命令列參數。

使用 `mercury run "<prompt>"` 可在沒有終端機使用者介面的情況下執行一則提示詞：

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` 輸出回答；失敗輪次的原因會寫入 stderr。
- `json` 會把最後一列 `outcome` 以單一 JSON 物件印出。
- `rows` 每行寫入一個 JSON 物件：先是 `session`，接著是一個 `turn` 與其 `text`、`reasoning`、`tool_call`、`tool_result` 和 `step` 列，最後以 `outcome` 結束。等待、工具進度、背景工作與通知各有自己的列。每列都包含 `seq`、`timestamp` 與 `session_id`；輪次內的列也會帶有其 `turn` 編號。`seq` 從 1 開始為本次執行的串流編號；`turn` 計算的是工作階段中的輪次，因此延續既有對話的執行（`-c`、`-r`、`--fork`），會接在既有輪次之後編號，且其 `session` 列會在 `resume_of` 中標示所延續的對話。

輸出列依其 `type` 欄位區分：

- `session`：開頭列，包含 `version`、`build`（建置套件所依據之原始碼樹的前十二個十六進位字元，與 `mercury daemon status` 的輸出相同；若建置套件旁沒有清單檔，則不含此項）、`resume_of`（延續執行時為所延續對話的工作階段 ID；除非該執行是分叉（fork）而來，否則與 `session_id` 相同）、`cwd`、`model`、`mode`，以及工作階段擁有的 `tools`、`mcp_servers`、`commands`、`agents`、`skills` 與 `extensions`，另有 `tools_withheld`（當拒絕規則依工具的裸名隱藏某工具時出現：每一項包含 `tool`、`rule` 與 `source`）。
- `turn`：輪次處於 `started` 或 `waiting` 狀態，包含其 `turn_id`；在已知時也包含 `model`、`message_ids` 與 `agents` 數量。
- `text`：已定稿的文字區塊：`message_id`、`block`、`text`，以及其 `phase`（`commentary` 或 `final_answer`）。
- `reasoning`：已定稿的推理區塊：`message_id`、`block`、`text`，或 `redacted: true`。
- `tool_call`：一次工具呼叫：`call_id`、`tool`、`input`，並附有其 `message_id` 與 `block`。
- `tool_result`：呼叫的結果：`call_id`、`status`（`ok`、`error`、`aborted` 或 `refused`）以及 `output`。若模型產生的呼叫格式不當，以至於在執行前即被拒絕（例如未知的工具、參數不是有效的 JSON，或不符合工具的 schema），它仍會有配對的列：一列 `tool_call`（其中的參數依提交時的原樣保留；若參數不是物件，則為 `{}`），以及一列 `tool_result`（狀態為 `refused`，其 `output` 為拒絕原因）；隨後會輸出更正用的 `notice`。這類呼叫從未執行，也不算拒絕（denial）。
- `tool_update`：執行中工具的進度：`call_id`、`tick`、`source`（`shell`、`powershell`、`mcp` 或 `eval`），以及呼叫所回報的 `line`、`elapsed_s`、`lines`、`bytes`、`budget_ms`、`progress` 與 `total` 之中的任何欄位。shell 或 PowerShell 呼叫會隨輸出抵達而發出 tick（不印出任何內容的指令永遠不會發出 tick）；MCP 呼叫在其伺服器回報進度時發出 tick；Eval 呼叫在其儲存格執行期間發出 tick；其他工具都不發出 tick；Browser 或 Crewmate 呼叫則在回傳結果之前保持靜默。
- `step`：主執行緒的一次模型呼叫：`message_id`、`model`、`usage`；若模型說明了停止原因，則另含 `stop`。
- `outcome`：該輪次的結果，見下文說明。
- `close`：關閉時為下一個工作階段留下的備註：`state`（`stored`、`skipped` 或 `none`）、`note_chars`，以及寫入該備註之模型呼叫的 `usage`，因此把每一列的 usage 加總，即可得到 outcome 中的數字。若提示詞以引數給出，備註會在最後一個輪次內請求，且 `close` 會先於該輪次的 `outcome` 出現；若使用 `--input rows`，則會在 stdin 關閉後，接在最後一個 `outcome` 之後。
- `wait`：模型的等待狀態：`state`（`first_byte`、`retry`、`silence`、`loading` 或 `done`），並附上該狀態所帶的數據，例如 `since_ms`、`attempt` 與 `of`、`delay_ms`、`reason` 與 `http_status`。
- `heartbeat`：模型串流在至少一秒內沒有解析出任何事件之後，又顯示出活動跡象：收到位元組，但沒有產生任何列。該列不包含其他內容，最多每秒一次；出現頻率取決於供應商的串流形式，因此在事件之間從不暫停的串流不會發出任何此類列。
- `compaction`：上下文壓縮（compaction）的 `started`、`progress` 或 `ended` 狀態：`trigger`（`manual`、`auto` 或 `overflow`）、`stage`、`fill`、`summary_tokens`，並在結束時包含 `exit`（`landed`、`cancelled` 或 `failed`）。
- `mode`：權限模式已變更：`mode`。
- `rate_limit`：供應商的速率限制狀態：`status`（`allowed`、`warning` 或 `rejected`）、`window`、`resets_at`、`utilization`，以及超額欄位。
- `task`：背景工作的 `started`、`progress` 或 `ended` 狀態：`task_id`、`task_type`、`description`、`usage`、`summary`、`status`（`completed`、`failed` 或 `stopped`），以及已知時的 `output_file`。
- `notice`：給讀取者的 `warning` 或 `error`：`text`，以及 `code`（例如 `input_refused`）。
- `command_output`：未送達模型之斜線指令的輸出：`command` 與 `text`。
- `mission_updated`：工作階段的任務帳本已變更；請重新讀取。
- `samples_updated`：工作階段的範例已變更；請重新讀取。

`--partial` 與 `--format rows` 搭配時，會另外加入 `block_start`、`text_delta`、`reasoning_delta`、`tool_input_delta` 與 `retracted` 列。增量（delta）屬於 `message_id` 與 `block`；`retracted` 列會撤回該訊息的增量。定稿的文字列或工具列才是完整的值。

outcome 包含 `schema`、`turn_id`、`status`、`steps`、`wall_ms`、`usage`、`models` 與 `denials`；完成時另含 `answer`，失敗時則含 `error`（`message`、`class`，以及選填的 `detail`）。在可用時，還會包含 `stop`、`api_ms`、`cost_usd`、所請求的 `structured` 輸出，以及 `notices`。`wall_ms` 是該輪次經過的時間。`api_ms` 是該輪次所發出之所有模型請求（包括重試，以及與主執行緒並行執行的 crewmate 請求）耗時的總和，因此在請求重疊時，它可能超過 `wall_ms`。`cost_usd` 是該輪次中已計價請求的美元金額，與狀態無關：Mercury 無法計價的請求（沒有已登錄的費率，或回應中未提供費用），不會計入其中，其所屬模型仍會列在 `models` 中，但沒有自己的 `cost_usd`；只有在該輪次中沒有任何內容被計價時，此欄位才會缺少。使用 Claude 訂閱登入時，Anthropic 請求沒有美元價格，因此這些請求與該列都不含 `cost_usd`，但 usage 仍會保留。usage 包含 `input_tokens`（已含快取的 token）、`cached_input_tokens`、`cache_write_input_tokens`、`output_tokens`，以及在供應商有回報時的 `reasoning_output_tokens`，並會在主執行緒與 crewmate 之間加總。`models` 依模型細分 token 用量。`steps` 只計算主代理人的模型呼叫；crewmate 所做的模型呼叫會以各自的 `step` 列出現，並附上 `parent_call_id` 標記。

狀態可能為 `completed`、`blocked`、`refused`、`failed`、`interrupted`、`turn_limit`、`budget_limit`、`time_limit`、`schema_unmet` 或 `loop_stopped`。在 `--max-time`（秒數，或 `10m`、`1h`）之下執行的任務，時間到後會在下一步以 `time_limit` 結束；進行中的模型呼叫或工具回合不會被中斷。已完成的執行結束代碼為 0，其他結果為 1，用法錯誤為 2。SIGINT 與 SIGTERM 會在被中斷輪次的 outcome 寫出之後，分別以代碼 130 與 143 結束。被拒絕的工具呼叫會列在 `denials` 中。若拒絕是因為一個無人能回答的詢問（例如在會詢問的模式中沒有宿主，即 `--mode dontAsk`，或宿主的詢問已逾時），且該輪次之後沒有任何工具呼叫成功，則執行狀態為 `blocked`：回答會保留，`error` 會指出工具名稱以及如何繼續（`--allowed-tools`、其他 `--mode`，或能回答詢問的宿主），並以代碼 1 結束。若同一輪次中之後的工具呼叫成功，該輪次會恢復，並以 `completed` 結束（代碼 0），同時附上一則警告 `notice`（`"<Tool> was not approved; the run continued with other tools."`）。你已作答的拒絕（經由拒絕規則、掛鉤，或回答「否」的宿主）會讓已完成的輪次維持完成狀態。未回答的 `AskUserQuestion` 呼叫也會使執行以 `blocked` 結束，並在 `error` 中引用該問題；Mercury 會從執行所記錄的詢問讀取結果，而非從回覆文字，因此只寫在回覆中的問題仍會以 `completed` 結束。未知的斜線指令會以 `refused` 結束，並顯示與互動畫面相同的句子（`Unknown command: /name · /help lists commands`），且以代碼 1 結束。

`--input rows` 需搭配 `--format rows` 使用，並且每行讀取一個輸入物件：

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

輸入類型包括：`prompt`（帶有 `content`，即文字或文字／圖像區塊）、`shell`（帶有 `command`），以及 `note`（帶有 `to` 即代理人 ID，與 `content`）。每種類型都接受選用的 `id`；prompt 與 shell 列還接受 `priority`（`now`、`next` 或 `later`）、`sent_at` 與 `origin`。被拒絕的輸入格式會產生一則 `notice`（代碼為 `input_refused`）；格式錯誤的 JSON 會結束執行。這些列只傳遞輸入；權限的回答則使用下方的 runner 協定。

使用 `mercury run -`，或將文字導入 `mercury run`，即可從 stdin 讀取完整的提示詞。在提示詞引數旁，導入的文字會以帶有分隔符號的脈絡附加在後：管道會一直讀取到關閉，或靜默滿一秒為止；因此持續送出資料的串流會被讀到結尾，而保持開啟卻不送資料的管道不會卡住執行。若既沒有提示詞，stdin 又是終端機，`run` 會印出其用法並以代碼 2 結束。

`--mode <mode>` 選擇權限姿態。`--sovereign` 會在沒有權限提示的情況下執行，`--allow-sovereign` 則讓該姿態可於之後切換。權限政策與拒絕規則仍然適用。以 root 使用者進入 sovereign 模式時，stderr 會收到一則通知，執行繼續。

使用 `-c` 延續最近的對話，`-r` 依 ID、標題或選擇器恢復對話，`-w` 在受管理的工作樹中執行，`--lean` 則啟動精簡的工作階段。`run` 沒有可以回答權限詢問的宿主：其權限規則與模式決定可以執行哪些操作，而仍需核准的呼叫會被拒絕。

### 無頭映像檔

儲存庫根目錄下的 `Dockerfile` 會為 CI 與伺服器建置 Linux x64 映像檔。其進入點為 `mercury`，預設動詞為 `run`，因此該映像檔會對掛載的目錄樹執行一則提示詞，並以執行的結束代碼退出：

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

映像檔內含建置套件、其 Node 24 執行階段（位於 `PATH` 上）、內附的搜尋、shell、偵錯器、語言與圖像工具、`git`，以及憑證存放區；沒有進入畫面，也沒有登入流程。它以非 root 使用者 `mercury` 執行，設定目錄位於容器內（`MERCURY_CONFIG_DIR`），工作目錄為 `/work`。色彩與滑鼠遵循產品本身的終端機偵測；`--user 0` 會以 root 執行，並顯示上述的 sovereign 通知。

供應商金鑰以環境變數傳入，拼寫與產品各處讀取的完全相同：`ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 或 `GOOGLE_API_KEY`、`XAI_API_KEY`（用量計量另可使用 `XAI_MANAGEMENT_API_KEY`）、`DEEPSEEK_API_KEY`、`MOONSHOT_API_KEY`、`ZAI_API_KEY`、`OPENROUTER_API_KEY`、`HF_TOKEN`、`MISTRAL_API_KEY`（組織用量計量另可使用 `MISTRAL_ADMIN_API_KEY`）、`NOUS_API_KEY`、`OPENCODE_API_KEY`、`MINIMAX_API_KEY`、`TOGETHER_API_KEY` 或 `TOGETHER_AI_API_KEY`、`COHERE_API_KEY` 或 `CO_API_KEY`、`GROQ_API_KEY`、`CEREBRAS_API_KEY`、`FIREWORKS_API_KEY`、`DASHSCOPE_API_KEY`、`MODEL_API_KEY` 或 `META_API_KEY`、自訂 OpenAI 相容端點使用的 `MERCURY_COMPAT_API_KEY`，以及本機伺服器使用的 `MERCURY_LOCAL_API_KEY`。若沒有任何金鑰，執行會以一行訊息拒絕，並以代碼 1 結束。`docker run -i … mercury run -` 會從 stdin 讀取提示詞。

### 代管工作階段

`mercury runner` 會透過 stdio 把工作階段提供給宿主：採用 JSON-RPC 2.0，每行一則訊息。宿主須先送出 `initialize`，並等待回應，然後才送出工作：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

宿主的名稱與版本放在 `host` 之下；`capabilities` 宣告 `holds_asks`、`elicitation` 與 `partial_rows`。每個請求的 `id` 都必須是正整數：`id` 不是正整數的請求會收到 `-32600` 回應（帶 `id: null`），因此請從 1 開始編號。

`queue/add` 接受與上方列輸入相同的 prompt、shell 或 note 物件。輸出會以 `row` 通知送達。`session/facts` 讀取工作階段狀態；`session/set_mode` 立即變更權限模式；`session/set_model` 與 `session/set_effort` 變更模型與 effort，若在輪次執行期間變更，該變更會保留到輪次結束：回應會帶有 `at: "turn_end"`，接著 `session/applied` 會宣告此變更已生效。`turn/interrupt` 會中止輪次；關閉 stdin 即可結束工作階段。

權限詢問會以 `permission/request` 送達，並附上 `kind: "tool"` 或 `kind: "network"`。宿主以 `outcome: "allow"` 或 `outcome: "deny"` 回應；允許時可附上編輯過的 `input` 與權限 `rules`。被撤回的詢問會送出 `$/cancel_request`（附有其 `request_id`）。`holds_asks` 讓宿主掌握詢問的計時。MCP 的問題只會使用 `elicitation/request`（僅於宿主宣告 `elicitation` 時）；否則會以 `cancel` 回應。

未知的方法會回應 `-32601`，參數無效會回應 `-32602`，`id` 不是正整數會回應 `-32600`，初始化前送出的請求會回應 `-32002`。規則拒絕會回應 `-32010`，並在 `error.message` 中附上一句話，在 `error.data.kind` 中附上原因，例如 `mode`、`model`、`effort` 或 `claim`。runner 遇到格式錯誤的行時會回應 `-32700` 並繼續執行；連續三行格式錯誤則會結束執行。

### 其他指令

可用的指令包括：

- **`mercury health`**：診斷報告，也稱為健康證明（health certificate）。`--json` 會回傳完整報告，`--deep` 會執行深入盤點，`--fix` 會執行引導式修正。
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**：登入（`login [<family>]`）、列出供應商系列（`list`）、檢查帳戶是否已登入（`status [<family>]`）、登出（`logout [<family>]`），或產生長期有效的 Anthropic token（`mint`）。
- **`mercury models [--json]`**：列出已登入帳戶可連上的模型（與 `mercury://models` 的資訊相同）。
- **`mercury mcp`**：以 `add`、`import`、`list`、`get`、`remove`、`trust-reset` 與 `serve` 管理 MCP 伺服器。
- **`mercury extensions`**：安裝擴充功能並管理其來源。動作包括：`list`、`sources`、`add`、`remove`、`refresh`、`install`、`trust`、`enable`、`disable`、`update`、`uninstall`、`fence`、`unfence`、`inspect` 與 `scaffold`。
- **`mercury roster`**：列出代理人清單。
- **`mercury usage`**：印出 `/usage` 畫面所顯示的精簡數據列；`--json` 則印出完整讀數：每個已登入供應商的用量視窗（包括已用量與重設時間）、其提供的數字與點數（各附來源與時效），以及依模型計算的工作階段花費。讀取方式與畫面相同（每個已登入供應商的讀取器只取樣一次，與開啟畫面時相同）。
- **`mercury daemon run|status|stop|restart`**：執行、檢查、停止或重新啟動背景常駐程式（daemon）。其工作階段席次皆為 `mercury runner` 子程序；常駐程式會傳送它們的提示詞，並代管它們的權限詢問。
- **`mercury sessions list`**（單獨輸入 `mercury sessions` 亦可）：由新到舊列出此專案已保存的工作階段，包括 ID、最後寫入時間、大小、常駐程式目前代管該工作階段時的 `live` 標記，以及標題或第一則提示詞；`--all` 會讀取所有專案，`--limit <n>` 限制列表長度。ID 即為 `mercury --resume <id>` 重新開啟、以及 `sessions delete` 刪除時所用的識別。
- **`mercury sessions delete <id>`**：有意刪除一個已保存的工作階段，包括其逐字紀錄（transcript）以及與之並存的紀錄（收據、恢復快照）。刪除前會先詢問；`--yes` 可讓指令碼略過詢問。常駐程式目前代管的工作階段會被拒絕刪除；未知的 ID 也會被拒絕，並提示參考清單（在 Mercury 內使用 `/sessions`）。除此之外，已保存的工作階段絕不會自行刪除。
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**：將本機或 SSH 電腦作為模型伺服器執行，供共用同一設定目錄的所有工作階段使用（`compat/box-<name>/<model>`），所用權重來自已驗證的本機權重庫或已確認的下載。參見 [docs/LLM-HOST.md](../LLM-HOST.md)。
- **`mercury lsp list`** 與 **`mercury lsp install <server>`**：語言伺服器目錄會列出每個伺服器，已安裝者顯示其執行檔，未安裝者顯示安裝方式。`install` 會顯示某伺服器的安裝方式、詢問後，嚴格照其執行（`--yes` 可讓指令碼略過詢問），並回報執行檔的位置。未知的伺服器會被拒絕，並附上清單。Mercury 絕不會自行安裝語言伺服器；開啟檔案只會啟動已安裝的伺服器。
- **`mercury acp`**：透過 Agent Client Protocol 為編輯器提供服務，每個工作階段對應一個 runner 子程序。`mercury bridge install` 安裝 VS Code 擴充功能；`mercury bridge status` 檢查該擴充功能；`mercury bridge uninstall` 將其移除。
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**：管理目前目錄中 Godot 專案的引擎工作。Mercury 會從凍結的專案副本，在自己的無頭工作程序上執行測試套件。此服務包含編譯閘門（compilation gate）、擷取（capture）、影格統計、已定稿的效能分析（profile）、工作佇列存取、取消，以及依 ID 取得結果。參見 [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md)。
- **`mercury image <image>`**：在終端機中顯示圖像。
- **`mercury install`** 與 **`mercury update`**（別名 `upgrade`）：安裝或更新發行壓縮檔；使用 `--json` 時，無論結論為何，文件都會輸出到 stdout，結束代碼則表示是否失敗。參見[安裝](#安裝)。
- **`mercury version`** 與 **`mercury help [command]`**：印出版本資訊列或說明頁，與 `--version` 及 `--help` 相同；兩者都不會啟動工作階段。

## 內建內容：Mneme RAG 記憶、LSP、23 種語言 AST、DAP 偵錯器、網路搜尋與橋接

- **Mneme 混合 RAG 專案記憶。** Mneme 預設開啟，將每個專案的事實保存在純 Markdown 主題頁面中（`Retain`、`Recall`、`Reflect`、`Correct`）。Recall 會融合裝置端的 118 MB BGE 語意嵌入模型（`bge-base-en-v1.5` `q8_0`，MIT 授權，內建於每個發行壓縮檔，並依其平台建置；參見[選用元件](#選用元件)），並透過互逆排名融合（reciprocal rank fusion，`k = 60`），結合經詞幹還原（stemming）的 BM25 詞彙排序、時效加權與引用追蹤。釘選規則（`pin: true`）會逐字載入釘選區，且只有在你明確要求時才會變更。工作階段開始時，Mercury 會依目前的分支、近期觸及的檔案，以及上一個工作階段的交接筆記，在專用的啟動額度（`memory.startLimit`，預設 4,000 個字元）之內，為未釘選的事實與較早的筆記評分。寫入時的矛盾檢查會在儲存衝突事實之前，攔截極性、否定與數字的翻轉。每個工作階段在結束時都會以自己的話寫下交接筆記，供下一個工作階段的入口頁使用，另外也可以寫一則選用的工作階段日誌。`/memory` 會開啟記憶中心，`/memory page` 則會在瀏覽器中把記憶庫繪製成節點與連線的圖形。參見 [docs/MNEME.md](../MNEME.md)。
- **LSP 程式碼智慧、23 種語言的 AST 改寫、DAP 偵錯器與 `Eval` 儲存格。** 帶錨點的讀取與原子化的多檔案編輯（`ChangeSet`）；語言伺服器查詢（`LspRead`）與先預覽後套用的重構（`LspRename`、`LspMoveSymbol`、`LspMoveFile`、`LspCodeAction`、`LspFormat`）；語法樹搜尋與改寫（`AstSearch`、`AstEdit`），使用 `$NAME` 與 `$$$NAME` 元變數，涵蓋發行壓縮檔中的 23 種文法（每次 `bun install` 建置包含其中 16 種，另 7 種位於文法套件中）；可持續保存狀態的 Python（`python3`）與 JavaScript（Node ES 模組）程式碼儲存格（`Eval`）；以及 Debug Adapter Protocol 偵錯器（`Debug`），可驅動 `debugpy`、`js-debug`、`lldb`、`gdb`、`dlv`、`netcoredbg`、`rdbg`、Dart SDK 的偵錯適配器、`kotlin-debug-adapter`、elixir-ls 偵錯適配器與 Godot。`Test` 工具的 `debug` 操作，會把失敗的 Python（`pytest`、`unittest`）、JavaScript/TypeScript（`node-test`、`vitest`、`jest`）、Go（`go test`）或 Rust（`cargo test`）測試，直接單步進入 `Debug` 工作階段。參見 [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md)、[變更交易](../CHANGE-TRANSACTIONS.md)、[結構化樣式](../STRUCTURAL-PATTERNS.md)、[程式碼儲存格](../EVAL.md)，以及[偵錯器](../DEBUGGER.md)。
- **無需金鑰的 `WebSearch` 與 Markdown 格式的 `WebFetch`。** `WebSearch` 依序走完一條途徑：若工作階段模型支援，先使用供應商原生的即時搜尋（`ProviderSearch`）；其次是已保存的 Brave 或 Tavily 金鑰；再次是依查詢形式選出的官方 API（Stack Exchange、npm、PyPI、crates.io、GitHub 程式碼搜尋、Hacker News Algolia、Wikipedia）；接著是已設定的 SearXNG JSON API（`MERCURY_SEARCH_SEARXNG_INSTANCES`）；最後是無需金鑰的 DuckDuckGo 網頁擷取（預設開啟；可在 `/config` 中關閉，或設定 `MERCURY_SEARCH_KEYLESS=0`）。每個回答都會控制在 2,000 個 token 之內，並註明作答的來源。`WebFetch` 會在 38,000 字元的單次呼叫預算內，以作者原本的文字讀取公開頁面，並轉為 Markdown（需要瀏覽器的頁面會透過代管閱讀器 `r.jina.ai` 讀取，除非設定 `MERCURY_FETCH_READER=0`；私有網路位址絕不會傳送給它）。參見 [docs/ENGINES.md](../ENGINES.md)。
- **代理人、跨供應商 crewmate（`Crewmate`）、工作樹與檔案租約。** 兩個內建代理人（`mercury-crew` 負責各類委派工作，`mercury-scout` 負責唯讀偵查），與你在 `/agents` 中建立的代理人定義並存。可在任何已登入的供應商上啟動 crewmate，將平行工作隔離在 `git worktree` 檢出副本中（`isolation: "worktree"`），以行程內的專案檔案租約協調共用檔案（`mcp__mercury__lease_take`、`mcp__mercury__lease_release`、`mcp__mercury__lease_list`），並可用 `SendMessage` 與 `ResumeCrewmate` 依名稱或 ID 引導或恢復 crewmate。在 `/crewmates` 與 `/runs` 中可追蹤 crewmate 與工作流程的執行。參見 [docs/CREW.md](../CREW.md)。
- **桌面電腦操作。** 原生桌面驅動可用時預設啟用。`Computer` 工具會擷取螢幕畫面，並控制前景應用程式中的滑鼠與鍵盤。Mercury 在操作前會依名稱與身分確認應用程式；除非你的權限規則、工作階段授權、存取設定或權限模式已允許該操作，否則會請求核准；按 `Esc` 即可停止；同一時間只允許一個工作階段控制桌面；螢幕畫面也不會寫入已保存的對話檔案。設定 `MERCURY_COMPUTER_USE=0` 即可移除此工具。參見 [docs/COMPUTER-USE.md](../COMPUTER-USE.md)。
- **裝置端 Whisper 語音輸入（`/voice`）。** `/voice on` 會在首次使用時下載 60 MB 的英文語音模型（`base.en-q5_1`），驗證其 SHA-256 摘要，並啟用聽寫；`/voice off` 則將其停用。按住空白鍵 1 秒即可開始說話，放開即停止；或在語音已開啟時直接執行 `/voice`，以開始與停止一段錄音（take）。Whisper 在裝置端轉寫，因此語音音訊絕不會離開你的機器。`MERCURY_WHISPER_MODEL` 可選擇 `tiny.en-q5_1`、`small.en-q5_1`、多語言的 `base-q5_1`，或本機的 `.gguf` 檔案。參見 [docs/VOICE.md](../VOICE.md)。
- **Saturn 排程與工作階段排程器（`/saturn`）。** 可為既有工作階段排程一則提示詞（`CronCreate`、`CronList`、`CronDelete`、`ScheduleWakeup`、`/loop`），也可排程新工作階段在設定的時間啟動。排程可以只執行一次，也可以重複執行。參見 [docs/SATURN.md](../SATURN.md)。
- **VS Code（ACP）、Unity、Blender、Godot 與 Aseprite 橋接。** `mercury acp` 可連接支援 Agent Client Protocol 的編輯器。VS Code 擴充功能（`mercury bridge install`）透過該協定在編輯器中執行 Mercury：包括對話、工作階段、代理人、成品（artifacts）與審閱，並隨每則提示詞附上編輯器的選取範圍與診斷資訊。另有獨立且需要明確啟用的整合，可連接正在執行的 Unity（`MERCURY_UNITY=1`）、Blender（`MERCURY_BLENDER=1`）與 Godot（`MERCURY_GODOT_TOOLS=1`）編輯器，並提供對 Aseprite 的批次存取（`MERCURY_ASEPRITE=1`）。參見 [Unity](../UNITY-BRIDGE.md)、[Blender](../BLENDER-BRIDGE.md)、[Godot](../VULCAN-GODOT-TOOLS.md) 與 [Aseprite](../ASEPRITE-BRIDGE.md)。
- **擴充功能。** 每個擴充功能都只有一份清單（manifest）。可從 git URL、本機資料夾或壓縮檔加入來源，並須經其貢獻雜湊值（contributions hash）核准。參見 [docs/EXTENSIONS.md](../EXTENSIONS.md)。
- **MCPs & Skills。** 依儲存庫設定工作階段要載入的內容，提供具名的預設集，並可在工作階段中調整控制項。參見 [docs/KIT.md](../KIT.md)。
- **診斷。** 健康檢查與 `/health` 會產生有診斷證據支撐的報告，結論為 `certified`、`caution` 或 `fault`，並提供經過驗證的修正。參見 [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md)。
- **信任與權限。** 工作區信任、權限規則與模式，以及所有工作階段都會拒絕的指令。參見 [docs/TRUST.md](../TRUST.md)。
- **Apollo Mode**，即規格訪談（specification interview）：回答代理人的問題，以完成它將用來建置原型的規格。參見 [docs/APOLLO-MODE.md](../APOLLO-MODE.md)。
- **復原。** 原子化發佈、帶日誌的操作，以及啟動時的狀態對帳（reconciliation）。參見 [docs/DURABILITY.md](../DURABILITY.md)。

執行時期旗標定義於 `src/substrate/flagRegistry.ts`，以 `MERCURY_*` 設定的形式提供，並依需要呈現。整合相容性記錄於 [docs/COMPATIBILITY.md](../COMPATIBILITY.md)。完整的文件索引位於 [docs/README.md](../README.md)。

## 斜線指令

`/help` 會列出可用的互動式指令。使用 `/palette` 進行模糊指令搜尋。下表依 `/help` 所用的分類，將預設啟用的內建指令分組；即時清單還會包含 `/samples`（位於 `current work` 下，當透過 `MERCURY_SAMPLES=1` 或 Boot Menu 的 Samples 列啟用 Samples 時）、`/showcase`（當設定 `MERCURY_DEV_SURFACES=1` 時），以及所有技能與擴充功能的指令。

| 類別 | 指令 |
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

| 指令 | 功能 |
| --- | --- |
| `/llmhost` | 選擇要在 Runpod、Vast.ai 或 Lambda 上租用的模型、在你自己的電腦上執行，或連接既有的伺服器。 |
| `/restart` | 把此對話移到已安裝的 Mercury 版本；正在執行的監看（watch）與背景 shell 會停止。 |
| `/mcp` | 檢視伺服器、登入、瀏覽每個伺服器的工具與參數、重新連線，或為此對話切換伺服器的啟用狀態。 |

`/mouse off` 會把指標交還給終端機，以便進行原生的文字選取與複製。此偏好會被保存，並在 `/config` 中顯示為 Mouse capture。

在技能的用法中，必要引數以 `<…>` 開頭。例如，`/update-config` 與 `/debug` 需要引數。若單獨送出其中一個指令，會得到它的說明與用法，且不會開始新的輪次。在輸入提示（typeahead）中選取後按 Enter，會留下 `/name ` 供你加入引數。`/loop` 沒有必要引數，會立即執行。

## 回報問題

若要提交簡短報告，請使用[測試者表單](https://mercury-cli.ai/report)，或在 Mercury 中輸入 `/bug --short <what you tried>`。它會詢問你的作業系統、你嘗試了什麼，以及哪裡出了問題；不需要附上健康檢查的完整傾印。

在 Mercury 中執行 `/bug <what happened>`，可在透過已登入的 GitHub CLI（`gh`）提交前預覽報告。若沒有 `gh`，Mercury 會在設定目錄中保存一份本機草稿，並指引你前往儲存庫的 issues 頁面。

你也可以直接使用 bug、provider/model 或 feature request 範本開立 issue。請附上 `--version` 的輸出、作業系統、終端機，以及確切的重現步驟。Bug 與供應商相關的報告還需要 `mercury health --json` 的輸出；原始碼建置則使用 `node dist/mercury.mjs health --json`。失敗畫面的文字紀錄會很有幫助。

請透過儲存庫的 Security 分頁私下回報安全問題，不要放在公開的 issue 中。參見 [SECURITY.md](../../SECURITY.md)。[CONTRIBUTING.md](../../CONTRIBUTING.md) 說明 issue、拉取請求（pull request）與檢查流程。

## 授權

Mercury CLI 依 [LICENSE.md](../../LICENSE.md) 中的 Apache License 2.0（`Apache-2.0`）授權。[sdk/](../../sdk/) 與 [sdk-py/](../../sdk-py/) 中的 TypeScript 與 Python SDK（於 npm 與 PyPI 上以 `mercury-cli-sdk` 發佈）同樣依 Apache License 2.0（`Apache-2.0`）授權，各自由其所附的 LICENSE 檔案（[sdk/LICENSE](../../sdk/LICENSE) 與 [sdk-py/LICENSE](../../sdk-py/LICENSE)）管轄。

Mercury 名稱與標誌的使用適用[商標政策](../../TRADEMARKS.md)。隨附的第三方授權列於 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)。
