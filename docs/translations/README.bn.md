[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI (mercury-cli.ai, npm প্যাকেজ `mercury-tech-cli`) আপনার টার্মিনালে AI কোডিং এজেন্ট চালায়, macOS, Linux ও Windows-এ আপনার নিজের git রিপোজিটরির ভেতরে।

ওয়েবসাইট: [mercury-cli.ai](https://mercury-cli.ai) · রিপোজিটরি: [github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI) (`Whq02/MercuryCLI`) · npm: `mercury-tech-cli`

একটি এজেন্ট ফাইল পড়ে ও সম্পাদনা করে, shell কমান্ড চালায়, টেস্ট ও ডিবাগারে ধাপে ধাপে এগোয়, এবং ফলাফল যাচাই করে। আপনি বেছে নেন মডেল প্রদানকারী, মডেল, এবং এজেন্ট কী করতে পারবে:

- **মাল্টি-সেশন Concourse ও আলাদা worktree:** Session Concourse-এ (`/concourse`) পাশাপাশি একাধিক সেশন চালান, এবং সমান্তরাল কাজ বিভিন্ন প্রদানকারীর crewmate-দের (`Crewmate`) হাতে দিন। তারা আলাদা `git worktree` চেকআউটে কাজ করে এবং প্রকল্পের ফাইল লিজ (project file leases) ব্যবহার করে, যাতে সমান্তরাল এজেন্টরা একে অপরের ফাইল ওভাররাইট না করে।
- **22টি মডেল প্রদানকারী, `/llmhost` ও `/localsetup`:** 22টি প্রদানকারীর সবগুলোতে একসঙ্গে সাইন ইন রাখুন (OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot/Kimi, Z.AI/GLM, OpenRouter, Hugging Face, xAI/Grok, Meta/Muse, Mistral, Nous Portal, OpenCode Zen, Qwen, MiniMax, Together AI, Cohere, Groq, Cerebras, Fireworks AI, Melious AI, OrcaRouter), এবং চ্যাটের মাঝখানেই প্রদানকারী ও মডেল বদলান। `/llmhost` খুলে একটি মডেল বেছে নিন, তার quantization, `conversations × context` ভাগ ও thinking লেভেল দেখুন, এবং সেটি ভাড়া করা GPU-তে (Runpod, Vast.ai বা Lambda), আপনার নিজের কম্পিউটারে (`mercury host`), অথবা বিদ্যমান কোনো সার্ভারে চালান। অথবা `/localsetup` চালিয়ে LM Studio, vLLM ও llama.cpp-এর পাশাপাশি Ollama ইনস্টল বা সংযুক্ত করুন।
- **Mneme হাইব্রিড RAG প্রকল্প মেমরি:** ডিভাইসে চলা 118 MB-এর BGE semantic embedding মডেল (`bge-base-en-v1.5`) ব্যবহার করে। সঙ্গে আছে BM25 শব্দ র‍্যাংকিং ও উদ্ধৃতি ট্র্যাকিং, হুবহু পিন করা নিয়ম, ব্রাঞ্চ-সচেতন শুরুর প্রসঙ্গ, লেখার সময় বিরোধ যাচাই, সেশনের হ্যান্ডঅফ নোট, এবং `/memory page` ব্রাউজার গ্রাফ।
- **কম্পাইলার, AST ও DAP ডিবাগিং টুল:** LSP কোড ইন্টেলিজেন্স ও পূর্বরূপ-সহ রিফ্যাক্টর (`LspRead`, `LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`), 23 ভাষার tree-sitter AST কাঠামোগত সার্চ ও রিরাইট (`AstSearch`, `AstEdit`), অন্তর্নির্মিত Debug Adapter Protocol (`Debug`) ডিবাগার (`debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`), যা ব্যর্থ Python, Node, Go ও Rust টেস্টের ভেতরে ধাপে ধাপে ঢুকতে দেয়, এবং স্থায়ী Python ও JavaScript `Eval` সেল।
- **কী ছাড়া `WebSearch` ও markdown `WebFetch`:** প্রদানকারীর নিজস্ব সার্চ, Brave বা Tavily কী, অফিশিয়াল API (Stack Exchange, npm, PyPI, crates.io, GitHub, Hacker News, Wikipedia), SearXNG ও কী ছাড়া DuckDuckGo-এর মাধ্যমে সার্চ করে, এবং 38,000 অক্ষরের কল বাজেটের মধ্যে পাবলিক ডকুমেন্টেশন markdown আকারে নিয়ে আসে।
- **ডেস্কটপ কম্পিউটার ব্যবহার, Whisper ভয়েস, Saturn শিডিউলিং ও এডিটর ব্রিজ:** ডেস্কটপ অ্যাপ্লিকেশন নিয়ন্ত্রণ করে (`Computer`)। push-to-talk ভয়েস ডিক্টেশন ডিভাইসেই Whisper দিয়ে লিখে দেয় (`/voice`)। Saturn দিয়ে পুনরাবৃত্ত বা একবারের সেশন শিডিউল করে (`/saturn`)। আর Agent Client Protocol-এর মাধ্যমে (`mercury acp`) VS Code-এর সঙ্গে যুক্ত হয়, পাশাপাশি Unity, Blender, Godot ও Aseprite-এর সঙ্গেও।
- **ভিডিও তৈরি (`Video`):** একটি কনফিগার করা MiniMax জেনারেটরে প্রম্পট ও প্রকল্পের রেফারেন্স ফাইল পাঠান ([docs/VIDEO.md](../VIDEO.md)), এবং তৈরি হওয়া MP4 ও 1-সেকেন্ডের অবস্থানের ঐচ্ছিক PNG প্রিভিউ ফ্রেম আপনার প্রকল্পে সংরক্ষণ করুন।

Mercury দিয়ে Mercury তৈরি করা হয়, দীর্ঘ কাজ জুড়ে একাধিক সেশন ও মডেল চালিয়ে। এই কাজের হিসাব রাখাই কঠিন অংশ: কী এখনও চলছে, কী বদলেছে, আর কোন বিষয়ে সিদ্ধান্ত দরকার। প্রতিটি সেশন শেষ হলে নিজের হ্যান্ডঅফ নোট লেখে। পরের সেশন শুরুতে আমার পিন করা নিয়মের সঙ্গে সেই নোটটি একবার পড়ে, যাতে সেশনের মাঝে প্রসঙ্গ দূষিত হওয়া (context poisoning) ঠেকানো যায়।

![সেশন বোর্ডে সমন্বয়কারীকে একটি প্রম্পট দিলে দুটি সেশন চালু হয়, প্রতিটি নিজের worktree-তে। একটি সম্পাদনার আগে জিজ্ঞেস করে, আর দুটিই পর্যালোচনার জন্য প্রস্তুত পরিবর্তন নিয়ে শেষ হয়](../media/session-board-stream.gif)

Mercury Apache License 2.0-এর অধীনে ওপেন সোর্স, এবং [sdk/](../../sdk/) ও [sdk-py/](../../sdk-py/)-এর SDK গুলোও তা-ই।

## ইনস্টল

Apple silicon ও Intel Mac, Linux x64 ও arm64, এবং Windows x64 ও arm64-এর জন্য রিলিজ আর্কাইভ পাওয়া যায়। `git` আলাদা করে ইনস্টল করুন; প্রতিটি আর্কাইভে Node ও ripgrep থাকে, তাই আলাদা Node ইনস্টল লাগে না।

একটি ইনস্টল পদ্ধতি বেছে নিন:

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS ও Linux (x64 ও arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows (x64 ও arm64), PowerShell 7-এ
brew install Whq02/mercury/mercury                 # Homebrew: macOS ও Linux x64
npm install -g mercury-tech-cli                    # npm; `bun install -g mercury-tech-cli` একই প্যাকেজ
mise use -g npm:mercury-tech-cli                   # mise, npm প্যাকেজের মাধ্যমে
```

ইনস্টলের ঠিকানাগুলো উৎস ও UTC দিন অনুযায়ী স্ক্রিপ্ট-অনুরোধের আনুমানিক সংখ্যা রাখে (সম্পন্ন ইনস্টল গোনা হয় না)। কাউন্টার কোনো IP ঠিকানা, user-agent স্ট্রিং বা cookie সংরক্ষণ করে না।

একটি নতুন টার্মিনাল খুলুন, অথবা shell ইনস্টলার যে `export PATH=…` লাইনটি দেখায় সেটি চালান। তারপর যাচাইয়ের জন্য `mercury --version` চালান, এবং একটি রিপোজিটরি থেকে `mercury` চালিয়ে [প্রথম চালানো](#প্রথম-চালানো) শুরু করুন। Windows PowerShell-এ, এবং Homebrew, npm, bun বা mise ইনস্টলের পরে, `mercury` একই টার্মিনালেই কাজ করে।

<details>
<summary>ইনস্টলের পথ, আপডেট ও রিলিজ যাচাই</summary>

### ইনস্টল পদ্ধতিগুলো কীভাবে আলাদা

shell ও PowerShell ইনস্টলার আপনার প্ল্যাটফর্মের সর্বশেষ রিলিজ নামিয়ে আনে, `SHA256SUMS.txt`-এর সঙ্গে এর SHA-256 মিলিয়ে দেখে, আর্কাইভটি খুলে ফেলে, এবং আর্কাইভের নিজস্ব `mercury install` কমান্ড চালায়।

Homebrew ও npm প্যাকেজ প্রতিটি একটি নির্দিষ্ট রিলিজে পিন করা থাকে এবং কোনো tag-এর পরে আবার প্রকাশিত হয়। তাই সর্বশেষ রিলিজের চেয়ে পিছিয়ে থাকতে পারে। Homebrew কমান্ডে পুরো tap নাম `Whq02/mercury/mercury` ব্যবহার হয় (শুধু `mercury` নামে `homebrew-core`-এ যা আছে তা আলাদা একটি প্রোগ্রাম)। npm প্যাকেজ `mercury-tech-cli` একটি লঞ্চার, যা তার পিন করা রিলিজ ডাউনলোড করে। mise একই প্যাকেজটিই ইনস্টল করে। `mercury install --uninstall` ইনস্টল করা রিলিজ ও কমান্ড shim সরিয়ে দেয়, তবে আপনার কনফিগারেশন ও সেশন রেখে দেয় (npm লঞ্চার ইনস্টল করে থাকলে `npm uninstall -g mercury-tech-cli`-ও চালান)।

Mercury-র ইনস্টলেশন ব্যবহারকারী-স্থানীয় (user-local), এর জন্য প্রশাসক অধিকার লাগে না। ইনস্টল কমান্ড আবার চালানো নিরাপদ।

### ইনস্টলের পথ

রিলিজের সংস্করণগুলো কনফিগ হোমের ভেতরে `~/.mercury/versions/<version>`-এ থাকে (Windows-এ `%USERPROFILE%\.mercury\versions`)। `mercury` কমান্ড macOS ও Linux-এ `~/.local/bin`-এ, অথবা Windows-এ `%LOCALAPPDATA%\Mercury\bin`-এ ইনস্টল হয়।

`mercury install` কমান্ডের ডিরেক্টরি PATH-এ একবার যোগ করে: আপনার shell স্টার্টআপ ফাইলে একটি সুরক্ষিত লাইন, অথবা Windows ব্যবহারকারীর PATH-এ একটি এন্ট্রি হিসেবে। নতুন টার্মিনাল পরিবর্তনটি স্বয়ংক্রিয়ভাবে ধরে নেয়।

### আপডেট

যেকোনো ইনস্টল পদ্ধতিতে `mercury update` ব্যবহার করুন।

shell বা PowerShell ইনস্টলার, অথবা `mercury install` দিয়ে করা ইনস্টলে এটি Mercury-কে একই জায়গায় আপডেট করে। `--check` আপডেট আছে কিনা দেখে, `--status` আপডেটের অবস্থা জানায়, আর `--rollback` আগের সংস্করণে ফিরিয়ে নেয়; সেই সংস্করণটি ডিস্কেই থেকে যায়।

Homebrew-এর ক্ষেত্রে `brew upgrade Whq02/mercury/mercury` চালানোর আগে এটি জিজ্ঞেস করে। ডিফল্ট উত্তর না; অনুমোদন দিতে `y` লিখুন। Mercury কমান্ডের আউটপুট সরাসরি দেখায় এবং পরে ইনস্টল করা সংস্করণ যাচাই করে। স্ক্রিপ্টে প্রশ্ন এড়াতে `--yes` ব্যবহার করুন।

npm লঞ্চার ইনস্টলারের মতো একই রিলিজ-কাঠামো ব্যবহার করে এবং প্রতিটি রান ইনস্টল করা রিলিজের হাতে তুলে দেয়। তাই `mercury update` Mercury-র নিজস্ব আপডেট চ্যানেলের মাধ্যমে npm ইনস্টলেশনকেও একই জায়গায় আপডেট করে। `npm update -g mercury-tech-cli` শুধু প্যাকেজটি প্রথম রানে যে রিলিজ ইনস্টল করে সেটি বদলায়। mise ব্যবহার করলেও একই কথা প্রযোজ্য।

`--check` সব ইনস্টল পদ্ধতির জন্য একই রিলিজ তালিকা পড়ে এবং আপনার ইনস্টল কীভাবে আপডেট করবেন তা জানায়। আপডেট পাওয়া গেলে হোম স্ক্রিনের নিচের ডান কোণে একবার `vX.Y.Z available · mercury update` দেখা যায়, এবং আপডেট না করা পর্যন্ত চ্যাটে একই নোটিশ দেখা যায়। দুটিই লুকাতে `MERCURY_UPDATE_NOTICE=0` সেট করুন।

ইনস্টল ও আপডেটের অনুরোধ অজ্ঞাতনামাভাবে পাবলিক রিলিজ তালিকা ও আর্কাইভ নামিয়ে আনে। অ্যাকাউন্ট বা token ছাড়াই এগুলো চালাতে পারেন। অজ্ঞাতনামা অনুরোধ প্রত্যাখ্যাত হলে Mercury সাইন-ইন করা GitHub CLI (`gh`) দেখে।

আপডেটের পরে Mercury যাচাই করে PATH-এর কমান্ডটি আপডেট করা ইনস্টলেশনের দিকে নির্দেশ করছে কিনা। অন্য কোনো ইনস্টল অগ্রাধিকার পেলে, অথবা আপডেট করা কমান্ড PATH-এ না থাকলে, এটি সমস্যা ও সমাধান ব্যাখ্যা করে। `mercury health` একই সমস্যা জানায়।

### রিলিজ যাচাই

একটি রিলিজ সক্রিয় করার আগে Mercury তার আর্কাইভ `SHA256SUMS.txt`-এর সঙ্গে মিলিয়ে দেখে। আপডেট প্রস্তুত করার আগে এটি এমন একটি payload-ও দাবি করে, যেটি Mercury-র সংকলিত ট্রাস্ট তালিকায় থাকা রিলিজ কী দিয়ে স্বাক্ষরিত। প্রত্যাখ্যাত স্বাক্ষর সক্রিয় ইনস্টলেশনকে অপরিবর্তিত রাখে।

অস্বাক্ষরিত payload গ্রহণ করতে `--allow-unsigned` ব্যবহার করুন। তবুও Mercury অজানা স্বাক্ষর কী, ত্রুটিপূর্ণ স্বাক্ষর ব্লক এবং বদলানো বিষয়বস্তু প্রত্যাখ্যান করে। কমান্ডের ফলাফল ও তার স্থানীয় রেকর্ড, দুটিতেই দেখা যায় যে আপনি অস্বাক্ষরিত payload অনুমোদন করেছিলেন।

রিলিজ আর্কাইভগুলো স্বাক্ষরিত। ইনস্টল করা রিলিজের স্বাক্ষর দেখতে `mercury health` চালান।

রিলিজের স্বাক্ষর ছাড়া কোনো আর্কাইভকে অস্বাক্ষরিত হিসেবে চিহ্নিত করা হয়। `--allow-unsigned` না দিলে ইনস্টল ও আপডেট সেটি প্রত্যাখ্যান করে।

[docs/TRUST.md](../TRUST.md) যাচাইয়ের ফলাফল এবং আর্কাইভ নিজে হাতে যাচাই করার পদ্ধতি ব্যাখ্যা করে। [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) শুরুর যাচাই নিয়ে আলোচনা করে।

### প্ল্যাটফর্মের নোট

উপরে তালিকাভুক্ত প্রতিটি প্ল্যাটফর্মের জন্য রিলিজ আর্কাইভ আছে। অন্য যেকোনো মেশিনের জন্য সোর্স থেকে বিল্ড করতে হয়।

Intel Mac-এর জন্য রিলিজ আর্কাইভ পাওয়া যায়।

</details>

## প্রয়োজনীয়তা

রিলিজ আর্কাইভে Node 24 LTS অন্তর্ভুক্ত থাকে। লঞ্চার, `mercury install` ও `mercury update` সেই সঙ্গে থাকা runtime ব্যবহার করে; রিলিজের জন্য শুধু `git` আলাদা প্রয়োজন।

সোর্স থেকে বিল্ড করতে আপনার লাগবে:

- **Node 24 LTS**, সমর্থিত পরিসর `>=24.20.0 <25`-এর মধ্যে। `.node-version` বিল্ডের জন্য ব্যবহৃত প্যাচ সংস্করণটি পিন করে, যেটি রিলিজ আর্কাইভেও অন্তর্ভুক্ত থাকে।
- **bun 1.4.4**, বিল্ডের জন্য। এটি রিলিজের সঙ্গে আসে না।
- **git**। Windows-এ Windows Terminal বা VS Code টার্মিনালের ভেতরে PowerShell 7 চালান। দেখুন [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md)।

Node-এর ন্যূনতম সংস্করণে nodejs/node#56645-এর ফিক্স অন্তর্ভুক্ত। 24.20.0-এর নিচে Windows-এ, কোনো টুল ডাকে এমন headless `run` কমান্ড প্রস্থান করার সময় বাতিল (abort) হয়ে যায়।

লঞ্চার এই ক্রমে Node বেছে নেয়: স্পষ্টভাবে নির্দিষ্ট `MERCURY_NODE` বাইনারি, সঙ্গে থাকা runtime, তারপর PATH-এ একটি উপযুক্ত Node ইনস্টলেশন। runtime না থাকলে লঞ্চার একটি ত্রুটি জানায়।

### Windows-এর শেল

রিলিজ আর্কাইভে Mercury-র bash-সামঞ্জস্যপূর্ণ shell engine (`brush`) অন্তর্ভুক্ত থাকে। Windows-এ এটিই ডিফল্টভাবে Bash টুল চালায়: `.cmd` বা `.bat` প্রোগ্রাম (যেমন `npm`) PATHEXT-এর মাধ্যমে শুধু নাম দিয়েই খুঁজে পায়, `%VAR%` ও `^`-কে কোনো পরিবর্তন ছাড়াই batch ফাইলে পাঠায়, `cd`-এর পরে আপেক্ষিক পথে নির্দিষ্ট প্রোগ্রাম চালায়, এবং কলের মধ্যে shell-এর অবস্থা ধরে রাখে। Git for Windows-এর `bash.exe` লাগে না। ইনস্টল থাকলে `MERCURY_SHELL_ENGINE=system` সেট করুন, অথবা `system` বেছে নিন `/config`-এর Shell engine-এ; তখন Bash টুল শুধু `bash.exe`-এ চলে।

কোন shell সক্রিয় এবং কেন, তা জানতে স্বাস্থ্য পরীক্ষার `shell` সারিটি পড়ুন: সঙ্গে আসা engine (Windows-এর ডিফল্ট, অথবা pin বা সেটিং দিয়ে সক্রিয় করা), অথবা engine বন্ধ থাকলে বা তার pack না থাকলে Git Bash।

macOS ও Linux-এ সিস্টেমের shell-ই ডিফল্ট। সেখানেও সঙ্গে আসা engine-এ Bash টুল চালাতে, এবং স্থায়ী shell অবস্থা পেতে `MERCURY_SHELL_ENGINE=brush` সেট করুন, অথবা `brush` বেছে নিন `/config`-এর Shell engine থেকে।

engine pack বা Git for Windows ছাড়া সোর্স বিল্ড তবুও শুরু হয়, কিন্তু Bash টুল পাওয়া যায় না। PowerShell টুল উপলব্ধ থাকে, এবং `shell` ডায়াগনস্টিক Bash সমর্থন ফিরিয়ে আনার উপায় বলে দেয়।

## সোর্স থেকে বিল্ড

Mercury bun দিয়ে বিল্ড হয় এবং Node 24 LTS-এ চলে। bun 1.4.4-সহ [সোর্স-বিল্ডের প্রয়োজনীয়তা](#প্রয়োজনীয়তা) ইনস্টল করুন:

```sh
curl -fsSL https://bun.com/install | bash -s -- bun-v1.4.4           # macOS ও Linux
powershell -c "& ([scriptblock]::Create((irm https://bun.com/install.ps1))) -Version 1.4.4"       # Windows, PowerShell 7-এ
bun --version                                      # 1.4.4
```

এরপর এই রিপোজিটরির একটি ক্লোনে:

```sh
bun run setup                      # একবার; bun install + সঙ্গে থাকা packs
bun run build.ts                   # dist/mercury.mjs ও dist/manifest.json লেখে
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### টার্মিনাল সমর্থন

ফুল-স্ক্রিন ইন্টারফেসের জন্য একটি সত্যিকারের TTY দরকার, তবে টার্মিনালের ন্যূনতম আকার নির্ধারিত নেই। পূর্ণ লেআউট শুরু হয় 100 কলাম বাই 26 সারি থেকে; ছোট উইন্ডোতে একটি সংক্ষিপ্ত লেআউট ব্যবহৃত হয়।

টার্মিনাল `COLORTERM=truecolor`-এর মাধ্যমে সমর্থন ঘোষণা করলে, অথবা iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal বা VS Code হিসেবে চিহ্নিত হলে, Mercury 24-bit রং ব্যবহার করে। অন্য টার্মিনালে 256 রং ব্যবহৃত হয়, macOS 15 ও তার আগের সংস্করণের Apple-এর Terminal-সহ।

স্বাস্থ্য পরীক্ষার Terminal color সারিতে শনাক্ত করা গভীরতা ও তার কারণ দেখানো হয়। যে টার্মিনাল true colour সমর্থন করে কিন্তু তা ঘোষণা করে না, তার জন্য `MERCURY_TRUECOLOR=1` সেট করুন; আর 256 রং জোর করে চালাতে `MERCURY_TRUECOLOR=0` সেট করুন।

### ঐচ্ছিক উপাদান

`setup` সঙ্গে থাকা capability packs নামিয়ে আনে: pyright, debugpy, js-debug, অতিরিক্ত গ্রামার (grammars), প্ল্যাটফর্মের Node runtime, এবং brush। কোনো ডাউনলোড ব্যর্থ হলে সেই pack বাদ যায়, আর বিল্ড ও প্রভাবিত টুল অনুপস্থিত উপাদানটির কথা জানায়। শুধু `bun install` চালালে এই packs ছাড়া একটি বিল্ড তৈরি হয়।

voice সমর্থন তৈরি করতে Rust ইনস্টল থাকা অবস্থায় `setup` চালান। এতে `native/voice` তৈরি হয়। `native/whisper`-ও বানাতে cmake যোগ করুন। Rust ইনস্টল থাকলে `setup` desktop driver addon (`native/desktop`)-ও বানায়, যার মাধ্যমে `Computer` টুল কাজ করে। এছাড়া Rust ইনস্টল থাকলে `setup` লোকাল embedding addon (`native/embed`, `bun run scripts/vendor/build-embed.ts`)-ও বানায় এবং 118 MB BGE মডেল (`bun run scripts/vendor/fetch-embed-models.ts --default`) নামিয়ে আনে। cargo ছাড়া pack বাদ যায়, setup সে কথা জানায়, এবং Mneme মেমরি খোঁজে শুধু শব্দ-মিল ব্যবহৃত হয়। প্রতিটি রিলিজ আর্কাইভে তার প্ল্যাটফর্মের জন্য বানানো embedding pack থাকে। Linux ও Windows-এ গণনা একটি vectorised kernel-এ চলে, তাই অর্থের ভিত্তিতে Recall প্রায় এক-দশমাংশ সেকেন্ড নেয় (macOS-এ, যেখানে Accelerate ব্যবহৃত হয়, কয়েক শতাংশ সেকেন্ড)। নেটিভ বিল্ডে টুল না থাকলে setup সেটি বাদ দেয় এবং স্বাস্থ্য পরীক্ষা অনুপস্থিত addon-এর কথা জানায়। Windows shell engine-ও আপনার মেশিনে কম্পাইল হয়, কারণ upstream-এ কোনো Windows binary নেই।

`brush` shell engine-এর জন্য [Windows-এর শেল](#windows-এর-শেল) ও [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) দেখুন।

বিল্ড শুধু `dist/`-এ লেখে। কনফিগারেশন ও সেশন থাকে `~/.mercury`-এ, অথবা `MERCURY_CONFIG_DIR` দিয়ে সেট করা ডিরেক্টরিতে; প্রথম চালানোর সময় এগুলো তৈরি হয়। Windows-এ সরাসরি `node dist\mercury.mjs` চালান।

### সোর্স বিল্ডকে কমান্ড হিসেবে ইনস্টল করা

`scripts/ops/deploy-runtime.sh` একটি ক্লিন-ট্রি বিল্ডকে নতুন `<config home>/runtime/builds/<build>` ফোল্ডারে প্রকাশ করে এবং `runtime/current`-কে সেটির দিকে নির্দেশ করে (`runtime/dist` একই লিংকের পুরোনো নাম)। `scripts/ops/deploy-launcher.sh` লঞ্চারটি `<config home>/bin/mercury`-তে ইনস্টল করে। ওই ডিরেক্টরিটি PATH-এ যোগ করুন; zsh-এর জন্য:

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

runtime না থাকলে লঞ্চার একটি ত্রুটি দিয়ে থেমে যায়। সে অন্য বিল্ডে সরে যায় না। Node বাছাই [প্রয়োজনীয়তা](#প্রয়োজনীয়তা)-য় উল্লেখিত ক্রম মেনে চলে। রিলিজ ইনস্টলেশনের জন্য `mercury install` বা `mercury update` চালান; এগুলো সোর্স চেকআউট অপরিবর্তিত রাখে। দেখুন [আপডেট](#আপডেট)।

[AGENTS.md](../../AGENTS.md) হলো বিল্ড ও চালানোর সংক্ষিপ্ত নির্দেশিকা। [BUILD-NOTES.md](../../BUILD-NOTES.md) বিল্ড নিয়ে আরও বিস্তারিত বলে।

## প্রথম চালানো

প্রথম ইন্টারঅ্যাকটিভ চালানোয় একটি appearance বেছে নিন, তারপর একটি প্রদানকারীতে সাইন ইন করুন। ব্রাউজ করার সময় স্ক্রিন থিমের পরিবর্তন আগেভাগে দেখায়। True Black ডিফল্ট; অন্য দুটি বিকল্প হলো oasis dark থিম এবং Black and white, যেটি কোনো রং আঁকে না: টার্মিনালের নিজস্ব কালি তার নিজস্ব জমিতে, অর্থাৎ রং-বিহীন টার্মিনালে Mercury যেভাবে দেখায়। পরে `/appearance` দিয়ে এটি বদলাতে পারবেন।

একটি অ্যাকাউন্ট যুক্ত না করে ঘুরে দেখতে "sign in later" বেছে নিতে পারেন। আপনার পরিবেশে থাকা কোনো প্রদানকারীর key যদি আগে থেকেই একটি প্রদানকারীকে সাইন ইন করে রাখে, তবে সাইন-ইন ধাপটি আর জিজ্ঞেস করা হয় না। এরপর Guardrails ধাপ আপনাকে মনে করিয়ে দেয় Mercury-র সম্পাদনা ও কমান্ড যাচাই করতে, এবং Mercury যা পড়ে তাতে মডেলের জন্য নির্দেশ থাকতে পারে। Mercury যেসব টার্মিনাল কনফিগার করতে জানে (Terminal.app, VS Code পরিবার, Alacritty, Zed), সেখানে একটি Terminal keys ধাপ টার্মিনালের নিজের সেটিংয়ে নতুন-লাইনের keybinding বসাতে পারে। macOS-এর Terminal.app-এ এটি newline-এর জন্য `Option+Enter` সেট করে এবং সব প্রোফাইলে টার্মিনালের বেল বন্ধ করে; Terminal.app পুনরায় চালু করার পরে এটি কার্যকর হয়। VS Code পরিবার, Alacritty ও Zed-এ এটি newline-এর জন্য `Shift+Enter` লেখে। আপনি না বাছলে এটি বন্ধ থাকে, এবং একটি ব্যাকআপ রাখা হয়।

এরপর Mercury জিজ্ঞেস করে আপনি যে ফোল্ডারটি খুলেছেন তাতে আস্থা রাখেন কিনা। ওয়ার্কস্পেস কনফিগারেশনের চাওয়া কোনো কিছুই এই আস্থা দেওয়ার আগে চলে না। এই অনুমতি পুরো রিপোজিটরিকে ঢেকে দেয়; প্রত্যাখ্যান করলে Mercury বন্ধ হয়ে যায়। দেখুন [docs/TRUST.md](../TRUST.md)।

সাধারণ ইন্টারঅ্যাকটিভ চালু হলে হোম স্ক্রিন খোলে। সেখানে দশটি মেনু এন্ট্রি থাকে; Continue Last Session শুধু সেশনের ইতিহাস থাকলে দেখা যায়:

- **New Session in \<folder\>** বর্তমান ফোল্ডারে একটি নতুন সেশন শুরু করে।
- **Continue Last Session** আপনার সবচেয়ে সাম্প্রতিক চ্যাটে ফিরিয়ে আনে।
- **Boot Menu** পরবর্তী সেশনগুলো কনফিগার করে, এর মধ্যে motion, crewmate ও workflow-ও আছে।
- **MCPs & Skills** ঠিক করে পরের সেশনে কী লোড হবে। দেখুন [docs/KIT.md](../KIT.md)।
- **Agents** এজেন্ট তৈরি ও সম্পাদনা করে।
- **Health Check** ইনস্টলেশন যাচাই করে।
- **Saturn Scheduler** সেশন শিডিউল করে। দেখুন [docs/SATURN.md](../SATURN.md)।
- **Logins** প্রদানকারীর অ্যাকাউন্ট সংযুক্ত করে।
- **Session Concourse** বর্তমান প্রকল্পের সেশন তালিকা খোলে।
- **Sessions · Projects** একটি সেশন বা রিপোজিটরি বেছে নিতে দেয়।

মেনু এন্ট্রিগুলো হোম স্ক্রিনের ওপরে খোলে, এবং `Esc` আপনার বাছাই করা এন্ট্রিতে ফিরিয়ে আনে। সেশন তালিকা আলাদা একটি স্ক্রিনে খোলে, যা `Shift+→` দিয়েও পাওয়া যায়। একটি prompt আর্গুমেন্ট, `--continue` বা `--resume` সরাসরি চ্যাটে নিয়ে যায়।

### Motion, crewmate ও workflow

Boot Menu-এর Performance বিভাগে একটি Motion সেটিং আছে: `auto`, `full`, `reduced` বা `off`। এটি ইন্টারফেসের নিষ্ক্রিয় অবস্থার অ্যানিমেশন নিয়ন্ত্রণ করে এবং `/config`-এও পাওয়া যায়।

Agents-এর অধীনে Crewmates ও Workflows সুইচ ঠিক করে নতুন সেশন Crewmate ও Workflow টুল পাবে কিনা। কোনো সুইচ বন্ধ করলে সংশ্লিষ্ট টুল সরে যায়; সেই ধরনের কাজ শুরু করার চেষ্টা একই ব্যাখ্যা ফেরত দেয়। সেশনের ভেতরে `/crewmates on|off` ও `/workflows on|off` পরের টার্ন-সীমায় সেটিং বদলায়।

## দৈনন্দিন কাজের ধারা: Session Concourse, git worktree ও crewmate

### সেশন শুরু ও worktree আলাদা রাখা

বর্তমান ফোল্ডারে আপনার ডিফল্ট মডেল দিয়ে একটি সেশন তৈরি করতে New Session-এ `Enter` চাপুন। Mercury চ্যাট খোলে এবং একই সঙ্গে সেশন তালিকায় যোগ করে। শুরুর কাজ কমাতে এটি মেনুর পেছনে একটি প্রক্রিয়া প্রস্তুত রাখে।

আরেকটি সেশন শুরু করলে আগেরটি থামে না। একটি কাজ চালু রেখে অন্য জায়গায় কাজ করতে পারেন। একটি সেশনকে নিজস্ব branch ও checkout দিতে `--worktree [name]` দিয়ে চালান (অথবা চ্যাটে `worktree` চেয়ে `EnterWorktree` চালান); সেটি `.mercury/worktrees/`-এর অধীনে থাকে। সমান্তরাল crewmate-রাও আলাদা worktree-তে চলতে পারে এবং প্রকল্পের ফাইল লিজের মাধ্যমে শেয়ার্ড ফাইল সমন্বয় করতে পারে; দেখুন [ভেতরে কী আছে](#ভেতরে-কী-আছে-mneme-rag-memory-lsp-23-ভাষার-ast-dap-debugger-ওয়েব-সার্চ-ও-ব্রিজ) ও [docs/CREW.md](../CREW.md)।

### চ্যাটে কাজ করা

কাজটি সহজ ভাষায় বর্ণনা করুন। আপনার বেছে নেওয়া অনুমতি মোডের অধীনে এজেন্ট কোড পড়ে, সম্পাদনা করে, চালায় ও যাচাই করে। টুল কল চলার সময়ই দেখা যায়, হয় সংক্ষিপ্ত কার্ড আকারে, নয়তো পূর্ণ আউটপুটসহ। প্রদর্শন বেছে নিতে `/config`-এর Tool output-এ যান; সেটিং পরের চালানোর জন্যও সংরক্ষিত থাকে।

সেশন ঠিক করতে `/model` ও `/effort` ব্যবহার করুন। `/permissions` ঠিক করে কোনটি অনুমোদন ছাড়া চলতে পারবে, আর কোনটির আগে জিজ্ঞেস করতে হবে।

`/diff` দিয়ে পরিবর্তন পর্যালোচনা করুন, উৎস, ফাইল ও hunk অনুযায়ী। `! <command>` চ্যাটের ভেতরে একটি shell কমান্ড চালায় এবং আউটপুটের শেষ অংশ সরাসরি দেখায়। `/runs` চলমান shell ও crewmate দেখায় (`/tasks` একই বোর্ড খোলে), এবং `/crewmates` খোলে লাইভ Crew ভিউ। টার্নের মাঝে `/clear` বর্তমান চ্যাট সংরক্ষণ করে একটি নতুন সেশন খোলে, আর `/restart` চ্যাটটিকে সদ্য ইনস্টল করা Mercury বিল্ডে সরিয়ে নেয়। `/title` চ্যাটের নাম দেয়, এবং `/help` উপলব্ধ কমান্ডের তালিকা দেখায়।

### স্ক্রিনের মধ্যে চলাফেরা

`Shift+←` ও `Shift+→` এখন উপলব্ধ স্ক্রিনগুলোর মধ্যে সরায়। নতুন চালু হলে হোম স্ক্রিন ও সেশন তালিকা থাকে। কোনো সেশনে ফোকাস করলে চ্যাট স্ক্রিন যোগ হয়, আর শেষ চ্যাটটি বন্ধ হলে সরে যায়। কী-হিন্ট শুধু উপলব্ধ সরানোর দিকগুলো দেখায়।

সব চ্যাট বন্ধ করলে আপনি হোম স্ক্রিনে ফিরে যান। শুধু হোম স্ক্রিন ও চ্যাট দেখতে, সেশন তালিকা ছাড়া, `--chat` ব্যবহার করুন। `--concourse-off` এই পছন্দটি পরবর্তী চালানোর জন্য সংরক্ষণ করে; `--concourse-on` বা `/config` এটি আবার চালু করে।

### Session Concourse-এ সেশন পরিচালনা

হোম স্ক্রিন থেকে `/concourse` বা `Shift+→` দিয়ে সেশন তালিকা খুলুন। এতে প্রথমে বর্তমান প্রকল্পের চলমান সেশনগুলো দেখায়, তারপর চালু নেই এমন সংরক্ষিত চ্যাট, নতুনগুলো আগে।

প্রতিটি চলমান সেশনের একটি NOW ঘর থাকে, যেখানে তার বর্তমান কাজ দেখা যায়। একটি সারি বেছে `Enter` চাপলে চ্যাটে ফিরে যান, এবং বাকি সেশনগুলো চলতে থাকে। যে সেশন ক্র্যাশ করে, সেটি কারণসহ NEEDS YOU হিসেবে সেশন তালিকায় থাকে, যতক্ষণ না আপনি সেটি ছেড়ে দেন।

সেশনের জীবনচক্র নিয়ে আলোচনা আছে [docs/SESSIONS.md](../SESSIONS.md)-এ।

## মডেল প্রদানকারী ও মডেল: সাইন-ইন, `/localsetup` ও `/llmhost`

কোনো প্রদানকারী সংযুক্ত করতে `/logins` ব্যবহার করুন। এটি সেটআপের সময় ব্যবহৃত একই সাইন-ইন তালিকা খোলে। পরে `/accounts` সংযুক্ত প্রদানকারীর স্লট পরিচালনা করে।

- **OpenAI:** ChatGPT সাবস্ক্রিপশন বা API key।
- **Anthropic:** Claude সাবস্ক্রিপশন, Console সাইন-ইন বা API key।
- **OpenRouter:** OAuth বা API key দিয়ে ক্যাটালগ অ্যাক্সেস; মডেল অনুরোধ ডেটা সংগ্রহ নাকচ করে এবং শুরু থেকেই প্রতিটি প্যারামিটার বাধ্যতামূলক করে। `/config → OpenRouter routing policy` fallback ও zero-data-retention পছন্দ ঠিক করে; নীতি শিথিল করতে ও রাউটিং OpenRouter-এর হাতে ছাড়তে open বেছে নিন।
- **Google Gemini:** Sign in with Google, একটি API key, অথবা আপনার নিজের OAuth client। Sign in with Google Gemini চালায় Google অ্যাকাউন্টের প্ল্যানের কোটায় (বিনামূল্যের অ্যাকাউন্ট, Google AI Pro বা Google AI Ultra), Google-এর নিজস্ব Antigravity client-এর মাধ্যমে: prompt, টুল স্কিমা ও টুল ফলাফল সেই client ও সাইন-ইন করা অ্যাকাউন্টের অধীনে Google-এর Code Assist endpoint-এ যায়, এবং `/model` দেখায় Google এই অ্যাকাউন্টকে কোন মডেলের তালিকা দেয়। API key বা আপনার নিজের OAuth client-এ বিল হয় একটি Cloud প্রকল্পে।
- **Hugging Face:** device-code সাইন-ইন বা Hub token।
- **Kimi (Moonshot):** device-code সাইন-ইন বা API key।
- **GLM (Z.AI):** একটি GLM Coding Plan সাবস্ক্রিপশন key বা সাধারণ pay-as-you-go API key। `/logins zai` দুটির যেকোনোটি সংরক্ষণ করে এবং প্ল্যানটি রেকর্ড করে; `ZAI_API_KEY`-ও কাজ করে, এবং `ZAI_KEY_PLAN=coding|general` প্ল্যানটির নাম দেয় (সেট না থাকলে Mercury key-র নিজের মডেল তালিকা থেকে তা পড়ে)।
- **DeepSeek:** DeepSeek প্ল্যাটফর্মের একটি API key (`/logins deepseek`, অথবা `DEEPSEEK_API_KEY`)।
- **xAI (Grok):** আপনার Grok সাবস্ক্রিপশন (SuperGrok / X Premium) দিয়ে সাইন ইন করুন, অথবা `/logins xai`-এর মাধ্যমে একটি API key পেস্ট করুন।
- **Meta (Muse):** Sign in with Meta (একটি Muse Code সাবস্ক্রিপশন, আপনার ব্রাউজারে একটি device code) অথবা pay-as-you-go Model API key। Sign in with Meta Muse Code-এর public client id-র অধীনে Meta-র OIDC endpoint-এ (`https://auth.meta.com/oidc/device/authorization/` ও `/oidc/device/token/`) device code বিনিময় করে; প্রাপ্ত অ্যাকাউন্ট token একবার `https://api.meta.ai/muse-code/key`-এ পাঠায় সাবস্ক্রিপশনের API key তৈরি করতে (এবং প্ল্যানের স্তর ও ব্যবহারের উইন্ডো জানতে সীমিত `/usage` পাঠে), আর প্রতিটি মডেল অনুরোধে শুধু তৈরি হওয়া key-টি `https://api.meta.ai/v1`-এ পাঠায়। পেস্ট করা Model API key বা `MODEL_API_KEY` / `META_API_KEY` pay-as-you-go হিসেবে বিল হয়।

- **Qwen:** একটি QwenCloud key (Token Plan বা pay-as-you-go) অথবা একটি Alibaba Cloud Model Studio key (pay-as-you-go, Token Plan বা Coding Plan), যা সংরক্ষণের আগে নিজস্ব endpoint-এ যাচাই হয়; প্ল্যানের key প্ল্যানের মডেলগুলো দেখায়, Qwen3.8 Max প্রথমে।
- **MiniMax:** একটি Open Platform key বা একটি M Plan সাবস্ক্রিপশন key।
- **Together AI** ও **Cohere:** API key।
- **Groq**, **Cerebras** ও **Fireworks AI:** API key; যেকোনো পরিবারের key `credentials.keyCommands.<family>`-তে নাম দেওয়া একটি কমান্ড থেকেও আসতে পারে।

Mistral, Nous Portal ও OpenCode Zen-ও `/logins`-এর মাধ্যমে সংযুক্ত হয়; মোট সাইন-ইন প্রদানকারী পরিবার হয় 22টি। স্থানীয় মডেল সার্ভার (Ollama, LM Studio, vLLM ও llama.cpp) এবং কাস্টম OpenAI-সামঞ্জস্যপূর্ণ endpoint কোনো প্রদানকারীর সাইন-ইন ছাড়াই কাজ করে। Ollama ইনস্টল বা চালু করতে, আপনার মেমরিতে ধরে এমন একটি মডেল আনতে, তার context window সেট করতে, অথবা চালু থাকা LM Studio, vLLM বা llama.cpp সার্ভারের সঙ্গে যুক্ত হতে `/localsetup` চালান ([docs/LOCAL-SETUP.md](../LOCAL-SETUP.md))। প্রতিটি প্রদানকারী নিজস্ব প্রোটোকল, credential ও ত্রুটি হ্যান্ডলিং ব্যবহার করে, এবং অনুরোধ কখনো অন্য প্রদানকারীতে ফিরে যায় না। দেখুন [docs/ENGINES.md](../ENGINES.md)।

`/llmhost` আপনি যে মডেলগুলো হোস্ট করতে পারেন তার তালিকা দেখায় এবং এখন কোথায় চলতে পারে তা জানায়: Runpod, Vast.ai বা Lambda থেকে ভাড়া করা GPU-তে, আপনার নিজের কম্পিউটারে বা সংরক্ষিত SSH কম্পিউটারে (`mercury host`), অথবা বিদ্যমান মডেল সার্ভারে। প্রতিটি মডেল পাতায় quantization বিকল্প, GPU মেমরির বাজেট সমান্তরাল কথোপকথনে কীভাবে ভাগ হয় (`conversations × context`), এবং ডিফল্ট thinking লেভেল দেখায় (যা `/effort` প্রতি অনুরোধে বদলায়)। GPU ভাড়ার জন্য ঘণ্টার দাম নিশ্চিত করতে হয়, আর পপআপ বন্ধ করলেও setup পটভূমিতে চলতে থাকে। Runpod-এ ভাড়া নেওয়ার আগে বা চালু থাকা pod-এ গুণমান, context ভাগ ও thinking-ও ঠিক করা যায় (`Tune`), weight দ্রুত-লোড হওয়া volume-এ রাখা যায় এবং 5 সেকেন্ডের স্টক ওয়াচ সেট করা যায়। Vast.ai ও Lambda ভাড়া 1.0.0-beta.40-এ নতুন, এবং বিক্রেতাদের প্রকাশিত API-এর বিপরীতে fixtures ব্যবহার করে যাচাই করা হয়েছে (সরাসরি ভাড়া নিয়ে চালানো হয়নি)। দেখুন [docs/LLM-HOST.md](../LLM-HOST.md)।

নতুন সেশন আপনার সবচেয়ে সাম্প্রতিক সংযুক্ত প্রদানকারী এবং ওই অ্যাকাউন্টের জন্য উপলব্ধ সর্বশেষ মডেল ব্যবহার করে। অ্যাকাউন্ট যে মডেলে প্রবেশ করতে পারে না, সেগুলো এড়িয়ে যাওয়া হয়। ওই প্রদানকারীর কোনো ব্যবহারযোগ্য মডেল না থাকলে Mercury পরের সবচেয়ে সাম্প্রতিক সংযুক্ত প্রদানকারী যাচাই করে। এই বাছাই সেশন শুরুর সময় হয়; বিদ্যমান সেশনে ব্যর্থ অনুরোধ তার প্রদানকারীর সঙ্গেই থাকে।

`/model` বাছাইটি ব্যাখ্যা করে। একটি পরিবারের নাম সেই পরিবারের সর্বশেষ মডেল বেছে নেয়: `/model grok`, `/model deepseek`, `/model kimi` বা `/model glm`। কোনো প্রদানকারী সংযুক্ত না থাকলে হোম স্ক্রিন ও `/model` আপনাকে `/logins`-এ পাঠায়। `/defaultprovider` দিয়ে কোনো প্রদানকারীকে স্পষ্টভাবে সবচেয়ে সাম্প্রতিক বাছাই বানানো যায়।

প্রদানকারীর অ্যাক্সেস তার নিজস্ব শর্ত ও প্রাপ্যতার অধীনে থাকে। Mercury-র লাইসেন্স সেই শর্তের জায়গা নেয় না।

## হেডলেস CLI: `mercury run`, Docker ও JSON-RPC runner

একই বিল্ডটি ইন্টারঅ্যাকটিভ ইন্টারফেস ছাড়াই চলে। `node dist/mercury.mjs --help` প্রতিটি flag তালিকাভুক্ত করে।

`mercury run "<prompt>"` টার্মিনাল UI ছাড়াই একটি prompt চালায়:

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` উত্তর প্রিন্ট করে; ব্যর্থ টার্নের কারণ stderr-এ যায়।
- `json` শেষ `outcome` সারিটি একটি JSON অবজেক্ট হিসেবে প্রিন্ট করে।
- `rows` প্রতি লাইনে একটি JSON অবজেক্ট লেখে: `session`, তারপর একটি `turn` ও তার `text`, `reasoning`, `tool_call`, `tool_result` ও `step` সারি, এবং শেষে `outcome`। অপেক্ষা, টুলের অগ্রগতি, ব্যাকগ্রাউন্ড টাস্ক ও নোটিশের নিজস্ব সারি আছে। প্রতিটি সারিতে `seq`, `timestamp` ও `session_id` থাকে; একটি টার্নের ভেতরের সারিতে তার `turn` নম্বরও থাকে। `seq` এই রানের স্ট্রিম 1 থেকে গোনে, আর `turn` সেশনের টার্ন গোনে। তাই সংরক্ষিত কথোপকথন চালিয়ে নেওয়া রান (`-c`, `-r`, `--fork`) ইতিমধ্যে থাকা টার্নগুলোর পরে তার টার্ন নম্বর দেয়, এবং তার `session` সারি `resume_of`-এ জানায় কোন কথোপকথনটি চালিয়ে নিচ্ছে।

আউটপুট সারির ধরন, তাদের `type` ফিল্ড অনুযায়ী:

- `session`: শুরুর সারি: `version`; `build` (যে ট্রি থেকে বান্ডল বানানো হয়েছে তার প্রথম বারোটি হেক্স অক্ষর, `mercury daemon status` যেমন দেখায়; বান্ডলের পাশে কোনো manifest না থাকলে অনুপস্থিত); `resume_of` (চালিয়ে নেওয়া রানে, যে কথোপকথনটি চালানো হচ্ছে তার সেশন আইডি; রান fork না হলে `session_id`-এর সমান); `cwd`, `model`, `mode`; সেশনের `tools`, `mcp_servers`, `commands`, `agents`, `skills` ও `extensions`; এবং `tools_withheld` (যখন একটি deny rule শুধু নাম দিয়ে কোনো টুল আটকে রাখে তখন থাকে: প্রতিটি এন্ট্রির `tool`, `rule` ও `source`)।
- `turn`: একটি টার্ন `started` বা `waiting` অবস্থায়, তার `turn_id`-সহ; `model`, `message_ids` এবং জানা থাকলে `agents`-এর সংখ্যা।
- `text`: একটি স্থির টেক্সট ব্লক: `message_id`, `block`, `text`, এবং তার `phase` (`commentary` বা `final_answer`)।
- `reasoning`: একটি স্থির reasoning ব্লক: `message_id`, `block`, `text`, অথবা `redacted: true`।
- `tool_call`: একটি টুল কল: `call_id`, `tool`, `input`, তার `message_id` ও `block`-সহ।
- `tool_result`: কলের ফলাফল: `call_id`, `status` (`ok`, `error`, `aborted` বা `refused`) ও `output`। মডেল যে কলটি এত খারাপভাবে গঠন করেছে যে তা কার্যকর হওয়ার আগেই প্রত্যাখ্যাত হয়েছে (একটি অজানা টুল, এমন আর্গুমেন্ট যা বৈধ JSON নয় বা টুলের স্কিমার সঙ্গে মেলে না), তারও জোড়া থাকে: যেভাবে পৌঁছেছে সেই আর্গুমেন্ট-সহ একটি `tool_call` সারি (অবজেক্ট না হলে `{}`), এবং একটি `tool_result` সারি যার স্ট্যাটাস `refused` এবং যার `output` হলো কারণ। তারপর সংশোধনের `notice` আসে। এমন কল কখনো চলেনি, এবং এটি কোনো প্রত্যাখ্যান (denial) নয়।
- `tool_update`: চলমান টুলের অগ্রগতি: `call_id`, `tick`, `source` (`shell`, `powershell`, `mcp` বা `eval`), এবং কল যেগুলো জানায় তার মধ্যে `line`, `elapsed_s`, `lines`, `bytes`, `budget_ms`, `progress` ও `total`-এর যেকোনোটি। shell বা PowerShell কল আউটপুট আসার সঙ্গে সঙ্গে টিক পাঠায় (যে কমান্ড কিছুই ছাপে না, তা কখনো টিক পাঠায় না); MCP কল তখন টিক পাঠায় যখন তার সার্ভার অগ্রগতি জানায়; Eval কল তার সেল চলাকালীন টিক পাঠায়। অন্য কোনো টুল টিক পাঠায় না; Browser বা Crewmate কল ফলাফল আসা পর্যন্ত নীরব থাকে।
- `step`: মূল থ্রেডের একটি মডেল কল: `message_id`, `model`, `usage`, এবং মডেল কেন থামল তা বললে `stop`।
- `outcome`: টার্নের ফলাফল, যা নিচে বর্ণিত।
- `close`: বন্ধের সময় পরের সেশনের জন্য রেখে যাওয়া নোট: `state` (`stored`, `skipped` বা `none`), `note_chars`, এবং যে মডেল কলগুলো এটি লিখেছে তাদের `usage`; তাই প্রতিটি সারির ব্যবহারের হিসাব যোগ করলে ফলাফলের হিসাবের সমান হয়। প্রম্পট আর্গুমেন্ট হিসেবে দেওয়া হলে নোট শেষ টার্নের ভেতরে চাওয়া হয় এবং `close` সেই টার্নের `outcome`-এর আগে আসে; `--input rows`-এ stdin বন্ধ হলে তা শেষ `outcome`-এর পরে আসে।
- `wait`: মডেলের জন্য অপেক্ষা: `state` (`first_byte`, `retry`, `silence`, `loading` বা `done`), সেই অবস্থায় যে সংখ্যাগুলো থাকে তাসহ, যেমন `since_ms`, `attempt` ও `of`, `delay_ms`, `reason` ও `http_status`।
- `heartbeat`: মডেল স্ট্রিম কমপক্ষে এক সেকেন্ড কোনো পার্স করা ইভেন্ট ছাড়াই প্রাণের চিহ্ন দেখিয়েছে: এমন বাইট এসেছে যা কোনো সারি তৈরি করেনি। সারিতে আর কিছু থাকে না, এবং এটি সর্বোচ্চ প্রতি সেকেন্ডে একবার আসে। কতবার আসে তা প্রদানকারীর স্ট্রিমিং ধরনের ওপর নির্ভর করে, তাই যে স্ট্রিম ইভেন্টের মাঝে কখনো থামে না, তা কোনো সারি পাঠায় না।
- `compaction`: একটি compaction `started`, `progress` বা `ended` অবস্থায়: `trigger` (`manual`, `auto` বা `overflow`), `stage`, `fill`, `summary_tokens`, এবং শেষে `exit` (`landed`, `cancelled` বা `failed`)।
- `mode`: অনুমতি মোড বদলেছে: `mode`।
- `rate_limit`: প্রদানকারীর সীমার অবস্থা: `status` (`allowed`, `warning` বা `rejected`), `window`, `resets_at`, `utilization` এবং অতিরিক্ত ব্যবহারের ফিল্ড।
- `task`: একটি ব্যাকগ্রাউন্ড টাস্ক `started`, `progress` বা `ended` অবস্থায়: `task_id`, `task_type`, `description`, `usage`, `summary`, `status` (`completed`, `failed` বা `stopped`), এবং জানা হলে `output_file`।
- `notice`: পাঠকের জন্য একটি `warning` বা `error`: `text`, এবং একটি `code`, যেমন `input_refused`।
- `command_output`: একটি স্ল্যাশ কমান্ডের আউটপুট, যা কখনো মডেলে পৌঁছায়নি: `command` ও `text`।
- `mission_updated`: সেশনের টাস্ক লেজার বদলেছে; আবার পড়ুন।
- `samples_updated`: সেশনের নমুনা বদলেছে; আবার পড়ুন।

`--partial` যদি `--format rows`-এর সঙ্গে ব্যবহার করা হয়, তবে `block_start`, `text_delta`, `reasoning_delta`, `tool_input_delta` ও `retracted` সারি যোগ হয়। delta গুলো `message_id` ও `block`-এর অন্তর্গত; `retracted` সারি সেই বার্তার delta প্রত্যাহার করে। স্থির টেক্সট বা টুল সারিই সম্পূর্ণ মান।

আউটপুট `schema`, `turn_id`, `status`, `steps`, `wall_ms`, `usage`, `models` ও `denials` বহন করে; সফল হলে `answer` ও ব্যর্থ হলে `error` (`message`, `class`, ঐচ্ছিক `detail`) থাকে। `stop`, `api_ms`, `cost_usd`, অনুরোধ করা `structured` আউটপুট ও `notices` পাওয়া গেলে অন্তর্ভুক্ত হয়। `wall_ms` হলো টার্নের অতিবাহিত সময়। `api_ms` হলো টার্ন যতগুলো মডেল অনুরোধ করেছে তাদের প্রতিটির সময়ের যোগফল (পুনঃচেষ্টা এবং মূল থ্রেডের পাশাপাশি চলা crewmate-দের অনুরোধও ধরে), তাই অনুরোধগুলো একসঙ্গে চললে এটি `wall_ms`-কেও ছাড়িয়ে যেতে পারে। `cost_usd` হলো টার্নের দাম-নির্ধারিত অনুরোধগুলোর ডলার মূল্য, স্ট্যাটাস যাই হোক না কেন। যে অনুরোধের দাম Mercury নির্ধারণ করতে পারে না (কোনো রেট জানা নেই, বা উত্তরে কোনো খরচ উল্লেখ নেই), তা এতে কিছু যোগ করে না, এবং তার মডেলটি `models`-এ `cost_usd` ছাড়াই থাকে; টার্নে কোনো কিছুর দাম নির্ধারিত না হলেই কেবল ফিল্ডটি অনুপস্থিত থাকে। Claude সাবস্ক্রিপশন সাইন-ইনে Anthropic অনুরোধগুলোর ডলার মূল্য নেই, তাই সেগুলো বা সারিটি কেউই `cost_usd` বহন করে না; তবে ব্যবহারের হিসাব থাকে। ব্যবহারের হিসাবে থাকে `input_tokens` (ক্যাশ করা token-সহ), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, এবং জানানো হলে `reasoning_output_tokens`, যা মূল থ্রেড ও crewmate-দের মিলিয়ে যোগ করা। `models` মডেল অনুযায়ী token ব্যবহারের ভাগ দেখায়। `steps` শুধু মূল এজেন্টের মডেল কল গোনে; crewmate-দের মডেল কল নিজস্ব `step` সারি হিসেবে আসে, যা `parent_call_id` দিয়ে চিহ্নিত।

স্ট্যাটাস হতে পারে `completed`, `blocked`, `refused`, `failed`, `interrupted`, `turn_limit`, `budget_limit`, `time_limit`, `schema_unmet` বা `loop_stopped`। `--max-time` (সেকেন্ড, বা `10m`, `1h`) সহ চলা রান সময় শেষ হলে পরের ধাপে `time_limit` হয়ে শেষ হয়; চলমান মডেল কল বা টুল রাউন্ড বাধাপ্রাপ্ত হয় না। সম্পন্ন রান 0 কোডে বের হয়, অন্য ফলাফল 1 কোডে, এবং ব্যবহারের ত্রুটি 2 কোডে। বাধাপ্রাপ্ত টার্নের outcome লেখা হওয়ার পরে SIGINT ও SIGTERM যথাক্রমে 130 ও 143 কোডে বের হয়। প্রত্যাখ্যাত টুল কল `denials`-এ তালিকাভুক্ত হয়। যখন প্রত্যাখ্যানটি এমন একটি অনুমতি-জিজ্ঞাসা ছিল যার উত্তর কেউ দিতে পারেনি (জিজ্ঞেস করে এমন মোডে কোনো হোস্ট ছাড়া রান, `--mode dontAsk`, বা হোস্টের মেয়াদোত্তীর্ণ জিজ্ঞাসা), এবং টার্নের আর কোনো পরবর্তী টুল কল সফল হয়নি, তখন রানটি `blocked`: উত্তরটি রাখা হয়, `error` টুলের নাম ও কীভাবে আবার শুরু করতে হবে তা উল্লেখ করে (`--allowed-tools`, অন্য `--mode`, বা জিজ্ঞাসার উত্তর দেয় এমন হোস্ট), এবং রানটি 1 কোডে বের হয়। একই টার্নের পরের কোনো টুল কল সফল হলে টার্ন পুনরুদ্ধার হয় এবং `completed` (0 কোড) হয়ে শেষ হয়, সঙ্গে একটি সতর্কতা `notice` থাকে (`"<Tool> was not approved; the run continued with other tools."`)। যে প্রত্যাখ্যানের উত্তর আপনি দিয়েছেন (deny rule, hook, বা "না" বলা হোস্টের মাধ্যমে), তা সম্পন্ন টার্নকে সম্পন্নই রাখে। উত্তরবিহীন `AskUserQuestion` কলও রানকে `blocked` করে, `error`-এ প্রশ্নটি উদ্ধৃত করে। Mercury outcome পড়ে রানের রেকর্ড করা জিজ্ঞাসা থেকে, উত্তরের টেক্সট থেকে নয়; তাই শুধু উত্তরের ভেতরে লেখা প্রশ্ন `completed` হিসেবে শেষ হয়। অজানা স্ল্যাশ কমান্ড `refused` হয়, সঙ্গে ইন্টারঅ্যাকটিভ স্ক্রিন যে বাক্যটি দেয় সেটিই (`Unknown command: /name · /help lists commands`), এবং 1 কোডে বের হয়।

`--input rows`-এর জন্য `--format rows` লাগে, এবং এটি প্রতি লাইনে একটি ইনপুট অবজেক্ট পড়ে:

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

ইনপুট ধরনগুলো হলো: `prompt`, যাতে থাকে `content` (টেক্সট বা টেক্সট/ছবির ব্লক); `shell`, যাতে থাকে `command`; এবং `note`, যাতে থাকে `to` (একটি এজেন্ট আইডি) ও `content`। প্রতিটি একটি ঐচ্ছিক `id` গ্রহণ করে; prompt ও shell সারি `priority` (`now`, `next` বা `later`), `sent_at` ও `origin`-ও গ্রহণ করে। প্রত্যাখ্যাত ইনপুট আকৃতি একটি `notice` তৈরি করে যার কোড `input_refused`; ত্রুটিপূর্ণ JSON রানটি শেষ করে দেয়। এই সারিগুলো শুধু ইনপুট বহন করে; অনুমতির উত্তর নিচে বর্ণিত runner প্রোটোকল ব্যবহার করে।

পুরো prompt stdin থেকে পড়তে `mercury run -` ব্যবহার করুন, অথবা `mercury run`-এ টেক্সট পাইপ করুন। prompt আর্গুমেন্টের পাশে পাইপ করা টেক্সট সীমাবদ্ধ প্রসঙ্গ হিসেবে যোগ হয়: পাইপ বন্ধ না হওয়া পর্যন্ত, অথবা এক সেকেন্ড চুপ না থাকা পর্যন্ত পড়া হয়। তাই যে স্ট্রিম ক্রমাগত ডেটা পাঠায় তা শেষ পর্যন্ত পড়া হয়, আর যে পাইপ খোলা থাকে কিন্তু চুপ থাকে, তা রানকে আটকে রাখে না। prompt না থাকলে এবং stdin-এ টার্মিনাল থাকলে `run` তার ব্যবহারবিধি ছাপে এবং 2 কোডে বের হয়।

`--mode <mode>` অনুমতির অবস্থান বেছে নেয়। `--sovereign` অনুমতির প্রশ্ন ছাড়াই চলে, আর `--allow-sovereign` এই অবস্থানটি পরে বদলানোর জন্য উপলব্ধ রাখে। অনুমতি নীতি ও deny rule তবুও প্রযোজ্য থাকে। root ব্যবহারকারী sovereign মোডে প্রবেশ করলে stderr-এ একটি নোটিশ পায়; রান চলতে থাকে।

সবচেয়ে সাম্প্রতিক কথোপকথন চালিয়ে যেতে `-c`, আইডি, শিরোনাম বা picker দিয়ে ফিরে যেতে `-r`, একটি managed worktree-তে চালাতে `-w`, এবং একটি ন্যূনতম সেশনের জন্য `--lean` ব্যবহার করুন। `run`-এর কোনো হোস্ট নেই যে অনুমতির জিজ্ঞাসার উত্তর দেবে: এর অনুমতি নিয়ম ও মোড ঠিক করে কী চলতে পারবে, আর যে কল এখনও অনুমোদন চায়, তা প্রত্যাখ্যাত হয়।

### হেডলেস ইমেজ

রিপোজিটরির মূলে থাকা `Dockerfile` CI ও সার্ভারের জন্য একটি Linux x64 ইমেজ বানায়। এর এন্ট্রি পয়েন্ট `mercury` এবং ডিফল্ট ক্রিয়া `run`, তাই ইমেজটি একটি mount করা ট্রির বিপরীতে একটি prompt চালায় এবং রানের কোড দিয়ে বের হয়:

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

ইমেজে থাকে বান্ডল, তার Node 24 runtime (`PATH`-এ), সঙ্গে থাকা search, shell, debugger, language ও image টুল, `git` এবং certificate store। কোনো enter স্ক্রিন ও সাইন-ইন প্রবাহ থাকে না। এটি `mercury` নামের non-root ব্যবহারকারী হিসেবে চলে, এবং তার কনফিগ হোম কন্টেইনারের ভেতরে থাকে (`MERCURY_CONFIG_DIR`); `/work` তার কার্যকরী ডিরেক্টরি। রং ও মাউস পণ্যের নিজস্ব টার্মিনাল শনাক্তকরণ অনুসরণ করে। `--user 0` root হিসেবে চালায়, সঙ্গে উপরে উল্লেখিত একটি sovereign নোটিশ।

প্রদানকারীর key আসে একটি এনভায়রনমেন্ট ভেরিয়েবল হিসেবে; পণ্য সর্বত্র যে বানানগুলো পড়ে সেগুলোই: `ANTHROPIC_API_KEY` বা `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` বা `GOOGLE_API_KEY`, `XAI_API_KEY` (এবং তার usage meter-এর জন্য `XAI_MANAGEMENT_API_KEY`), `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY` (এবং তার organisation meter-এর জন্য `MISTRAL_ADMIN_API_KEY`), `NOUS_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`, `TOGETHER_API_KEY` বা `TOGETHER_AI_API_KEY`, `COHERE_API_KEY` বা `CO_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `DASHSCOPE_API_KEY`, `MODEL_API_KEY` বা `META_API_KEY`, কাস্টম OpenAI-সামঞ্জস্যপূর্ণ endpoint-এর জন্য `MERCURY_COMPAT_API_KEY`, এবং স্থানীয় সার্ভারের জন্য `MERCURY_LOCAL_API_KEY`। কোনো key না থাকলে রান এক লাইনে প্রত্যাখ্যান করে এবং 1 কোডে বের হয়। `docker run -i … mercury run -` stdin থেকে prompt পড়ে।

### একটি সেশন হোস্ট করা

`mercury runner` stdio-র মাধ্যমে একটি সেশন একটি হোস্টকে পরিবেশন করে: JSON-RPC 2.0, প্রতি লাইনে একটি বার্তা। হোস্ট প্রথমে `initialize` পাঠায় এবং কাজ পাঠানোর আগে উত্তরের জন্য অপেক্ষা করে:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

হোস্টের নাম ও সংস্করণ `host`-এর অধীনে যায়; `capabilities` ঘোষণা করে `holds_asks`, `elicitation` ও `partial_rows`। প্রতিটি অনুরোধের `id` হতে হবে একটি ধনাত্মক পূর্ণসংখ্যা: যে অনুরোধের `id` অন্য কিছু, তার উত্তরে `-32600` এবং `id: null` পাঠানো হয়। তাই অনুরোধগুলো 1 থেকে নম্বর দিন।

`queue/add` উপরের সারি-ইনপুটের মতোই একই prompt, shell বা note অবজেক্ট নেয়। আউটপুট আসে `row` বিজ্ঞপ্তিতে। `session/facts` সেশনের অবস্থা পড়ে; `session/set_mode` অনুমতি মোড সঙ্গে সঙ্গে বদলায়; `session/set_model` ও `session/set_effort` মডেল ও effort বদলায়। টার্ন চলাকালীন করা বদল টার্ন শেষ হওয়া পর্যন্ত আটকে থাকে: তখন উত্তর আসে `at: "turn_end"`-সহ, এবং তারপর `session/applied` তা ঘোষণা করে। `turn/interrupt` একটি টার্ন থামায়; সেশন শেষ করতে stdin বন্ধ করুন।

অনুমতির জিজ্ঞাসা আসে `permission/request` হিসেবে, `kind: "tool"` বা `kind: "network"`-সহ। হোস্ট `outcome: "allow"` বা `outcome: "deny"` দিয়ে উত্তর দেয়; allow-তে সম্পাদিত `input` ও অনুমতি `rules` থাকতে পারে। প্রত্যাহার করা জিজ্ঞাসা `$/cancel_request` পাঠায় তার `request_id`-সহ। `holds_asks` জিজ্ঞাসার সময়গণনার মালিকানা হোস্টকে দেয়। MCP প্রশ্ন `elicitation/request` ব্যবহার করে শুধু তখন, যখন হোস্ট `elicitation` ঘোষণা করে; অন্যথায় তার উত্তর হয় `cancel`।

অজানা method-এর উত্তর `-32601`, অবৈধ parameters-এর `-32602`, ধনাত্মক পূর্ণসংখ্যা নয় এমন `id`-এর `-32600`, এবং initialization-এর আগের অনুরোধের `-32002`। নিয়মভিত্তিক প্রত্যাখ্যান `-32010`, যার `error.message`-এ একটি বাক্য এবং `error.data.kind`-এ কারণ থাকে, যেমন `mode`, `model`, `effort` বা `claim`। runner একটি ত্রুটিপূর্ণ লাইনের উত্তর দেয় `-32700` দিয়ে এবং চলতে থাকে; পরপর তিনটি ত্রুটিপূর্ণ লাইনে এটি বন্ধ হয়।

### অন্যান্য কমান্ড

উপলব্ধ কমান্ডগুলোর মধ্যে আছে:

- **`mercury health`**: ডায়াগনস্টিক প্রতিবেদন, যাকে স্বাস্থ্য সনদও (health certificate) বলা হয়। `--json` পূর্ণ প্রতিবেদন ফেরত দেয়, `--deep` গভীর তালিকা (inventory) চালায়, এবং `--fix` নির্দেশিত সমাধান চালায়।
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**: সাইন ইন (`login [<family>]`), প্রদানকারী পরিবারের তালিকা (`list`), কোনো অ্যাকাউন্ট সাইন-ইন আছে কিনা তা যাচাই (`status [<family>]`), সাইন আউট (`logout [<family>]`), বা একটি দীর্ঘস্থায়ী Anthropic token তৈরি (`mint`)।
- **`mercury models [--json]`**: সাইন-ইন করা অ্যাকাউন্টগুলো যে মডেলে পৌঁছায় তা প্রিন্ট করে (`mercury://models`-এর একই তথ্য)।
- **`mercury mcp`**: `add`, `import`, `list`, `get`, `remove`, `trust-reset` ও `serve` দিয়ে MCP সার্ভার পরিচালনা।
- **`mercury extensions`**: এক্সটেনশন ইনস্টল ও তাদের উৎস পরিচালনা। কাজগুলো: `list`, `sources`, `add`, `remove`, `refresh`, `install`, `trust`, `enable`, `disable`, `update`, `uninstall`, `fence`, `unfence`, `inspect` ও `scaffold`।
- **`mercury roster`**: এজেন্টের তালিকা (inventory) দেখায়।
- **`mercury usage`**: `/usage` স্ক্রিন যে সংক্ষিপ্ত সংখ্যার লাইন দেখায়, তা প্রিন্ট করে; `--json` পুরো পাঠ প্রিন্ট করে: প্রতিটি সাইন-ইন করা প্রদানকারীর উইন্ডো, কতটা ব্যবহৃত ও কখন রিসেট হয়, তার বলা সংখ্যা ও ক্রেডিট, প্রতিটির সঙ্গে তার উৎস ও বয়স, এবং মডেল-অনুযায়ী সেশনের খরচ। স্ক্রিন যেভাবে পড়ে সেভাবেই পড়া হয় (খোলার সময়ের মতো, প্রতিটি সাইন-ইন করা প্রদানকারীর রিডার একবার নমুনা নেয়)।
- **`mercury daemon run|status|stop|restart`**: ব্যাকগ্রাউন্ড daemon চালানো, দেখা, থামানো বা পুনরায় চালানো। এর সেশন-সিটগুলো (seats) হলো `mercury runner`-এর child প্রক্রিয়া; daemon সেগুলোর prompt পাঠায় এবং তাদের অনুমতির জিজ্ঞাসা হোস্ট করে।
- **`mercury sessions list`** (শুধু `mercury sessions`-ও): এই প্রকল্পের সংরক্ষিত সেশনগুলো তালিকাভুক্ত করে, নতুনগুলো আগে: আইডি, শেষবার কখন লেখা হয়েছে, আকার, daemon এখন হোস্ট করলে `live`, এবং শিরোনাম বা প্রথম prompt। `--all` সব প্রকল্প পড়ে, `--limit <n>` তালিকার সীমা ঠিক করে। আইডিটিই `mercury --resume <id>` দিয়ে আবার খোলে এবং `sessions delete` দিয়ে মোছা হয়।
- **`mercury sessions delete <id>`**: ইচ্ছা করে একটি সংরক্ষিত সেশন মুছে ফেলে: এর ট্রান্সক্রিপ্ট ও পাশে রাখা রেকর্ড (receipts, resume snapshot), একটি প্রশ্নের পরে। স্ক্রিপ্টের জন্য `--yes` প্রশ্নটি এড়িয়ে যায়। daemon এখন যে সেশন হোস্ট করছে, তা প্রত্যাখ্যাত হয়; অজানা আইডিও প্রত্যাখ্যাত হয়, সঙ্গে তালিকার (roster) একটি ইঙ্গিত (Mercury-র ভেতরে `/sessions`)। অন্যথায় সংরক্ষিত সেশন নিজে থেকে কখনো মোছা হয় না।
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**: একটি স্থানীয় বা SSH কম্পিউটারকে কনফিগ হোম শেয়ার করা প্রতিটি সেশনের জন্য মডেল সার্ভার হিসেবে চালায় (`compat/box-<name>/<model>`), যাচাইকৃত স্থানীয় weight bank বা নিশ্চিত ডাউনলোড ব্যবহার করে। দেখুন [docs/LLM-HOST.md](../LLM-HOST.md)।
- **`mercury lsp list`** ও **`mercury lsp install <server>`**: ভাষা-সার্ভারের ক্যাটালগ; প্রতিটি সার্ভার ইনস্টল আছে (তার বাইনারিসহ) বা নেই (তার ইনস্টল-সমাধানসহ) তা দেখায়। `install` একটি সার্ভারের সমাধান (remedy) দেখায়, জিজ্ঞেস করে, ঠিক সেটিই চালায় (`--yes` স্ক্রিপ্টে প্রশ্ন এড়ায়), এবং বাইনারিটি কোথায় বসল তা জানায়। অজানা সার্ভার তালিকা (roster) সহ প্রত্যাখ্যাত হয়। Mercury নিজে থেকে কখনো ভাষা-সার্ভার ইনস্টল করে না; ফাইল খুললে শুধু আগে থেকে ইনস্টল করা সার্ভার চালু হয়।
- **`mercury acp`**: Agent Client Protocol-এর মাধ্যমে একটি এডিটরকে পরিবেশন করে, প্রতিটি সেশনের জন্য একটি runner child-সহ। `mercury bridge install` VS Code এক্সটেনশন ইনস্টল করে; `mercury bridge status` তা পরীক্ষা করে; `mercury bridge uninstall` তা সরিয়ে দেয়।
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**: বর্তমান ডিরেক্টরির Godot প্রকল্পের ইঞ্জিন জব পরিচালনা করে। Mercury একটি জমানো (frozen) প্রকল্প-কপি থেকে নিজের headless ওয়ার্কারে স্যুট চালায়। এই সার্ভিসে আছে কম্পাইল গেট, ক্যাপচার, ফ্রেম পরিসংখ্যান, স্থির profile, জব কিউয়ের অ্যাক্সেস, বাতিলকরণ এবং ID অনুযায়ী ফলাফল। দেখুন [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md)।
- **`mercury image <image>`**: টার্মিনালে একটি ছবি দেখায়।
- **`mercury install`** ও **`mercury update`** (উপনাম `upgrade`): রিলিজ আর্কাইভ ইনস্টল বা আপডেট করে। `--json`-এর সঙ্গে ফলাফল যাই হোক, নথিটি stdout-এ যায়, আর exit কোড জানায় এটি ব্যর্থ হয়েছে কিনা। দেখুন [ইনস্টল](#ইনস্টল)।
- **`mercury version`** ও **`mercury help [command]`**: সংস্করণের লাইন বা একটি সাহায্য পাতা প্রিন্ট করে, `--version` ও `--help`-এর মতোই; কোনোটিই সেশন শুরু করে না।

## ভেতরে কী আছে: Mneme RAG memory, LSP, 23 ভাষার AST, DAP debugger, ওয়েব সার্চ ও ব্রিজ

- **Mneme হাইব্রিড RAG প্রকল্প মেমরি।** Mneme ডিফল্টভাবে চালু থাকে, প্রতিটি প্রকল্পের তথ্য সাধারণ markdown টপিক পাতায় রাখে (`Retain`, `Recall`, `Reflect`, `Correct`)। Recall ডিভাইসে চলা 118 MB BGE semantic embedding মডেল (`bge-base-en-v1.5` `q8_0`, MIT লাইসেন্সের, প্রতিটি রিলিজ আর্কাইভে বান্ডল করা এবং তার প্ল্যাটফর্মের জন্য বানানো; দেখুন [ঐচ্ছিক উপাদান](#ঐচ্ছিক-উপাদান))-কে reciprocal rank fusion (`k = 60`)-এর মাধ্যমে stemmed BM25 শব্দ র‍্যাংকিং, সাম্প্রতিকতার ওজন ও উদ্ধৃতি ট্র্যাকিংয়ের সঙ্গে মেলায়। পিন করা নিয়ম (`pin: true`) পিন-করা তাকে হুবহু লোড হয়, এবং শুধু আপনার কথায় বদলায়। সেশন শুরুর সময় Mercury পিন-না-করা তথ্য ও আগের নোটগুলোকে আপনার বর্তমান ব্রাঞ্চ, সম্প্রতি স্পর্শ করা ফাইল এবং শেষ সেশনের হ্যান্ডঅফ নোটের সঙ্গে মিলিয়ে স্কোর করে, একটি নির্দিষ্ট স্টার্টআপ বরাদ্দের (`memory.startLimit`, ডিফল্ট 4,000 অক্ষর) মধ্যে। লেখার সময়ের বিরোধ যাচাই কোনো বিরোধী তথ্য সংরক্ষণের আগে বিপরীত অর্থ (polarity), না-বাচক শব্দ (negation) ও সংখ্যার উল্টোপাল্টা ধরে ফেলে। প্রতিটি সেশন বের হওয়ার সময় পরের সেশনের প্রবেশ-পাতার জন্য নিজের ভাষায় একটি হ্যান্ডঅফ নোট লেখে, সঙ্গে ঐচ্ছিক একটি সেশন জার্নাল এন্ট্রি। `/memory` মেমরি সেন্টার খোলে, এবং `/memory page` আপনার ব্রাউজারে লাইব্রেরিটিকে নোড-ও-এজের গ্রাফ হিসেবে আঁকে। দেখুন [docs/MNEME.md](../MNEME.md)।
- **LSP কোড ইন্টেলিজেন্স, 23 ভাষার AST রিরাইট, DAP ডিবাগার ও `Eval` সেল।** অ্যাঙ্কর-করা পাঠ ও একাধিক ফাইল জুড়ে পারমাণবিক সম্পাদনা (`ChangeSet`); language-server কোয়েরি (`LspRead`) এবং আগে পূর্বরূপ দেখে পরে প্রয়োগ হওয়া রিফ্যাক্টর (`LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`); syntax-tree সার্চ ও রিরাইট (`AstSearch`, `AstEdit`), যাতে রিলিজ আর্কাইভের 23টি গ্রামারে `$NAME` ও `$$$NAME` মেটা-ভেরিয়েবল ব্যবহৃত হয় (প্রতিটি `bun install` বিল্ডে 16টি, এবং গ্রামার pack-এ 7টি); স্থায়ী Python (`python3`) ও JavaScript (Node ES module) কোড সেল (`Eval`); এবং একটি Debug Adapter Protocol ডিবাগার (`Debug`), যা `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`, `netcoredbg`, `rdbg`, Dart SDK-এর debug adapter, `kotlin-debug-adapter`, elixir-ls debug adapter ও Godot চালায়। `Test` টুলের `debug` অপারেশন একটি ব্যর্থ Python (`pytest`, `unittest`), JavaScript/TypeScript (`node-test`, `vitest`, `jest`), Go (`go test`) বা Rust (`cargo test`) টেস্টে সরাসরি একটি `Debug` সেশনে ধাপে ধাপে ঢোকে। দেখুন [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md), [পরিবর্তনের লেনদেন](../CHANGE-TRANSACTIONS.md), [স্ট্রাকচারাল প্যাটার্ন](../STRUCTURAL-PATTERNS.md), [কোড সেল](../EVAL.md) ও [ডিবাগার](../DEBUGGER.md)।
- **কী ছাড়া `WebSearch` ও markdown `WebFetch`।** `WebSearch` একটি ধারাবাহিক সিঁড়ি ধরে এগোয়: সেশন মডেল সমর্থন করলে প্রথমে প্রদানকারীর নিজস্ব লাইভ সার্চ (`ProviderSearch`), তারপর সংরক্ষিত Brave বা Tavily key, তারপর কোয়েরির আকৃতি অনুযায়ী বাছাই করা অফিশিয়াল API (Stack Exchange, npm, PyPI, crates.io, GitHub কোড সার্চ, Hacker News Algolia, Wikipedia), তারপর কনফিগার করা SearXNG JSON API (`MERCURY_SEARCH_SEARXNG_INSTANCES`), এবং শেষে কী ছাড়া DuckDuckGo পেজ স্ক্র্যাপিং (ডিফল্টে চালু; `/config`-এ বা `MERCURY_SEARCH_KEYLESS=0` দিয়ে বন্ধ করা যায়)। প্রতিটি উত্তর 2,000 token-এর নিচে থাকে এবং যে উৎস উত্তর দিয়েছে তার নাম দেয়। `WebFetch` 38,000 অক্ষরের কল বাজেটের মধ্যে পাবলিক পাতা markdown আকারে পড়ে, পাতার নিজের ভাষায়। যে পাতার জন্য ব্রাউজার দরকার, সেটি hosted reader `r.jina.ai`-এর মাধ্যমে পড়া হয় যদি না `MERCURY_FETCH_READER=0` সেট থাকে; কোনো private network ঠিকানা সেখানে কখনো পাঠানো হয় না। দেখুন [docs/ENGINES.md](../ENGINES.md)।
- **এজেন্ট, বিভিন্ন প্রদানকারীর crewmate (`Crewmate`), worktree ও ফাইল লিজ।** দুটি বিল্ট-ইন এজেন্ট আছে (`mercury-crew`, সব ধরনের অর্পিত কাজের জন্য; `mercury-scout`, শুধু-পড়া অনুসন্ধানের জন্য), যেগুলো `/agents`-এ আপনার তৈরি এজেন্ট সংজ্ঞার পাশে থাকে। যেকোনো সাইন-ইন করা প্রদানকারীতে crewmate চালান, সমান্তরাল কাজ `git worktree` চেকআউটে আলাদা রাখুন (`isolation: "worktree"`), প্রক্রিয়ার ভেতরের প্রকল্প ফাইল লিজ (`mcp__mercury__lease_take`, `mcp__mercury__lease_release`, `mcp__mercury__lease_list`) দিয়ে শেয়ার্ড ফাইল সমন্বয় করুন, এবং `SendMessage` ও `ResumeCrewmate` দিয়ে নাম বা আইডি ধরে crewmate-কে নির্দেশ দিন বা পুনরায় চালু করুন। `/crewmates` ও `/runs`-এ crewmate ও workflow রান অনুসরণ করুন। দেখুন [docs/CREW.md](../CREW.md)।
- **ডেস্কটপ কম্পিউটার ব্যবহার।** নেটিভ ডেস্কটপ ড্রাইভার পাওয়া গেলে ডিফল্টভাবে চালু থাকে। `Computer` টুল স্ক্রিনশট নেয় এবং সামনের অ্যাপ্লিকেশনে মাউস ও কীবোর্ড নিয়ন্ত্রণ করে। কাজ করার আগে Mercury অ্যাপ্লিকেশনটিকে নাম ও পরিচয় দিয়ে যাচাই করে; আপনার অনুমতি নিয়ম, সেশন অনুমোদন, অ্যাক্সেস সেটিং বা অনুমতি মোড যদি কাজটিকে আগে থেকে অনুমোদন না দেয়, তবে অনুমোদন চায়। `Esc` চাপলে থামে, একসঙ্গে শুধু একটি সেশন ডেস্কটপ নিয়ন্ত্রণ করতে পারে, এবং স্ক্রিনশট সংরক্ষিত কথোপকথন ফাইলের বাইরে রাখে। টুলটি সরাতে `MERCURY_COMPUTER_USE=0` সেট করুন। দেখুন [docs/COMPUTER-USE.md](../COMPUTER-USE.md)।
- **ডিভাইসে Whisper ভয়েস ইনপুট (`/voice`)।** `/voice on` প্রথমবার ব্যবহারের সময় 60 MB ইংরেজি বক্তৃতা মডেল (`base.en-q5_1`) ডাউনলোড করে, তার SHA-256 ডাইজেস্ট যাচাই করে এবং ডিক্টেশন চালু করে; `/voice off` তা বন্ধ করে। কথা বলতে স্পেস 1 সেকেন্ড ধরে রাখুন এবং থামাতে ছেড়ে দিন; অথবা ভয়েস চালু থাকলে শুধু `/voice` চালিয়ে রেকর্ডিং শুরু ও থামাতে পারেন। Whisper ডিভাইসেই ট্রান্সক্রাইব করে, তাই ভয়েসের অডিও কখনো মেশিন ছাড়ে না। `MERCURY_WHISPER_MODEL` দিয়ে `tiny.en-q5_1`, `small.en-q5_1`, বহুভাষিক `base-q5_1`, অথবা একটি স্থানীয় `.gguf` ফাইল বেছে নেওয়া যায়। দেখুন [docs/VOICE.md](../VOICE.md)।
- **Saturn cron ও সেশন শিডিউলার (`/saturn`)।** একটি বিদ্যমান সেশনের জন্য prompt শিডিউল করুন (`CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, `/loop`), অথবা একটি নতুন সেশন নির্ধারিত সময়ে শুরু হওয়ার জন্য শিডিউল করুন। শিডিউল একবার চলতে পারে বা পুনরাবৃত্ত হতে পারে। দেখুন [docs/SATURN.md](../SATURN.md)।
- **VS Code (ACP), Unity, Blender, Godot ও Aseprite ব্রিজ।** `mercury acp` Agent Client Protocol সমর্থনকারী এডিটরের সঙ্গে যুক্ত হয়। VS Code এক্সটেনশন (`mercury bridge install`) ওই প্রোটোকলের মাধ্যমে এডিটরের ভেতরে Mercury চালায়: চ্যাট, সেশন, এজেন্ট, artifacts ও পর্যালোচনা; এবং প্রতিটি prompt-এর সঙ্গে এডিটরের নির্বাচন ও ডায়াগনস্টিক যায়। আলাদা, opt-in ইন্টিগ্রেশন চালু থাকা Unity (`MERCURY_UNITY=1`), Blender (`MERCURY_BLENDER=1`) ও Godot (`MERCURY_GODOT_TOOLS=1`) এডিটরের সঙ্গে যুক্ত হয়, এবং Aseprite-এ ব্যাচ অ্যাক্সেস পায় (`MERCURY_ASEPRITE=1`)। দেখুন [Unity](../UNITY-BRIDGE.md), [Blender](../BLENDER-BRIDGE.md), [Godot](../VULCAN-GODOT-TOOLS.md) ও [Aseprite](../ASEPRITE-BRIDGE.md)।
- **এক্সটেনশন।** প্রতিটি এক্সটেনশনের একটি manifest থাকে। git URL, স্থানীয় ফোল্ডার বা আর্কাইভ থেকে উৎস যোগ করুন; এগুলো তার contributions hash দিয়ে অনুমোদিত হয়। দেখুন [docs/EXTENSIONS.md](../EXTENSIONS.md)।
- **MCPs & Skills।** প্রতিটি রিপোজিটরির জন্য কনফিগারেশন, সেশন কী লোড করবে তার জন্য; নামযুক্ত preset এবং সেশনের মাঝেও বদলানো যায় এমন নিয়ন্ত্রণসহ। দেখুন [docs/KIT.md](../KIT.md)।
- **ডায়াগনস্টিকস।** স্বাস্থ্য পরীক্ষা ও `/health` ডায়াগনস্টিক প্রমাণ-নির্ভর একটি প্রতিবেদন তৈরি করে, যার রায় হয় `certified`, `caution` বা `fault`, এবং যাচাইকৃত সমাধান থাকে। দেখুন [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md)।
- **ট্রাস্ট ও অনুমতি।** ওয়ার্কস্পেস ট্রাস্ট, অনুমতি নিয়ম ও মোড, এবং প্রতিটি সেশন যে কমান্ড প্রত্যাখ্যান করে। দেখুন [docs/TRUST.md](../TRUST.md)।
- **Apollo Mode**, স্পেসিফিকেশন ইন্টারভিউ: এজেন্টের প্রশ্নের উত্তর দিন, যাতে সে একটি প্রোটোটাইপ বানানোর জন্য ব্যবহার করবে এমন স্পেসিফিকেশন সম্পূর্ণ হয়। দেখুন [docs/APOLLO-MODE.md](../APOLLO-MODE.md)।
- **পুনরুদ্ধার।** পারমাণবিক প্রকাশনা, জার্নাল-করা অপারেশন ও স্টার্টআপে মেলানো (reconciliation)। দেখুন [docs/DURABILITY.md](../DURABILITY.md)।

রানটাইম ফ্ল্যাগ `src/substrate/flagRegistry.ts`-এ সংজ্ঞায়িত, `MERCURY_*` সেটিং হিসেবে উন্মুক্ত এবং চাহিদামতো দেখানো হয়। ইন্টিগ্রেশনের সামঞ্জস্য [docs/COMPATIBILITY.md](../COMPATIBILITY.md)-এ লেখা আছে। সম্পূর্ণ ডকুমেন্টেশন সূচি [docs/README.md](../README.md)।

## স্ল্যাশ কমান্ড

`/help` উপলব্ধ ইন্টারঅ্যাকটিভ কমান্ডের তালিকা দেখায়। ফাজি কমান্ড সার্চের জন্য `/palette` ব্যবহার করুন। নিচের টেবিলে ডিফল্টে চালু থাকা বিল্ট-ইন কমান্ডগুলো `/help`-এ ব্যবহৃত বিভাগ অনুযায়ী সাজানো। লাইভ তালিকায় আরও থাকে `/samples` (`current work`-এর অধীনে, যখন Samples চালু থাকে: `MERCURY_SAMPLES=1` বা Boot Menu-এর Samples সারি), `/showcase`, যখন `MERCURY_DEV_SURFACES=1` সেট থাকে, এবং যেকোনো skill বা এক্সটেনশন কমান্ড।

| বিভাগ | কমান্ড |
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

| কমান্ড | কী করে |
| --- | --- |
| `/imagesetup` | স্থানীয় ছবি ও ভিডিও মডেল সেট আপ করুন। |
| `/llmhost` | Runpod, Vast.ai বা Lambda-তে ভাড়া নেওয়ার জন্য একটি মডেল বেছে নিন, নিজের কম্পিউটারে চালান, অথবা বিদ্যমান সার্ভারে সংযুক্ত হন। |
| `/restart` | এই চ্যাটটি ইনস্টল করা Mercury বিল্ডে সরান; চলমান watch ও ব্যাকগ্রাউন্ড shell থেমে যাবে। |
| `/mcp` | সার্ভার দেখুন, সাইন ইন করুন, প্রতিটি সার্ভারের টুল ও প্যারামিটার ব্রাউজ করুন, পুনরায় সংযুক্ত হন, বা এই চ্যাটের জন্য একটি সার্ভার চালু বা বন্ধ করুন। |

`/mouse off` পয়েন্টারকে টার্মিনালে ফিরিয়ে দেয়, যাতে নেটিভ টেক্সট নির্বাচন ও কপি করা যায়। পছন্দটি সংরক্ষিত হয় এবং `/config`-এ Mouse capture হিসেবে দেখায়।

skill-এর ব্যবহারে যে আর্গুমেন্ট বাধ্যতামূলক, তা `<…>` দিয়ে শুরু হয়। যেমন `/update-config` ও `/debug`-এর একটি আর্গুমেন্ট দরকার। শুধু একটি কমান্ড পাঠালে তার বর্ণনা ও ব্যবহার দেখানো হয়; কোনো টার্ন শুরু হয় না। typeahead-এ এটি বেছে Enter চাপলে আর্গুমেন্ট যোগ করার জন্য `/name ` প্রস্তুত থাকে। `/loop`-এর কোনো বাধ্যতামূলক আর্গুমেন্ট নেই, এবং এটি সঙ্গে সঙ্গে চলে।

## সমস্যা জানানো

সংক্ষিপ্ত প্রতিবেদনের জন্য [টেস্টার ফর্ম](https://mercury-cli.ai/report) ব্যবহার করুন, অথবা Mercury-র ভেতরে `/bug --short <what you tried>`। এটি আপনার OS, কী চেষ্টা করেছিলেন ও কী ভেঙেছে তা জিজ্ঞেস করে; স্বাস্থ্য পরীক্ষার পূর্ণ ডাম্প দরকার হয় না।

জমা দেওয়ার আগে প্রতিবেদনটি দেখতে Mercury-র ভেতরে `/bug <what happened>` চালান; তারপর সাইন-ইন করা GitHub CLI (`gh`) দিয়ে সেটি জমা হয়। `gh` না থাকলে Mercury কনফিগ হোমের অধীনে একটি স্থানীয় খসড়া সংরক্ষণ করে এবং রিপোজিটরির issues পাতার দিকে নির্দেশ করে।

bug, provider/model বা feature request টেমপ্লেট ব্যবহার করে সরাসরি একটি issue খুলতেও পারেন। আপনার `--version` আউটপুট, OS, টার্মিনাল ও সঠিক ধাপগুলো যোগ করুন। bug ও provider প্রতিবেদনে `mercury health --json` লাগে, অথবা সোর্স বিল্ডে `node dist/mercury.mjs health --json`। ব্যর্থ স্ক্রিনের একটি ট্রান্সক্রিপ্ট কাজে লাগে।

নিরাপত্তা সমস্যা রিপোজিটরির Security ট্যাবের মাধ্যমে ব্যক্তিগতভাবে জানান। সেগুলো প্রকাশ্য issue-তে রাখবেন না। দেখুন [SECURITY.md](../../SECURITY.md)। issue, pull request ও check নিয়ে আলোচনা আছে [CONTRIBUTING.md](../../CONTRIBUTING.md)-এ।

## লাইসেন্স

Mercury CLI [LICENSE.md](../../LICENSE.md)-এ দেওয়া Apache License 2.0 (`Apache-2.0`)-এর অধীনে লাইসেন্সপ্রাপ্ত। [sdk/](../../sdk/) ও [sdk-py/](../../sdk-py/)-এর TypeScript ও Python SDK-গুলোও (npm ও PyPI-তে `mercury-cli-sdk`) Apache License 2.0 (`Apache-2.0`)-এর অধীনে লাইসেন্সপ্রাপ্ত; প্রতিটি তার সঙ্গের LICENSE ফাইল অনুযায়ী ([sdk/LICENSE](../../sdk/LICENSE) ও [sdk-py/LICENSE](../../sdk-py/LICENSE))।

Mercury-এর নাম ও চিহ্নের ব্যবহার [ট্রেডমার্ক নীতি](../../TRADEMARKS.md)-র অধীন। বান্ডল করা তৃতীয়-পক্ষের লাইসেন্সগুলো [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)-এ তালিকাভুক্ত।
