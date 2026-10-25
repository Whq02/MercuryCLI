[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI (mercury-cli.ai, gói npm `mercury-tech-cli`) chạy các tác nhân lập trình AI ngay trong terminal của bạn, bên trong các kho git của riêng bạn trên macOS, Linux và Windows.

Trang web: [mercury-cli.ai](https://mercury-cli.ai) · Kho mã: [github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI) (`Whq02/MercuryCLI`) · npm: `mercury-tech-cli`

Một tác nhân đọc và sửa tệp, chạy lệnh shell, đi qua từng bước các bài kiểm thử và trình gỡ lỗi, rồi kiểm tra kết quả. Bạn chọn nhà cung cấp mô hình, mô hình và những việc tác nhân được phép làm:

- **Nhiều phiên trên Session Concourse và worktree cách ly:** chạy nhiều phiên song song trên Session Concourse (`/concourse`), và giao việc song song cho các crewmate đa nhà cung cấp (`Crewmate`) trong các bản checkout `git worktree` cách ly, có lease tệp dự án để các tác nhân song song không ghi đè lên nhau.
- **20 nhà cung cấp mô hình, `/llmhost` và `/localsetup`:** giữ đồng thời cả 20 nhà cung cấp (OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot/Kimi, Z.AI/GLM, OpenRouter, Hugging Face, xAI/Grok, Meta/Muse, Mistral, Nous Portal, OpenCode Zen, Qwen, MiniMax, Together AI, Cohere, Groq, Cerebras, Fireworks AI) ở trạng thái đã đăng nhập, và đổi nhà cung cấp cũng như mô hình ngay giữa cuộc trò chuyện. Mở `/llmhost` để chọn một mô hình, xem mức lượng tử hóa (quantization), cách chia `conversations × context` và mức thinking, rồi chạy mô hình trên GPU thuê (Runpod, Vast.ai hoặc Lambda), trên máy của bạn (`mercury host`), hoặc trên một máy chủ có sẵn. Hoặc chạy `/localsetup` để cài đặt hoặc kết nối Ollama cùng với LM Studio, vLLM và llama.cpp.
- **Bộ nhớ dự án Mneme RAG lai:** dùng một mô hình embedding ngữ nghĩa BGE 118 MB chạy trên thiết bị (`bge-base-en-v1.5`), kết hợp xếp hạng từ BM25 và theo dõi trích dẫn, các quy tắc đã ghim giữ nguyên văn (pinned rules), ngữ cảnh khởi động nhận biết nhánh, kiểm tra mâu thuẫn tại thời điểm ghi, ghi chú bàn giao giữa các phiên, và đồ thị trình duyệt `/memory page`.
- **Trình biên dịch, AST và công cụ gỡ lỗi DAP:** kết nối trí tuệ mã LSP và các phép refactor có xem trước (`LspRead`, `LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`), tìm kiếm và viết lại cấu trúc bằng AST tree-sitter cho 23 ngôn ngữ (`AstSearch`, `AstEdit`), trình gỡ lỗi Debug Adapter Protocol tích hợp sẵn (`Debug`) dùng `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv` để đi từng bước vào các bài kiểm thử Python, Node, Go và Rust đang lỗi, cùng các ô `Eval` Python và JavaScript được giữ lại giữa các lần chạy.
- **`WebSearch` không cần khóa và `WebFetch` xuất markdown:** tìm kiếm qua công cụ tìm kiếm gốc của nhà cung cấp, khóa Brave hoặc Tavily, các API chính thức (Stack Exchange, npm, PyPI, crates.io, GitHub, Hacker News, Wikipedia), SearXNG và DuckDuckGo không cần khóa; và tải tài liệu công khai dưới dạng markdown trong ngân sách 38.000 ký tự mỗi lần gọi.
- **Điều khiển máy tính để bàn, giọng nói Whisper, lập lịch Saturn và cầu nối trình soạn thảo:** điều khiển các ứng dụng trên máy tính (`Computer`), chép lời giọng nói kiểu nhấn để nói bằng Whisper ngay trên thiết bị (`/voice`), lên lịch phiên định kỳ hoặc một lần với Saturn (`/saturn`), và kết nối với VS Code qua Agent Client Protocol (`mercury acp`) cùng với Unity, Blender, Godot và Aseprite.
- **Tạo video (`Video`):** gửi prompt và các tệp tham chiếu của dự án đến bộ tạo MiniMax đã cấu hình ([docs/VIDEO.md](../VIDEO.md)), rồi lưu tệp MP4 được tạo cùng khung xem trước PNG 1 giây (tùy chọn) vào dự án của bạn.

Mercury được dùng để xây dựng chính Mercury, chạy nhiều phiên và mô hình xuyên suốt các tác vụ dài. Theo dõi công việc đó mới là phần khó: cái gì vẫn đang chạy, cái gì đã thay đổi, và cái gì cần một quyết định. Mỗi phiên ghi một ghi chú bàn giao khi kết thúc, và phiên kế tiếp đọc ghi chú đó một lần lúc khởi động cùng với các quy tắc đã ghim của tôi, nhờ đó ngăn ngữ cảnh bị nhiễm bẩn giữa các phiên.

![Một prompt gửi đến bộ điều phối trên bảng phiên sẽ khởi chạy hai phiên, mỗi phiên trong một worktree riêng; một phiên hỏi trước khi chỉnh sửa, và cả hai đều kết thúc với các thay đổi sẵn sàng để xem xét.](../media/session-board-stream.gif)

Mercury là mã nguồn mở theo Apache License 2.0, cũng như các SDK trong [sdk/](../../sdk/) và [sdk-py/](../../sdk-py/).

## Cài đặt

Có gói phát hành cho Mac Apple silicon và Mac Intel, Linux x64 và arm64, và Windows x64 và arm64. Hãy cài `git` riêng; mỗi gói đã có sẵn Node và ripgrep, nên không cần cài Node riêng.

Chọn một phương thức cài đặt:

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS và Linux (x64 và arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows (x64 và arm64), trong PowerShell 7
brew install Whq02/mercury/mercury                 # Homebrew: macOS và Linux x64
npm install -g mercury-tech-cli                    # npm; `bun install -g mercury-tech-cli` là cùng một gói
mise use -g npm:mercury-tech-cli                   # mise, thông qua gói npm
```

Các địa chỉ cài đặt lưu số lượt yêu cầu script ước lượng theo nguồn và theo ngày UTC (các lần cài đặt hoàn tất không được tính); bộ đếm không lưu địa chỉ IP, chuỗi user-agent hay cookie.

Mở một terminal mới, hoặc chạy dòng `export PATH=…` mà trình cài đặt shell in ra, rồi chạy `mercury --version` để kiểm tra và chạy `mercury` từ một kho git để bắt đầu [lần chạy đầu tiên](#lần-chạy-đầu-tiên). Trên Windows PowerShell, và sau khi cài bằng Homebrew, npm, bun hoặc mise, `mercury` hoạt động trong cùng một terminal.

<details>
<summary>Đường dẫn cài đặt, cập nhật và xác minh bản phát hành</summary>

### Khác biệt giữa các phương thức cài đặt

Trình cài đặt shell và PowerShell tải phát hành mới nhất cho nền tảng của bạn, kiểm tra SHA-256 của nó với `SHA256SUMS.txt`, giải nén, rồi chạy lệnh `mercury install` có sẵn trong chính gói đó.

Gói Homebrew và gói npm mỗi loại được ghim vào một phát hành cụ thể và được phát hành lại sau khi có tag, nên có thể chậm hơn phát hành mới nhất. Lệnh Homebrew dùng đầy đủ tên tap `Whq02/mercury/mercury` (`mercury` đứng riêng trong `homebrew-core` là một chương trình khác). Gói npm `mercury-tech-cli` là một trình khởi chạy tải phát hành đã ghim của nó; mise cài đúng gói đó. `mercury install --uninstall` gỡ bản phát hành đã cài cùng lớp shim lệnh nhưng giữ lại cấu hình và phiên (cũng chạy `npm uninstall -g mercury-tech-cli` nếu bạn đã cài trình khởi chạy npm).

Cài đặt của Mercury nằm trong phạm vi người dùng và không cần quyền quản trị. Bạn có thể chạy lại lệnh cài đặt một cách an toàn.

### Đường dẫn cài đặt

Các phiên bản phát hành nằm trong thư mục cấu hình tại `~/.mercury/versions/<version>` (`%USERPROFILE%\.mercury\versions` trên Windows). Lệnh `mercury` được cài vào `~/.local/bin` trên macOS và Linux, hoặc `%LOCALAPPDATA%\Mercury\bin` trên Windows.

`mercury install` thêm thư mục của lệnh vào PATH một lần: một dòng có bảo vệ trong tệp khởi động shell của bạn, hoặc một mục trong PATH của người dùng Windows. Terminal mới sẽ tự nhận thay đổi.

### Cập nhật

Dùng `mercury update` với mọi phương thức cài đặt.

Với bản cài đặt bằng trình cài đặt shell hoặc PowerShell, hoặc bằng `mercury install`, lệnh này cập nhật Mercury tại chỗ. `--check` kiểm tra bản cập nhật, `--status` báo trạng thái cập nhật, còn `--rollback` quay về phiên bản trước, phiên bản này vẫn nằm trên đĩa.

Với Homebrew, lệnh hỏi trước khi chạy `brew upgrade Whq02/mercury/mercury`. Đáp án mặc định là không; gõ `y` để chấp thuận. Mercury hiển thị đầu ra của lệnh theo luồng và kiểm tra phiên bản đã cài sau đó. Dùng `--yes` để bỏ qua câu hỏi trong script.

Trình khởi chạy npm dùng cùng cấu trúc phát hành với trình cài đặt và chuyển mỗi lần chạy cho bản phát hành đã cài. Vì vậy `mercury update` cập nhật một bản cài đặt npm tại chỗ thông qua kênh cập nhật của chính Mercury. `npm update -g mercury-tech-cli` chỉ thay đổi bản phát hành mà gói cài đặt trong lần chạy đầu tiên. Điều này cũng áp dụng khi dùng mise.

`--check` đọc cùng một danh sách phát hành cho mọi phương thức cài đặt và cho bạn biết cách cập nhật bản cài đặt của mình. Khi có bản cập nhật, màn hình chính hiển thị `vX.Y.Z available · mercury update` một lần ở góc dưới bên phải, và cuộc trò chuyện hiển thị một thông báo tạm thời. Đặt `MERCURY_UPDATE_NOTICE=0` để ẩn cả hai.

Các yêu cầu cài đặt và cập nhật tải danh sách phát hành công khai và các gói lưu trữ một cách ẩn danh. Bạn có thể chạy chúng mà không cần tài khoản hay token. Nếu một yêu cầu ẩn danh bị từ chối, Mercury sẽ dùng GitHub CLI (`gh`) đã đăng nhập.

Sau khi cập nhật, Mercury kiểm tra xem lệnh trên PATH của bạn có trỏ đến bản cài đặt đã cập nhật không. Nếu một bản cài đặt khác được ưu tiên, hoặc lệnh đã cập nhật không có trong PATH, Mercury giải thích vấn đề và cách khắc phục. `mercury health` báo cáo cùng vấn đề đó.

### Xác minh bản phát hành

Trước khi kích hoạt một bản phát hành, Mercury kiểm tra gói lưu trữ của nó với `SHA256SUMS.txt`. Nó cũng yêu cầu một payload được ký bằng khóa phát hành của Mercury nằm trong danh sách tin cậy được biên dịch sẵn (trust roster), trước khi đưa bản cập nhật vào giai đoạn chuẩn bị. Chữ ký bị từ chối sẽ không làm thay đổi bản cài đặt đang hoạt động.

Dùng `--allow-unsigned` để chấp nhận một payload chưa ký. Mercury vẫn từ chối các khóa ký không xác định, khối chữ ký sai định dạng và nội dung bị sửa đổi. Kết quả lệnh và bản ghi cục bộ đều cho thấy bạn đã cho phép một payload chưa ký.

Từ 1.0.0-beta.3 trở đi, các gói lưu trữ được ký trong quá trình đóng gói và chữ ký của chúng được xác minh trước khi công bố. Bản cài đặt đã xác minh không hiển thị thông báo chữ ký khi khởi động. `mercury health` báo cáo khóa ký `627b54b734ca0e72`.

Các gói lưu trữ 1.0.0-beta.2 không được ký. Những bản cài đặt này báo cáo nguồn gốc chưa ký (unsigned provenance) một lần cho mỗi lần cài đặt, khi bạn khởi động Mercury ở chế độ tương tác mà không kèm lệnh hoặc cờ nào. Health check tiếp tục hiển thị trạng thái này. Điều đó có nghĩa là manifest của gói lưu trữ không có chữ ký; tệp tải về vẫn được kiểm tra với `SHA256SUMS.txt`.

[docs/TRUST.md](../TRUST.md) giải thích kết quả xác minh và cách tự kiểm tra một gói lưu trữ. [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) đề cập đến xác minh khi khởi động.

### Ghi chú theo nền tảng

Các gói phát hành có sẵn cho mọi nền tảng được liệt kê ở trên. Mọi máy khác đều biên dịch từ mã nguồn.

Gói lưu trữ cho Mac Intel có từ 1.0.0-beta.3. Chúng được đóng gói chéo trên một runner Apple silicon và được kiểm tra khi khởi động dưới Rosetta trước khi công bố. Mac Intel đang dùng 1.0.0-beta.2 cần biên dịch từ mã nguồn.

</details>

## Yêu cầu

Các gói phát hành bao gồm Node 24 LTS. Trình khởi chạy, `mercury install` và `mercury update` dùng runtime đi kèm này; `git` là yêu cầu riêng duy nhất đối với chính bản phát hành.

Để biên dịch từ mã nguồn, bạn cần:

- **Node 24 LTS**, trong phạm vi được hỗ trợ `>=24.20.0 <25`. `.node-version` ghim phiên bản vá dùng khi biên dịch và có trong các gói phát hành.
- **bun 1.3.x** để biên dịch. Bun không được đóng gói kèm bản phát hành.
- **git**. Trên Windows, chạy PowerShell 7 trong Windows Terminal hoặc terminal của VS Code. Xem [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md).

Mức Node tối thiểu đã bao gồm bản sửa nodejs/node#56645. Dưới 24.20.0, các lệnh `run` headless gọi một công cụ sẽ bị hủy khi thoát trên Windows.

Trình khởi chạy chọn Node theo thứ tự sau: binary `MERCURY_NODE` được chỉ định rõ, runtime đi kèm, rồi đến một cài đặt Node tương thích trên PATH. Nếu thiếu runtime, trình khởi chạy báo lỗi.

### Shell trên Windows

Các gói phát hành bao gồm engine shell tương thích bash của Mercury (`brush`). Trên Windows, engine này phục vụ công cụ Bash theo mặc định: nó tìm một chương trình `.cmd` hoặc `.bat` như `npm` theo tên trần thông qua PATHEXT, truyền `%VAR%` và `^` đến tệp batch mà không thay đổi, chạy một chương trình được đặt tên bằng đường dẫn tương đối sau `cd`, và giữ trạng thái shell giữa các lần gọi. `bash.exe` của Git for Windows không bắt buộc. Khi đã được cài, `MERCURY_SHELL_ENGINE=system`, hoặc `system` trong `/config` tại mục Shell engine, sẽ chạy công cụ Bash chỉ bằng `bash.exe`.

Đọc dòng `shell` trong health check để xem shell nào đang hoạt động và vì sao: engine đi kèm (mặc định trên Windows, hoặc được bật bởi ghim hoặc thiết lập), hoặc Git Bash khi engine đã bị tắt hoặc gói engine không có.

Trên macOS và Linux, shell hệ thống là mặc định. Đặt `MERCURY_SHELL_ENGINE=brush`, hoặc chọn `brush` trong `/config` tại mục Shell engine, để công cụ Bash cũng chạy trên engine đi kèm ở đó, với trạng thái shell được giữ lại.

Bản biên dịch từ mã nguồn không có gói engine hoặc Git for Windows vẫn khởi động được, nhưng công cụ Bash không khả dụng. Công cụ PowerShell vẫn dùng được, và chẩn đoán `shell` giải thích cách khôi phục hỗ trợ Bash.

## Biên dịch từ mã nguồn

Mercury biên dịch bằng bun và chạy trên Node 24 LTS. Cài đặt [các yêu cầu biên dịch từ mã nguồn](#yêu-cầu), bao gồm bun 1.3.x:

```sh
curl -fsSL https://bun.sh/install | bash           # macOS và Linux
powershell -c "irm bun.sh/install.ps1 | iex"       # Windows, trong PowerShell 7
bun --version                                      # 1.3.x
```

Sau đó, trong một bản sao (clone) của kho này:

```sh
bun run setup                      # chạy một lần; bun install + các gói đi kèm
bun run build.ts                   # ghi dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### Hỗ trợ terminal

Giao diện toàn màn hình cần một TTY thực, nhưng không có kích thước terminal tối thiểu. Bố cục đầy đủ bắt đầu từ 100 cột × 26 hàng; cửa sổ nhỏ hơn dùng bố cục gọn.

Mercury dùng màu 24-bit khi terminal công bố hỗ trợ qua `COLORTERM=truecolor`, hoặc được nhận diện là iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal hoặc VS Code. Các terminal khác dùng 256 màu, kể cả Terminal của Apple trên macOS 15 trở về trước.

Hàng Terminal color trong health check báo cáo độ sâu màu được phát hiện và lý do. Đặt `MERCURY_TRUECOLOR=1` cho terminal hỗ trợ màu thực nhưng không công bố điều đó, hoặc `MERCURY_TRUECOLOR=0` để buộc dùng 256 màu.

### Thành phần tùy chọn

`setup` tải các gói chức năng đi kèm: pyright, debugpy, js-debug, các grammar bổ sung, runtime Node của nền tảng và brush. Nếu một lần tải thất bại, gói đó bị bỏ qua và bản biên dịch cùng các công cụ bị ảnh hưởng sẽ báo thiếu thành phần. Chỉ chạy `bun install` sẽ tạo ra một bản biên dịch không có các gói này.

Để biên dịch hỗ trợ giọng nói, chạy `setup` khi đã cài Rust. Lệnh này biên dịch `native/voice`. Thêm cmake để biên dịch cả `native/whisper`. Khi đã cài Rust, `setup` cũng biên dịch addon trình điều khiển máy tính để bàn (`native/desktop`) mà công cụ `Computer` chạy qua. Khi đã cài Rust, `setup` cũng biên dịch addon embedding cục bộ (`native/embed`, `bun run scripts/vendor/build-embed.ts`) và tải mô hình BGE 118 MB (`bun run scripts/vendor/fetch-embed-models.ts --default`); nếu không có cargo, gói đó bị bỏ qua, setup thông báo điều này, và việc tra cứu bộ nhớ Mneme chỉ so khớp từ. Mọi gói lưu trữ phát hành đều mang gói embedding được biên dịch cho nền tảng của nó; trên Linux và Windows, phép tính chạy bằng một kernel vector hóa, nên một Recall theo ý nghĩa mất khoảng một phần mười giây (vài phần trăm giây trên macOS, nơi dùng Accelerate). Nếu một bản biên dịch native thiếu công cụ, setup bỏ qua nó và health check báo cáo addon bị thiếu. Engine shell của Windows cũng được biên dịch trên máy bạn vì upstream không có binary cho Windows.

Xem [Shell trên Windows](#shell-trên-windows) và [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) để biết về engine shell `brush`.

Quá trình biên dịch chỉ ghi vào `dist/`. Cấu hình và phiên nằm trong `~/.mercury`, hoặc thư mục do `MERCURY_CONFIG_DIR` đặt, và được tạo ở lần chạy đầu tiên. Trên Windows, chạy trực tiếp `node dist\mercury.mjs`.

### Cài bản biên dịch từ mã nguồn thành lệnh

`scripts/ops/deploy-runtime.sh` xuất bản một bản biên dịch từ cây sạch vào thư mục mới `<config home>/runtime/builds/<build>` và trỏ `runtime/current` vào đó (`runtime/dist` là tên cũ của cùng liên kết đó). `scripts/ops/deploy-launcher.sh` cài trình khởi chạy tại `<config home>/bin/mercury`. Thêm thư mục đó vào PATH; với zsh:

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

Trình khởi chạy dừng với lỗi nếu thiếu runtime. Nó không chuyển sang bản biên dịch khác. Việc chọn Node theo thứ tự trong [Yêu cầu](#yêu-cầu). Với cài đặt phát hành, chạy `mercury install` hoặc `mercury update`, các lệnh này giữ nguyên các bản checkout mã nguồn; xem [Cập nhật](#cập-nhật).

[AGENTS.md](../../AGENTS.md) là hướng dẫn ngắn về biên dịch và chạy. [BUILD-NOTES.md](../../BUILD-NOTES.md) trình bày chi tiết hơn về việc biên dịch.

## Lần chạy đầu tiên

Trong lần chạy tương tác đầu tiên, chọn diện mạo (appearance), rồi đăng nhập vào một nhà cung cấp. Màn hình xem trước các thay đổi diện mạo khi bạn duyệt. True Black là mặc định; các lựa chọn khác là theme tối oasis và Black and white. Black and white không tô màu gì cả: nó dùng chính màu chữ và màu nền của terminal, giống cách Mercury hiển thị trên một terminal không có màu. Bạn có thể đổi sau này bằng `/appearance`.

Bạn cũng có thể chọn "sign in later" để xem qua mà không kết nối tài khoản. Khi một khóa nhà cung cấp trong môi trường đã đăng nhập sẵn một nhà cung cấp, bước đăng nhập sẽ không được hỏi. Tiếp theo, bước Guardrails nhắc bạn kiểm tra các chỉnh sửa và lệnh của Mercury, và cho biết nội dung nó đọc có thể chứa chỉ dẫn cho mô hình. Trong một terminal mà Mercury biết cách cấu hình (Terminal.app, nhóm VS Code, Alacritty, Zed), bước Terminal keys có thể cấu hình phím tắt xuống dòng trong chính phần cài đặt của terminal đó (trên Terminal.app của macOS, nó đặt `Option+Enter` để xuống dòng và tắt chuông terminal ở mọi profile, có hiệu lực sau khi khởi động lại Terminal.app; trong nhóm VS Code, Alacritty và Zed, nó ghi `Shift+Enter` để xuống dòng). Bước này tắt mặc định trừ khi bạn chọn bật, và một bản sao lưu được giữ lại.

Tiếp theo, Mercury hỏi bạn có tin tưởng thư mục đã mở hay không. Không có gì do cấu hình workspace yêu cầu được chạy trước khi bạn cấp sự tin tưởng đó. Sự tin tưởng áp dụng cho toàn bộ kho; nếu từ chối, Mercury thoát. Xem [docs/TRUST.md](../TRUST.md).

Một lần khởi chạy tương tác thông thường mở màn hình chính. Màn hình này có mười mục menu; Continue Last Session chỉ xuất hiện sau khi bạn đã có lịch sử phiên:

- **New Session in \<folder\>** bắt đầu một phiên mới trong thư mục hiện tại.
- **Continue Last Session** quay lại cuộc trò chuyện gần nhất của bạn.
- **Boot Menu** cấu hình các phiên sắp tới, bao gồm motion, crewmate và workflow.
- **MCPs & Skills** chọn những gì phiên kế tiếp sẽ tải. Xem [docs/KIT.md](../KIT.md).
- **Agents** tạo và chỉnh sửa tác nhân.
- **Health Check** kiểm tra bản cài đặt.
- **Saturn Scheduler** lên lịch các phiên. Xem [docs/SATURN.md](../SATURN.md).
- **Logins** kết nối các tài khoản nhà cung cấp.
- **Session Concourse** mở danh sách phiên của dự án hiện tại.
- **Sessions · Projects** cho phép bạn chọn một phiên hoặc kho mã.

Các mục menu mở chồng lên màn hình chính, và `Esc` đưa bạn về mục bạn đã chọn. Danh sách phiên mở trên một màn hình riêng, cũng có thể truy cập bằng `Shift+→`. Một đối số prompt, `--continue` hoặc `--resume` đưa bạn thẳng vào khung chat.

### Motion, crewmate và workflow

Phần Performance trong Boot Menu có thiết lập Motion: `auto`, `full`, `reduced` hoặc `off`. Thiết lập này điều khiển hoạt ảnh khi rảnh trong giao diện và cũng có sẵn trong `/config`.

Dưới Agents, các công tắc Crewmates và Workflows quyết định việc các phiên mới có nhận công cụ Crewmate và Workflow hay không. Tắt một công tắc sẽ gỡ công cụ tương ứng; mọi nỗ lực tạo loại công việc đó sẽ trả về cùng một giải thích. Trong một phiên, `/crewmates on|off` và `/workflows on|off` đổi thiết lập vào ranh giới lượt kế tiếp.

## Vòng làm việc hằng ngày: Session Concourse, git worktree và crewmate

### Bắt đầu phiên và cách ly worktree

Nhấn `Enter` trên New Session để tạo một phiên trong thư mục hiện tại với mô hình mặc định của bạn. Mercury mở khung chat và đồng thời thêm phiên vào danh sách phiên. Nó giữ sẵn một tiến trình phía sau menu để giảm bớt công việc khi khởi động.

Khởi chạy một phiên khác không dừng phiên trước đó. Bạn có thể để một tác vụ tiếp tục chạy và làm việc ở chỗ khác. Chạy với `--worktree [name]` (hoặc yêu cầu `worktree` trong chat để chạy `EnterWorktree`) để cấp cho một phiên nhánh và bản checkout riêng dưới `.mercury/worktrees/`. Các crewmate song song cũng có thể chạy trong worktree cách ly và phối hợp các tệp dùng chung bằng lease tệp dự án; xem [Bên trong có gì](#bên-trong-có-gì-bộ-nhớ-rag-mneme-lsp-ast-23-ngôn-ngữ-dap-debugger-tìm-kiếm-web-và-cầu-nối) và [docs/CREW.md](../CREW.md).

### Làm việc trong khung chat

Mô tả công việc bằng ngôn ngữ thường. Tác nhân đọc, chỉnh sửa, chạy và kiểm tra mã theo chế độ quyền bạn đã chọn. Các lệnh gọi công cụ hiển thị khi chúng chạy, dưới dạng thẻ gọn hoặc kèm toàn bộ đầu ra. Chọn cách hiển thị trong `/config` tại mục Tool output; thiết lập này được lưu cho các lần khởi chạy sau.

Dùng `/model` và `/effort` để điều chỉnh phiên. `/permissions` kiểm soát những gì có thể chạy mà không cần phê duyệt và những gì phải hỏi trước.

Xem lại thay đổi bằng `/diff`, theo nguồn, tệp và hunk. `! <command>` chạy một lệnh shell trong chat với phần đuôi đầu ra trực tiếp. `/runs` hiển thị các shell và crewmate đang chạy (`/tasks` mở cùng bảng đó), còn `/crewmates` mở màn hình Crew trực tiếp. Giữa các lượt, `/clear` lưu chat hiện tại và mở một phiên mới, còn `/restart` chuyển chat sang bản biên dịch Mercury vừa được cài. `/title` đặt tên cho chat, và `/help` liệt kê các lệnh có sẵn.

### Chuyển giữa các màn hình

`Shift+←` và `Shift+→` chuyển giữa các màn hình hiện có. Lần khởi chạy mới có màn hình chính và danh sách phiên. Màn hình chat được thêm khi một phiên được focus và bị gỡ khi chat cuối cùng đóng. Các gợi ý phím chỉ hiển thị những lần chuyển khả dụng.

Đóng mọi chat sẽ đưa bạn về màn hình chính. Dùng `--chat` để chỉ có màn hình chính và chat, không có danh sách phiên. `--concourse-off` lưu tùy chọn này cho các lần khởi chạy sau; `--concourse-on` hoặc `/config` bật lại.

### Quản lý phiên trên Session Concourse

Mở danh sách phiên bằng `/concourse` hoặc `Shift+→` từ màn hình chính. Danh sách hiển thị trước các phiên đang chạy của dự án hiện tại, tiếp theo là các chat đã lưu nhưng không chạy, mới nhất trước.

Mỗi phiên đang chạy có một ô NOW hiển thị hoạt động hiện tại của nó. Chọn một hàng và nhấn `Enter` để quay lại chat, trong khi các phiên khác vẫn tiếp tục chạy. Một phiên bị crash vẫn nằm trong danh sách phiên với nhãn NEEDS YOU kèm lý do, cho đến khi bạn giải phóng nó.

[docs/SESSIONS.md](../SESSIONS.md) trình bày vòng đời của phiên.

## Nhà cung cấp và mô hình: đăng nhập, `/localsetup` và `/llmhost`

Dùng `/logins` để kết nối một nhà cung cấp. Lệnh này mở cùng danh mục đăng nhập được dùng trong lúc thiết lập. `/accounts` quản lý các ô nhà cung cấp đã kết nối sau đó.

- **OpenAI:** gói ChatGPT hoặc khóa API.
- **Anthropic:** gói Claude, đăng nhập Console hoặc khóa API.
- **OpenRouter:** truy cập danh mục qua OAuth hoặc khóa API; các yêu cầu mô hình từ chối thu thập dữ liệu và yêu cầu mọi tham số ngay từ đầu. `/config → OpenRouter routing policy` đặt lựa chọn dự phòng (fallback) và không lưu giữ dữ liệu (zero-data-retention); chọn open để nới lỏng chính sách và để việc định tuyến cho OpenRouter.
- **Google Gemini:** Sign in with Google, khóa API, hoặc OAuth client riêng của bạn. Sign in with Google chạy Gemini bằng hạn mức của gói mà tài khoản Google đang có (tài khoản miễn phí, Google AI Pro hoặc Google AI Ultra) thông qua client Antigravity của chính Google: prompt, schema công cụ và kết quả công cụ được gửi đến endpoint Code Assist của Google dưới client đó và tài khoản đã đăng nhập, còn `/model` liệt kê danh sách mô hình mà Google cung cấp cho tài khoản. Khóa API hoặc OAuth client riêng thay vào đó sẽ tính phí cho một dự án Cloud.
- **Hugging Face:** đăng nhập bằng mã thiết bị hoặc token Hub.
- **Kimi (Moonshot):** đăng nhập bằng mã thiết bị hoặc khóa API.
- **GLM (Z.AI):** khóa gói GLM Coding Plan hoặc khóa API trả theo mức sử dụng thông thường. `/logins zai` lưu một trong hai và ghi lại gói; `ZAI_API_KEY` cũng hoạt động, với `ZAI_KEY_PLAN=coding|general` đặt tên gói (nếu không đặt, Mercury đọc gói từ danh sách mô hình của chính khóa đó).
- **DeepSeek:** khóa API từ nền tảng DeepSeek (`/logins deepseek`, hoặc `DEEPSEEK_API_KEY`).
- **xAI (Grok):** đăng nhập bằng gói Grok của bạn (SuperGrok / X Premium), hoặc dán khóa API qua `/logins xai`.
- **Meta (Muse):** Sign in with Meta (gói Muse Code, mã thiết bị trong trình duyệt) hoặc khóa Model API trả theo mức sử dụng. Sign in with Meta đổi mã thiết bị lấy token qua các endpoint OIDC của Meta (`https://auth.meta.com/oidc/device/authorization/` và `/oidc/device/token/`) dưới client id công khai của Muse Code, gửi token tài khoản thu được một lần đến `https://api.meta.ai/muse-code/key` để tạo khóa API của gói (và các lần đọc `/usage` có giới hạn để lấy bậc gói và các cửa sổ sử dụng), rồi chỉ gửi khóa đã tạo đó trong mọi yêu cầu mô hình đến `https://api.meta.ai/v1`. Khóa Model API dán vào, hoặc `MODEL_API_KEY` / `META_API_KEY`, được tính phí theo mức sử dụng.

- **Qwen:** khóa QwenCloud (Token Plan hoặc trả theo mức sử dụng) hoặc khóa Alibaba Cloud Model Studio (trả theo mức sử dụng, Token Plan hoặc Coding Plan), được kiểm tra trên endpoint riêng trước khi lưu; khóa của gói sẽ liệt kê các mô hình của gói, với Qwen3.8 Max đứng đầu.
- **MiniMax:** khóa Open Platform hoặc khóa gói M Plan đăng ký.
- **Together AI** và **Cohere:** khóa API.
- **Groq**, **Cerebras** và **Fireworks AI:** khóa API; khóa của bất kỳ họ nào cũng có thể lấy từ một lệnh được đặt tên trong `credentials.keyCommands.<family>`.

Mistral, Nous Portal và OpenCode Zen cũng kết nối qua `/logins`, nâng tổng số họ nhà cung cấp đăng nhập lên 20. Các máy chủ mô hình cục bộ (Ollama, LM Studio, vLLM và llama.cpp) và các endpoint tùy chỉnh tương thích OpenAI hoạt động mà không cần đăng nhập nhà cung cấp. Chạy `/localsetup` để cài hoặc khởi động Ollama, tải một mô hình vừa với bộ nhớ của bạn, đặt cửa sổ ngữ cảnh của nó, hoặc kết nối một máy chủ LM Studio, vLLM hoặc llama.cpp đang chạy ([docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)). Mỗi nhà cung cấp dùng giao thức, thông tin xác thực và cách xử lý lỗi riêng, và các yêu cầu không bao giờ chuyển sang nhà cung cấp khác. Xem [docs/ENGINES.md](../ENGINES.md).

`/llmhost` liệt kê các mô hình bạn có thể lưu trữ và cho biết mỗi mô hình có thể chạy ở đâu ngay lúc này: trên GPU thuê từ Runpod, Vast.ai hoặc Lambda, trên máy của bạn hoặc một máy tính SSH đã lưu (`mercury host`), hoặc trên một máy chủ mô hình có sẵn. Mỗi trang mô hình hiển thị các tùy chọn lượng tử hóa, cách ngân sách bộ nhớ GPU được chia cho các cuộc trò chuyện song song (`conversations × context`), và mức thinking mặc định (mà `/effort` thay đổi theo từng yêu cầu). Thuê GPU yêu cầu xác nhận giá theo giờ một cách rõ ràng, và thiết lập tiếp tục chạy nền nếu bạn đóng hộp thoại bật lên. Trên Runpod, bạn cũng có thể điều chỉnh chất lượng, cách chia ngữ cảnh và thinking trước khi thuê hoặc trên một pod đang chạy (`Tune`), giữ trọng số trên một volume tải nhanh, và đặt các theo dõi tồn kho 5 giây. Việc thuê trên Vast.ai và Lambda là tính năng mới trong 1.0.0-beta.40 và được xác minh theo các API công khai của nhà cung cấp, bằng fixture kiểm thử (chưa thực hiện các lần thuê thực tế). Xem [docs/LLM-HOST.md](../LLM-HOST.md).

Phiên mới dùng nhà cung cấp mà bạn đã kết nối gần nhất và mô hình mới nhất mà tài khoản đó có thể dùng. Các mô hình mà tài khoản không truy cập được sẽ bị bỏ qua. Nếu nhà cung cấp đó không có mô hình khả dụng, Mercury kiểm tra nhà cung cấp được kết nối gần nhất kế tiếp. Lựa chọn này diễn ra khi phiên bắt đầu; một yêu cầu thất bại trong phiên đang tồn tại vẫn ở lại với nhà cung cấp của nó.

`/model` giải thích lựa chọn. Một từ chỉ họ sẽ chọn mô hình mới nhất của họ đó: `/model grok`, `/model deepseek`, `/model kimi` hoặc `/model glm`. Khi chưa kết nối nhà cung cấp nào, màn hình chính và `/model` sẽ hướng bạn đến `/logins`. `/defaultprovider` cho phép bạn đặt rõ một nhà cung cấp làm lựa chọn gần nhất.

Quyền truy cập nhà cung cấp vẫn tuân theo điều khoản và tính khả dụng của chính nhà cung cấp đó. Giấy phép của Mercury không thay thế các điều khoản ấy.

## CLI không giao diện: `mercury run`, Docker và runner JSON-RPC

Cùng một bản biên dịch chạy được mà không cần giao diện tương tác. `node dist/mercury.mjs --help` liệt kê mọi cờ.

`mercury run "<prompt>"` chạy một prompt mà không có giao diện terminal:

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` in câu trả lời; lý do của một lượt thất bại được gửi đến stderr.
- `json` in dòng `outcome` cuối cùng dưới dạng một đối tượng JSON.
- `rows` ghi mỗi dòng một đối tượng JSON: `session`, rồi một `turn` cùng các dòng `text`, `reasoning`, `tool_call`, `tool_result` và `step` của nó, kết thúc bằng `outcome`. Thời gian chờ, tiến độ công cụ, tác vụ nền và thông báo đều có dòng riêng. Mọi dòng đều có `seq`, `timestamp` và `session_id`; các dòng trong một lượt cũng mang số `turn` của lượt đó. `seq` đánh số luồng của lần chạy này từ 1; `turn` đếm các lượt của phiên, nên một lần chạy tiếp tục một cuộc trò chuyện đã lưu (`-c`, `-r`, `--fork`) sẽ đánh số lượt của nó nối tiếp các lượt đã có trong đó, và dòng `session` của nó ghi cuộc trò chuyện đang được tiếp tục vào `resume_of`.

Các loại dòng đầu ra, theo trường `type` của chúng:

- `session`: dòng mở đầu: `version`, `build` (12 ký tự hex đầu của cây mã mà bundle được biên dịch từ đó, như `mercury daemon status` in ra; bị bỏ qua khi không có manifest bên cạnh bundle), `resume_of` (trong một lần chạy tiếp tục, là session id của cuộc trò chuyện đang được tiếp tục; giống `session_id` trừ khi lần chạy được fork), `cwd`, `model`, `mode`, `tools`, `mcp_servers`, `commands`, `agents`, `skills` và `extensions` mà phiên có, và `tools_withheld` (chỉ có khi một quy tắc deny giữ lại một công cụ theo tên trần của nó: mỗi mục có `tool`, `rule` và `source`).
- `turn`: một lượt đang `started` hoặc `waiting`, với `turn_id` của nó; kèm `model`, `message_ids` và số `agents` khi đã biết.
- `text`: một khối văn bản đã hoàn tất: `message_id`, `block`, `text`, và `phase` (`commentary` hoặc `final_answer`).
- `reasoning`: một khối suy luận (reasoning) đã hoàn tất: `message_id`, `block`, `text`, hoặc `redacted: true`.
- `tool_call`: một lệnh gọi công cụ: `call_id`, `tool`, `input`, cùng `message_id` và `block` của nó.
- `tool_result`: kết quả của lệnh gọi: `call_id`, `status` (`ok`, `error`, `aborted` hoặc `refused`) và `output`. Một lệnh gọi mà mô hình tạo ra sai đến mức bị từ chối trước khi thực thi (công cụ không xác định, đối số không phải JSON hợp lệ hoặc không khớp schema của công cụ) vẫn có cặp của nó: một dòng `tool_call` với các đối số như đã gửi (`{}` khi chúng không phải object) và một dòng `tool_result` với status `refused` mà `output` là lý do; thông báo sửa lỗi `notice` đi sau. Lệnh gọi như vậy chưa từng chạy và không phải là một lần bị từ chối.
- `tool_update`: tiến độ từ một công cụ đang chạy: `call_id`, `tick`, `source` (`shell`, `powershell`, `mcp` hoặc `eval`), và bất kỳ trường nào trong `line`, `elapsed_s`, `lines`, `bytes`, `budget_ms`, `progress` và `total` mà lệnh gọi báo cáo. Lệnh shell hoặc PowerShell phát một tick khi đầu ra đến (lệnh không in gì thì không bao giờ phát tick), lệnh MCP khi máy chủ của nó báo tiến độ, lệnh Eval trong khi ô của nó chạy; các công cụ khác không phát tick; lệnh gọi Browser hoặc Crewmate im lặng cho đến khi có kết quả.
- `step`: một lần gọi mô hình của luồng chính: `message_id`, `model`, `usage`, và `stop` khi mô hình cho biết lý do nó dừng.
- `outcome`: kết quả của lượt, được mô tả bên dưới.
- `close`: ghi chú để lại cho phiên kế tiếp khi đóng: `state` (`stored`, `skipped` hoặc `none`), `note_chars`, và `usage` của các lần gọi mô hình đã ghi nó, để người đọc cộng usage của mọi dòng sẽ ra đúng usage của outcome. Khi prompt được truyền dưới dạng đối số, ghi chú được yêu cầu bên trong lượt cuối cùng và `close` đứng trước `outcome` của lượt đó; với `--input rows`, nó đứng sau `outcome` cuối cùng khi stdin đóng.
- `wait`: một lần chờ mô hình: `state` (`first_byte`, `retry`, `silence`, `loading` hoặc `done`) cùng các số liệu mà trạng thái đó mang theo, như `since_ms`, `attempt` và `of`, `delay_ms`, `reason` và `http_status`.
- `heartbeat`: luồng mô hình có dấu hiệu còn sống sau ít nhất một giây không có sự kiện đã phân tích: các byte đã đến nhưng không tạo ra dòng nào. Dòng này không mang gì khác và xuất hiện tối đa mỗi giây một lần; tần suất phụ thuộc vào kiểu truyền dữ liệu của nhà cung cấp, nên luồng không bao giờ tạm dừng giữa các sự kiện sẽ không phát dòng nào.
- `compaction`: một lần compaction `started`, `progress` hoặc `ended`: `trigger` (`manual`, `auto` hoặc `overflow`), `stage`, `fill`, `summary_tokens` và, khi kết thúc, `exit` (`landed`, `cancelled` hoặc `failed`).
- `mode`: chế độ quyền đã thay đổi: `mode`.
- `rate_limit`: trạng thái giới hạn tốc độ của nhà cung cấp: `status` (`allowed`, `warning` hoặc `rejected`), `window`, `resets_at`, `utilization` và các trường overage.
- `task`: một tác vụ nền `started`, `progress` hoặc `ended`: `task_id`, `task_type`, `description`, `usage`, `summary`, `status` (`completed`, `failed` hoặc `stopped`) và `output_file` khi chúng được biết.
- `notice`: `warning` hoặc `error` dành cho người đọc: `text`, và một `code` như `input_refused`.
- `command_output`: đầu ra của một lệnh slash chưa bao giờ đến được mô hình: `command` và `text`.
- `mission_updated`: sổ tác vụ (task ledger) của phiên đã thay đổi; hãy đọc lại.
- `samples_updated`: các mẫu (samples) của phiên đã thay đổi; hãy đọc lại.

`--partial` đi cùng `--format rows` thêm các dòng `block_start`, `text_delta`, `reasoning_delta`, `tool_input_delta` và `retracted`. Các delta thuộc về `message_id` và `block`; một dòng `retracted` rút lại các delta của thông điệp đó. Dòng text hoặc tool đã hoàn tất là giá trị đầy đủ.

Kết quả (outcome) mang `schema`, `turn_id`, `status`, `steps`, `wall_ms`, `usage`, `models` và `denials`, với `answer` khi hoàn thành và `error` (`message`, `class`, `detail` tùy chọn) khi thất bại. `stop`, `api_ms`, `cost_usd`, đầu ra `structured` đã yêu cầu và `notices` được đưa vào khi có sẵn. `wall_ms` là thời gian trôi qua của lượt. `api_ms` là tổng thời lượng của mọi yêu cầu mô hình mà lượt đã thực hiện (bao gồm các lần thử lại và các yêu cầu của crewmate chạy song song với luồng chính), nên nó có thể vượt quá `wall_ms` khi các yêu cầu chồng lên nhau. `cost_usd` là số USD của các yêu cầu có giá trong lượt, bất kể trạng thái: một yêu cầu mà Mercury không thể định giá (không có đơn giá trong hồ sơ, không có chi phí nào được nêu trong phản hồi) không đóng góp gì vào giá trị này và để mô hình của nó nằm trong `models` mà không có `cost_usd` riêng; trường này chỉ vắng mặt khi không có gì trong lượt được định giá. Với đăng nhập gói đăng ký Claude, các yêu cầu Anthropic không có giá bằng đô la, nên cả chúng lẫn dòng đó đều không mang `cost_usd`; usage vẫn có. Usage gồm `input_tokens` (đã tính token được cache), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` và, khi được báo cáo, `reasoning_output_tokens`, được cộng dồn qua luồng chính và các crewmate. `models` chia mức sử dụng token theo từng mô hình. `steps` chỉ đếm các lần gọi mô hình của tác nhân chính; các lần gọi mô hình do crewmate thực hiện xuất hiện dưới dạng các dòng `step` riêng, được gắn thẻ `parent_call_id`.

Trạng thái (status) là một trong các giá trị `completed`, `blocked`, `refused`, `failed`, `interrupted`, `turn_limit`, `budget_limit`, `time_limit`, `schema_unmet` hoặc `loop_stopped`. Một lần chạy với `--max-time` (tính bằng giây, hoặc `10m`, `1h`) kết thúc với `time_limit` ở bước kế tiếp khi hết thời gian; lần gọi mô hình hoặc vòng công cụ đang diễn ra không bị cắt. Một lần chạy hoàn tất thoát với mã 0, kết quả khác thoát với mã 1, và lỗi cách dùng thoát với mã 2. SIGINT và SIGTERM thoát với mã 130 và 143 sau khi outcome của lượt bị ngắt được ghi ra (flush). Lệnh gọi công cụ bị từ chối được liệt kê trong `denials`. Khi việc từ chối là một yêu cầu phê duyệt mà không ai có thể trả lời (lần chạy không có host ở chế độ có hỏi, `--mode dontAsk`, hoặc yêu cầu của host đã hết hạn) và không có lệnh gọi công cụ nào sau đó trong lượt thành công, lần chạy là `blocked`: câu trả lời được giữ lại, `error` nêu tên công cụ và cách tiếp tục (`--allowed-tools`, một `--mode` khác, hoặc một host trả lời các yêu cầu phê duyệt), và lần chạy thoát với mã 1. Nếu một lệnh gọi công cụ sau đó trong cùng lượt thành công, lượt được phục hồi và kết thúc `completed` (mã 0) kèm một `notice` cảnh báo (`"<Tool> was not approved; the run continued with other tools."`). Một lần từ chối mà bạn đã trả lời (qua quy tắc deny, hook, hoặc một host đã từ chối) không làm thay đổi trạng thái của lượt đã hoàn tất. Một lệnh gọi `AskUserQuestion` không được trả lời cũng kết thúc lần chạy là `blocked`, với câu hỏi được trích dẫn trong `error`; Mercury đọc kết quả từ các yêu cầu hỏi đã được ghi lại của lần chạy, không bao giờ từ văn bản trả lời, nên một câu hỏi chỉ được viết trong phần trả lời sẽ kết thúc là `completed`. Lệnh slash không xác định là `refused` với đúng câu mà màn hình tương tác đưa ra (`Unknown command: /name · /help lists commands`) và thoát với mã 1.

`--input rows` yêu cầu `--format rows` và đọc mỗi dòng một đối tượng đầu vào:

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

Các loại đầu vào là `prompt` với `content` (văn bản hoặc khối văn bản/ảnh), `shell` với `command`, và `note` với `to` (một ID tác nhân) và `content`. Mỗi loại đều nhận một `id` tùy chọn; các dòng prompt và shell còn nhận `priority` (`now`, `next` hoặc `later`), `sent_at` và `origin`. Một đầu vào có hình dạng bị từ chối tạo ra một `notice` với mã `input_refused`; JSON sai định dạng sẽ kết thúc lần chạy. Các dòng này chỉ mang đầu vào; các câu trả lời cấp quyền dùng giao thức runner bên dưới.

Dùng `mercury run -` hoặc đưa văn bản vào `mercury run` qua pipe để đọc toàn bộ prompt từ stdin. Cạnh một đối số prompt, văn bản qua pipe được nối thêm dưới dạng ngữ cảnh có phân định: pipe được đọc cho đến khi nó đóng hoặc im lặng trong một giây, nên một luồng tiếp tục gửi dữ liệu sẽ được đọc đến hết, còn một pipe mở và im lặng không giữ lần chạy lại. Khi không có prompt và stdin là một terminal, `run` in cách dùng và thoát với mã 2.

`--mode <mode>` chọn tư thế quyền (posture). `--sovereign` chạy mà không có lời nhắc quyền, và `--allow-sovereign` làm cho tư thế đó khả dụng để chuyển sang sau này. Chính sách quyền và các quy tắc deny vẫn áp dụng. Người dùng root khi vào chế độ sovereign nhận một thông báo trên stderr; lần chạy vẫn tiếp tục.

Dùng `-c` để tiếp tục cuộc trò chuyện gần nhất, `-r` để tiếp tục theo ID, tiêu đề hoặc bộ chọn, `-w` để chạy trong một worktree được quản lý, và `--lean` cho một phiên tối giản. Một `run` không có host để trả lời các yêu cầu quyền: quy tắc quyền và chế độ của nó quyết định điều gì có thể chạy, và một lệnh gọi vẫn cần phê duyệt sẽ bị từ chối.

### Image headless

`Dockerfile` ở gốc kho biên dịch một image Linux x64 cho CI và máy chủ. Điểm vào của nó là `mercury` và lệnh mặc định là `run`, nên image chạy một prompt trên một cây được gắn kết và thoát với mã của lần chạy đó:

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

Image chứa bundle, runtime Node 24 của nó (trên `PATH`), các công cụ tìm kiếm, shell, debugger, ngôn ngữ và xử lý ảnh được đóng gói sẵn, `git` và kho chứng chỉ; không có màn hình vào và không có luồng đăng nhập. Nó chạy với người dùng không phải root `mercury`, thư mục cấu hình nằm trong container (`MERCURY_CONFIG_DIR`), và `/work` là thư mục làm việc của nó. Màu sắc và chuột theo cách phát hiện terminal riêng của sản phẩm, còn `--user 0` chạy với quyền root kèm thông báo sovereign nêu trên.

Khóa nhà cung cấp được truyền qua biến môi trường, với cùng các cách viết mà sản phẩm đọc ở mọi nơi: `ANTHROPIC_API_KEY` hoặc `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` hoặc `GOOGLE_API_KEY`, `XAI_API_KEY` (và `XAI_MANAGEMENT_API_KEY` cho bộ đo mức sử dụng của nó), `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY` (và `MISTRAL_ADMIN_API_KEY` cho bộ đo mức sử dụng của tổ chức), `NOUS_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`, `TOGETHER_API_KEY` hoặc `TOGETHER_AI_API_KEY`, `COHERE_API_KEY` hoặc `CO_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `DASHSCOPE_API_KEY`, `MODEL_API_KEY` hoặc `META_API_KEY`, `MERCURY_COMPAT_API_KEY` cho một endpoint tương thích OpenAI tùy chỉnh và `MERCURY_LOCAL_API_KEY` cho một máy chủ cục bộ. Khi không có khóa, lần chạy từ chối bằng một dòng và thoát với mã 1. `docker run -i … mercury run -` đọc prompt từ stdin.

### Host một phiên

`mercury runner` cung cấp một phiên cho một host qua stdio: JSON-RPC 2.0, mỗi thông điệp một dòng. Host gửi `initialize` trước tiên và chờ phản hồi trước khi gửi công việc:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

Tên và phiên bản của host được đặt dưới `host`; `capabilities` khai báo `holds_asks`, `elicitation` và `partial_rows`. Mọi `id` yêu cầu đều phải là số nguyên dương: một yêu cầu có `id` là giá trị khác sẽ được trả lời `-32600` với `id: null`, nên hãy đánh số yêu cầu từ 1.

`queue/add` nhận cùng đối tượng prompt, shell hoặc note như đầu vào dòng ở trên. Đầu ra đến qua các thông báo `row`. `session/facts` đọc trạng thái của phiên; `session/set_mode` đổi chế độ quyền ngay lập tức; `session/set_model` và `session/set_effort` đổi mô hình và mức nỗ lực (effort), và một thay đổi thực hiện khi lượt đang chạy sẽ được giữ lại cho đến khi lượt kết thúc: nó trả lời với `at: "turn_end"`, rồi `session/applied` thông báo điều đó. `turn/interrupt` dừng một lượt; đóng stdin để kết thúc phiên.

Các yêu cầu quyền đến dưới dạng `permission/request`, với `kind: "tool"` hoặc `kind: "network"`. Host trả lời bằng `outcome: "allow"` hoặc `outcome: "deny"`; một allow có thể mang `input` đã sửa và các `rules` quyền. Một yêu cầu đã rút sẽ gửi `$/cancel_request` kèm `request_id` của nó. `holds_asks` giao cho host quyền sở hữu bộ đếm thời gian của yêu cầu. Một câu hỏi MCP chỉ dùng `elicitation/request` khi host khai báo `elicitation`; nếu không, nó được trả lời `cancel`.

Một phương thức không xác định trả lời `-32601`, tham số không hợp lệ `-32602`, một `id` không phải số nguyên dương `-32600`, và yêu cầu trước khi khởi tạo `-32002`. Một lần từ chối theo quy tắc là `-32010`, với một câu trong `error.message` và lý do trong `error.data.kind`, như `mode`, `model`, `effort` hoặc `claim`. Runner trả lời một dòng sai định dạng bằng `-32700` và tiếp tục; ba dòng sai liên tiếp sẽ kết thúc nó.

### Các lệnh khác

Các lệnh có sẵn bao gồm:

- **`mercury health`**: báo cáo chẩn đoán, còn gọi là health certificate. `--json` trả về toàn bộ báo cáo, `--deep` chạy kiểm kê sâu, và `--fix` chạy các bước sửa có hướng dẫn.
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**: đăng nhập (`login [<family>]`), liệt kê các họ nhà cung cấp (`list`), kiểm tra xem một tài khoản đã đăng nhập chưa (`status [<family>]`), đăng xuất (`logout [<family>]`), hoặc tạo một token Anthropic dài hạn (`mint`).
- **`mercury models [--json]`**: in các mô hình mà các tài khoản đã đăng nhập truy cập được (cùng thông tin với `mercury://models`).
- **`mercury mcp`**: quản lý máy chủ MCP với `add`, `import`, `list`, `get`, `remove`, `trust-reset` và `serve`.
- **`mercury extensions`**: cài đặt extension và quản lý nguồn của chúng. Các hành động: `list`, `sources`, `add`, `remove`, `refresh`, `install`, `trust`, `enable`, `disable`, `update`, `uninstall`, `fence`, `unfence`, `inspect` và `scaffold`.
- **`mercury roster`**: liệt kê danh mục tác nhân.
- **`mercury usage`**: in dòng tóm tắt gọn các con số mà màn hình `/usage` hiển thị; `--json` in toàn bộ số đọc: các cửa sổ của từng nhà cung cấp đã đăng nhập cùng mức đã dùng và thời điểm đặt lại, các con số và tín dụng mà nhà cung cấp công bố (mỗi thứ kèm nguồn và tuổi), và mức chi tiêu của phiên theo từng mô hình, đọc theo cách màn hình đọc (bộ đọc của mỗi nhà cung cấp đã đăng nhập được lấy mẫu một lần, như khi mở màn hình).
- **`mercury daemon run|status|stop|restart`**: chạy, kiểm tra, dừng hoặc khởi động lại daemon nền. Các seat phiên của nó là các tiến trình con `mercury runner`; daemon gửi prompt của chúng và lưu trữ các yêu cầu quyền của chúng.
- **`mercury sessions list`** (hoặc `mercury sessions` trơn): liệt kê các phiên đã lưu của dự án này, mới nhất trước: id, thời điểm ghi lần cuối, kích thước, `live` khi daemon đang lưu trữ nó, và tiêu đề hoặc prompt đầu tiên; `--all` đọc mọi dự án, `--limit <n>` giới hạn danh sách. Id là thứ mà `mercury --resume <id>` mở lại và `sessions delete` xóa.
- **`mercury sessions delete <id>`**: xóa có chủ đích một phiên đã lưu, gồm bản ghi hội thoại (transcript) và các bản ghi đi kèm (biên nhận, snapshot để tiếp tục), sau một câu hỏi xác nhận; `--yes` bỏ qua câu hỏi trong script. Một phiên mà daemon đang lưu trữ sẽ bị từ chối, và một id không rõ được từ chối kèm gợi ý đến danh mục (roster) (`/sessions` bên trong Mercury). Các phiên đã lưu không bao giờ bị xóa tự động.
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**: chạy một máy tính cục bộ hoặc qua SSH như một máy chủ mô hình cho mọi phiên dùng chung thư mục cấu hình (`compat/box-<name>/<model>`), dùng một kho trọng số cục bộ đã xác minh hoặc một lần tải đã được xác nhận. Xem [docs/LLM-HOST.md](../LLM-HOST.md).
- **`mercury lsp list`** và **`mercury lsp install <server>`**: danh mục máy chủ ngôn ngữ, mỗi máy chủ được hiển thị là đã cài (kèm binary) hoặc chưa có (kèm cách cài); `install` hiển thị cách cài của một máy chủ, hỏi xác nhận, chạy đúng lệnh đó (`--yes` bỏ qua câu hỏi trong script) và báo binary được đặt ở đâu. Một máy chủ không rõ sẽ bị từ chối kèm danh mục. Mercury không bao giờ tự cài máy chủ ngôn ngữ; mở một tệp chỉ khởi động máy chủ đã được cài sẵn.
- **`mercury acp`**: phục vụ một trình soạn thảo qua Agent Client Protocol, với một tiến trình con runner cho mỗi phiên. `mercury bridge install` cài extension VS Code; `mercury bridge status` kiểm tra nó; `mercury bridge uninstall` gỡ nó.
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**: quản lý các job engine cho dự án Godot trong thư mục hiện tại. Mercury chạy các bộ kiểm thử trên các worker headless riêng từ một bản sao dự án đã đóng băng. Dịch vụ bao gồm cổng biên dịch, chụp ảnh, thống kê khung hình, hồ sơ đã ổn định, truy cập hàng đợi job, hủy và kết quả theo ID. Xem [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md).
- **`mercury image <image>`**: hiển thị một ảnh trong terminal.
- **`mercury install`** và **`mercury update`** (bí danh `upgrade`): cài đặt hoặc cập nhật các gói phát hành; với `--json`, tài liệu được in ra stdout bất kể kết quả là gì, và mã thoát cho biết có thất bại hay không. Xem [Cài đặt](#cài-đặt).
- **`mercury version`** và **`mercury help [command]`**: in dòng phiên bản hoặc trang trợ giúp, giống `--version` và `--help`; cả hai đều không khởi động phiên.

## Bên trong có gì: bộ nhớ RAG Mneme, LSP, AST 23 ngôn ngữ, DAP debugger, tìm kiếm web và cầu nối

- **Bộ nhớ dự án RAG lai Mneme.** Mneme bật mặc định, giữ các sự kiện của mỗi dự án trong các trang chủ đề markdown thuần (`Retain`, `Recall`, `Reflect`, `Correct`). Recall kết hợp một mô hình embedding ngữ nghĩa BGE 118 MB chạy trên thiết bị (`bge-base-en-v1.5` `q8_0`, giấy phép MIT, có trong mọi gói phát hành và được biên dịch cho nền tảng của nó; xem [Thành phần tùy chọn](#thành-phần-tùy-chọn)) với xếp hạng từ BM25 có stemming, trọng số độ mới và theo dõi trích dẫn qua hợp nhất xếp hạng nghịch đảo (reciprocal rank fusion, `k = 60`). Các quy tắc đã ghim (`pin: true`) được tải nguyên văn trên kệ ghim và chỉ thay đổi theo lời bạn. Khi phiên bắt đầu, Mercury chấm điểm các sự kiện chưa ghim và các ghi chú trước đó theo nhánh hiện tại, các tệp vừa được chỉnh sửa và ghi chú bàn giao của phiên trước, trong một hạn mức khởi động riêng (`memory.startLimit`, mặc định 4.000 ký tự). Kiểm tra mâu thuẫn tại thời điểm ghi bắt được đảo cực tính, phủ định và đảo số trước khi một sự kiện xung đột được lưu. Mỗi phiên ghi một ghi chú bàn giao bằng chính lời của nó khi thoát, để làm trang mở đầu cho phiên kế tiếp, cộng thêm một mục nhật ký phiên tùy chọn. `/memory` mở trung tâm bộ nhớ, còn `/memory page` vẽ thư viện trong trình duyệt của bạn dưới dạng đồ thị nút và cạnh. Xem [docs/MNEME.md](../MNEME.md).
- **LSP code intelligence, viết lại AST 23 ngôn ngữ, DAP debugger và ô `Eval`.** Đọc có neo và chỉnh sửa nhiều tệp nguyên tử (`ChangeSet`); truy vấn máy chủ ngôn ngữ (`LspRead`) và các phép refactor xem trước rồi áp dụng (`LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`); tìm kiếm và viết lại cây cú pháp (`AstSearch`, `AstEdit`) với biến meta `$NAME` và `$$$NAME` trên 23 grammar có trong gói phát hành (16 grammar trong mọi bản biên dịch `bun install` cộng 7 grammar trong gói grammar); các ô mã Python (`python3`) và JavaScript (ES module của Node) được giữ lại giữa các lần chạy (`Eval`); và một debugger Debug Adapter Protocol (`Debug`) điều khiển `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`, `netcoredbg`, `rdbg`, adapter gỡ lỗi của Dart SDK, `kotlin-debug-adapter`, adapter gỡ lỗi elixir-ls và Godot. Công cụ `Test` có thao tác `debug` đưa một bài kiểm thử Python (`pytest`, `unittest`), JavaScript/TypeScript (`node-test`, `vitest`, `jest`), Go (`go test`) hoặc Rust (`cargo test`) đang lỗi thẳng vào một phiên `Debug` để đi từng bước. Xem [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md), [giao dịch thay đổi](../CHANGE-TRANSACTIONS.md), [mẫu cấu trúc](../STRUCTURAL-PATTERNS.md), [ô mã](../EVAL.md) và [debugger](../DEBUGGER.md).
- **`WebSearch` không cần khóa và `WebFetch` xuất markdown.** `WebSearch` chạy một chuỗi cố định: trước hết là tìm kiếm trực tiếp gốc của nhà cung cấp khi mô hình của phiên hỗ trợ (`ProviderSearch`), sau đó là khóa Brave hoặc Tavily đã lưu, rồi đến các API chính thức được chọn theo hình dạng truy vấn (Stack Exchange, npm, PyPI, crates.io, tìm kiếm mã GitHub, Hacker News Algolia, Wikipedia), rồi đến các API JSON SearXNG đã cấu hình (`MERCURY_SEARCH_SEARXNG_INSTANCES`), và cuối cùng là cào trang DuckDuckGo không cần khóa (bật mặc định; tắt trong `/config` hoặc bằng `MERCURY_SEARCH_KEYLESS=0`). Mọi câu trả lời đều dưới 2.000 token và nêu tên nguồn đã trả lời. `WebFetch` đọc các trang công khai dưới dạng markdown, bằng chính lời của trang, trong ngân sách 38.000 ký tự mỗi lần gọi (một trang cần trình duyệt được đọc qua trình đọc được lưu trữ `r.jina.ai`, trừ khi `MERCURY_FETCH_READER=0`, và địa chỉ mạng riêng không bao giờ được gửi đến đó). Xem [docs/ENGINES.md](../ENGINES.md).
- **Agent, crewmate đa nhà cung cấp (`Crewmate`), worktree và lease tệp.** Hai agent tích hợp sẵn (`mercury-crew` cho công việc được giao thuộc mọi loại và `mercury-scout` cho việc trinh sát chỉ đọc) nằm cạnh các định nghĩa agent bạn tạo trong `/agents`. Khởi chạy crewmate trên bất kỳ nhà cung cấp nào đã đăng nhập, cách ly công việc song song trong các bản checkout `git worktree` (`isolation: "worktree"`), phối hợp các tệp dùng chung bằng lease tệp dự án trong tiến trình (`mcp__mercury__lease_take`, `mcp__mercury__lease_release`, `mcp__mercury__lease_list`), và điều hướng hoặc tiếp tục crewmate theo tên hoặc id bằng `SendMessage` và `ResumeCrewmate`. Theo dõi crewmate và các lần chạy workflow trong `/crewmates` và `/runs`. Xem [docs/CREW.md](../CREW.md).
- **Điều khiển máy tính để bàn.** Được bật mặc định khi trình điều khiển máy tính gốc khả dụng. Công cụ `Computer` chụp ảnh màn hình và điều khiển chuột cùng bàn phím trong ứng dụng ở tiền cảnh. Mercury kiểm tra ứng dụng theo tên và danh tính trước khi hành động, yêu cầu phê duyệt trừ khi quy tắc quyền, phiên cho phép, cài đặt truy cập hoặc chế độ quyền của bạn đã cho phép hành động đó, dừng khi nhấn `Esc`, chỉ cho một phiên điều khiển máy tính tại một thời điểm, và không lưu ảnh chụp màn hình vào tệp hội thoại đã lưu. Đặt `MERCURY_COMPUTER_USE=0` để gỡ công cụ. Xem [docs/COMPUTER-USE.md](../COMPUTER-USE.md).
- **Nhập giọng nói Whisper trên thiết bị (`/voice`).** `/voice on` tải mô hình giọng nói tiếng Anh 60 MB (`base.en-q5_1`) ở lần dùng đầu tiên, xác minh digest SHA-256 của nó và bật nhập liệu bằng giọng nói; `/voice off` tắt nó. Giữ phím cách trong 1 giây để nói và thả để dừng, hoặc chạy `/voice` trơn để bắt đầu và dừng một đoạn ghi (take) khi giọng nói đang bật. Whisper chép lời ngay trên thiết bị nên âm thanh không bao giờ rời khỏi máy, và `MERCURY_WHISPER_MODEL` chọn `tiny.en-q5_1`, `small.en-q5_1`, `base-q5_1` đa ngôn ngữ, hoặc một tệp `.gguf` cục bộ. Xem [docs/VOICE.md](../VOICE.md).
- **Cron và bộ lập lịch phiên Saturn (`/saturn`).** Lên lịch một prompt cho một phiên hiện có (`CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, `/loop`) hoặc lên lịch một phiên mới bắt đầu vào một thời điểm đặt sẵn. Lịch có thể chạy một lần hoặc lặp lại. Xem [docs/SATURN.md](../SATURN.md).
- **Cầu nối VS Code (ACP), Unity, Blender, Godot và Aseprite.** `mercury acp` kết nối với các trình soạn thảo hỗ trợ Agent Client Protocol. Extension VS Code (`mercury bridge install`) chạy Mercury trong trình soạn thảo qua giao thức đó: chat, phiên, agent, artifact và review, với vùng chọn và chẩn đoán của trình soạn thảo đi kèm mỗi prompt. Các tích hợp riêng, tùy chọn bật, kết nối đến các trình soạn thảo Unity (`MERCURY_UNITY=1`), Blender (`MERCURY_BLENDER=1`) và Godot (`MERCURY_GODOT_TOOLS=1`) đang chạy, với truy cập theo lô tới Aseprite (`MERCURY_ASEPRITE=1`). Xem [Unity](../UNITY-BRIDGE.md), [Blender](../BLENDER-BRIDGE.md), [Godot](../VULCAN-GODOT-TOOLS.md) và [Aseprite](../ASEPRITE-BRIDGE.md).
- **Extension.** Mỗi extension có một manifest. Thêm nguồn từ URL git, thư mục cục bộ hoặc archive, được phê duyệt theo hash đóng góp của nó. Xem [docs/EXTENSIONS.md](../EXTENSIONS.md).
- **MCPs & Skills.** Cấu hình theo từng kho cho những gì các phiên tải, với các preset có tên và các điều khiển bạn có thể đổi trong một phiên. Xem [docs/KIT.md](../KIT.md).
- **Chẩn đoán.** Health check và `/health` tạo ra một báo cáo dựa trên bằng chứng chẩn đoán, với phán quyết `certified`, `caution` hoặc `fault` và các bản sửa đã xác minh. Xem [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md).
- **Tin cậy và quyền.** Tin cậy workspace, quy tắc và chế độ quyền, cùng các lệnh mà mọi phiên đều từ chối. Xem [docs/TRUST.md](../TRUST.md).
- **Apollo Mode**, cuộc phỏng vấn đặc tả: trả lời các câu hỏi của tác nhân để hoàn tất đặc tả mà nó sẽ dùng để xây dựng một nguyên mẫu. Xem [docs/APOLLO-MODE.md](../APOLLO-MODE.md).
- **Phục hồi.** Xuất bản nguyên tử, các thao tác được ghi nhật ký và đối soát khi khởi động. Xem [docs/DURABILITY.md](../DURABILITY.md).

Các cờ runtime được định nghĩa trong `src/substrate/flagRegistry.ts`, được hiển thị dưới dạng cài đặt `MERCURY_*` và được kết xuất theo yêu cầu. Khả năng tương thích tích hợp được ghi lại trong [docs/COMPATIBILITY.md](../COMPATIBILITY.md). Chỉ mục tài liệu đầy đủ là [docs/README.md](../README.md).

## Lệnh slash

`/help` liệt kê các lệnh tương tác có sẵn. Dùng `/palette` để tìm lệnh theo kiểu mờ. Bảng dưới đây nhóm các lệnh tích hợp được bật mặc định theo các danh mục dùng trong `/help`; danh sách trực tiếp còn bao gồm `/samples` dưới `current work` khi Samples được bật (`MERCURY_SAMPLES=1` hoặc hàng Samples trong Boot Menu), `/showcase` khi `MERCURY_DEV_SURFACES=1` được đặt, và mọi lệnh skill hoặc extension.

| Nhóm | Lệnh |
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

| Lệnh | Mô tả |
| --- | --- |
| `/llmhost` | Chọn một mô hình để thuê trên Runpod, Vast.ai hoặc Lambda, chạy trên máy của bạn, hoặc kết nối một máy chủ có sẵn. |
| `/restart` | Chuyển chat này sang bản biên dịch Mercury đã cài đặt; các watch đang chạy và shell nền sẽ dừng. |
| `/mcp` | Kiểm tra máy chủ, đăng nhập, duyệt công cụ và tham số của từng máy chủ, kết nối lại, hoặc bật/tắt một máy chủ cho chat này. |

`/mouse off` trả con trỏ về terminal để chọn và sao chép văn bản gốc. Tùy chọn này được lưu và xuất hiện trong `/config` dưới tên Mouse capture.

Đối số bắt buộc được ghi bằng `<…>` trong cách dùng của một skill. Ví dụ, `/update-config` và `/debug` cần một đối số. Gửi một mình thì bạn nhận được mô tả và cách dùng; không có lượt nào bắt đầu. Chọn nó trong typeahead rồi nhấn Enter sẽ để lại `/name ` sẵn sàng để bạn thêm đối số. `/loop` không có đối số bắt buộc và chạy ngay.

## Báo cáo sự cố

Để gửi báo cáo ngắn, dùng [biểu mẫu dành cho người thử nghiệm](https://mercury-cli.ai/report) hoặc `/bug --short <what you tried>` bên trong Mercury. Biểu mẫu hỏi hệ điều hành, những gì bạn đã thử và những gì bị hỏng; không cần đính kèm health dump.

Chạy `/bug <what happened>` bên trong Mercury để xem trước báo cáo trước khi gửi qua GitHub CLI (`gh`) đã đăng nhập. Nếu không có `gh`, Mercury lưu một bản nháp cục bộ dưới thư mục cấu hình và chỉ đến trang issue của kho mã.

Bạn cũng có thể mở issue trực tiếp bằng mẫu báo lỗi, mẫu nhà cung cấp/mô hình hoặc mẫu yêu cầu tính năng. Hãy kèm đầu ra `--version`, hệ điều hành, terminal và các bước chính xác. Báo cáo lỗi và báo cáo nhà cung cấp cũng cần `mercury health --json`, hoặc `node dist/mercury.mjs health --json` đối với bản biên dịch từ mã nguồn. Bản ghi hội thoại (transcript) của màn hình gặp lỗi sẽ rất hữu ích.

Báo cáo các vấn đề bảo mật một cách riêng tư qua tab Security của kho mã. Đừng đưa chúng vào issue công khai. Xem [SECURITY.md](../../SECURITY.md). [CONTRIBUTING.md](../../CONTRIBUTING.md) trình bày về issue, pull request và các bước kiểm tra.

## Giấy phép

Mercury CLI được cấp phép theo Apache License 2.0 (`Apache-2.0`) trong [LICENSE.md](../../LICENSE.md). Các SDK TypeScript và Python trong [sdk/](../../sdk/) và [sdk-py/](../../sdk-py/) (`mercury-cli-sdk` trên npm và PyPI) cũng được cấp phép theo Apache License 2.0 (`Apache-2.0`), mỗi SDK theo tệp LICENSE đi kèm ([sdk/LICENSE](../../sdk/LICENSE) và [sdk-py/LICENSE](../../sdk-py/LICENSE)).

Việc sử dụng tên và nhãn hiệu Mercury tuân theo [chính sách nhãn hiệu](../../TRADEMARKS.md). Các giấy phép của bên thứ ba đi kèm được liệt kê trong [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
