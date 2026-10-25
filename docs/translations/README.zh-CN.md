[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI（mercury-cli.ai，npm 包 `mercury-tech-cli`）在终端里运行 AI 编程智能体，工作在你自己的 git 仓库中，支持 macOS、Linux 和 Windows。

网站：[mercury-cli.ai](https://mercury-cli.ai) · 仓库：[github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI)（`Whq02/MercuryCLI`）· npm：`mercury-tech-cli`

智能体会读取和编辑文件、运行 shell 命令、逐步执行测试和调试器，并检查结果。你可以选择模型服务商、模型，以及允许智能体做哪些事：

- **多会话 Concourse 与隔离的工作树：** 可以在 Session Concourse（`/concourse`）上并排运行多个会话，并把并行工作委派给跨服务商的 crewmate（`Crewmate`）。它们在隔离的 `git worktree` 检出副本中工作，并借助项目文件租约，让并行的智能体不会相互覆盖。
- **20 个模型服务商、`/llmhost` 与 `/localsetup`：** 可以同时保持全部 20 个服务商处于登录状态（OpenAI、Anthropic、Google Gemini、DeepSeek、Moonshot/Kimi、Z.AI/GLM、OpenRouter、Hugging Face、xAI/Grok、Meta/Muse、Mistral、Nous Portal、OpenCode Zen、Qwen、MiniMax、Together AI、Cohere、Groq、Cerebras、Fireworks AI），并在对话中切换服务商和模型。打开 `/llmhost` 即可选择模型、查看其量化方式、`conversations × context` 的划分方式和思考等级，然后在租用的 GPU（Runpod、Vast.ai 或 Lambda）上、在你自己的电脑（`mercury host`）上，或在已有的服务器上运行。也可以运行 `/localsetup`，安装或连接 Ollama，与 LM Studio、vLLM 和 llama.cpp 并列使用。
- **Mneme 混合 RAG 项目记忆：** 使用设备端的 118 MB BGE 语义嵌入模型（`bge-base-en-v1.5`），并包含 BM25 词语排序与引用追踪、逐字保留的置顶规则、感知分支的启动上下文、写入时的矛盾检查、会话交接笔记，以及 `/memory page` 浏览器图谱。
- **编译器、AST 与 DAP 调试工具：** 接入 LSP 代码智能和可预览的重构（`LspRead`、`LspRename`、`LspMoveSymbol`、`LspMoveFile`、`LspCodeAction`、`LspFormat`），支持 23 种语言的 tree-sitter AST 结构化搜索与改写（`AstSearch`、`AstEdit`），并提供内置的 Debug Adapter Protocol（`Debug`）调试器（`debugpy`、`js-debug`、`lldb`、`gdb`、`dlv`），用于单步进入失败的 Python、Node、Go 和 Rust 测试，另有可持久化的 Python 与 JavaScript `Eval` 单元格。
- **无需密钥的 `WebSearch` 与 Markdown 格式的 `WebFetch`：** 通过服务商原生搜索、Brave 或 Tavily 密钥、官方 API（Stack Exchange、npm、PyPI、crates.io、GitHub、Hacker News、Wikipedia）、SearXNG 以及无需密钥的 DuckDuckGo 进行搜索，并在 38,000 字符的单次调用预算内，以 Markdown 形式抓取公开文档。
- **桌面计算机操作、Whisper 语音、Saturn 调度与编辑器桥接：** 控制桌面应用（`Computer`），在设备端用 Whisper 转写按键说话的语音听写（`/voice`），借助 Saturn 调度周期性或一次性的会话（`/saturn`），并通过 Agent Client Protocol（`mercury acp`）连接 VS Code；Unity、Blender、Godot 和 Aseprite 也有对应的桥接。
- **视频生成（`Video`）：** 将提示词和项目参考文件发送给已配置的 MiniMax 生成器（[docs/VIDEO.md](../VIDEO.md)），并把生成的 MP4 以及可选的 1 秒 PNG 预览帧保存到你的项目中。

Mercury 被用来构建 Mercury 本身，同时运行多个会话和模型来完成长时间任务。难点在于跟踪这些工作：哪些仍在运行，哪些已经改动，哪些需要决定。每个会话结束时都会写下自己的交接笔记；下一个会话启动时会读取一次该笔记，并与我的置顶规则一起加载，从而防止会话之间的上下文污染。

![在会话看板上对协调者发一条提示，即可启动两个会话，每个会话在各自的工作树中运行；其中一个会先询问再编辑，两个会话完成后都会准备好可供审阅的改动](../media/session-board-stream.gif)

Mercury 以 Apache License 2.0 开源授权，[sdk/](../../sdk/) 与 [sdk-py/](../../sdk-py/) 中的 SDK 同样如此。

## 安装

发布压缩包提供以下平台：Apple silicon 与 Intel 版 Mac、Linux x64 与 arm64，以及 Windows x64 与 arm64。`git` 需要单独安装；每个压缩包都内置了 Node 和 ripgrep，因此无需另行安装 Node。

选择一种安装方式：

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS 和 Linux（x64 与 arm64）
irm https://mercury-cli.ai/install.ps1 | iex        # Windows（x64 与 arm64），在 PowerShell 7 中运行
brew install Whq02/mercury/mercury                 # Homebrew：macOS 和 Linux x64
npm install -g mercury-tech-cli                    # npm；`bun install -g mercury-tech-cli` 是同一个包
mise use -g npm:mercury-tech-cli                   # mise，通过 npm 包安装
```

安装地址会按来源和 UTC 日期保留脚本请求的大致次数（已完成的安装不计入）；计数器不保存 IP 地址、User-Agent 字符串或 Cookie。

打开一个新终端，或者运行 shell 安装程序打印出的 `export PATH=…` 那一行，然后运行 `mercury --version` 检查版本，并在某个仓库中运行 `mercury`，开始[首次运行](#首次运行)。在 Windows PowerShell 中，以及通过 Homebrew、npm、bun 或 mise 安装之后，`mercury` 可以直接在当前终端中使用。

<details>
<summary>安装路径、更新和发布验证</summary>

### 各安装方式的区别

shell 和 PowerShell 安装程序会为你所在的平台获取最新发布版本，用 `SHA256SUMS.txt` 校验其 SHA-256，解压后运行压缩包自带的 `mercury install` 命令。

Homebrew 和 npm 包各自固定在某个特定版本上，并在打标签（tag）后重新发布，因此可能落后于最新版本。Homebrew 命令使用完整的 tap 名称 `Whq02/mercury/mercury`（裸 `mercury` 在 `homebrew-core` 中是另一个程序）。npm 包 `mercury-tech-cli` 是一个启动器，会下载其固定的发布版本；mise 安装的也是同一个包。`mercury install --uninstall` 会删除已安装的版本和命令 shim，同时保留你的配置和会话（如果你安装的是 npm 启动器，还需运行 `npm uninstall -g mercury-tech-cli`）。

Mercury 的安装仅属于当前用户，无需管理员权限。安装命令可以安全地重复运行。

### 安装路径

发布版本位于配置目录下的 `~/.mercury/versions/<version>`（Windows 上为 `%USERPROFILE%\.mercury\versions`）。`mercury` 命令在 macOS 和 Linux 上安装于 `~/.local/bin`，在 Windows 上安装于 `%LOCALAPPDATA%\Mercury\bin`。

`mercury install` 会把命令所在目录加入 PATH，且只做一次：在 shell 启动文件中写入一行带保护标记的配置，或在 Windows 用户 PATH 中添加一项。新开的终端会自动生效。

### 更新

无论采用哪种安装方式，都可以使用 `mercury update`。

对于通过 shell 或 PowerShell 安装程序完成的安装，或通过 `mercury install` 完成的安装，它会就地更新 Mercury。`--check` 检查更新，`--status` 报告更新状态，`--rollback` 回退到上一个版本，该版本仍保留在磁盘上。

对于 Homebrew 安装，它会在运行 `brew upgrade Whq02/mercury/mercury` 之前先询问。默认答案是否定的；输入 `y` 即可确认。Mercury 会实时显示该命令的输出，并在之后检查已安装的版本。在脚本中可以使用 `--yes` 跳过提示。

npm 启动器使用与安装程序相同的版本目录结构，并把每次运行交给已安装的版本。因此，`mercury update` 会通过 Mercury 自身的更新通道，就地更新 npm 安装。`npm update -g mercury-tech-cli` 只会改变该包在首次运行时安装的版本。使用 mise 时同样适用。

`--check` 对所有安装方式都读取同一份版本列表，并告诉你如何更新自己的安装。有可用更新时，首页右下角会显示一次 `vX.Y.Z available · mercury update`，对话中也会出现一条临时通知。设置 `MERCURY_UPDATE_NOTICE=0` 可同时隐藏两者。

安装和更新请求会以匿名方式获取公开的版本列表和压缩包，因此无需账户或 token 即可运行。如果匿名请求被拒绝，Mercury 会查询已登录的 GitHub CLI（`gh`）。

更新之后，Mercury 会检查 PATH 中的命令是否指向已更新的安装。如果另一个安装优先，或者已更新的命令不在 PATH 中，它会说明问题并给出修复方法。`mercury health` 会报告同样的问题。

### 发布验证

在启用某个发布版本之前，Mercury 会用 `SHA256SUMS.txt` 校验其压缩包。在暂存更新之前，它还要求负载（payload）由内置信任名单中的 Mercury 发布密钥签名。签名被拒绝时，当前生效的安装保持不变。

使用 `--allow-unsigned` 可以接受未签名的负载。Mercury 仍会拒绝未知的签名密钥、格式错误的签名块和被篡改的内容。命令结果和本地记录都会显示你允许了未签名的负载。

从 1.0.0-beta.3 起，压缩包在打包时签名，并在发布前验证签名。经过验证的安装在启动时不会添加签名提示。`mercury health` 会报告签名密钥 `627b54b734ca0e72`。

1.0.0-beta.2 的压缩包未签名。这类安装在你不带命令或参数、以交互方式启动 Mercury 时，每次安装只会报告一次来源未签名。健康检查会继续显示该状态。这表示压缩包清单没有签名；下载内容仍会与 `SHA256SUMS.txt` 校验。

[docs/TRUST.md](../TRUST.md) 说明了验证结果以及如何手动检查压缩包。[docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) 介绍启动时的验证。

### 平台说明

上面列出的每个平台都提供发布压缩包。其他机器则需要从源码构建。

Intel 版 Mac 的压缩包从 1.0.0-beta.3 起提供。它们在 Apple silicon 运行器上交叉打包，并在发布前于 Rosetta 下测试启动。使用 1.0.0-beta.2 的 Intel 版 Mac 需要从源码构建。

</details>

## 环境要求

发布压缩包内置了 Node 24 LTS。启动器、`mercury install` 和 `mercury update` 都使用这个内置运行时；就发布版本本身而言，`git` 是唯一需要单独安装的依赖。

从源码构建需要以下条件：

- **Node 24 LTS**，支持范围为 `>=24.20.0 <25`。`.node-version` 固定了用于构建、并随发布压缩包一同提供的补丁版本。
- **bun 1.3.x**，用于构建。发布版本不包含 bun。
- **git**。在 Windows 上，请在 Windows Terminal 或 VS Code 终端中运行 PowerShell 7。参见 [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md)。

Node 的最低版本要求已包含 nodejs/node#56645 的修复。低于 24.20.0 时，在 Windows 上调用工具的无头 `run` 命令会在退出时中止。

启动器按以下顺序选择 Node：明确指定的 `MERCURY_NODE` 可执行文件、内置运行时，然后是 PATH 上兼容的 Node 安装。如果运行时缺失，启动器会报告错误。

### Windows 中的 shell

发布压缩包内置了与 bash 兼容的 shell 引擎（`brush`）。在 Windows 上，它默认为 Bash 工具提供服务：通过 PATHEXT 以裸名找到 `.cmd` 或 `.bat` 程序（如 `npm`），将 `%VAR%` 和 `^` 原样传给批处理文件，在 `cd` 之后运行由相对路径指定的程序，并在两次调用之间保留 shell 状态。不需要 Git for Windows 的 `bash.exe`；安装后，设置 `MERCURY_SHELL_ENGINE=system`，或选择 `system`（位于 `/config` 的 Shell engine 项下），即可让 Bash 工具只运行在 `bash.exe` 上。

查看健康检查中的 `shell` 行，就能知道当前生效的是哪种 shell 以及原因：是内置引擎（Windows 默认值，或由固定项或设置启用），还是在引擎被关闭或其组件包缺失时使用的 Git Bash。

在 macOS 和 Linux 上默认使用系统 shell。若要让此处的 Bash 工具也运行在内置引擎上，并保留持久的 shell 状态，可设置 `MERCURY_SHELL_ENGINE=brush`，或选择 `brush`（位于 `/config` 的 Shell engine 项下）。

没有引擎组件包、也没有 Git for Windows 的源码构建仍可以启动，但 Bash 工具不可用。PowerShell 工具仍然可用，`shell` 诊断会说明如何恢复 Bash 支持。

## 从源码构建

Mercury 使用 bun 构建，并运行于 Node 24 LTS 之上。请先安装[源码构建所需的环境](#环境要求)，包括 bun 1.3.x：

```sh
curl -fsSL https://bun.sh/install | bash           # macOS 和 Linux
powershell -c "irm bun.sh/install.ps1 | iex"       # Windows，在 PowerShell 7 中运行
bun --version                                      # 1.3.x
```

然后，在本仓库的克隆副本中运行：

```sh
bun run setup                      # 只需一次；bun install 加内置的组件包
bun run build.ts                   # 写入 dist/mercury.mjs 与 dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### 终端支持

全屏界面需要真正的 TTY，但对终端尺寸没有最低要求。完整布局从 100 列 × 26 行开始；更小的窗口使用紧凑布局。

当终端通过 `COLORTERM=truecolor` 声明支持，或被识别为 iTerm2、Ghostty、WezTerm、Kitty、Windows Terminal 或 VS Code 时，Mercury 使用 24 位颜色。其他终端使用 256 色，包括 macOS 15 及更早版本中的 Apple 的 Terminal。

健康检查中的 Terminal color 行会报告检测到的颜色深度及其原因。对于支持真彩色但没有声明这一点的终端，可设置 `MERCURY_TRUECOLOR=1`；若要强制使用 256 色，则设置 `MERCURY_TRUECOLOR=0`。

### 可选组件

`setup` 会获取内置的能力组件包：pyright、debugpy、js-debug、额外的语法（grammar）、当前平台的 Node 运行时，以及 brush。如果某个下载失败，该组件包会被跳过，构建和受影响的工具会报告缺少的组件。只运行 `bun install` 得到的构建不包含这些组件包。

要构建语音支持，请在安装了 Rust 的环境中运行 `setup`，这会构建 `native/voice`。若还要构建 `native/whisper`，请再安装 cmake。安装了 Rust 后，`setup` 还会构建桌面驱动原生插件（`native/desktop`），供 `Computer` 工具运行使用。同样在安装了 Rust 的情况下，`setup` 还会构建本地嵌入原生插件（`native/embed`，`bun run scripts/vendor/build-embed.ts`），并获取 118 MB 的 BGE 模型（`bun run scripts/vendor/fetch-embed-models.ts --default`）；没有 cargo 时该组件包会被跳过，setup 会说明这一点，Mneme 的记忆检索则仅做词语匹配。每个发布压缩包都带有为其平台构建的嵌入组件包。在 Linux 和 Windows 上，数学运算由向量化内核完成，因此按语义执行一次 Recall 约需十分之一秒（在使用 Accelerate 的 macOS 上为几百分之一秒）。如果原生构建缺少所需的工具，setup 会跳过它，健康检查会报告缺失的原生插件。由于上游没有提供 Windows 二进制文件，Windows 的 shell 引擎也会在你的机器上编译。

关于 `brush` shell 引擎，请参见[Windows 中的 shell](#windows-中的-shell)以及 [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md)。

构建只写入 `dist/`。配置和会话保存在 `~/.mercury` 中（或保存在 `MERCURY_CONFIG_DIR` 指定的目录中），并在首次运行时创建。在 Windows 上，请直接运行 `node dist\mercury.mjs`。

### 将源码构建安装为命令

`scripts/ops/deploy-runtime.sh` 会把一次干净工作树的构建发布到新的 `<config home>/runtime/builds/<build>` 文件夹中，并让 `runtime/current` 指向它（`runtime/dist` 是同一个链接的旧名称）。`scripts/ops/deploy-launcher.sh` 会把启动器安装到 `<config home>/bin/mercury`。将该目录加入 PATH，以 zsh 为例：

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

如果运行时缺失，启动器会报错并停止，不会切换到其他构建。Node 的选择顺序见[环境要求](#环境要求)。对于发布版本的安装，请运行 `mercury install` 或 `mercury update`；它们不会改动源码检出副本。参见[更新](#更新)。

[AGENTS.md](../../AGENTS.md) 是简短的构建与运行指南。[BUILD-NOTES.md](../../BUILD-NOTES.md) 更详细地介绍了构建过程。

## 首次运行

首次以交互方式运行时，请先选择外观，然后登录一个服务商。浏览主题时，界面会实时预览主题效果。默认主题为 True Black；其他选项是 oasis dark 主题，以及完全不使用颜色的 Black and white：它使用终端自身的前景色和背景色，即 Mercury 在不支持颜色的终端上的样子。之后可以用 `/appearance` 更改。

你也可以选择“sign in later”，先不连接账户，四处看看。若环境中的服务商密钥已经让某个服务商处于登录状态，就不会再询问登录步骤。接下来，Guardrails 步骤会提醒你检查 Mercury 的编辑与命令，并提醒你它读取的内容可能夹带给模型的指令。在 Mercury 能够配置的终端（Terminal.app、VS Code 系列、Alacritty、Zed）中，Terminal keys 步骤可以在终端自身的设置里配置换行键绑定（在 macOS 的 Terminal.app 上，它会把 `Option+Enter` 设为换行，并在所有配置文件中关闭终端响铃，这一改动需要重启 Terminal.app 后生效；在 VS Code 系列、Alacritty 和 Zed 中，则会写入 `Shift+Enter` 作为换行键）。除非你选择启用，否则该功能默认关闭，并会保留备份。

接下来，Mercury 会询问你是否信任所打开的文件夹。在你授予信任之前，工作区配置请求的任何内容都不会运行。这一授权覆盖整个仓库；拒绝则会退出 Mercury。参见 [docs/TRUST.md](../TRUST.md)。

正常的交互式启动会打开首页。首页共有十个菜单项，其中 Continue Last Session 只有在存在会话历史之后才会出现：

- **New Session in \<folder\>** 在当前文件夹中启动一个新会话。
- **Continue Last Session** 返回最近的一次对话。
- **Boot Menu** 用于配置之后的会话，包括动效、crewmate 和工作流。
- **MCPs & Skills** 选择下一个会话要加载的内容。参见 [docs/KIT.md](../KIT.md)。
- **Agents** 用于创建和编辑智能体。
- **Health Check** 检查安装状态。
- **Saturn Scheduler** 用于调度会话。参见 [docs/SATURN.md](../SATURN.md)。
- **Logins** 用于连接服务商账户。
- **Session Concourse** 打开当前项目的会话列表。
- **Sessions · Projects** 让你选择会话或仓库。

菜单项会覆盖在首页之上打开，按 `Esc` 可返回你刚才选择的菜单项。会话列表在单独的界面中打开，也可以按 `Shift+→` 打开。若带有提示词参数，或使用 `--continue` 或 `--resume`，则会直接进入对话。

### 动效、crewmate 与工作流

Boot Menu 的 Performance 区域包含一项 Motion 设置：`auto`、`full`、`reduced` 或 `off`。它控制界面中的空闲动画，也可以在 `/config` 中设置。

在 Agents 下，Crewmates 与 Workflows 两个开关决定新会话能否获得 Crewmate 和 Workflow 工具。关闭某个开关会移除对应的工具；尝试启动该类工作时，将返回相同的说明。在会话中，`/crewmates on|off` 和 `/workflows on|off` 会在下一个轮次边界更改设置。

## 日常流程：Session Concourse、git 工作树与 crewmate

### 启动会话并隔离工作树

在 New Session 上按 `Enter`，即可用默认模型在当前文件夹中创建一个会话。Mercury 会同时打开对话，并把它加入会话列表。为减少启动耗时，它会在菜单后方提前准备好一个进程。

启动另一个会话不会停止之前的会话。你可以让一个任务继续运行，然后去别处工作。使用 `--worktree [name]` 启动（或在对话中要求使用 `worktree`，从而运行 `EnterWorktree`），即可让会话在 `.mercury/worktrees/` 下拥有自己的分支和检出副本。并行的 crewmate 也可以在隔离的工作树中运行，并通过项目文件租约协调共享文件；参见[内置内容](#内置内容mneme-rag-记忆lsp23-语言-astdap-调试器网络搜索与桥接)和 [docs/CREW.md](../CREW.md)。

### 在对话中工作

用平实的语言描述你的工作即可。智能体会在你选定的权限模式下读取、编辑、运行和检查代码。工具调用会在运行时显示，既可以是紧凑的卡片，也可以显示完整输出。你可以在 `/config` 的 Tool output 项下选择显示方式，该设置会保存，供之后的启动使用。

使用 `/model` 和 `/effort` 调整会话。`/permissions` 用于控制哪些操作无需批准即可运行，哪些必须先询问。

使用 `/diff` 按来源、文件和变更块（hunk）查看改动。`! <command>` 可在对话中运行 shell 命令，并实时显示输出的末尾部分。`/runs` 显示正在运行的 shell 和 crewmate（`/tasks` 会打开同一面板），`/crewmates` 则打开实时的 Crew 视图。在两轮对话之间，`/clear` 会保存当前对话并打开一个新会话，`/restart` 会把对话切换到新安装的 Mercury 版本。`/title` 为对话命名，`/help` 列出可用命令。

### 在界面之间切换

`Shift+←` 和 `Shift+→` 可在当前可用的界面之间切换。刚启动时只有首页和会话列表。聚焦某个会话时会加入对话界面，最后一个对话关闭后，该界面随之移除。按键提示只显示可用的切换操作。

关闭所有对话后会返回首页。使用 `--chat` 只显示首页和对话，不显示会话列表。`--concourse-off` 会把这一偏好保存下来，供之后的启动使用；`--concourse-on` 或 `/config` 可将其重新开启。

### 在 Session Concourse 上管理会话

在首页上使用 `/concourse` 或 `Shift+→` 打开会话列表。列表会先显示当前项目中正在运行的会话，然后按从新到旧的顺序显示未在运行的已保存对话。

每个正在运行的会话都有一个 NOW 单元格，显示其当前活动。选中一行并按 `Enter`，即可返回该对话，其他会话继续运行。崩溃的会话会以 NEEDS YOU 状态保留在会话列表中，并显示原因，直到你将其释放。

[docs/SESSIONS.md](../SESSIONS.md) 介绍了会话的生命周期。

## 模型服务商与模型：登录、`/localsetup` 与 `/llmhost`

使用 `/logins` 连接服务商。它会打开与设置过程中相同的登录目录。之后可以用 `/accounts` 管理已连接的服务商槽位。

- **OpenAI：** ChatGPT 订阅或 API 密钥。
- **Anthropic：** Claude 订阅、Console 登录或 API 密钥。
- **OpenRouter：** 通过 OAuth 或 API 密钥访问模型目录；模型请求会拒绝数据收集，并从一开始就要求所有参数都受支持。`/config → OpenRouter routing policy` 用于设置回退（fallback）和零数据保留（zero-data-retention）选项；选择 open 即可放宽策略，把路由交由 OpenRouter 处理。
- **Google Gemini：** 可以使用 Sign in with Google、API 密钥，或你自己的 OAuth 客户端登录。Sign in with Google 会通过 Google 自家的 Antigravity 客户端，使用 Google 账户所持套餐（免费账户、Google AI Pro 或 Google AI Ultra）的配额运行 Gemini：提示词、工具架构（tool schemas）和工具结果会在该客户端与已登录账户的身份下发送至 Google 的 Code Assist 端点，`/model` 则会列出 Google 为该账户提供的模型清单。API 密钥或你自己的 OAuth 客户端则改为向一个 Cloud 项目计费。
- **Hugging Face：** 设备码登录或 Hub token。
- **Kimi（Moonshot）：** 设备码登录或 API 密钥。
- **GLM（Z.AI）：** 可使用 GLM Coding Plan 订阅密钥，或通用的按量付费 API 密钥。`/logins zai` 会保存其中任意一种并记录所属套餐；`ZAI_API_KEY` 同样可用，并可通过 `ZAI_KEY_PLAN=coding|general` 指定套餐（未设置时，Mercury 会从该密钥自身的模型列表中读取）。
- **DeepSeek：** 来自 DeepSeek 平台的 API 密钥（`/logins deepseek`，或 `DEEPSEEK_API_KEY`）。
- **xAI（Grok）：** 使用你的 Grok 订阅（SuperGrok / X Premium）登录，或通过 `/logins xai` 粘贴 API 密钥。
- **Meta（Muse）：** 可使用 Sign in with Meta（Muse Code 订阅，在浏览器中输入设备码）登录，或使用按量付费的 Model API 密钥。Sign in with Meta 会在 Muse Code 的公共客户端 ID 下，用设备码向 Meta 的 OIDC 端点（`https://auth.meta.com/oidc/device/authorization/` 与 `/oidc/device/token/`）换取凭据，将得到的账户 token 仅发送一次到 `https://api.meta.ai/muse-code/key`，以生成该订阅的 API 密钥（并在有限的 `/usage` 读取中获取套餐等级和用量窗口）；之后每个模型请求只把生成的密钥发送到 `https://api.meta.ai/v1`。粘贴的 Model API 密钥，或 `MODEL_API_KEY` / `META_API_KEY`，则按量付费计费。

- **Qwen：** 可使用 QwenCloud 密钥（Token Plan 或按量付费），或阿里云 Model Studio 密钥（按量付费、Token Plan 或 Coding Plan）。密钥在保存前会先在其自身的端点上校验；套餐密钥会列出该套餐的模型，并将 Qwen3.8 Max 排在最前。
- **MiniMax：** Open Platform 密钥或 M Plan 订阅密钥。
- **Together AI** 和 **Cohere：** API 密钥。
- **Groq**、**Cerebras** 和 **Fireworks AI：** API 密钥；任一服务商系列的密钥也可以来自 `credentials.keyCommands.<family>` 中指定的命令。

Mistral、Nous Portal 和 OpenCode Zen 同样可以通过 `/logins` 连接，共计 20 个登录服务商系列。本地模型服务器（Ollama、LM Studio、vLLM 和 llama.cpp）以及自定义的 OpenAI 兼容端点，无需服务商登录即可使用。运行 `/localsetup` 可以安装或启动 Ollama、拉取一个适合你内存容量的模型、设置其上下文窗口，或连接正在运行的 LM Studio、vLLM 或 llama.cpp 服务器（[docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)）。每个服务商都使用自己的协议、凭据和错误处理方式，请求绝不会回退到其他服务商。参见 [docs/ENGINES.md](../ENGINES.md)。

`/llmhost` 会列出你可以托管的模型，并显示每个模型当前可在哪里运行：在从 Runpod、Vast.ai 或 Lambda 租用的 GPU 上、在你自己的电脑或已保存的 SSH 电脑（`mercury host`）上，或在已有的模型服务器上。每个模型页面都会显示量化选项、GPU 显存预算如何在并行对话之间划分（`conversations × context`），以及默认的思考等级（`/effort` 可以按请求更改）。租用 GPU 需要明确确认每小时价格；如果你关闭弹窗，设置会在后台继续进行。在 Runpod 上，你还可以在租用前或在运行中的 pod 上（`Tune`）调整质量、上下文划分和思考设置，将权重保存在快速加载卷上，并设置 5 秒级的库存监视。Vast.ai 与 Lambda 的租用功能是 1.0.0-beta.40 中的新增功能，已依据厂商公布的 API 在测试夹具（fixtures）上完成验证（未执行真实的租用运行）。参见 [docs/LLM-HOST.md](../LLM-HOST.md)。

新会话会使用你最近连接的服务商，以及该账户可用的最新模型。账户无法访问的模型会被跳过。如果该服务商没有可用模型，Mercury 会检查下一个最近连接的服务商。这一选择在会话启动时完成；已存在会话中的失败请求，仍保留在其原来的服务商上。

`/model` 会说明当前的选择。输入系列名称即可选出该系列最新的模型：`/model grok`、`/model deepseek`、`/model kimi` 或 `/model glm`。若未连接任何服务商，首页和 `/model` 会引导你前往 `/logins`。`/defaultprovider` 可以明确地将某个服务商设为最近的选择。

服务商的访问仍受其自身条款和可用性约束。Mercury 的许可证并不会取代这些条款。

## 无头 CLI：`mercury run`、Docker 与 JSON-RPC 运行器

同一构建无需交互界面即可运行。`node dist/mercury.mjs --help` 会列出所有命令行参数。

使用 `mercury run "<prompt>"` 可以在没有终端界面的情况下运行一条提示词：

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` 打印回答；失败轮次的原因输出到 stderr。
- `json` 将最后一行 `outcome` 以单个 JSON 对象的形式打印出来。
- `rows` 每行写入一个 JSON 对象：先是 `session`，然后是一个 `turn` 及其 `text`、`reasoning`、`tool_call`、`tool_result` 和 `step` 行，最后以 `outcome` 结束。等待、工具进度、后台任务和通知各有自己的行。每一行都包含 `seq`、`timestamp` 和 `session_id`；轮次内的行还会带上该轮的 `turn` 编号。`seq` 从 1 开始为本次运行的输出流编号；`turn` 统计的是会话中的轮次，因此继续已保存对话（`-c`、`-r`、`--fork`）的运行，其轮次编号会接在已有轮次之后，并且它的 `session` 行会在 `resume_of` 中注明所继续的对话。

输出行的类型由其 `type` 字段区分：

- `session`：开场行，包含 `version`、`build`（构建该包所用源码树的前十二位十六进制字符，与 `mercury daemon status` 的输出相同；若构建包旁没有清单文件，则不包含此项）、`resume_of`（继续运行时为所继续对话的会话 ID；除非该运行是分叉（fork）而来，否则与 `session_id` 相同）、`cwd`、`model`、`mode`，以及会话拥有的 `tools`、`mcp_servers`、`commands`、`agents`、`skills` 和 `extensions`，另有 `tools_withheld`（当拒绝规则按工具的裸名隐藏某个工具时出现：每一项包含 `tool`、`rule` 和 `source`）。
- `turn`：轮次处于 `started` 或 `waiting` 状态，包含其 `turn_id`；在已知时还包含 `model`、`message_ids` 和 `agents` 数量。
- `text`：已定稿的文本块：`message_id`、`block`、`text`，以及其 `phase`（`commentary` 或 `final_answer`）。
- `reasoning`：已定稿的推理块：`message_id`、`block`、`text`，或 `redacted: true`。
- `tool_call`：一次工具调用：`call_id`、`tool`、`input`，并带有其 `message_id` 和 `block`。
- `tool_result`：调用的结果：`call_id`、`status`（`ok`、`error`、`aborted` 或 `refused`）以及 `output`。若模型生成的调用不合格，以至于在执行前即被拒绝（例如调用了未知工具，或参数不是有效的 JSON，或不符合工具的 schema），它仍会有配对的输出：一条 `tool_call` 行（其中的参数按提交时的原样保留；若参数不是对象，则为 `{}`），以及一条 `tool_result` 行（状态为 `refused`，其 `output` 为拒绝原因）；随后输出更正用的 `notice`。这类调用从未执行，也不计为拒绝（denial）。
- `tool_update`：正在运行的工具的进度：`call_id`、`tick`、`source`（`shell`、`powershell`、`mcp` 或 `eval`），以及调用所报告的 `line`、`elapsed_s`、`lines`、`bytes`、`budget_ms`、`progress` 和 `total` 中的任意字段。shell 或 PowerShell 调用会随输出到达而发出 tick（不打印任何内容的命令永远不会发出 tick）；MCP 调用在其服务器报告进度时发出 tick；Eval 调用在其单元格运行期间发出 tick；其他工具都不发出 tick；Browser 或 Crewmate 调用则在返回结果前保持静默。
- `step`：主线程的一次模型调用：`message_id`、`model`、`usage`；若模型说明了停止原因，则还包含 `stop`。
- `outcome`：该轮次的结果，见下文说明。
- `close`：关闭时为下一个会话留下的备注：`state`（`stored`、`skipped` 或 `none`）、`note_chars`，以及写入该备注的模型调用的 `usage`，因此把每一行的 usage 相加，即可得到 outcome 中的总量。若提示词以参数形式给出，备注会在最后一个轮次内请求，`close` 先于该轮次的 `outcome` 出现；若使用 `--input rows`，则在 stdin 关闭后，它出现在最后一个 `outcome` 之后。
- `wait`：等待模型的状态：`state`（`first_byte`、`retry`、`silence`、`loading` 或 `done`），并附带该状态携带的数值，例如 `since_ms`、`attempt` 和 `of`、`delay_ms`、`reason` 和 `http_status`。
- `heartbeat`：模型流在至少一秒内没有解析出任何事件后又显示出活动迹象：收到了字节，但没有产生任何行。该行不包含其他内容，至多每秒一次；出现频率取决于服务商的流式输出形式，因此在事件之间从不停顿的流不会发出该行。
- `compaction`：上下文压缩（compaction）的 `started`、`progress` 或 `ended` 状态：`trigger`（`manual`、`auto` 或 `overflow`）、`stage`、`fill`、`summary_tokens`，并在结束时包含 `exit`（`landed`、`cancelled` 或 `failed`）。
- `mode`：权限模式已更改：`mode`。
- `rate_limit`：服务商的限额状态：`status`（`allowed`、`warning` 或 `rejected`）、`window`、`resets_at`、`utilization`，以及超额字段。
- `task`：后台任务的 `started`、`progress` 或 `ended` 状态：`task_id`、`task_type`、`description`、`usage`、`summary`、`status`（`completed`、`failed` 或 `stopped`），以及已知时的 `output_file`。
- `notice`：面向读者的 `warning` 或 `error`：`text`，以及 `code`（例如 `input_refused`）。
- `command_output`：未发送给模型的斜杠命令的输出：`command` 和 `text`。
- `mission_updated`：会话的任务账本已更改；请重新读取。
- `samples_updated`：会话的样本已更改；请重新读取。

`--partial` 与 `--format rows` 同用时，会额外添加 `block_start`、`text_delta`、`reasoning_delta`、`tool_input_delta` 和 `retracted` 行。增量（delta）归属于 `message_id` 和 `block`；`retracted` 行会撤回该消息的增量。定稿后的文本行或工具行才是完整的值。

outcome 包含 `schema`、`turn_id`、`status`、`steps`、`wall_ms`、`usage`、`models` 和 `denials`；完成时还包含 `answer`，失败时则包含 `error`（`message`、`class`，以及可选的 `detail`）。在可用时，还会包含 `stop`、`api_ms`、`cost_usd`、所请求的 `structured` 输出以及 `notices`。`wall_ms` 是该轮次经过的时间。`api_ms` 是该轮次发出的所有模型请求（包括重试，以及与主线程并行运行的 crewmate 请求）耗时的总和，因此在请求重叠时，它可能超过 `wall_ms`。`cost_usd` 是该轮次中已计价请求的美元金额，与状态无关：Mercury 无法计价的请求（没有登记费率，或响应中未给出费用）不会计入其中，其所属模型仍会列在 `models` 中，但没有各自的 `cost_usd`；只有当该轮次中没有任何内容被计价时，该字段才会缺失。使用 Claude 订阅登录时，Anthropic 请求没有美元价格，因此这些请求和该行都不包含 `cost_usd`，但 usage 数据依然保留。usage 包含 `input_tokens`（已计入缓存的 token）、`cached_input_tokens`、`cache_write_input_tokens`、`output_tokens`，以及在服务商报告时的 `reasoning_output_tokens`，并在主线程与 crewmate 之间合计。`models` 按模型细分 token 用量。`steps` 只统计主智能体的模型调用；crewmate 发出的模型调用则以各自的 `step` 行出现，并带有 `parent_call_id` 标记。

状态可以是 `completed`、`blocked`、`refused`、`failed`、`interrupted`、`turn_limit`、`budget_limit`、`time_limit`、`schema_unmet` 或 `loop_stopped`。在 `--max-time`（秒数，或 `10m`、`1h`）限制下运行的任务，时间到后会在下一步以 `time_limit` 结束；正在进行的模型调用或工具轮次不会被截断。已完成的运行退出码为 0，其他结果的退出码为 1，用法错误的退出码为 2。SIGINT 和 SIGTERM 会在被中断轮次的 outcome 写出之后，分别以退出码 130 和 143 退出。被拒绝的工具调用会列在 `denials` 中。若拒绝对应的是一次无人能够回答的询问（例如在会询问的模式下没有宿主，即 `--mode dontAsk`，或宿主的询问已过期），并且该轮次中之后的工具调用都没有成功，则运行状态为 `blocked`：回答内容会保留，`error` 会指明工具名称以及如何恢复（`--allowed-tools`、其他 `--mode`，或能够应答询问的宿主），运行以退出码 1 结束。若同一轮次中之后的工具调用成功，该轮次会恢复并以 `completed` 结束（退出码 0），同时附带一条警告 `notice`（`"<Tool> was not approved; the run continued with other tools."`）。你已作出回答的拒绝（通过拒绝规则、钩子，或说了“否”的宿主）会让已完成的轮次保持完成状态。未回答的 `AskUserQuestion` 调用同样会使运行以 `blocked` 结束，问题会引用在 `error` 中；Mercury 从运行所记录的询问中读取结果，而不是从回复文本中读取，因此只写在回复里的问题仍会以 `completed` 结束。未知的斜杠命令会以 `refused` 结束，并输出与交互界面相同的提示语（`Unknown command: /name · /help lists commands`），退出码为 1。

`--input rows` 需要配合 `--format rows` 使用，并且每行读取一个输入对象：

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

输入类型包括：`prompt`（带 `content` 字段，即文本或文本/图像块）、`shell`（带 `command`），以及 `note`（带 `to` 即智能体 ID，和 `content`）。每种类型都接受可选的 `id`；prompt 和 shell 行还接受 `priority`（`now`、`next` 或 `later`）、`sent_at` 和 `origin`。被拒绝的输入结构会产生一条 `notice`（代码为 `input_refused`）；格式错误的 JSON 会使运行结束。这些行只用于传入输入；权限的回答则使用下文的 runner 协议。

使用 `mercury run -`，或把文本通过管道输入 `mercury run`，即可从 stdin 读取完整的提示词。在提供提示词参数的同时，管道中的文本会以带分隔符的上下文形式附加在后面：管道会一直读取到关闭，或静默满一秒为止；因此持续输出的流会被读完，而保持打开却静默的管道不会阻塞运行。若既没有提示词，stdin 又是终端，`run` 会打印其用法说明并以退出码 2 结束。

`--mode <mode>` 选择权限模式。`--sovereign` 会在没有权限提示的情况下运行，`--allow-sovereign` 则使该模式可在之后切换。权限策略和拒绝规则仍然适用。以 root 用户进入 sovereign 模式时，stderr 会输出一条通知，运行继续。

使用 `-c` 继续最近的对话，使用 `-r` 按 ID、标题或选择器恢复对话，使用 `-w` 在受管理的工作树中运行，使用 `--lean` 启动精简会话。`run` 没有可以应答权限询问的宿主：其权限规则和模式决定哪些操作可以运行，仍需批准的调用会被拒绝。

### 无头镜像

仓库根目录下的 `Dockerfile` 会构建一个面向 CI 和服务器的 Linux x64 镜像。它的入口点是 `mercury`，默认子命令是 `run`，因此该镜像会针对挂载的目录树运行一条提示词，并以运行的退出码退出：

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

镜像内含构建包、其 Node 24 运行时（位于 `PATH` 上）、随包内置的搜索、shell、调试器、语言与图像工具，以及 `git` 和证书存储；没有进入界面，也没有登录流程。它以非 root 用户 `mercury` 运行，配置目录位于容器内（`MERCURY_CONFIG_DIR`），`/work` 为其工作目录。颜色和鼠标支持遵循产品自身的终端检测结果；`--user 0` 则以 root 身份运行，并会输出上文提到的那条 sovereign 通知。

服务商密钥通过环境变量传入，名称与产品各处读取的完全相同：`ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`、`OPENAI_API_KEY`、`GEMINI_API_KEY` 或 `GOOGLE_API_KEY`、`XAI_API_KEY`（另可设置 `XAI_MANAGEMENT_API_KEY` 用于其用量计量）、`DEEPSEEK_API_KEY`、`MOONSHOT_API_KEY`、`ZAI_API_KEY`、`OPENROUTER_API_KEY`、`HF_TOKEN`、`MISTRAL_API_KEY`（另可设置 `MISTRAL_ADMIN_API_KEY` 用于组织用量计量）、`NOUS_API_KEY`、`OPENCODE_API_KEY`、`MINIMAX_API_KEY`、`TOGETHER_API_KEY` 或 `TOGETHER_AI_API_KEY`、`COHERE_API_KEY` 或 `CO_API_KEY`、`GROQ_API_KEY`、`CEREBRAS_API_KEY`、`FIREWORKS_API_KEY`、`DASHSCOPE_API_KEY`、`MODEL_API_KEY` 或 `META_API_KEY`、用于自定义 OpenAI 兼容端点的 `MERCURY_COMPAT_API_KEY`，以及用于本地服务器的 `MERCURY_LOCAL_API_KEY`。若没有密钥，运行会以一行提示拒绝执行，并以退出码 1 结束。`docker run -i … mercury run -` 会从 stdin 读取提示词。

### 托管会话

`mercury runner` 通过 stdio 向宿主提供会话：采用 JSON-RPC 2.0，每行一条消息。宿主须先发送 `initialize`，并等待应答后再发送任务：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

宿主的名称和版本放在 `host` 下；`capabilities` 声明 `holds_asks`、`elicitation` 和 `partial_rows`。每个请求的 `id` 都必须是正整数：`id` 为其他任何值的请求都会收到 `-32600` 应答（带 `id: null`），因此请从 1 开始编号。

`queue/add` 接受与上文行输入相同的提示词、shell 或 note 对象。输出通过 `row` 通知到达。`session/facts` 读取会话状态；`session/set_mode` 立即更改权限模式；`session/set_model` 和 `session/set_effort` 更改模型与 effort。若在轮次运行期间进行更改，该更改会保留到轮次结束：应答中带有 `at: "turn_end"`，随后 `session/applied` 会宣告此更改已生效。`turn/interrupt` 用于中止轮次；关闭 stdin 即可结束会话。

权限询问以 `permission/request` 到达，并带有 `kind: "tool"` 或 `kind: "network"`。宿主以 `outcome: "allow"` 或 `outcome: "deny"` 应答；允许时可以附带编辑后的 `input` 和权限 `rules`。被撤回的询问会发送 `$/cancel_request`（附带其 `request_id`）。`holds_asks` 让宿主掌控询问的计时。MCP 的问题只使用 `elicitation/request`（仅当宿主声明 `elicitation` 时）；否则将以 `cancel` 应答。

未知方法会应答 `-32601`，参数无效会应答 `-32602`，`id` 不是正整数会应答 `-32600`，在初始化之前发出的请求会应答 `-32002`。规则拒绝会应答 `-32010`，并在 `error.message` 中给出一句说明，在 `error.data.kind` 中给出原因，例如 `mode`、`model`、`effort` 或 `claim`。runner 遇到格式错误的行时会应答 `-32700` 并继续运行；连续三行格式错误则会结束运行。

### 其他命令

可用命令包括：

- **`mercury health`**：诊断报告，也称健康证书（health certificate）。`--json` 返回完整报告，`--deep` 运行深度清点，`--fix` 运行引导式修复。
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**：登录（`login [<family>]`）、列出服务商系列（`list`）、检查账户是否已登录（`status [<family>]`）、退出登录（`logout [<family>]`），或生成长期有效的 Anthropic token（`mint`）。
- **`mercury models [--json]`**：打印已登录账户可以访问的模型（与 `mercury://models` 的内容相同）。
- **`mercury mcp`**：使用 `add`、`import`、`list`、`get`、`remove`、`trust-reset` 和 `serve` 管理 MCP 服务器。
- **`mercury extensions`**：安装扩展并管理其来源。可用操作：`list`、`sources`、`add`、`remove`、`refresh`、`install`、`trust`、`enable`、`disable`、`update`、`uninstall`、`fence`、`unfence`、`inspect` 和 `scaffold`。
- **`mercury roster`**：列出智能体清单。
- **`mercury usage`**：打印 `/usage` 界面所显示的紧凑数据行；`--json` 则打印完整读数：每个已登录服务商的用量窗口（包括已用量与重置时间）、其报告的数据和额度（各自附带来源和时效），以及按模型统计的会话花费。读取方式与界面相同（每个已登录服务商的读取器只采样一次，与打开界面时相同）。
- **`mercury daemon run|status|stop|restart`**：运行、检查、停止或重启后台守护进程（daemon）。其会话席位均为 `mercury runner` 子进程；守护进程负责发送它们的提示词，并托管它们的权限询问。
- **`mercury sessions list`**（直接输入 `mercury sessions` 也可）：按从新到旧的顺序列出本项目已保存的会话，包括 ID、最后写入时间、大小、守护进程当前托管该会话时显示的 `live` 标记，以及标题或第一条提示词；`--all` 读取所有项目，`--limit <n>` 限制列表长度。ID 即为 `mercury --resume <id>` 重新打开、`sessions delete` 删除时所用的标识。
- **`mercury sessions delete <id>`**：有意删除一个已保存的会话，包括其记录（transcript）以及与之并存的记录（回执、恢复快照）。删除前会先询问；`--yes` 可为脚本跳过该询问。守护进程当前托管的会话会被拒绝删除；未知的 ID 也会被拒绝，并提示参考清单（在 Mercury 内使用 `/sessions`）。除此之外，已保存的会话绝不会自行删除。
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**：把本地或 SSH 计算机作为模型服务器运行，供所有共享同一配置目录的会话使用（`compat/box-<name>/<model>`），所用权重来自已验证的本地权重库或已确认的下载。参见 [docs/LLM-HOST.md](../LLM-HOST.md)。
- **`mercury lsp list`** 和 **`mercury lsp install <server>`**：语言服务器目录会列出每个服务器：已安装的显示其可执行文件，未安装的显示其安装步骤。`install` 会显示某个服务器的安装步骤、询问确认、严格执行该步骤（`--yes` 可为脚本跳过询问），并报告可执行文件的落点。未知的服务器会被拒绝，并附上清单。Mercury 绝不会自行安装语言服务器；打开文件只会启动已安装的服务器。
- **`mercury acp`**：通过 Agent Client Protocol 为编辑器提供服务，每个会话对应一个 runner 子进程。`mercury bridge install` 安装 VS Code 扩展；`mercury bridge status` 检查该扩展；`mercury bridge uninstall` 将其移除。
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**：管理当前目录中 Godot 项目的引擎任务。Mercury 会从冻结的项目副本出发，在自己的无头工作进程上运行测试套件。该服务包括编译检查门（compilation gate）、捕获（capture）、帧统计、定稿的性能分析（profile）、任务队列访问、取消，以及按 ID 获取结果。参见 [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md)。
- **`mercury image <image>`**：在终端中显示图像。
- **`mercury install`** 和 **`mercury update`**（别名 `upgrade`）：安装或更新发布压缩包。使用 `--json` 时，无论结论如何，JSON 文档都会输出到 stdout，退出码则表明是否失败。参见[安装](#安装)。
- **`mercury version`** 和 **`mercury help [command]`**：打印版本信息行或帮助页面，效果与 `--version` 和 `--help` 相同；两者都不会启动会话。

## 内置内容：Mneme RAG 记忆、LSP、23 语言 AST、DAP 调试器、网络搜索与桥接

- **Mneme 混合 RAG 项目记忆。** Mneme 默认开启，将每个项目的事实保存在纯 Markdown 主题页面中（`Retain`、`Recall`、`Reflect`、`Correct`）。Recall 会融合设备端的 118 MB BGE 语义嵌入模型（`bge-base-en-v1.5` `q8_0`，MIT 许可，随每个发布压缩包内置，并针对其平台构建；参见[可选组件](#可选组件)），以及经词干提取（stemming）的 BM25 词语排序、时效加权，并通过倒数排名融合（reciprocal rank fusion，`k = 60`）进行引用追踪。置顶规则（`pin: true`）会逐字载入置顶区，且只有在你明确要求时才会更改。会话开始时，Mercury 会依据当前分支、最近触碰过的文件以及上一次会话的交接笔记，在专用的启动额度（`memory.startLimit`，默认 4,000 个字符）之内，为未置顶的事实和较早的笔记评分。写入时的矛盾检查会在保存冲突事实之前，识别极性、否定和数字的翻转。每个会话在退出时都会用自己的话写下一份交接笔记，供下一个会话的入口页使用，另外还可以写一条可选的会话日志。`/memory` 会打开记忆中心，`/memory page` 则在浏览器中把记忆库绘制为节点与连线的图谱。参见 [docs/MNEME.md](../MNEME.md)。
- **LSP 代码智能、23 种语言的 AST 改写、DAP 调试器与 `Eval` 单元格。** 支持带锚点的读取和原子化的多文件编辑（`ChangeSet`）；可进行语言服务器查询（`LspRead`），以及先预览、再应用的重构（`LspRename`、`LspMoveSymbol`、`LspMoveFile`、`LspCodeAction`、`LspFormat`）；语法树搜索与改写（`AstSearch`、`AstEdit`）支持 `$NAME` 和 `$$$NAME` 元变量，覆盖发布压缩包中的 23 种语法（每次 `bun install` 构建包含 16 种，另有 7 种位于语法组件包中）；提供可持久化的 Python（`python3`）与 JavaScript（Node ES 模块）代码单元格（`Eval`）；此外，还有一个 Debug Adapter Protocol 调试器（`Debug`），可驱动 `debugpy`、`js-debug`、`lldb`、`gdb`、`dlv`、`netcoredbg`、`rdbg`、Dart SDK 自带的调试适配器、`kotlin-debug-adapter`、elixir-ls 调试适配器以及 Godot。`Test` 工具的 `debug` 操作，可以直接把失败的 Python（`pytest`、`unittest`）、JavaScript/TypeScript（`node-test`、`vitest`、`jest`）、Go（`go test`）或 Rust（`cargo test`）测试单步调入 `Debug` 会话。参见 [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md)、[变更事务](../CHANGE-TRANSACTIONS.md)、[结构化模式](../STRUCTURAL-PATTERNS.md)、[代码单元格](../EVAL.md) 以及[调试器](../DEBUGGER.md)。
- **无需密钥的 `WebSearch` 与 Markdown 格式的 `WebFetch`。** `WebSearch` 依次尝试以下途径：若会话模型支持，则优先使用服务商原生的实时搜索（`ProviderSearch`）；然后是已保存的 Brave 或 Tavily 密钥；接着是按查询形式挑选的官方 API（Stack Exchange、npm、PyPI、crates.io、GitHub 代码搜索、Hacker News Algolia、Wikipedia）；再然后是已配置的 SearXNG JSON API（`MERCURY_SEARCH_SEARXNG_INSTANCES`）；最后是无需密钥的 DuckDuckGo 网页抓取（默认开启；可在 `/config` 中关闭，或设置 `MERCURY_SEARCH_KEYLESS=0`）。每个结果都控制在 2,000 个 token 以内，并注明作答的来源。`WebFetch` 会在 38,000 字符的单次调用预算内，以 Markdown 形式读取公开页面并保留页面原文（需要浏览器的页面会通过托管阅读器 `r.jina.ai` 读取，除非设置了 `MERCURY_FETCH_READER=0`；私有网络地址绝不会发送给该阅读器）。参见 [docs/ENGINES.md](../ENGINES.md)。
- **智能体、跨服务商 crewmate（`Crewmate`）、工作树与文件租约。** 内置两个智能体：`mercury-crew` 用于各类委派工作，`mercury-scout` 用于只读侦察；它们与你在 `/agents` 中创建的智能体定义并存。可以在任何已登录的服务商上启动 crewmate，将并行工作隔离在 `git worktree` 检出副本中（`isolation: "worktree"`），并通过进程内的项目文件租约协调共享文件（`mcp__mercury__lease_take`、`mcp__mercury__lease_release`、`mcp__mercury__lease_list`），还可以借助 `SendMessage` 和 `ResumeCrewmate` 按名称或 ID 引导或恢复 crewmate。在 `/crewmates` 和 `/runs` 中可以跟踪 crewmate 与工作流运行。参见 [docs/CREW.md](../CREW.md)。
- **桌面计算机操作。** 在原生桌面驱动可用时默认启用。`Computer` 工具会截取屏幕截图，并控制前台应用中的鼠标和键盘。Mercury 在操作之前会按名称和身份核对应用；除非你的权限规则、会话授权、访问设置或权限模式已允许该操作，否则会请求批准；按 `Esc` 即可停止；同一时间只允许一个会话控制桌面；屏幕截图也不会写入已保存的对话文件。设置 `MERCURY_COMPUTER_USE=0` 可移除该工具。参见 [docs/COMPUTER-USE.md](../COMPUTER-USE.md)。
- **设备端 Whisper 语音输入（`/voice`）。** `/voice on` 会在首次使用时下载 60 MB 的英语语音模型（`base.en-q5_1`），校验其 SHA-256 摘要，并启用听写；`/voice off` 则将其关闭。按住空格键 1 秒后开始说话，松开即停止；或者在语音已开启时直接运行 `/voice`，以开始和停止一段录音（take）。Whisper 在设备端完成转写，语音音频绝不会离开你的机器。`MERCURY_WHISPER_MODEL` 可选择 `tiny.en-q5_1`、`small.en-q5_1`、多语言的 `base-q5_1`，或本地的 `.gguf` 文件。参见 [docs/VOICE.md](../VOICE.md)。
- **Saturn 定时任务与会话调度器（`/saturn`）。** 可以为现有会话安排提示词（`CronCreate`、`CronList`、`CronDelete`、`ScheduleWakeup`、`/loop`），也可以安排一个新会话在设定时间启动。调度可以只运行一次，也可以周期性重复。参见 [docs/SATURN.md](../SATURN.md)。
- **VS Code（ACP）、Unity、Blender、Godot 和 Aseprite 桥接。** `mercury acp` 可连接支持 Agent Client Protocol 的编辑器。VS Code 扩展（`mercury bridge install`）通过该协议在编辑器中运行 Mercury：包括对话、会话、智能体、产物（artifacts）和审阅，并且编辑器的选中内容与诊断信息会随每条提示词一并发送。另有需要主动开启的独立集成，可连接正在运行的 Unity（`MERCURY_UNITY=1`）、Blender（`MERCURY_BLENDER=1`）和 Godot（`MERCURY_GODOT_TOOLS=1`）编辑器，并提供对 Aseprite 的批处理访问（`MERCURY_ASEPRITE=1`）。参见 [Unity](../UNITY-BRIDGE.md)、[Blender](../BLENDER-BRIDGE.md)、[Godot](../VULCAN-GODOT-TOOLS.md) 和 [Aseprite](../ASEPRITE-BRIDGE.md)。
- **扩展。** 每个扩展都只有一个清单（manifest）。可从 git URL、本地文件夹或压缩包添加来源；来源需经其贡献内容哈希（contributions hash）确认后方可使用。参见 [docs/EXTENSIONS.md](../EXTENSIONS.md)。
- **MCPs & Skills。** 按仓库配置会话加载的内容，提供具名预设，并可在会话期间调整控制项。参见 [docs/KIT.md](../KIT.md)。
- **诊断。** 健康检查和 `/health` 会生成有诊断证据支撑的报告，结论为 `certified`、`caution` 或 `fault` 之一，并提供经过验证的修复。参见 [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md)。
- **信任与权限。** 工作区信任、权限规则与模式，以及所有会话都会拒绝执行的命令。参见 [docs/TRUST.md](../TRUST.md)。
- **Apollo Mode**，即规格访谈（specification interview）：回答智能体的问题，以完成它将用来构建原型的规格说明。参见 [docs/APOLLO-MODE.md](../APOLLO-MODE.md)。
- **恢复。** 原子化发布、带日志的操作，以及启动时的状态对账（reconciliation）。参见 [docs/DURABILITY.md](../DURABILITY.md)。

运行时标志定义在 `src/substrate/flagRegistry.ts` 中，以 `MERCURY_*` 设置的形式对外提供，并按需展示。集成兼容性记录在 [docs/COMPATIBILITY.md](../COMPATIBILITY.md) 中。完整的文档索引见 [docs/README.md](../README.md)。

## 斜杠命令

`/help` 会列出可用的交互式命令。使用 `/palette` 进行模糊命令搜索。下表按 `/help` 所用的分类，将默认启用的内置命令分组；实时列表还会包含 `/samples`（位于 `current work` 下，当通过 `MERCURY_SAMPLES=1` 或 Boot Menu 中的 Samples 一行启用 Samples 时）、`/showcase`（当设置了 `MERCURY_DEV_SURFACES=1` 时），以及所有技能或扩展命令。

| 类别 | 命令 |
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

| 命令 | 作用 |
| --- | --- |
| `/llmhost` | 选择要在 Runpod、Vast.ai 或 Lambda 上租用的模型，在你自己的电脑上运行，或连接已有的服务器。 |
| `/restart` | 将当前对话切换到已安装的 Mercury 版本；正在运行的监视任务（watch）和后台 shell 会停止。 |
| `/mcp` | 查看服务器、登录、浏览每个服务器的工具与参数、重新连接，或为当前对话切换某个服务器的启用状态。 |

`/mouse off` 会将指针交还给终端，以便进行原生的文本选择与复制。该偏好会被保存，并在 `/config` 中显示为 Mouse capture。

在技能的用法说明中，必填参数以 `<…>` 开头。例如，`/update-config` 和 `/debug` 需要参数。若单独发送其中一个命令，会得到它的说明和用法，且不会开始新的轮次。在输入建议（typeahead）中选中它后按 Enter，会留下 `/name ` 供你补充参数。`/loop` 没有必填参数，会立即运行。

## 报告问题

如需提交简短报告，可使用[测试者表单](https://mercury-cli.ai/report)，或在 Mercury 中运行 `/bug --short <what you tried>`。它会询问你的操作系统、你尝试了什么以及出了什么问题；不需要附上健康检查的转储信息。

在 Mercury 中运行 `/bug <what happened>`，可以在通过已登录的 GitHub CLI（`gh`）提交之前预览报告。若没有 `gh`，Mercury 会在配置目录下保存一份本地草稿，并指引你前往仓库的 Issues 页面。

你也可以直接使用 bug、provider/model 或 feature request 模板新建 issue。请附上 `--version` 的输出、操作系统、终端以及准确的复现步骤。Bug 和服务商相关的报告还需要提供 `mercury health --json` 的输出；源码构建则使用 `node dist/mercury.mjs health --json`。出错界面的文字记录会很有帮助。

请通过仓库的 Security 标签页私下报告安全问题，不要将其放在公开的 issue 中。参见 [SECURITY.md](../../SECURITY.md)。[CONTRIBUTING.md](../../CONTRIBUTING.md) 介绍了 issue、拉取请求（pull request）和检查流程。

## 许可证

Mercury CLI 依据 [LICENSE.md](../../LICENSE.md) 中的 Apache License 2.0（`Apache-2.0`）授权。[sdk/](../../sdk/) 和 [sdk-py/](../../sdk-py/) 中的 TypeScript 与 Python SDK（在 npm 和 PyPI 上以 `mercury-cli-sdk` 发布）同样依据 Apache License 2.0（`Apache-2.0`）授权，各自由其附带的 LICENSE 文件（[sdk/LICENSE](../../sdk/LICENSE) 与 [sdk-py/LICENSE](../../sdk-py/LICENSE)）约束。

Mercury 名称与标识的使用适用[商标政策](../../TRADEMARKS.md)。随附的第三方许可证列在 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) 中。
