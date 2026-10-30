[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI（mercury-cli.ai、npm パッケージ `mercury-tech-cli`）は、macOS、Linux、Windows 上で、自分の git リポジトリの中から AI コーディングエージェントをターミナルで実行します。

ウェブサイト：[mercury-cli.ai](https://mercury-cli.ai) · リポジトリ：[github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI)（`Whq02/MercuryCLI`）· npm：`mercury-tech-cli`

エージェントはファイルを読み書きし、シェルコマンドを実行し、テストやデバッガーを一歩ずつ進めて、結果を確認します。モデルプロバイダー、モデル、エージェントに許可する操作の範囲は、自分で選べます：

- **複数セッションの Concourse と分離されたワークツリー：** Session Concourse（`/concourse`）で複数のセッションを並べて実行でき、並列の作業は、プロバイダーをまたぐ crewmate（`Crewmate`）へ、分離された `git worktree` のチェックアウトとプロジェクトファイルのリースを使って委任できます。並列のエージェント同士がファイルを上書きし合わないようにするためです。
- **22 のモデルプロバイダー、`/llmhost` と `/localsetup`：** 22 のプロバイダー（OpenAI、Anthropic、Google Gemini、DeepSeek、Moonshot/Kimi、Z.AI/GLM、OpenRouter、Hugging Face、xAI/Grok、Meta/Muse、Mistral、Nous Portal、OpenCode Zen、Qwen、MiniMax、Together AI、Cohere、Groq、Cerebras、Fireworks AI、Melious AI、OrcaRouter）すべてに同時にサインインした状態を保ち、チャットの途中でプロバイダーやモデルを切り替えられます。`/llmhost` を開くと、モデルを選び、量子化方式、`conversations × context` の配分、思考レベルを確認できます。そして、レンタルした GPU（Runpod、Vast.ai、Lambda）、自分のコンピューター（`mercury host`）、または既存のサーバーで実行できます。`/localsetup` を実行すると、Ollama をインストールまたは接続し、LM Studio、vLLM、llama.cpp と並べて使えます。
- **Mneme ハイブリッド RAG のプロジェクトメモリ：** デバイス上で動作する 118 MB の BGE セマンティック埋め込みモデル（`bge-base-en-v1.5`）を使い、BM25 の単語ランキングと引用の追跡、原文のまま保持されるピン留めルール、ブランチを意識した起動時のコンテキスト、書き込み時の矛盾チェック、セッションの引き継ぎメモ、`/memory page` のブラウザーグラフを備えます。
- **コンパイラー、AST、DAP のデバッグツール：** LSP によるコードインテリジェンスとプレビュー付きのリファクタリング（`LspRead`、`LspRename`、`LspMoveSymbol`、`LspMoveFile`、`LspCodeAction`、`LspFormat`）に接続し、23 言語対応の tree-sitter による AST の構造検索と書き換え（`AstSearch`、`AstEdit`）を使えます。組み込みの Debug Adapter Protocol デバッガー（`Debug`、`debugpy`、`js-debug`、`lldb`、`gdb`、`dlv`）は、失敗した Python、Node、Go、Rust のテストにステップ実行で入り込めます。永続化される Python と JavaScript の `Eval` セルも使えます。
- **キー不要の `WebSearch` と Markdown 形式の `WebFetch`：** プロバイダー提供のネイティブ検索、Brave または Tavily のキー、公式 API（Stack Exchange、npm、PyPI、crates.io、GitHub、Hacker News、Wikipedia）、SearXNG、キー不要の DuckDuckGo で検索し、38,000 文字の呼び出し予算の中で、公開ドキュメントを Markdown として取得します。
- **デスクトップ操作、Whisper 音声入力、Saturn スケジューリング、エディターブリッジ：** デスクトップアプリケーションを操作し（`Computer`）、プッシュトゥトーク方式の音声入力をデバイス上の Whisper で文字に起こし（`/voice`）、Saturn で定期的または単発のセッションを予約し（`/saturn`）、Agent Client Protocol（`mercury acp`）経由で VS Code に接続します。Unity、Blender、Godot、Aseprite とも連携します。
- **動画生成（`Video`）：** 設定済みの MiniMax ジェネレーターにプロンプトとプロジェクトの参照ファイルを送り（[docs/VIDEO.md](../VIDEO.md)）、生成された MP4 と、必要に応じて 1 秒の PNG プレビューフレームを、プロジェクトに保存します。

Mercury は Mercury 自身の開発にも使われており、複数のセッションとモデルを組み合わせて長時間のタスクを進めています。難しいのは、その作業全体を把握し続けることです。何がまだ実行中か、何が変わったか、何に判断が必要か。各セッションは終了時に自分の引き継ぎメモを書き、次のセッションは起動時に、私のピン留めされたルールと一緒にそのメモを一度読み込みます。これにより、セッション間のコンテキスト汚染を防ぎます。

![セッションボードでコーディネーターに一つのプロンプトを送ると、二つのセッションが起動し、それぞれ独自のワークツリーで動きます。一方は編集の前に確認を求め、両方とも確認できる変更を用意して完了します](../media/session-board-stream.gif)

Mercury は Apache License 2.0 のもとでオープンソースとして公開されており、[sdk/](../../sdk/) と [sdk-py/](../../sdk-py/) の SDK も同様です。

## インストール

リリースアーカイブは、Apple silicon と Intel の Mac、Linux の x64 と arm64、Windows の x64 と arm64 向けに提供されています。`git` は別途インストールしてください。各アーカイブには Node と ripgrep が含まれているため、Node を別途インストールする必要はありません。

インストール方法を一つ選んでください：

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS と Linux（x64 と arm64）
irm https://mercury-cli.ai/install.ps1 | iex        # Windows（x64 と arm64）、PowerShell 7 で実行
brew install Whq02/mercury/mercury                 # Homebrew：macOS と Linux x64
npm install -g mercury-tech-cli                    # npm。`bun install -g mercury-tech-cli` も同じパッケージです
mise use -g npm:mercury-tech-cli                   # mise。npm パッケージ経由
```

インストール用の URL では、取得元と UTC の日付ごとに、スクリプトからのリクエスト数のおおよその値を保持します（完了したインストールは数えません）。カウンターは IP アドレス、User-Agent 文字列、Cookie を保存しません。

新しいターミナルを開くか、シェルのインストーラーが表示する `export PATH=…` の行を実行してから、`mercury --version` でバージョンを確認します。リポジトリ内で `mercury` を実行すると、[初回起動](#初回起動)が始まります。Windows PowerShell の場合、また Homebrew、npm、bun、mise でインストールした後は、同じターミナルで `mercury` がそのまま使えます。

<details>
<summary>インストール先、アップデート、リリースの検証</summary>

### インストール方法の違い

シェルと PowerShell のインストーラーは、お使いのプラットフォーム向けの最新リリースを取得し、`SHA256SUMS.txt` に対して SHA-256 を検証し、展開して、アーカイブ内に含まれる `mercury install` コマンドを実行します。

Homebrew と npm パッケージは、それぞれ特定のリリースに固定されており、タグが付いた後に再公開されるため、最新リリースより遅れることがあります。Homebrew のコマンドでは、tap の完全名 `Whq02/mercury/mercury` を使います（単なる `mercury` は `homebrew-core` では別のプログラムです）。npm パッケージ `mercury-tech-cli` は、固定されたリリースをダウンロードするランチャーです。mise も同じパッケージをインストールします。`mercury install --uninstall` は、設定とセッションを残したまま、インストールされたリリースとコマンドのシムを削除します（npm ランチャーをインストールした場合は、`npm uninstall -g mercury-tech-cli` も実行してください）。

Mercury のインストールはユーザー単位で行われ、管理者権限は不要です。インストールコマンドは安全に再実行できます。

### インストール先

リリースのバージョンは、設定ホームの `~/.mercury/versions/<version>` に置かれます（Windows では `%USERPROFILE%\.mercury\versions`）。`mercury` コマンドは、macOS と Linux では `~/.local/bin` に、Windows では `%LOCALAPPDATA%\Mercury\bin` にインストールされます。

`mercury install` は、コマンドのディレクトリを一度だけ PATH に追加します。シェルの起動ファイルに保護された 1 行を書き込むか、Windows のユーザー PATH にエントリを追加します。新しいターミナルでは、この変更が自動的に反映されます。

### アップデート

どのインストール方法でも `mercury update` を使えます。

シェルまたは PowerShell のインストーラー、あるいは `mercury install` でインストールした場合は、Mercury をその場でアップデートします。`--check` はアップデートを確認し、`--status` はアップデートの状態を表示し、`--rollback` は一つ前のバージョンに戻します。そのバージョンはディスクに残ります。

Homebrew の場合は、`brew upgrade Whq02/mercury/mercury` を実行する前に確認を求めます。既定の回答は「いいえ」です。承認するには `y` を入力します。Mercury はコマンドの出力をリアルタイムで表示し、その後にインストール済みのバージョンを確認します。スクリプトでは `--yes` を使うと確認を省略できます。

npm ランチャーは、インストーラーと同じリリースのレイアウトを使い、各実行をインストール済みのリリースに委ねます。そのため `mercury update` は、Mercury 独自のアップデートチャネルを通じて npm インストールをその場でアップデートします。`npm update -g mercury-tech-cli` が変更するのは、パッケージが初回実行時にインストールするリリースだけです。mise を使う場合も同様です。

`--check` は、どのインストール方法でも同じリリース一覧を読み込み、お使いのインストールをどう更新すればよいかを示します。アップデートがあると、ホーム画面の右下に `vX.Y.Z available · mercury update` が一度表示され、チャットにはアップデートするまで同じ通知が出ます。両方を非表示にするには `MERCURY_UPDATE_NOTICE=0` を設定します。

インストールとアップデートのリクエストは、公開されているリリース一覧とアーカイブを匿名で取得します。アカウントやトークンがなくても実行できます。匿名のリクエストが拒否された場合、Mercury はサインイン済みの GitHub CLI（`gh`）を参照します。

アップデートの後、Mercury は PATH 上のコマンドが更新されたインストールを指しているかを確認します。別のインストールが優先されている場合や、更新されたコマンドが PATH にない場合は、問題と修正方法を説明します。`mercury health` も同じ問題を報告します。

### リリースの検証

リリースを有効にする前に、Mercury はそのアーカイブを `SHA256SUMS.txt` と照合します。また、更新を準備する前に、ビルドに組み込まれた信頼リストにある Mercury リリースキーで署名されたペイロードを要求します。署名が拒否された場合、有効なインストールは変更されません。

署名のないペイロードを受け入れるには `--allow-unsigned` を使います。それでも Mercury は、未知の署名キー、形式の不正な署名ブロック、改ざんされた内容を拒否します。コマンドの結果とローカルの記録の両方に、署名のないペイロードを許可したことが示されます。

リリースアーカイブには署名があります。インストール済みリリースの署名を確認するには、`mercury health` を実行します。

リリース署名のないアーカイブは未署名と表示されます。`--allow-unsigned` を指定しない限り、インストールと更新はこれを拒否します。

[docs/TRUST.md](../TRUST.md) では、検証結果と、アーカイブを手動で確認する方法を説明しています。[docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) では、起動時の検証を扱っています。

### プラットフォームに関する注意

上記のすべてのプラットフォーム向けにリリースアーカイブがあります。それ以外のマシンでは、ソースからビルドします。

Intel Mac 向けのリリースアーカイブを利用できます。

</details>

## 必要条件

リリースアーカイブには Node 24 LTS が含まれています。ランチャー、`mercury install`、`mercury update` はこの同梱ランタイムを使います。リリース版そのものに必要な別の依存関係は `git` だけです。

ソースからビルドするには、次が必要です：

- **Node 24 LTS**（対応範囲は `>=24.20.0 <25`）。`.node-version` は、ビルドに使われ、リリースアーカイブにも含まれるパッチバージョンを固定します。
- ビルド用の **bun 1.3.x**。リリースには同梱されていません。
- **git**。Windows では、Windows Terminal または VS Code のターミナル内で PowerShell 7 を実行してください。[docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md) を参照してください。

Node の最小バージョンには、nodejs/node#56645 の修正が含まれています。24.20.0 より前では、ツールを呼び出すヘッドレスの `run` コマンドが Windows で終了時に中止されます。

ランチャーは次の順序で Node を選びます：明示的に指定された `MERCURY_NODE` のバイナリ、同梱ランタイム、そして PATH 上の互換性のある Node インストール。ランタイムがない場合、ランチャーはエラーを報告します。

### Windows のシェル

リリースアーカイブには、Mercury の bash 互換シェルエンジン（`brush`）が含まれています。Windows では、既定で Bash ツールにこのエンジンを使います。`.cmd` や `.bat` のプログラム（`npm` など）は、PATHEXT を通じて名前だけで見つけ、`%VAR%` と `^` はそのままバッチファイルに渡し、`cd` の後に相対パスで指定されたプログラムを実行し、呼び出しの間もシェルの状態を保持します。Git for Windows の `bash.exe` は必要ありません。インストールされている場合は、`MERCURY_SHELL_ENGINE=system` を設定するか、`system` を `/config` の Shell engine で選ぶと、Bash ツールは `bash.exe` だけで実行されます。

どのシェルが有効で、その理由が何かは、ヘルスチェックの `shell` の行で確認できます。同梱エンジン（Windows の既定値、またはピン留めや設定で有効化されたもの）か、エンジンが無効になっている、またはそのパックがない場合の Git Bash かのどちらかです。

macOS と Linux では、既定でシステムのシェルを使います。同じく同梱エンジンで Bash ツールを動かし、シェルの状態を保持するには、`MERCURY_SHELL_ENGINE=brush` を設定するか、`brush` を `/config` の Shell engine で選びます。

エンジンパックも Git for Windows もないソースビルドでも起動はしますが、Bash ツールは使えません。PowerShell ツールは引き続き使え、`shell` の診断で Bash サポートを復元する方法が説明されます。

## ソースからのビルド

Mercury は bun でビルドし、Node 24 LTS 上で動作します。bun 1.3.x を含む、[ソースビルドの必要条件](#必要条件)をインストールしてください：

```sh
curl -fsSL https://bun.sh/install | bash           # macOS と Linux
powershell -c "irm bun.sh/install.ps1 | iex"       # Windows、PowerShell 7 で実行
bun --version                                      # 1.3.x
```

続けて、このリポジトリのクローンで実行します：

```sh
bun run setup                      # 初回のみ。bun install とベンダー同梱のパック
bun run build.ts                   # dist/mercury.mjs と dist/manifest.json を書き出します
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### ターミナルのサポート

全画面表示のインターフェースには実際の TTY が必要ですが、ターミナルの最小サイズはありません。完全なレイアウトは 100 列 × 26 行から始まり、それより小さいウィンドウではコンパクトなレイアウトを使います。

ターミナルが `COLORTERM=truecolor` で対応を通知している場合、または iTerm2、Ghostty、WezTerm、Kitty、Windows Terminal、VS Code として認識される場合、Mercury は 24 ビットカラーを使います。それ以外のターミナルでは 256 色を使います。macOS 15 以前の Apple の Terminal も含まれます。

ヘルスチェックの Terminal color の行には、検出された色の深さと、その理由が表示されます。トゥルーカラーに対応しているのに通知しないターミナルでは `MERCURY_TRUECOLOR=1` を、256 色を強制するには `MERCURY_TRUECOLOR=0` を設定します。

### オプションのコンポーネント

`setup` は、同梱の機能パックを取得します。内容は pyright、debugpy、js-debug、追加の文法（grammar）、プラットフォーム用の Node ランタイム、brush です。ダウンロードに失敗すると、そのパックはスキップされ、ビルドと影響を受けるツールが不足しているコンポーネントを報告します。`bun install` だけを実行すると、これらのパックを含まないビルドになります。

音声サポートをビルドするには、Rust をインストールした状態で `setup` を実行します。これで `native/voice` がビルドされます。`native/whisper` もビルドするには cmake を追加します。Rust がインストールされていると、`setup` はデスクトップドライバーのアドオン（`native/desktop`）もビルドし、`Computer` ツールはこれを通じて動作します。同じく Rust がインストールされていると、`setup` はローカル埋め込みアドオン（`native/embed`、`bun run scripts/vendor/build-embed.ts`）もビルドし、118 MB の BGE モデル（`bun run scripts/vendor/fetch-embed-models.ts --default`）を取得します。cargo がない場合はそのパックがスキップされ、setup がその旨を示します。Mneme のメモリ検索は単語の一致だけで動作します。どのリリースアーカイブにも、そのプラットフォーム向けにビルドされた埋め込みパックが含まれています。Linux と Windows では、計算がベクトル化されたカーネルで実行されるため、意味による Recall は約 0.1 秒で完了します（Accelerate を使う macOS では数百分の一秒）。ネイティブビルドに必要なツールがない場合、setup はそれをスキップし、ヘルスチェックは不足しているアドオンを報告します。上流に Windows 用のバイナリがないため、Windows のシェルエンジンもお使いのマシンでコンパイルされます。

`brush` シェルエンジンについては、[Windows のシェル](#windows-のシェル)と [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) を参照してください。

ビルドが書き込むのは `dist/` だけです。設定とセッションは `~/.mercury`、または `MERCURY_CONFIG_DIR` で指定したディレクトリに保存され、初回実行時に作成されます。Windows では `node dist\mercury.mjs` を直接実行してください。

### ソースビルドをコマンドとしてインストールする

`scripts/ops/deploy-runtime.sh` は、クリーンなツリーのビルドを新しい `<config home>/runtime/builds/<build>` フォルダーに公開し、`runtime/current` をそこへ向けます（`runtime/dist` は同じリンクの旧名称です）。`scripts/ops/deploy-launcher.sh` は、ランチャーを `<config home>/bin/mercury` にインストールします。そのディレクトリを PATH に追加してください。zsh の場合は次のとおりです：

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

ランタイムがない場合、ランチャーはエラーで停止します。別のビルドに切り替えることはありません。Node の選択は[必要条件](#必要条件)の順序に従います。リリース版のインストールには `mercury install` または `mercury update` を実行してください。これらはソースのチェックアウトを変更しません。[アップデート](#アップデート)を参照してください。

[AGENTS.md](../../AGENTS.md) は、ビルドと実行の簡単なガイドです。[BUILD-NOTES.md](../../BUILD-NOTES.md) では、ビルドについてより詳しく説明しています。

## 初回起動

初めて対話的に実行するときは、まず外観を選び、次にプロバイダーにサインインします。テーマを選んでいる間、画面は変更内容をプレビューします。既定は True Black です。ほかに oasis dark テーマと、色をまったく使わない Black and white があります。後者は、ターミナル自身の文字色と背景色をそのまま使うもので、色のないターミナルでの Mercury の見た目です。後から `/appearance` で変更できます。

アカウントを接続せずに見て回るには、「sign in later」を選ぶこともできます。環境内のプロバイダーキーですでにプロバイダーにサインインしている場合、サインインの手順は表示されません。次に Guardrails の手順で、Mercury の編集やコマンドを確認するよう注意が表示されます。また、Mercury が読み込む内容には、モデルへの指示が含まれている可能性があることも示されます。Mercury が設定方法を知っているターミナル（Terminal.app、VS Code 系、Alacritty、Zed）では、Terminal keys の手順で、ターミナル自身の設定に改行用のキーバインドを設定できます。macOS の Terminal.app では、改行に `Option+Enter` を割り当て、すべてのプロファイルでベルを消音します。これは Terminal.app を再起動すると有効になります。VS Code 系、Alacritty、Zed では、改行用に `Shift+Enter` を書き込みます。選択しない限り無効のままで、バックアップが保持されます。

次に Mercury は、開いたフォルダーを信頼するかどうかを尋ねます。その信頼を与えるまで、ワークスペースの設定が要求するものは何も実行されません。この許可はリポジトリ全体に及びます。拒否すると Mercury は終了します。[docs/TRUST.md](../TRUST.md) を参照してください。

通常の対話的な起動では、ホーム画面が開きます。メニュー項目は 10 個あり、Continue Last Session はセッションの履歴ができてからのみ表示されます：

- **New Session in \<folder\>** 現在のフォルダーで新しいセッションを開始します。
- **Continue Last Session** 直近のチャットに戻ります。
- **Boot Menu** 今後のセッションを設定します。モーション、crewmate、ワークフローの設定を含みます。
- **MCPs & Skills** 次のセッションで読み込む内容を選びます。[docs/KIT.md](../KIT.md) を参照してください。
- **Agents** エージェントを作成し、編集します。
- **Health Check** インストールを確認します。
- **Saturn Scheduler** セッションをスケジュールします。[docs/SATURN.md](../SATURN.md) を参照してください。
- **Logins** プロバイダーのアカウントに接続します。
- **Session Concourse** 現在のプロジェクトのセッション一覧を開きます。
- **Sessions · Projects** セッションまたはリポジトリを選べます。

メニュー項目はホーム画面の上に開き、`Esc` で選択していた項目に戻ります。セッション一覧は別の画面で開き、`Shift+→` でも開けます。プロンプトの引数、`--continue`、`--resume` を指定すると、直接チャットに入ります。

### モーション、crewmate、ワークフロー

Boot Menu の Performance セクションには Motion の設定があり、`auto`、`full`、`reduced`、`off` から選べます。インターフェースでのアイドル時のアニメーションを制御し、`/config` でも設定できます。

Agents の下にある Crewmates と Workflows のスイッチは、新しいセッションで Crewmate と Workflow のツールを使えるかどうかを決めます。スイッチを切ると対応するツールは削除され、その種類の作業を開始しようとすると同じ説明が返されます。セッション内では、`/crewmates on|off` と `/workflows on|off` で、次のターンの区切りから設定を変更できます。

## 日常の作業の流れ: Session Concourse、git ワークツリー、crewmate

### セッションを開始し、ワークツリーを分離する

New Session で `Enter` を押すと、既定のモデルを使って現在のフォルダーにセッションを作成します。Mercury はそのチャットを開き、同時にセッション一覧へ追加します。起動時の待ち時間を減らすため、メニューの裏でプロセスを一つ準備しておきます。

別のセッションを開始しても、前のセッションは止まりません。タスクを実行したままにして、別の作業を進められます。`--worktree [name]` を付けて起動すると（またはチャットで `worktree` を依頼して `EnterWorktree` を実行すると）、セッションは `.mercury/worktrees/` の下に独自のブランチとチェックアウトを持ちます。並列の crewmate も分離されたワークツリーで動き、プロジェクトファイルのリースで共有ファイルを調整できます。詳しくは[機能一覧](#機能一覧mneme-rag-メモリlsp23-言語-astdap-デバッガーweb-検索とブリッジ)と [docs/CREW.md](../CREW.md) を参照してください。

### チャットでの作業

作業は平易な言葉で説明します。エージェントは、選んだ権限モードのもとでコードを読み、編集し、実行して確認します。ツールの呼び出しは実行されると同時に表示され、コンパクトなカードで表示することも、出力全体を表示することもできます。表示方法は `/config` の Tool output で選べます。この設定は保存され、次回以降の起動にも使われます。

`/model` と `/effort` でセッションを調整します。`/permissions` では、承認なしで実行できるものと、先に確認が必要なものを制御します。

`/diff` で、ソース、ファイル、ハンク単位の変更を確認できます。`! <command>` はチャット内でシェルコマンドを実行し、出力の末尾をリアルタイムで表示します。`/runs` は実行中のシェルと crewmate を表示し（`/tasks` でも同じボードが開きます）、`/crewmates` はライブの Crew ビューを開きます。ターンとターンの間で、`/clear` は現在のチャットを保存して新しいセッションを開き、`/restart` はチャットを新しくインストールされた Mercury のビルドに移します。`/title` はチャットに名前を付け、`/help` は利用可能なコマンドを一覧表示します。

### 画面の切り替え

`Shift+←` と `Shift+→` で、現在利用可能な画面の間を移動します。起動直後はホーム画面とセッション一覧があります。セッションにフォーカスするとチャット画面が加わり、最後のチャットを閉じると削除されます。キーのヒントには、利用可能な移動だけが表示されます。

すべてのチャットを閉じるとホーム画面に戻ります。セッション一覧を使わず、ホーム画面とチャットだけを表示するには `--chat` を使います。`--concourse-off` はその設定を今後の起動のために保存します。`--concourse-on` または `/config` で再びオンにできます。

### Session Concourse でセッションを管理する

ホーム画面から `/concourse` または `Shift+→` でセッション一覧を開きます。一覧ではまず現在のプロジェクトで実行中のセッションを表示し、その後に実行中でない保存済みのチャットを新しい順に並べます。

実行中の各セッションには、現在の動作を示す NOW セルがあります。行を選んで `Enter` を押すと、他のセッションは実行を続けたままチャットに戻ります。クラッシュしたセッションは、理由とともに NEEDS YOU としてセッション一覧に残り、解放するまで表示されたままです。

[docs/SESSIONS.md](../SESSIONS.md) では、セッションのライフサイクルを説明しています。

## プロバイダーとモデル: サインイン、`/localsetup`、`/llmhost`

`/logins` でプロバイダーに接続します。セットアップ時と同じサインインのカタログが開きます。その後、接続済みのプロバイダースロットは `/accounts` で管理します。

- **OpenAI：** ChatGPT のサブスクリプション、または API キー。
- **Anthropic：** Claude のサブスクリプション、Console でのサインイン、または API キー。
- **OpenRouter：** OAuth または API キーでモデルのカタログにアクセスします。モデルへのリクエストではデータ収集を拒否し、最初からすべてのパラメーターを必須にします。`/config → OpenRouter routing policy` では、フォールバックとゼロデータ保持（zero-data-retention）の選択肢を設定します。open を選ぶと、ポリシーを緩めてルーティングを OpenRouter に任せられます。
- **Google Gemini：** Sign in with Google、API キー、または自分の OAuth クライアント。Sign in with Google では、Google アカウントが持つプラン（無料アカウント、Google AI Pro、Google AI Ultra）のクォータを使い、Google 独自の Antigravity クライアント経由で Gemini を実行します。プロンプト、ツールスキーマ、ツールの結果は、そのクライアントとサインイン済みアカウントのもとで Google の Code Assist エンドポイントに送られます。`/model` には、そのアカウントに Google が提供するモデルの一覧が表示されます。API キーまたは自分の OAuth クライアントを使う場合は、代わりに Cloud プロジェクトに課金されます。
- **Hugging Face：** デバイスコードによるサインイン、または Hub トークン。
- **Kimi（Moonshot）：** デバイスコードによるサインイン、または API キー。
- **GLM（Z.AI）：** GLM Coding Plan のサブスクリプションキー、または従量課金の一般的な API キー。`/logins zai` でどちらも保存でき、プランも記録されます。`ZAI_API_KEY` も使えます。その場合、`ZAI_KEY_PLAN=coding|general` でプランを指定します（未設定の場合、Mercury はキー自身のモデル一覧からプランを読み取ります）。
- **DeepSeek：** DeepSeek プラットフォームの API キー（`/logins deepseek`、または `DEEPSEEK_API_KEY`）。
- **xAI（Grok）：** Grok のサブスクリプション（SuperGrok / X Premium）でサインインするか、`/logins xai` から API キーを貼り付けます。
- **Meta（Muse）：** Sign in with Meta（Muse Code のサブスクリプション。ブラウザーでデバイスコードを入力します）、または従量課金の Model API キー。Sign in with Meta では、Muse Code の公開クライアント ID を使って、Meta の OIDC エンドポイント（`https://auth.meta.com/oidc/device/authorization/` と `/oidc/device/token/`）でデバイスコードを交換します。得られたアカウントトークンは一度だけ `https://api.meta.ai/muse-code/key` に送られ、サブスクリプションの API キーが発行されます。プランのティアと使用量の期間を取得するため、限定的な `/usage` の読み取りも行われます。その後のモデルへのリクエストでは、発行されたキーだけを `https://api.meta.ai/v1` に送ります。貼り付けた Model API キー、または `MODEL_API_KEY` / `META_API_KEY` は従量課金になります。

- **Qwen：** QwenCloud のキー（Token Plan または従量課金）、または Alibaba Cloud Model Studio のキー（従量課金、Token Plan、Coding Plan）。キーは保存される前に、それぞれのエンドポイントで確認されます。プランのキーの場合は、そのプランのモデルが一覧表示され、Qwen3.8 Max が先頭に来ます。
- **MiniMax：** Open Platform のキー、または M Plan のサブスクリプションキー。
- **Together AI** と **Cohere：** API キー。
- **Groq**、**Cerebras**、**Fireworks AI：** API キー。どの系列のキーも、`credentials.keyCommands.<family>` で指定したコマンドから取得できます。

Mistral、Nous Portal、OpenCode Zen も `/logins` から接続できます。サインイン対象のプロバイダー系列は、合計で 22 になります。ローカルのモデルサーバー（Ollama、LM Studio、vLLM、llama.cpp）と、カスタムの OpenAI 互換エンドポイントは、プロバイダーへのサインインなしで使えます。`/localsetup` を実行すると、Ollama のインストールや起動、メモリに収まるモデルの取得、コンテキストウィンドウの設定、または実行中の LM Studio、vLLM、llama.cpp サーバーへの接続ができます（[docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)）。各プロバイダーは独自のプロトコル、認証情報、エラー処理を使い、リクエストが別のプロバイダーにフォールバックすることはありません。[docs/ENGINES.md](../ENGINES.md) を参照してください。

`/llmhost` は、ホストできるモデルを一覧表示し、各モデルを今どこで実行できるかを示します。Runpod、Vast.ai、Lambda からレンタルした GPU、自分のコンピューターまたは保存済みの SSH コンピューター（`mercury host`）、あるいは既存のモデルサーバーです。各モデルのページには、量子化オプション、GPU メモリの予算が並列の会話にどう分かれるか（`conversations × context`）、既定の思考レベル（`/effort` でリクエストごとに変更できます）が表示されます。GPU のレンタルには、時間単位の価格の明示的な確認が必要です。ポップアップを閉じても、セットアップはバックグラウンドで続行されます。Runpod では、レンタル前、または実行中のポッドで、品質・コンテキストの分割・思考設定を調整することもできます（`Tune`）。さらに、重みを高速読み込みボリュームに保持し、5 秒間隔の在庫監視を設定できます。Vast.ai と Lambda のレンタル機能は 1.0.0-beta.40 で追加されたもので、ベンダーが公開している API に対してフィクスチャで検証されています（実際のレンタルによる実行は行っていません）。[docs/LLM-HOST.md](../LLM-HOST.md) を参照してください。

新しいセッションでは、直近で接続したプロバイダーと、そのアカウントで利用できる最新のモデルを使います。アカウントがアクセスできないモデルはスキップされます。そのプロバイダーに使えるモデルがない場合、Mercury は次に直近で接続したプロバイダーを確認します。この選択はセッションの開始時に行われます。既存のセッションで失敗したリクエストは、そのプロバイダーに留まります。

`/model` は現在の選択を説明します。系列名を指定すると、その系列の最新モデルを選びます：`/model grok`、`/model deepseek`、`/model kimi`、`/model glm`。プロバイダーが接続されていない場合は、ホーム画面と `/model` から `/logins` へ案内されます。`/defaultprovider` を使うと、プロバイダーを明示的に最も新しい選択肢にできます。

プロバイダーの利用は、引き続きそのプロバイダー自身の規約と提供状況に従います。Mercury のライセンスがそれらに取って代わるものではありません。

## ヘッドレス CLI: `mercury run`、Docker、JSON-RPC ランナー

同じビルドを、対話型のインターフェースなしで実行できます。`node dist/mercury.mjs --help` で、すべてのフラグを確認できます。

`mercury run "<prompt>"` は、ターミナルの UI を使わずにプロンプトを実行します：

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` は回答を出力します。失敗したターンの理由は stderr に出力されます。
- `json` は最後の `outcome` 行を、1 つの JSON オブジェクトとして出力します。
- `rows` は、1 行につき 1 つの JSON オブジェクトを書き出します。最初に `session` があり、続いて `turn` と、その `text`、`reasoning`、`tool_call`、`tool_result`、`step` の各行が並び、最後は `outcome` で終わります。待機、ツールの進捗、バックグラウンドタスク、通知には、それぞれ専用の行があります。すべての行には `seq`、`timestamp`、`session_id` が含まれます。ターン内の行には、そのターンの `turn` 番号も含まれます。`seq` はこの実行のストリームを 1 から番号付けします。`turn` はセッションのターンを数えるため、保存済みの会話を継続する実行（`-c`、`-r`、`--fork`）では、既存のターンに続く番号が振られます。その `session` 行には、継続している会話が `resume_of` で示されます。

出力行の種類は、その `type` フィールドで区別されます：

- `session`：先頭の行です。`version`、`build`（バンドルのビルド元となったツリーの 16 進数 12 桁。`mercury daemon status` の表示と同じです。バンドルの横にマニフェストがない場合は省略されます）、`resume_of`（継続実行の場合は、継続している会話のセッション ID。実行がフォークされたものでない限り `session_id` と同じです）、`cwd`、`model`、`mode`、セッションが持つ `tools`、`mcp_servers`、`commands`、`agents`、`skills`、`extensions`、そして `tools_withheld`（拒否ルールがツールをその名前だけで非表示にした場合に存在します。各項目には `tool`、`rule`、`source` が含まれます）。
- `turn`：`started` または `waiting` の状態のターンです。`turn_id` を持ちます。判明している場合は `model`、`message_ids`、`agents` の数も含まれます。
- `text`：確定したテキストブロックです。`message_id`、`block`、`text`、およびその `phase`（`commentary` または `final_answer`）を含みます。
- `reasoning`：確定した推論ブロックです。`message_id`、`block`、`text`、または `redacted: true` を含みます。
- `tool_call`：ツール呼び出しです。`call_id`、`tool`、`input` を含み、その `message_id` と `block` が付きます。
- `tool_result`：呼び出しの結果です。`call_id`、`status`（`ok`、`error`、`aborted`、`refused` のいずれか）、`output` を含みます。モデルの形式が不正なため実行前に拒否された呼び出し（未知のツール、有効な JSON ではない引数、またはツールのスキーマに合わない引数）にも、対になる行が出力されます。その内容は、受け取った引数のままの `tool_call` 行（引数がオブジェクトでなかった場合は `{}`）と、`tool_result` 行（ステータスが `refused`、`output` に理由が入ったもの）です。その後に、修正を促す `notice` が続きます。このような呼び出しは実行されておらず、拒否（denial）ではありません。
- `tool_update`：実行中のツールの進捗です。`call_id`、`tick`、`source`（`shell`、`powershell`、`mcp`、`eval` のいずれか）、そして呼び出しが報告する `line`、`elapsed_s`、`lines`、`bytes`、`budget_ms`、`progress`、`total` のうち該当するものを含みます。shell または PowerShell の呼び出しは、出力が届くたびに tick します（何も出力しないコマンドは tick しません）。MCP の呼び出しは、サーバーが進捗を報告したときに、Eval の呼び出しはセルの実行中に tick します。ほかのツールは tick しません。Browser または Crewmate の呼び出しは、結果が返るまで無音です。
- `step`：メインスレッドの 1 回のモデル呼び出しです。`message_id`、`model`、`usage` を含み、モデルが停止理由を示した場合は `stop` も含みます。
- `outcome`：ターンの結果です。詳しくは後述します。
- `close`：終了時に次のセッションのために残されるメモです。`state`（`stored`、`skipped`、`none` のいずれか）、`note_chars`、そしてそのメモを書いたモデル呼び出しの `usage` を含みます。そのため、すべての行の usage を合計すると、outcome の値と一致します。プロンプトを引数で与えた場合、メモは最後のターン内で求められ、`close` はそのターンの `outcome` の前に出力されます。`--input rows` を使う場合は、stdin が閉じられた後、最後の `outcome` の後に出力されます。
- `wait`：モデルの待機です。`state`（`first_byte`、`retry`、`silence`、`loading`、`done` のいずれか）と、その状態が持つ数値を含みます。たとえば `since_ms`、`attempt` と `of`、`delay_ms`、`reason`、`http_status` などです。
- `heartbeat`：モデルのストリームが、解析可能なイベントのないまま少なくとも 1 秒経過した後も動きを示したことを表します。行を生まなかったバイトが届いたことを意味します。この行はほかに何も含まず、最大でも毎秒 1 回です。頻度はプロバイダーのストリーミング形式によって変わるため、イベントの間に一度も止まらないストリームでは、この行は出力されません。
- `compaction`：コンパクションの `started`、`progress`、`ended` のいずれかの状態です。`trigger`（`manual`、`auto`、`overflow` のいずれか）、`stage`、`fill`、`summary_tokens` を含みます。終了時には `exit`（`landed`、`cancelled`、`failed` のいずれか）も含みます。
- `mode`：権限モードが変更されたことを表します。`mode` を含みます。
- `rate_limit`：プロバイダーのレート制限の状態です。`status`（`allowed`、`warning`、`rejected` のいずれか）、`window`、`resets_at`、`utilization`、超過分のフィールドを含みます。
- `task`：バックグラウンドタスクの `started`、`progress`、`ended` のいずれかの状態です。`task_id`、`task_type`、`description`、`usage`、`summary`、`status`（`completed`、`failed`、`stopped` のいずれか）を含みます。`output_file` は判明し次第含まれます。
- `notice`：読み手に向けた `warning` または `error` です。`text` と、`code`（`input_refused` など）を含みます。
- `command_output`：モデルには送られなかったスラッシュコマンドの出力です。`command` と `text` を含みます。
- `mission_updated`：セッションのタスク台帳が変更されました。読み直してください。
- `samples_updated`：セッションのサンプルが変更されました。読み直してください。

`--partial` を `--format rows` と組み合わせると、`block_start`、`text_delta`、`reasoning_delta`、`tool_input_delta`、`retracted` の各行を追加します。デルタは `message_id` と `block` に属します。`retracted` 行は、そのメッセージのデルタを取り消します。確定したテキスト行またはツール行が、完全な値です。

outcome には、`schema`、`turn_id`、`status`、`steps`、`wall_ms`、`usage`、`models`、`denials` が含まれます。完了時には `answer`、失敗時には `error`（`message`、`class`、任意で `detail`）が加わります。`stop`、`api_ms`、`cost_usd`、要求された `structured` 出力、`notices` は、利用可能な場合に含まれます。`wall_ms` は、そのターンの経過時間です。`api_ms` は、ターンが行ったすべてのモデルリクエストの所要時間の合計です（再試行や、メインスレッドと並行して実行された crewmate のリクエストを含みます）。そのため、リクエストが重なった場合は `wall_ms` を超えることがあります。`cost_usd` は、ステータスにかかわらず、ターン内で価格が設定されたリクエストの米ドル額です。Mercury が価格を計算できないリクエスト（登録済みのレートがない、またはレスポンスにコストが記載されていない）は、この値に加算されず、その所属モデルは `models` に表示されますが、個別の `cost_usd` は持ちません。このフィールドは、ターン内で何も価格設定されなかった場合にのみ省略されます。Claude のサブスクリプションでサインインしている場合、Anthropic のリクエストにはドル価格がないため、それらも行も `cost_usd` を持ちません。usage は残ります。usage には、`input_tokens`（キャッシュされたトークンを含む）、`cached_input_tokens`、`cache_write_input_tokens`、`output_tokens`、そして報告された場合の `reasoning_output_tokens` が含まれ、メインスレッドと crewmate の合計です。`models` は、トークンの使用量をモデルごとに内訳します。`steps` はメインエージェントのモデル呼び出しのみを数えます。crewmate によるモデル呼び出しは、独自の `step` 行（`parent_call_id` 付き）として表示されます。

状態（status）は `completed`、`blocked`、`refused`、`failed`、`interrupted`、`turn_limit`、`budget_limit`、`time_limit`、`schema_unmet`、`loop_stopped` のいずれかです。`--max-time`（秒数、または `10m`、`1h`）を指定した実行は、時間が経過すると次のステップで `time_limit` となって終了します。進行中のモデル呼び出しやツールのラウンドは中断されません。完了した実行は終了コード 0、その他の結果は 1、使い方の誤りは 2 で終了します。SIGINT と SIGTERM は、中断されたターンの outcome が書き出された後、それぞれ終了コード 130 と 143 で終了します。拒否されたツール呼び出しは `denials` に記載されます。拒否の原因が、誰も応答できなかった確認（確認を求めるモードでホストがない実行、`--mode dontAsk`、またはホストの確認が期限切れになった場合）であり、かつそのターンで後続のツール呼び出しが成功しなかった場合、実行は `blocked` になります。回答は保持され、`error` にはツール名と再開方法（`--allowed-tools`、別の `--mode`、または確認に応答するホスト）が示され、実行は終了コード 1 で終わります。同じターンで後続のツール呼び出しが成功した場合、ターンは回復して `completed`（終了コード 0）で終わり、警告の `notice`（`"<Tool> was not approved; the run continued with other tools."`）が付きます。あなたが応答した拒否（拒否ルール、フック、または拒否と応答したホスト経由）は、完了したターンを完了状態のままにします。応答されなかった `AskUserQuestion` の呼び出しも、実行を `blocked` で終了させ、`error` に質問が引用されます。Mercury は、実行中に記録された確認から結果を読み取ります。応答テキストからは読み取らないため、応答の中だけに書かれた質問は `completed` で終わります。未知のスラッシュコマンドは `refused` になり、対話画面と同じ文言（`Unknown command: /name · /help lists commands`）とともに終了コード 1 で終わります。

`--input rows` は `--format rows` と併用する必要があり、1 行につき 1 つの入力オブジェクトを読み取ります：

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

入力の種類は、`prompt`（テキストまたはテキスト／画像ブロックの `content` を持つ）、`shell`（`command` を持つ）、`note`（エージェント ID の `to` と `content` を持つ）です。いずれも任意の `id` を受け付けます。prompt と shell の行は、さらに `priority`（`now`、`next`、`later` のいずれか）、`sent_at`、`origin` も受け付けます。拒否された入力の形式は、`notice`（コード `input_refused`）を生成します。不正な JSON は実行を終了させます。これらの行は入力だけを運びます。権限の回答には、後述のランナープロトコルを使います。

`mercury run -` を使うか、テキストをパイプで `mercury run` に渡すと、stdin からプロンプト全体を読み込みます。プロンプトの引数と並べてパイプから渡したテキストは、区切られたコンテキストとして追加されます。パイプは閉じられるか、1 秒間入力がなくなるまで読み込まれます。そのため、データを送り続けるストリームは最後まで読み込まれ、開いたまま何も送らないパイプが実行を止めることはありません。プロンプトがなく、stdin がターミナルの場合、`run` は使い方を表示し、終了コード 2 で終了します。

`--mode <mode>` で権限の方針を選びます。`--sovereign` は権限の確認なしで実行し、`--allow-sovereign` は、後から切り替えられるようにその方針を使えるようにします。権限ポリシーと拒否ルールは引き続き適用されます。root ユーザーが sovereign モードに入ると、stderr に通知が 1 回表示され、実行は続きます。

`-c` で直近の会話を継続し、`-r` で ID、タイトル、またはピッカーから再開し、`-w` で管理されたワークツリーで実行し、`--lean` で最小限のセッションを使います。`run` には、権限の確認に応答するホストがありません。何を実行できるかは権限ルールとモードで決まり、まだ承認が必要な呼び出しは拒否されます。

### ヘッドレスイメージ

リポジトリのルートにある `Dockerfile` は、CI とサーバー向けの Linux x64 イメージをビルドします。エントリーポイントは `mercury`、既定のサブコマンドは `run` です。そのため、このイメージはマウントされたツリーに対して 1 つのプロンプトを実行し、その実行のコードで終了します：

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

イメージには、バンドル、Node 24 ランタイム（`PATH` 上）、ベンダー同梱の検索・シェル・デバッガー・言語・画像ツール、`git`、証明書ストアが含まれます。開始画面もサインインの流れもありません。非 root ユーザー `mercury` として実行され、設定ホームはコンテナ内（`MERCURY_CONFIG_DIR`）にあります。作業ディレクトリは `/work` です。色とマウスは製品自身のターミナル検出に従います。`--user 0` を指定すると root として実行され、上記の sovereign 通知が 1 回表示されます。

プロバイダーのキーは環境変数で渡します。名前は、製品があらゆる場所で読み取るものと同じです：`ANTHROPIC_API_KEY` または `ANTHROPIC_AUTH_TOKEN`、`OPENAI_API_KEY`、`GEMINI_API_KEY` または `GOOGLE_API_KEY`、`XAI_API_KEY`（使用量メーター用の `XAI_MANAGEMENT_API_KEY` も可）、`DEEPSEEK_API_KEY`、`MOONSHOT_API_KEY`、`ZAI_API_KEY`、`OPENROUTER_API_KEY`、`HF_TOKEN`、`MISTRAL_API_KEY`（組織の使用量メーター用の `MISTRAL_ADMIN_API_KEY` も可）、`NOUS_API_KEY`、`OPENCODE_API_KEY`、`MINIMAX_API_KEY`、`TOGETHER_API_KEY` または `TOGETHER_AI_API_KEY`、`COHERE_API_KEY` または `CO_API_KEY`、`GROQ_API_KEY`、`CEREBRAS_API_KEY`、`FIREWORKS_API_KEY`、`DASHSCOPE_API_KEY`、`MODEL_API_KEY` または `META_API_KEY`、カスタムの OpenAI 互換エンドポイント用の `MERCURY_COMPAT_API_KEY`、ローカルサーバー用の `MERCURY_LOCAL_API_KEY`。キーがない場合、実行は 1 行で拒否され、終了コード 1 で終了します。`docker run -i … mercury run -` は、stdin からプロンプトを読み込みます。

### セッションのホスティング

`mercury runner` は、stdio 経由でセッションをホストに提供します。プロトコルは JSON-RPC 2.0 で、1 行につき 1 メッセージです。ホストは最初に `initialize` を送り、作業を送る前に応答を待ちます：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

ホストの名前とバージョンは `host` の下に渡されます。`capabilities` では `holds_asks`、`elicitation`、`partial_rows` を宣言します。すべてのリクエストの `id` は正の整数です。`id` がそれ以外の値であるリクエストには `-32600`（`id: null`）が返されます。そのため、リクエストには 1 から番号を振ってください。

`queue/add` は、上記の行入力と同じ prompt、shell、note のオブジェクトを受け取ります。出力は `row` 通知として届きます。`session/facts` はセッションの状態を読み取ります。`session/set_mode` は権限モードをすぐに変更します。`session/set_model` と `session/set_effort` はモデルと effort を変更します。ターンの実行中に行った変更は、ターンが終わるまで保留されます。その場合は `at: "turn_end"` で応答し、その後 `session/applied` で適用されたことを通知します。`turn/interrupt` はターンを停止します。セッションを終えるには stdin を閉じます。

権限の確認は `permission/request` として届き、`kind: "tool"` または `kind: "network"` を持ちます。ホストは `outcome: "allow"` または `outcome: "deny"` で応答します。allow には、編集された `input` と権限 `rules` を含めることができます。取り下げられた確認は、`$/cancel_request`（その `request_id` 付き）で通知されます。`holds_asks` は、確認の時間計測をホストが担当することを意味します。MCP の問い合わせは `elicitation/request` を使います（ホストが `elicitation` を宣言している場合のみ）。そうでない場合は `cancel` で応答されます。

未知のメソッドには `-32601`、無効なパラメーターには `-32602`、正の整数ではない `id` には `-32600`、初期化前のリクエストには `-32002` が返されます。ルールによる拒否は `-32010` で、`error.message` に一文、`error.data.kind` に `mode`、`model`、`effort`、`claim` などの理由が入ります。ランナーは形式の不正な行に `-32700` で応答して処理を続けます。連続して 3 行不正な行があると終了します。

### その他のコマンド

利用可能なコマンドは次のとおりです：

- **`mercury health`**：診断レポート（ヘルス証明書とも呼ばれます）。`--json` は完全なレポートを返し、`--deep` は詳細な棚卸しを実行し、`--fix` はガイド付きの修正を実行します。
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**：サインイン（`login [<family>]`）、プロバイダー系列の一覧表示（`list`）、アカウントがサインイン済みかの確認（`status [<family>]`）、サインアウト（`logout [<family>]`）、または長期間有効な Anthropic トークンの発行（`mint`）。
- **`mercury models [--json]`**：サインイン済みのアカウントで利用できるモデルを表示します（`mercury://models` と同じ情報です）。
- **`mercury mcp`**：`add`、`import`、`list`、`get`、`remove`、`trust-reset`、`serve` で MCP サーバーを管理します。
- **`mercury extensions`**：拡張機能をインストールし、そのソースを管理します。アクションは、`list`、`sources`、`add`、`remove`、`refresh`、`install`、`trust`、`enable`、`disable`、`update`、`uninstall`、`fence`、`unfence`、`inspect`、`scaffold` です。
- **`mercury roster`**：エージェントの一覧を表示します。
- **`mercury usage`**：`/usage` 画面に表示される簡潔な数値の行を表示します。`--json` は読み取った内容すべてを表示します。サインイン済みの各プロバイダーのウィンドウ（使用量とリセット）、そのプロバイダーが示した数値とクレジット（それぞれ取得元と経過時間付き）、およびモデル別のセッションの支出です。読み取りは画面と同じ方法で行われます（サインイン済みの各プロバイダーのリーダーは、画面を開いたときと同様に一度だけサンプリングされます）。
- **`mercury daemon run|status|stop|restart`**：バックグラウンドのデーモンを実行、確認、停止、または再起動します。そのセッションの席は `mercury runner` の子プロセスです。デーモンがそれらのプロンプトを送信し、権限の確認をホストします。
- **`mercury sessions list`**（単独の `mercury sessions` も同じ）：このプロジェクトに保存されたセッションを、新しい順に一覧表示します。ID、最後に書き込まれた日時、サイズ、デーモンが今ホストしている場合の `live`、タイトルまたは最初のプロンプトを表示します。`--all` はすべてのプロジェクトを読み取り、`--limit <n>` で一覧の件数を制限します。ID は、`mercury --resume <id>` で再び開くときや、`sessions delete` で削除するときに使います。
- **`mercury sessions delete <id>`**：保存されたセッションを、意図的に 1 つ削除します。トランスクリプトと、その横に保存された記録（受領記録、再開用のスナップショット）も対象です。削除前に確認が求められます。スクリプトでは `--yes` で確認を省略できます。デーモンがいま保持しているセッションは拒否されます。不明な ID も拒否され、一覧（Mercury 内の `/sessions`）を参照するよう案内されます。それ以外のとき、保存されたセッションが自動で削除されることはありません。
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**：ローカルまたは SSH のコンピューターを、設定ホームを共有するすべてのセッション向けのモデルサーバーとして実行します（`compat/box-<name>/<model>`）。検証済みのローカル重みバンク、または確認済みのダウンロードを使います。[docs/LLM-HOST.md](../LLM-HOST.md) を参照してください。
- **`mercury lsp list`** と **`mercury lsp install <server>`**：言語サーバーのカタログです。各サーバーがインストール済み（バイナリ付き）か、未インストール（インストール手順付き）かを表示します。`install` はサーバーの手順を表示し、確認を求めて、その手順をそのまま実行します（`--yes` でスクリプト向けに確認を省略できます）。そしてバイナリの配置先を報告します。不明なサーバーは一覧とともに拒否されます。Mercury は言語サーバーを自動でインストールすることはありません。ファイルを開いても、すでにインストールされているサーバーが起動するだけです。
- **`mercury acp`**：Agent Client Protocol でエディターにサービスを提供します。各セッションごとにランナーの子プロセスが起動します。`mercury bridge install` は VS Code 拡張機能をインストールし、`mercury bridge status` はその状態を確認し、`mercury bridge uninstall` は削除します。
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**：現在のディレクトリにある Godot プロジェクトのエンジンジョブを管理します。Mercury は、凍結されたプロジェクトのコピーから、独自のヘッドレスワーカー上でテストスイートを実行します。このサービスには、コンパイルゲート、キャプチャ、フレーム統計、確定したプロファイル、ジョブキューへのアクセス、キャンセル、ID による結果の取得が含まれます。[docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md) を参照してください。
- **`mercury image <image>`**：ターミナルに画像を表示します。
- **`mercury install`** と **`mercury update`**（エイリアス `upgrade`）：リリースアーカイブをインストールまたはアップデートします。`--json` を指定すると、判定の内容にかかわらず、ドキュメントが stdout に出力されます。終了コードで失敗したかどうかがわかります。[インストール](#インストール)を参照してください。
- **`mercury version`** と **`mercury help [command]`**：バージョン行、またはヘルプページを表示します。`--version` と `--help` と同じです。どちらもセッションは開始しません。

## 機能一覧：Mneme RAG メモリ、LSP、23 言語 AST、DAP デバッガー、Web 検索とブリッジ

- **Mneme ハイブリッド RAG プロジェクトメモリ。** Mneme はデフォルトで有効で、各プロジェクトの事実をプレーンな Markdown のトピックページに保存します（`Retain`、`Recall`、`Reflect`、`Correct`）。Recall は、デバイス上で動作する 118 MB の BGE セマンティック埋め込みモデル（`bge-base-en-v1.5` `q8_0`、MIT ライセンス。すべてのリリースアーカイブに同梱され、各プラットフォーム向けにビルドされています。[オプションのコンポーネント](#オプションのコンポーネント)を参照）と、語幹処理を施した BM25 の単語ランキング、新しさによる重み付け、そして相互ランク融合（`k = 60`）による引用の追跡を組み合わせます。ピン留めされたルール（`pin: true`）は、ピン留め棚に原文のまま読み込まれ、あなたの指示によってのみ変更されます。セッション開始時、Mercury は、ピン留めされていない事実と以前のメモを、現在のブランチ、最近触れられたファイル、前回セッションの引き継ぎメモと照らして採点します。その際、起動時専用の割り当て（`memory.startLimit`、既定値は 4,000 文字）の範囲内で行います。書き込み時の矛盾チェックは、矛盾する事実を保存する前に、極性、否定、数値の反転を検出します。各セッションは終了時に、次のセッションの入口ページ向けの引き継ぎメモを自分の言葉で書き、さらに任意でセッションのジャーナルの項目も書きます。`/memory` はメモリセンターを開き、`/memory page` は、ライブラリをブラウザーでノードと辺のグラフとして描画します。[docs/MNEME.md](../MNEME.md) を参照してください。
- **LSP によるコードインテリジェンス、23 言語の AST 書き換え、DAP デバッガー、`Eval` セル。** アンカー付きの読み取りと、アトミックな複数ファイル編集（`ChangeSet`）。言語サーバーへの問い合わせ（`LspRead`）と、プレビューしてから適用するリファクタリング（`LspRename`、`LspMoveSymbol`、`LspMoveFile`、`LspCodeAction`、`LspFormat`）。構文木の検索と書き換え（`AstSearch`、`AstEdit`）では、`$NAME` と `$$$NAME` のメタ変数をリリースアーカイブ内の 23 種類の文法（すべての `bun install` ビルドに含まれる 16 種類と、文法パックに含まれる 7 種類）にわたって使えます。永続化される Python（`python3`）と JavaScript（Node の ES モジュール）のコードセル（`Eval`）。そして Debug Adapter Protocol デバッガー（`Debug`）があり、`debugpy`、`js-debug`、`lldb`、`gdb`、`dlv`、`netcoredbg`、`rdbg`、Dart SDK のデバッグアダプター、`kotlin-debug-adapter`、elixir-ls のデバッグアダプター、Godot を動かします。`Test` ツールの `debug` 操作では、失敗した Python（`pytest`、`unittest`）、JavaScript/TypeScript（`node-test`、`vitest`、`jest`）、Go（`go test`）、Rust（`cargo test`）のテストを、そのまま `Debug` セッションにステップ実行できます。[docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md)、[変更トランザクション](../CHANGE-TRANSACTIONS.md)、[構造パターン](../STRUCTURAL-PATTERNS.md)、[コードセル](../EVAL.md)、[デバッガー](../DEBUGGER.md)を参照してください。
- **キー不要の `WebSearch` と Markdown 形式の `WebFetch`。** `WebSearch` は次の順序で検索を試みます。セッションのモデルが対応していれば、まずプロバイダーがネイティブに提供するライブ検索（`ProviderSearch`）を使い、次に保存済みの Brave または Tavily のキー、続いてクエリの形式に応じて選ばれる公式 API（Stack Exchange、npm、PyPI、crates.io、GitHub のコード検索、Hacker News Algolia、Wikipedia）、その後に設定済みの SearXNG JSON API（`MERCURY_SEARCH_SEARXNG_INSTANCES`）、最後にキー不要の DuckDuckGo によるページ取得です（既定で有効です。`/config` で、または `MERCURY_SEARCH_KEYLESS=0` を設定して無効にできます）。どの回答も 2,000 トークン未満に収まり、回答したソースが示されます。`WebFetch` は、38,000 文字の呼び出し予算の範囲内で、公開ページをページ自身の文面のまま Markdown として読み取ります（ブラウザーが必要なページは、ホストされたリーダー `r.jina.ai` を通じて読み取られます。ただし `MERCURY_FETCH_READER=0` が設定されている場合を除きます。プライベートネットワークのアドレスが送信されることは決してありません）。[docs/ENGINES.md](../ENGINES.md) を参照してください。
- **エージェント、プロバイダーをまたぐ crewmate（`Crewmate`）、ワークツリー、ファイルリース。** 組み込みのエージェントは 2 つあります。`mercury-crew` はあらゆる種類の委任作業向け、`mercury-scout` は読み取り専用の調査向けです。これらは、`/agents` で作成したエージェント定義と並んで存在します。サインイン済みの任意のプロバイダーで crewmate を起動し、並列の作業を `git worktree` のチェックアウト（`isolation: "worktree"`）で分離し、プロセス内のプロジェクトファイルリース（`mcp__mercury__lease_take`、`mcp__mercury__lease_release`、`mcp__mercury__lease_list`）で共有ファイルを調整できます。また、`SendMessage` と `ResumeCrewmate` を使って、名前または ID で crewmate に指示したり再開したりできます。crewmate とワークフローの実行は、`/crewmates` と `/runs` で追跡できます。[docs/CREW.md](../CREW.md) を参照してください。
- **デスクトップのコンピューター操作。** ネイティブのデスクトップドライバーが利用可能な場合は、既定で有効です。`Computer` ツールは、スクリーンショットを取得し、前面のアプリケーションでマウスとキーボードを操作します。Mercury は、操作の前にアプリケーションの名前と ID を確認します。権限ルール、セッションの許可、アクセス設定、権限モードでその操作がすでに許可されていない限り、承認を求めます。`Esc` で停止でき、同時にデスクトップを操作できるのは 1 つのセッションだけです。スクリーンショットは、保存された会話ファイルには残しません。ツールを削除するには `MERCURY_COMPUTER_USE=0` を設定します。[docs/COMPUTER-USE.md](../COMPUTER-USE.md) を参照してください。
- **デバイス上の Whisper 音声入力（`/voice`）。** `/voice on` を実行すると、初回使用時に 60 MB の英語音声モデル（`base.en-q5_1`）がダウンロードされ、SHA-256 のダイジェストが検証されて、音声入力が有効になります。`/voice off` で無効になります。スペースキーを 1 秒間押し続けると話し始め、離すと停止します。音声がオンのときに引数なしの `/voice` を実行すると、録音（take）の開始と停止を切り替えられます。Whisper はデバイス上で文字起こしを行うため、音声データがマシンの外に出ることはありません。`MERCURY_WHISPER_MODEL` で、`tiny.en-q5_1`、`small.en-q5_1`、多言語の `base-q5_1`、またはローカルの `.gguf` ファイルを選べます。[docs/VOICE.md](../VOICE.md) を参照してください。
- **Saturn の cron とセッションスケジューラー（`/saturn`）。** 既存のセッション向けにプロンプトをスケジュールする（`CronCreate`、`CronList`、`CronDelete`、`ScheduleWakeup`、`/loop`）か、新しいセッションを指定の時刻に開始するようスケジュールします。スケジュールは 1 回だけ実行することも、繰り返し実行することもできます。[docs/SATURN.md](../SATURN.md) を参照してください。
- **VS Code（ACP）、Unity、Blender、Godot、Aseprite のブリッジ。** `mercury acp` は、Agent Client Protocol に対応したエディターに接続します。VS Code 拡張機能（`mercury bridge install`）は、このプロトコル経由でエディター内に Mercury を実行します。チャット、セッション、エージェント、アーティファクト、レビューが使えて、エディターの選択範囲と診断情報が各プロンプトに添えられます。別途オプトインで有効にする統合機能は、実行中の Unity（`MERCURY_UNITY=1`）、Blender（`MERCURY_BLENDER=1`）、Godot（`MERCURY_GODOT_TOOLS=1`）のエディターに接続し、Aseprite へのバッチアクセスも提供します（`MERCURY_ASEPRITE=1`）。[Unity](../UNITY-BRIDGE.md)、[Blender](../BLENDER-BRIDGE.md)、[Godot](../VULCAN-GODOT-TOOLS.md)、[Aseprite](../ASEPRITE-BRIDGE.md) を参照してください。
- **拡張機能。** 各拡張機能はマニフェストを 1 つ持ちます。ソースは git URL、ローカルフォルダー、またはアーカイブから追加します。その際、コントリビューションのハッシュによって承認されます。[docs/EXTENSIONS.md](../EXTENSIONS.md) を参照してください。
- **MCPs & Skills。** セッションが読み込む内容をリポジトリごとに設定します。名前付きのプリセットと、セッション中に変更できるコントロールがあります。[docs/KIT.md](../KIT.md) を参照してください。
- **診断。** ヘルスチェックと `/health` は、診断の根拠に基づくレポートを作成します。判定は `certified`、`caution`、`fault` のいずれかで、修正は検証済みのものです。[docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md) を参照してください。
- **信頼と権限。** ワークスペースの信頼、権限ルールとモード、そしてすべてのセッションが拒否するコマンド。[docs/TRUST.md](../TRUST.md) を参照してください。
- **Apollo Mode**（仕様インタビュー）。エージェントの質問に答えて、プロトタイプの構築に使う仕様を完成させます。[docs/APOLLO-MODE.md](../APOLLO-MODE.md) を参照してください。
- **復旧。** アトミックな公開、ジャーナル化された操作、起動時の照合。[docs/DURABILITY.md](../DURABILITY.md) を参照してください。

ランタイムフラグは `src/substrate/flagRegistry.ts` で定義され、`MERCURY_*` の設定として公開され、必要に応じて表示されます。統合の互換性は [docs/COMPATIBILITY.md](../COMPATIBILITY.md) に記載されています。ドキュメントの完全な索引は [docs/README.md](../README.md) にあります。

## スラッシュコマンド

`/help` は利用可能な対話型コマンドを一覧表示します。曖昧一致でコマンドを検索するには `/palette` を使います。下の表は、既定で有効な組み込みコマンドを `/help` で使われているカテゴリーごとにまとめたものです。ライブの一覧には、`/samples`（`current work` の下に表示。Samples が `MERCURY_SAMPLES=1` または Boot Menu の Samples 行で有効な場合）や、`/showcase`（`MERCURY_DEV_SURFACES=1` が設定されている場合）、さらにスキルや拡張機能のコマンドも含まれます。

| 分類 | コマンド |
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

| コマンド | 機能 |
| --- | --- |
| `/llmhost` | Runpod、Vast.ai、Lambda でレンタルするモデルを選ぶ、自分のコンピューターで実行する、または既存のサーバーに接続します。 |
| `/restart` | 現在のチャットを、インストール済みの Mercury ビルドに移します。実行中の監視とバックグラウンドのシェルは停止します。 |
| `/mcp` | サーバーを確認する、サインインする、各サーバーのツールとパラメーターを参照する、再接続する、またはこのチャットでサーバーを切り替えます。 |

`/mouse off` は、ネイティブのテキスト選択とコピーのためにポインターをターミナルに戻します。この設定は保存され、`/config` に Mouse capture として表示されます。

スキルの使い方で、必須の引数は `<…>` で始まります。たとえば `/update-config` と `/debug` は引数が必要です。一つだけ送信すると、その説明と使い方が表示され、ターンは開始されません。入力候補で選んで Enter を押すと、`/name ` が入力された状態になり、引数を追加できます。`/loop` は必須の引数がなく、すぐに実行されます。

## 問題の報告

簡単な報告には、[テスター用フォーム](https://mercury-cli.ai/report)を使うか、Mercury 内で `/bug --short <what you tried>` を実行します。OS、試したこと、壊れた内容を尋ねられます。ヘルスチェックのダンプは不要です。

Mercury 内で `/bug <what happened>` を実行すると、サインイン済みの GitHub CLI（`gh`）で提出する前に、レポートをプレビューできます。`gh` がない場合、Mercury は設定ホームの下にローカルの下書きを保存し、リポジトリの Issues ページを案内します。

バグ、プロバイダー／モデル、機能要望のテンプレートを使って、直接 issue を作成することもできます。`--version` の出力、OS、ターミナル、正確な手順を含めてください。バグとプロバイダーの報告には、`mercury health --json` も必要です。ソースビルドの場合は `node dist/mercury.mjs health --json` を使います。失敗した画面の書き起こしがあると役立ちます。

セキュリティの問題は、リポジトリの Security タブを通じて非公開で報告してください。公開の issue には書かないでください。[SECURITY.md](../../SECURITY.md) を参照してください。[CONTRIBUTING.md](../../CONTRIBUTING.md) では、issue、プルリクエスト、チェックについて説明しています。

## ライセンス

Mercury CLI は、[LICENSE.md](../../LICENSE.md) にある Apache License 2.0（`Apache-2.0`）のもとでライセンスされています。[sdk/](../../sdk/) と [sdk-py/](../../sdk-py/) にある TypeScript と Python の SDK（npm と PyPI では `mercury-cli-sdk`）も Apache License 2.0（`Apache-2.0`）のもとでライセンスされており、それぞれ付属する LICENSE ファイル（[sdk/LICENSE](../../sdk/LICENSE) と [sdk-py/LICENSE](../../sdk-py/LICENSE)）によって規定されます。

Mercury の名称および商標の使用には[商標ポリシー](../../TRADEMARKS.md)が適用されます。同梱されているサードパーティのライセンスは [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) に記載されています。
