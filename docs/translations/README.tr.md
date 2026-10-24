[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI (mercury-cli.ai, npm paketi `mercury-tech-cli`), macOS, Linux ve Windows üzerinde kendi git depolarınızın içinde, terminalinizde yapay zekâ kodlama ajanlarını çalıştırır.

Web sitesi: [mercury-cli.ai](https://mercury-cli.ai) · Depo: [github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI) (`Whq02/MercuryCLI`) · npm: `mercury-tech-cli`

Bir ajan dosyaları okur ve düzenler, shell komutları çalıştırır, testlerde ve hata ayıklayıcılarda adım adım ilerler ve sonuçları denetler. Model sağlayıcısını, modeli ve ajanın neler yapabileceğini siz seçersiniz:

- **Çoklu oturum Concourse ve yalıtılmış worktree'ler:** Session Concourse'ta (`/concourse`) birden fazla oturumu yan yana çalıştırın ve paralel işleri farklı sağlayıcılardan crewmate'lere (`Crewmate`), yalıtılmış `git worktree` kopyalarında ve proje dosyası kiralamalarıyla (project file leases) devredin; böylece paralel ajanlar birbirlerinin dosyalarının üzerine yazmaz.
- **20 model sağlayıcı, `/llmhost` ve `/localsetup`:** 20 sağlayıcının tamamında aynı anda oturum açık tutun (OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot/Kimi, Z.AI/GLM, OpenRouter, Hugging Face, xAI/Grok, Meta/Muse, Mistral, Nous Portal, OpenCode Zen, Qwen, MiniMax, Together AI, Cohere, Groq, Cerebras, Fireworks AI) ve sohbetin ortasında sağlayıcı ile modeli değiştirin. `/llmhost` komutunu açarak bir model seçin, quantization durumunu, `conversations × context` bölümünü ve düşünme (thinking) düzeyini inceleyin; modeli kiralık bir GPU'da (Runpod, Vast.ai veya Lambda), kendi bilgisayarınızda (`mercury host`) ya da mevcut bir sunucuda çalıştırın. Ya da `/localsetup` komutuyla LM Studio, vLLM ve llama.cpp yanında Ollama'yı kurun veya bağlayın.
- **Mneme hibrit RAG proje belleği:** cihaz üzerinde çalışan 118 MB'lık BGE semantic embedding modelini (`bge-base-en-v1.5`) kullanır; bunun yanında BM25 kelime sıralaması ve alıntı takibi, kelimesi kelimesine sabitlenmiş kurallar, dal farkındalıklı başlangıç bağlamı, yazma anında çelişki denetimleri, oturum devir notları ve `/memory page` tarayıcı grafiği bulunur.
- **Derleyici, AST ve DAP hata ayıklama araçları:** LSP kod zekâsını ve önizlemeli yeniden düzenlemeleri (`LspRead`, `LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`), 23 dilli tree-sitter AST yapısal aramasını ve yeniden yazmayı (`AstSearch`, `AstEdit`), başarısız Python, Node, Go ve Rust testlerinin içine adım adım girmek için yerleşik bir Debug Adapter Protocol (`Debug`) hata ayıklayıcısını (`debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`) ve kalıcı Python ile JavaScript `Eval` hücrelerini bağlar.
- **Anahtarsız `WebSearch` ve markdown `WebFetch`:** sağlayıcının kendi aramasını, Brave veya Tavily anahtarlarını, resmî API'leri (Stack Exchange, npm, PyPI, crates.io, GitHub, Hacker News, Wikipedia), SearXNG'yi ve anahtarsız DuckDuckGo'yu kullanarak arama yapar; genel belgeleri 38.000 karakterlik bir çağrı bütçesi içinde markdown olarak getirir.
- **Masaüstü bilgisayar kullanımı, Whisper ses, Saturn zamanlaması ve editör köprüleri:** masaüstü uygulamalarını denetler (`Computer`), bas-konuş (push-to-talk) ses diktesini cihaz üzerinde Whisper ile metne döker (`/voice`), Saturn ile tekrarlayan veya tek seferlik oturumları zamanlar (`/saturn`) ve Agent Client Protocol üzerinden (`mercury acp`) VS Code'a, bunun yanında Unity, Blender, Godot ve Aseprite'a bağlanır.
- **Video üretimi (`Video`):** yapılandırılmış bir MiniMax üreticisine istemleri (prompt) ve proje referans dosyalarını gönderin ([docs/VIDEO.md](../VIDEO.md)); üretilen MP4'ü ve 1. saniyedeki isteğe bağlı PNG önizleme karesini projenizde kaydedin.

Mercury, uzun görevler boyunca birden fazla oturum ve model çalıştırarak Mercury'yi geliştirmek için kullanılır. Bu işi takip etmek asıl zor kısımdır: hâlâ neyin çalıştığı, neyin değiştiği ve neyin bir karara ihtiyaç duyduğu. Her oturum bittiğinde kendi devir notunu yazar; bir sonraki oturum başlarken bu notu benim sabitlenmiş kurallarımla birlikte bir kez okur ve oturumlar arasında bağlamın kirlenmesini (context poisoning) önler.

![Oturum panosunda koordinatöre tek bir istem verildiğinde, her biri kendi worktree'sinde olmak üzere iki oturum başlar; biri düzenlemeden önce soru sorar, ikisi de incelemeye hazır değişikliklerle tamamlanır](../media/session-board.gif)

Mercury, Business Source License 1.1 kapsamında kaynak kodu erişilebilir durumdadır; [sdk/](../../sdk/) ve [sdk-py/](../../sdk-py/) içindeki SDK'lar ise Apache License 2.0 kapsamında lisanslanmıştır. Üretimde kullanım koşulları için [Lisans](#lisans) bölümüne bakın.

## Kurulum

Sürüm arşivleri Apple silicon ve Intel Mac'ler, Linux x64 ve arm64, Windows x64 ve arm64 için sunulur. `git` aracını ayrıca kurun; her arşiv Node ve ripgrep içerdiğinden ayrı bir Node kurulumuna gerek yoktur.

Kurulum yöntemlerinden birini seçin:

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS ve Linux (x64 ve arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows (x64 ve arm64), PowerShell 7'de
brew install Whq02/mercury/mercury                 # Homebrew: macOS ve Linux x64
npm install -g mercury-tech-cli                    # npm; `bun install -g mercury-tech-cli` aynı paket
mise use -g npm:mercury-tech-cli                   # mise, npm paketi üzerinden
```

Kurulum adresleri, kaynağa ve UTC gününe göre yaklaşık betik istek sayılarını tutar (tamamlanan kurulumlar sayılmaz); sayaç hiçbir IP adresi, user-agent dizgisi veya çerez saklamaz.

Yeni bir terminal açın ya da shell kurucunun yazdırdığı `export PATH=…` satırını çalıştırın; ardından doğrulamak için `mercury --version`, [ilk çalıştırma](#i̇lk-çalıştırma) için bir depo dizininden `mercury` komutunu çalıştırın. Windows PowerShell'de ve Homebrew, npm, bun ya da mise kurulumundan sonra `mercury` aynı terminalde çalışır.

<details>
<summary>Kurulum yolları, güncellemeler ve sürüm doğrulaması</summary>

### Kurulum yöntemlerinin farkları

shell ve PowerShell kurucuları platformunuz için en yeni sürümü indirir, SHA-256 değerini `SHA256SUMS.txt` ile karşılaştırır, arşivi açar ve arşivin kendi `mercury install` komutunu çalıştırır.

Homebrew ve npm paketi her biri belirli bir sürüme sabitlenmiştir ve bir tag'den sonra yeniden yayımlanır; bu yüzden en yeni sürümün gerisinde kalabilirler. Homebrew komutları tam tap adı `Whq02/mercury/mercury`'yi kullanır (yalın `mercury`, `homebrew-core` içinde farklı bir programdır). `mercury-tech-cli` npm paketi, sabitlenmiş sürümünü indiren bir başlatıcıdır; mise de aynı paketi kurar. `mercury install --uninstall`, yapılandırmanızı ve oturumlarınızı koruyarak kurulu sürümü ve komut shim'ini kaldırır (npm başlatıcısını kurduysanız `npm uninstall -g mercury-tech-cli` komutunu da çalıştırın).

Mercury'nin kurulumu kullanıcıya özeldir ve yönetici erişimi gerektirmez. Bir kurulum komutunu güvenle yeniden çalıştırabilirsiniz.

### Kurulum yolları

Sürüm dosyaları yapılandırma ana dizini (config home) altında `~/.mercury/versions/<version>` konumunda bulunur (Windows'ta `%USERPROFILE%\.mercury\versions`). `mercury` komutu macOS ve Linux'ta `~/.local/bin` içine, Windows'ta ise `%LOCALAPPDATA%\Mercury\bin` içine kurulur.

`mercury install`, komutun dizinini PATH'e bir kez ekler: shell başlangıç dosyanıza korumalı bir satır ya da Windows kullanıcı PATH'ine bir girdi olarak. Yeni açılan bir terminal bu değişikliği otomatik olarak algılar.

### Güncellemeler

Herhangi bir kurulum yöntemiyle `mercury update` komutunu kullanın.

shell veya PowerShell kurucusuyla ya da `mercury install` ile yapılan kurulumlarda Mercury'yi yerinde günceller. `--check` güncelleme olup olmadığını denetler, `--status` güncelleme durumunu bildirir, `--rollback` ise diskte kalan önceki sürüme döner.

Homebrew için `brew upgrade Whq02/mercury/mercury` komutunu çalıştırmadan önce sorar. Varsayılan yanıt hayırdır; onaylamak için `y` girin. Mercury komutun çıktısını akış hâlinde gösterir ve ardından kurulu sürümü denetler. Betiklerde soruyu atlamak için `--yes` kullanın.

npm başlatıcısı kurucularla aynı sürüm düzenini kullanır ve her çalıştırmayı kurulu sürüme devreder. Bu nedenle `mercury update`, npm kurulumunu da Mercury'nin kendi güncelleme kanalı üzerinden yerinde günceller. `npm update -g mercury-tech-cli` ise paketin ilk çalıştırmasında kurduğu sürümü değiştirir. Bu durum mise kullanıldığında da geçerlidir.

`--check`, her kurulum yöntemi için aynı sürüm listesini okur ve kurulumunuzun nasıl güncelleneceğini söyler. Bir güncelleme mevcut olduğunda ana ekranda sağ alt köşede `vX.Y.Z available · mercury update` bir kez görüntülenir ve sohbette geçici bir bildirim gösterilir. İkisini de gizlemek için `MERCURY_UPDATE_NOTICE=0` ayarlayın.

Kurulum ve güncelleme istekleri genel sürüm listesini ve arşivleri isimsiz olarak alır. Bunları hesap veya token olmadan çalıştırabilirsiniz. İsimsiz bir istek reddedilirse Mercury, oturumu açık bir GitHub CLI'ye (`gh`) başvurur.

Bir güncellemeden sonra Mercury, PATH'inizdeki komutun güncellenmiş kuruluma işaret edip etmediğini denetler. Başka bir kurulum öncelikli ise ya da güncellenmiş komut PATH'te yoksa, sorunu ve çözümünü açıklar. `mercury health` aynı sorunu bildirir.

### Sürüm doğrulaması

Bir sürümü etkinleştirmeden önce Mercury, arşivini `SHA256SUMS.txt` ile denetler. Ayrıca güncellemeyi hazırlamadan önce, derlenmiş güven listesindeki Mercury sürüm anahtarıyla imzalanmış bir payload da ister. Reddedilen bir imza, etkin kurulumu değiştirmez.

İmzasız bir payload'ı kabul etmek için `--allow-unsigned` kullanın. Mercury yine de bilinmeyen imzalama anahtarlarını, bozuk imza bloklarını ve kurcalanmış içerikleri reddeder. Komutun sonucu ve yerel kaydı, imzasız bir payload'a izin verdiğinizi gösterir.

1.0.0-beta.3 sürümünden itibaren arşivler paketleme sırasında imzalanır ve yayımlanmadan önce imzaları doğrulanır. Doğrulanmış bir kurulum, başlangıçta herhangi bir imza bildirimi göstermez. `mercury health`, `627b54b734ca0e72` imzalama anahtarını bildirir.

1.0.0-beta.2 arşivleri imzasızdır. Bu kurulumlar, Mercury'yi komut veya bayrak olmadan etkileşimli olarak başlattığınızda, kurulum başına bir kez imzasız köken bildirir. Sağlık denetimi bu durumu göstermeye devam eder. Bu, arşiv manifest'inde imza bulunmadığı anlamına gelir; indirme yine de `SHA256SUMS.txt` ile denetlenir.

[docs/TRUST.md](../TRUST.md) doğrulama sonuçlarını ve bir arşivin elle nasıl denetleneceğini açıklar. [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) başlangıç doğrulamasını ele alır.

### Platform notları

Yukarıda listelenen her platform için sürüm arşivleri vardır. Diğer tüm makineler kaynaktan derlenir.

Intel Mac arşivleri 1.0.0-beta.3 sürümünden itibaren kullanılabilir. Bunlar bir Apple silicon çalıştırıcısında çapraz paketlenir ve yayımlanmadan önce Rosetta altında başlangıçta test edilir. 1.0.0-beta.2 kullanan Intel Mac'ler için kaynaktan derleme gerekir.

</details>

## Gereksinimler

Sürüm arşivleri Node 24 LTS içerir. Başlatıcı, `mercury install` ve `mercury update` bu paketlenmiş çalışma zamanını kullanır; sürümün kendisi için ayrıca yalnızca `git` gerekir.

Kaynaktan derlemek için şunlara ihtiyacınız vardır:

- **Node 24 LTS**, desteklenen `>=24.20.0 <25` aralığında. `.node-version` dosyası, derlemelerde kullanılan ve sürüm arşivlerine de dahil edilen yama sürümünü sabitler.
- **bun 1.3.x**, derleme için. Sürümlerle birlikte paketlenmez.
- **git**. Windows'ta PowerShell 7'yi Windows Terminal veya VS Code terminali içinde çalıştırın. Bkz. [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md).

Node'un asgari sürümü nodejs/node#56645 düzeltmesini içerir. 24.20.0'ın altında, Windows'ta bir araç çağıran headless `run` komutları çıkış sırasında iptal edilir.

Başlatıcılar Node'u şu sırayla seçer: açıkça belirtilen `MERCURY_NODE` ikilisi, paketlenmiş çalışma zamanı, ardından PATH üzerindeki uyumlu bir Node kurulumu. Çalışma zamanı yoksa başlatıcı bir hata bildirir.

### Windows kabukları

Sürüm arşivleri Mercury'nin bash uyumlu shell motorunu (`brush`) içerir ve Windows'ta varsayılan olarak Bash aracına hizmet verir: `.cmd` veya `.bat` uzantılı bir programı (örneğin `npm`) PATHEXT üzerinden yalnızca adıyla bulur, `%VAR%` ve `^` karakterlerini bir batch dosyasına değiştirmeden iletir, `cd` sonrasında göreli bir yolla belirtilen programı çalıştırır ve çağrılar arasında shell durumunu korur. Git for Windows'un `bash.exe` dosyası gerekli değildir; kuruluysa `MERCURY_SHELL_ENGINE=system` ortam değişkeni ya da `system` seçeneği (`/config` içindeki Shell engine ayarında), Bash aracını yalnızca `bash.exe` üzerinde çalıştırır.

Hangi shell'in etkin olduğunu ve nedenini görmek için sağlık denetiminin `shell` satırını okuyun: paketlenmiş motor (Windows varsayılanı ya da sabitleme veya ayar ile etkinleştirilmiş), ya da motor kapalıysa veya paketi yoksa Git Bash.

macOS ve Linux'ta varsayılan olarak sistem shell'i kullanılır; Bash aracını orada da paketlenmiş motorla ve kalıcı shell durumuyla çalıştırmak için `MERCURY_SHELL_ENGINE=brush` ayarlayın ya da `brush` seçeneğini (`/config` içindeki Shell engine bölümünden) belirleyin.

Motor paketi veya Git for Windows olmadan yapılan bir kaynak derlemesi yine de başlar, ancak Bash aracı kullanılamaz. PowerShell aracı kullanılabilir kalır ve `shell` tanılaması Bash desteğinin nasıl geri getirileceğini açıklar.

## Kaynaktan derleme

Mercury, bun ile derlenir ve Node 24 LTS üzerinde çalışır. bun 1.3.x dahil [kaynaktan derleme gereksinimlerini](#gereksinimler) kurun:

```sh
curl -fsSL https://bun.sh/install | bash           # macOS ve Linux
powershell -c "irm bun.sh/install.ps1 | iex"       # Windows, PowerShell 7'de
bun --version                                      # 1.3.x
```

Ardından bu deponun bir kopyasında:

```sh
bun run setup                      # bir kez; bun install + paketlenmiş (vendored) paketler
bun run build.ts                   # dist/mercury.mjs + dist/manifest.json yazar
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### Terminal desteği

Tam ekran arayüzü gerçek bir TTY gerektirir, ancak terminal için asgari bir boyut yoktur. Tam düzen 100 sütun × 26 satırdan başlar; daha küçük pencerelerde kompakt bir düzen kullanılır.

Terminal `COLORTERM=truecolor` üzerinden destek bildirdiğinde ya da iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal veya VS Code olarak tanındığında Mercury 24 bit renk kullanır. macOS 15 ve önceki sürümlerdeki Apple Terminal dahil diğer terminaller 256 renk kullanır.

Sağlık denetiminin Terminal color satırı, algılanan derinliği ve nedenini bildirir. True colour'ı destekleyip bunu ilan etmeyen bir terminal için `MERCURY_TRUECOLOR=1` ayarlayın; 256 rengi zorlamak için `MERCURY_TRUECOLOR=0` ayarlayın.

### İsteğe bağlı bileşenler

`setup`, paketlenmiş yetenek paketlerini indirir: pyright, debugpy, js-debug, ek dilbilgisi (grammar) paketleri, platformun Node çalışma zamanı ve brush. Bir indirme başarısız olursa o paket atlanır ve derleme ile etkilenen araçlar eksik bileşeni bildirir. Yalnızca `bun install` çalıştırmak, bu paketler olmadan bir derleme üretir.

Ses desteğini derlemek için Rust kurulu iken `setup` komutunu çalıştırın; bu `native/voice` dosyasını derler. `native/whisper`'ı da derlemek için cmake ekleyin. Rust kuruluyken `setup`, masaüstü sürücü eklentisini (`native/desktop`) de derler (`Computer` aracı bunun üzerinden çalışır). Ayrıca Rust kuruluyken `setup`, yerel gömme (embedding) eklentisini (`native/embed`, `bun run scripts/vendor/build-embed.ts`) derler ve 118 MB'lık BGE modelini (`bun run scripts/vendor/fetch-embed-models.ts --default`) indirir. cargo yoksa paket atlanır, setup bunu bildirir ve Mneme bellek aramaları yalnızca kelime eşleştirmesi yapar. Her sürüm arşivi, kendi platformu için derlenmiş gömme paketini içerir. Linux ve Windows'ta hesaplamalar vektörleştirilmiş bir çekirdekte çalışır; bu yüzden anlama dayalı bir Recall yaklaşık saniyenin onda biri kadar sürer (Accelerate kullanan macOS'te birkaç yüzde bir saniye). Yerel bir derlemede araçlar eksikse setup onu atlar ve sağlık denetimi eksik eklentiyi bildirir. Windows shell motoru da upstream'de bir Windows ikilisi bulunmadığından makinenizde derlenir.

`brush` shell motoru için bkz. [Windows kabukları](#windows-kabukları) ve [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md).

Derleme yalnızca `dist/` dizinine yazar. Yapılandırma ve oturumlar `~/.mercury` dizininde ya da `MERCURY_CONFIG_DIR` ile belirlenen dizinde bulunur ve ilk çalıştırmada oluşturulur. Windows'ta `node dist\mercury.mjs` komutunu doğrudan çalıştırın.

### Kaynak derlemesini komut olarak kurmak

`scripts/ops/deploy-runtime.sh`, temiz ağaçtan alınmış bir derlemeyi yeni bir `<config home>/runtime/builds/<build>` klasörüne yayımlar ve `runtime/current` bağlantısını ona yöneltir (`runtime/dist`, aynı bağlantının eski adıdır). `scripts/ops/deploy-launcher.sh`, başlatıcıyı `<config home>/bin/mercury` konumuna kurar. Bu dizini PATH'e ekleyin; zsh için:

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

Çalışma zamanı yoksa başlatıcı bir hatayla durur. Başka bir derlemeye geçmez. Node seçimi [Gereksinimler](#gereksinimler) bölümündeki sırayı izler. Bir sürüm kurulumu için `mercury install` veya `mercury update` çalıştırın; bunlar kaynak kopyalarını değiştirmez. Bkz. [Güncellemeler](#güncellemeler).

[AGENTS.md](../../AGENTS.md), derleme ve çalıştırma için kısa rehberdir. [BUILD-NOTES.md](../../BUILD-NOTES.md) derlemeyi daha ayrıntılı ele alır.

## İlk çalıştırma

İlk etkileşimli çalıştırmada bir görünüm seçin, ardından bir sağlayıcıda oturum açın. Ekran, gezinirken tema değişikliklerini önizler. Varsayılan True Black'tir; diğer seçenekler oasis dark teması ile hiç renk kullanmayan Black and white'tır: terminalin kendi mürekkebi, kendi zemininde; yani Mercury'nin renksiz bir terminalde göründüğü biçimde. Bunu daha sonra `/appearance` ile değiştirebilirsiniz.

Bir hesap bağlamadan göz atmak için "sign in later" seçeneğini de belirleyebilirsiniz. Ortamınızdaki bir sağlayıcı anahtarı zaten bir sağlayıcıda oturum açmışsa oturum açma adımı sorulmaz. Ardından Guardrails adımı, Mercury'nin düzenlemelerini ve komutlarını denetlemenizi hatırlatır; ayrıca okuduğu içeriğin modele yönelik talimatlar taşıyabileceğini bildirir. Mercury'nin yapılandırabildiği bir terminalde (Terminal.app, VS Code ailesi, Alacritty, Zed), bir Terminal keys adımı terminalin kendi ayarlarında yeni satır tuş bağlarını yapılandırabilir. macOS'ta Terminal.app'te yeni satır için `Option+Enter` ayarlanır ve her profilde terminal zil sesi kapatılır; bu, Terminal.app yeniden başlatıldıktan sonra etkinleşir. VS Code ailesi, Alacritty ve Zed'de yeni satır için `Shift+Enter` yazılır. Siz seçmedikçe bu adım kapalıdır ve bir yedek tutulur.

Ardından Mercury, açtığınız klasöre güvenip güvenmediğinizi sorar. Çalışma alanı yapılandırmasının istediği hiçbir şey, bu güveni vermeden önce çalışmaz. Verilen güven tüm depoyu kapsar; reddetmek Mercury'den çıkmanıza neden olur. Bkz. [docs/TRUST.md](../TRUST.md).

Normal bir etkileşimli başlatma ana ekranı açar. Ekranda on menü girdisi bulunur; Continue Last Session girdisi yalnızca oturum geçmişiniz olduktan sonra görünür:

- **New Session in \<folder\>**, geçerli klasörde yeni bir oturum başlatır.
- **Continue Last Session**, en son sohbetinize döndürür.
- **Boot Menu**, motion, crewmate'ler ve workflow'lar dahil sonraki oturumları yapılandırır.
- **MCPs & Skills**, bir sonraki oturumun neleri yükleyeceğini seçer. Bkz. [docs/KIT.md](../KIT.md).
- **Agents**, ajanlar oluşturur ve düzenler.
- **Health Check**, kurulumu denetler.
- **Saturn Scheduler**, oturumları zamanlar. Bkz. [docs/SATURN.md](../SATURN.md).
- **Logins**, sağlayıcı hesaplarını bağlar.
- **Session Concourse**, geçerli projenin oturum listesini açar.
- **Sessions · Projects**, bir oturum veya depo seçmenizi sağlar.

Menü girdileri ana ekranın üzerinde açılır ve `Esc`, seçtiğiniz girdiye geri döndürür. Oturum listesi ayrı bir ekranda açılır ve `Shift+→` ile de erişilebilir. Bir prompt argümanı, `--continue` veya `--resume` sizi doğrudan sohbete götürür.

### Motion, crewmate'ler ve workflow'lar

Boot Menu'nün Performance bölümünde bir Motion ayarı bulunur: `auto`, `full`, `reduced` veya `off`. Arayüzdeki boşta kalma animasyonunu denetler ve `/config` içinde de bulunur.

Agents altındaki Crewmates ve Workflows anahtarları, yeni oturumların Crewmate ve Workflow araçlarını alıp almayacağını belirler. Bir anahtarı kapatmak ilgili aracı kaldırır; o türde iş başlatma girişimleri aynı açıklamayı döndürür. Bir oturum içinde `/crewmates on|off` ve `/workflows on|off`, ayarı bir sonraki tur sınırında değiştirir.

## Günlük döngü: Session Concourse, git worktree'ler ve crewmate'ler

### Oturum başlatma ve worktree'leri yalıtma

Geçerli klasörde varsayılan modelinizle bir oturum oluşturmak için New Session üzerinde `Enter` tuşuna basın. Mercury sohbeti açar ve aynı anda oturumu oturum listesine ekler. Başlangıç işini azaltmak için menünün arkasında hazır bir süreç tutar.

Başka bir oturum başlatmak, öncekini durdurmaz. Bir görevi çalışır durumda bırakıp başka bir yerde çalışabilirsiniz. `--worktree [name]` ile başlatarak (ya da sohbette `worktree` isteyip `EnterWorktree` çalıştırarak) oturuma `.mercury/worktrees/` altında kendi dalını ve çalışma kopyasını verin. Paralel crewmate'ler de yalıtılmış worktree'lerde çalışabilir ve paylaşılan dosyaları proje dosyası kiralamalarıyla koordine edebilir; bkz. [İçinde neler var](#i̇çinde-neler-var-mneme-rag-belleği-lsp-23-dilli-ast-dap-hata-ayıklayıcı-web-araması-ve-köprüler) ve [docs/CREW.md](../CREW.md).

### Sohbette çalışmak

İşi sade bir dille anlatın. Ajan, seçtiğiniz izin modu altında kodu okur, düzenler, çalıştırır ve denetler. Araç çağrıları çalıştıkça görünür; ya kompakt kartlar hâlinde ya da tam çıktıyla. Görüntüleme biçimini `/config` içindeki Tool output bölümünden seçin; ayar sonraki başlatmalar için kaydedilir.

Oturumu ayarlamak için `/model` ve `/effort` komutlarını kullanın. `/permissions`, onay olmadan neyin çalışabileceğini ve neyin önce soru sorması gerektiğini denetler.

Değişiklikleri `/diff` ile kaynak, dosya ve hunk bazında inceleyin. `! <command>`, sohbet içinde bir shell komutu çalıştırır ve çıktının canlı sonunu gösterir. `/runs`, çalışan shell'leri ve crewmate'leri gösterir (`/tasks` aynı panoyu açar); `/crewmates` ise canlı Crew görünümünü açar. Turlar arasında `/clear`, geçerli sohbeti kaydeder ve yeni bir oturum açar; `/restart` ise sohbeti yeni kurulan bir Mercury sürümüne taşır. `/title` sohbete ad verir, `/help` ise kullanılabilir komutları listeler.

### Ekranlar arasında geçiş

`Shift+←` ve `Shift+→`, o anda kullanılabilir ekranlar arasında geçiş yapar. Yeni bir başlatmada ana ekran ve oturum listesi bulunur. Bir oturum odaklandığında sohbet ekranı eklenir ve son sohbet kapandığında kaldırılır. Tuş ipuçları yalnızca kullanılabilir geçişleri gösterir.

Tüm sohbetleri kapatmak sizi ana ekrana döndürür. Oturum listesi olmadan yalnızca ana ekran ve sohbet için `--chat` kullanın. `--concourse-off` bu tercihi sonraki başlatmalar için kaydeder; `--concourse-on` veya `/config` bunu yeniden açar.

### Session Concourse'ta oturumları yönetme

Ana ekrandan `/concourse` veya `Shift+→` ile oturum listesini açın. Önce geçerli projenin çalışan oturumlarını, ardından çalışmayan kayıtlı sohbetleri, en yenisi önce olacak biçimde gösterir.

Çalışan her oturumun, güncel etkinliğini gösteren bir NOW hücresi vardır. Bir satır seçip `Enter` tuşuna basarak sohbete dönün; diğer oturumlar çalışmaya devam eder. Çöken bir oturum, nedeniyle birlikte oturum listesinde NEEDS YOU olarak görünür ve siz serbest bırakana kadar orada kalır.

Oturumların yaşam döngüsü [docs/SESSIONS.md](../SESSIONS.md) dosyasında ele alınır.

## Sağlayıcılar ve modeller: oturum açmalar, `/localsetup` ve `/llmhost`

Bir sağlayıcıyı bağlamak için `/logins` komutunu kullanın. Kurulum sırasında kullanılan aynı oturum açma kataloğunu açar. `/accounts` ise sonrasında bağlı sağlayıcı yuvalarını yönetir.

- **OpenAI:** ChatGPT aboneliği veya API anahtarı.
- **Anthropic:** Claude aboneliği, Console oturum açma veya API anahtarı.
- **OpenRouter:** OAuth veya API anahtarı ile katalog erişimi; model istekleri veri toplamayı reddeder ve baştan her parametreyi zorunlu tutar. `/config → OpenRouter routing policy`, yedek ve sıfır veri saklama (zero-data-retention) seçimlerini belirler; politikayı gevşetmek ve yönlendirmeyi OpenRouter'a bırakmak için open seçeneğini belirleyin.
- **Google Gemini:** Sign in with Google, bir API anahtarı veya kendi OAuth istemciniz. Sign in with Google, Gemini'yi Google hesabının sahip olduğu planın kotası üzerinden (ücretsiz hesap, Google AI Pro veya Google AI Ultra) Google'ın kendi Antigravity istemcisiyle çalıştırır: prompt, araç şemaları ve araç sonuçları, bu istemci ve oturum açılmış hesap altında Google'ın Code Assist uç noktasına gider; `/model` ise Google'ın bu hesaba sunduğu modelleri listeler. Bir API anahtarı veya kendi OAuth istemciniz ise bunun yerine bir Cloud projesine faturalandırılır.
- **Hugging Face:** cihaz kodu ile oturum açma veya Hub token'ı.
- **Kimi (Moonshot):** cihaz kodu ile oturum açma veya API anahtarı.
- **GLM (Z.AI):** bir GLM Coding Plan abonelik anahtarı ya da genel kullanım-başına-ödeme (pay-as-you-go) API anahtarı. `/logins zai` ikisinden birini saklar ve planı kaydeder; `ZAI_API_KEY` de çalışır, planı `ZAI_KEY_PLAN=coding|general` adlandırır (ayarlanmadıysa Mercury planı anahtarın kendi model listesinden okur).
- **DeepSeek:** DeepSeek platformundan bir API anahtarı (`/logins deepseek` veya `DEEPSEEK_API_KEY`).
- **xAI (Grok):** Grok aboneliğinizle (SuperGrok / X Premium) oturum açın veya `/logins xai` üzerinden bir API anahtarı yapıştırın.
- **Meta (Muse):** Sign in with Meta (bir Muse Code aboneliği, tarayıcınızdaki bir cihaz kodu) veya kullanım-başına-ödeme Model API anahtarı. Sign in with Meta, cihaz kodunu Muse Code'un genel client id'si altında Meta'nın OIDC uç noktalarında (`https://auth.meta.com/oidc/device/authorization/` ve `/oidc/device/token/`) takas eder; ortaya çıkan hesap token'ını aboneliğin API anahtarını üretmek için bir kez `https://api.meta.ai/muse-code/key` adresine gönderir (ayrıca plan düzeyi ve kullanım pencereleri için sınırlı `/usage` okumalarında), ve her model isteğinde yalnızca üretilen anahtarı `https://api.meta.ai/v1` adresine gönderir. Yapıştırılan bir Model API anahtarı ya da `MODEL_API_KEY` / `META_API_KEY`, kullanım-başına-ödeme olarak faturalandırılır.

- **Qwen:** bir QwenCloud anahtarı (Token Plan veya kullanım-başına-ödeme) ya da bir Alibaba Cloud Model Studio anahtarı (kullanım-başına-ödeme, Token Plan veya Coding Plan); kaydedilmeden önce kendi uç noktasında denetlenir. Plan anahtarı, planın modellerini listeler; Qwen3.8 Max en başta.
- **MiniMax:** bir Open Platform anahtarı veya bir M Plan abonelik anahtarı.
- **Together AI** ve **Cohere:** API anahtarı.
- **Groq**, **Cerebras** ve **Fireworks AI:** API anahtarı; herhangi bir ailenin anahtarı, `credentials.keyCommands.<family>` içinde adı verilen bir komuttan da gelebilir.

Mistral, Nous Portal ve OpenCode Zen de `/logins` üzerinden bağlanır; toplamda 20 sağlayıcı ailesi için oturum açma desteklenir. Yerel model sunucuları (Ollama, LM Studio, vLLM ve llama.cpp) ile özel OpenAI uyumlu uç noktalar, bir sağlayıcı oturumu olmadan çalışır. Ollama'yı kurmak ya da başlatmak, belleğinize sığan bir model çekmek, bağlam penceresini ayarlamak veya çalışan bir LM Studio, vLLM ya da llama.cpp sunucusuna bağlanmak için `/localsetup` komutunu çalıştırın ([docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)). Her sağlayıcı kendi protokolünü, kimlik bilgilerini ve hata yönetimini kullanır; istekler hiçbir zaman başka bir sağlayıcıya geri düşmez. Bkz. [docs/ENGINES.md](../ENGINES.md).

`/llmhost`, barındırabileceğiniz modelleri listeler ve her birinin şu anda nerede çalışabileceğini gösterir: Runpod, Vast.ai veya Lambda'dan kiralanan bir GPU'da, kendi bilgisayarınızda ya da kayıtlı bir SSH bilgisayarında (`mercury host`), ya da mevcut bir model sunucusunda. Her model sayfasında quantization seçenekleri, GPU bellek bütçesinin paralel konuşmalara nasıl bölündüğü (`conversations × context`) ve varsayılan düşünme düzeyi (`/effort` bunu istek başına değiştirir) gösterilir. GPU kiralamaları açık bir saatlik fiyat onayı gerektirir; açılır pencereyi kapatırsanız kurulum arka planda devam eder. Runpod'da, kiralamadan önce ya da çalışan bir pod üzerinde kaliteyi, bağlam bölümlerini ve düşünmeyi de ayarlayabilir (`Tune`), ağırlıkları hızlı yüklenen bir volume üzerinde tutabilir ve 5 saniyelik stok izlemeleri kurabilirsiniz. Vast.ai ve Lambda kiralamaları 1.0.0-beta.40 sürümünde yenidir ve satıcıların yayımlanmış API'lerine karşı fixtures ile doğrulanmıştır (canlı kiralama çalıştırmaları yapılmamıştır). Bkz. [docs/LLM-HOST.md](../LLM-HOST.md).

Yeni oturumlar, en son bağladığınız sağlayıcıyı ve o hesap için kullanılabilir en yeni modeli kullanır. Hesabın erişemediği modeller atlanır. Bu sağlayıcının kullanılabilir bir modeli yoksa Mercury, bir sonraki en son bağlanan sağlayıcıyı denetler. Bu seçim oturum başladığında yapılır; mevcut bir oturumdaki başarısız bir istek, sağlayıcısında kalır.

`/model`, seçimi açıklar. Bir aile adı, o ailenin en yeni modelini seçer: `/model grok`, `/model deepseek`, `/model kimi` veya `/model glm`. Hiçbir sağlayıcı bağlı değilse ana ekran ve `/model` sizi `/logins` komutuna yönlendirir. `/defaultprovider` ile bir sağlayıcıyı açıkça en son seçim yapabilirsiniz.

Sağlayıcıya erişim, sağlayıcının kendi koşullarına ve kullanılabilirliğine tabi olmaya devam eder. Mercury lisansı bu koşulların yerini almaz.

## Arayüzsüz CLI: `mercury run`, Docker ve JSON-RPC runner

Aynı derleme etkileşimli arayüz olmadan çalışır. `node dist/mercury.mjs --help` her bayrağı listeler.

`mercury run "<prompt>"`, terminal arayüzü olmadan bir prompt çalıştırır:

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text`, yanıtı yazdırır; başarısız bir turun nedeni stderr'e gider.
- `json`, son `outcome` satırını tek bir JSON nesnesi olarak yazdırır.
- `rows`, satır başına bir JSON nesnesi yazar: `session`, ardından bir `turn` ve onun `text`, `reasoning`, `tool_call`, `tool_result` ve `step` satırları; sonunda `outcome`. Beklemeler, araç ilerlemesi, arka plan görevleri ve bildirimler kendi satırlarına sahiptir. Her satır `seq`, `timestamp` ve `session_id` taşır; bir turun içindeki satırlar ayrıca o turun `turn` numarasını da taşır. `seq`, bu çalıştırmanın akışını 1'den numaralandırır; `turn` ise oturumun turlarını sayar. Bu nedenle kayıtlı bir konuşmayı sürdüren bir çalıştırma (`-c`, `-r`, `--fork`), turunu mevcut turlardan sonra numaralandırır ve `session` satırı, sürdürdüğü konuşmayı `resume_of` alanında belirtir.

Çıktı satırı türleri, `type` alanlarına göre:

- `session`: açılış satırı: `version`, `build` (paketin üretildiği ağacın ilk on iki onaltılık karakteri; `mercury daemon status`'un yazdırdığı biçimde; paketin yanında bir manifest yoksa bulunmaz), `resume_of` (sürdürülen bir çalıştırmada, sürdürülen konuşmanın oturum kimliği; çalıştırma fork edilmediyse `session_id` ile aynıdır), `cwd`, `model`, `mode`, oturumun sahip olduğu `tools`, `mcp_servers`, `commands`, `agents`, `skills` ve `extensions`, ve `tools_withheld` (bir reddetme kuralı bir aracı çıplak adıyla geri tuttuğunda bulunur: her girdinin `tool`, `rule` ve `source` değerleriyle).
- `turn`: `started` ya da `waiting` durumundaki bir tur, `turn_id` değeriyle; `model`, `message_ids` ve biliniyorsa `agents` sayısı.
- `text`: kesinleşmiş bir metin bloğu: `message_id`, `block`, `text` ve `phase` değeri (`commentary` veya `final_answer`).
- `reasoning`: kesinleşmiş bir muhakeme bloğu: `message_id`, `block`, `text` ya da `redacted: true`.
- `tool_call`: bir araç çağrısı: `call_id`, `tool`, `input`, ve `message_id` ile `block` değerleri.
- `tool_result`: çağrının sonucu: `call_id`, `status` (`ok`, `error`, `aborted` veya `refused`) ve `output`. Model bir çağrıyı o kadar kötü biçimlendirmiş ki yürütülmeden önce reddedilmişse (bilinmeyen bir araç, geçerli JSON olmayan ya da aracın şemasına uymayan bağımsız değişkenler), bu çağrının da bir çifti olur: iletildiği haliyle bağımsız değişkenleri taşıyan bir `tool_call` satırı (nesne değilse `{}`) ve bir `tool_result` satırı (durumu `refused`, `output` değeri ise nedeni taşır); ardından düzeltme `notice` satırı gelir. Böyle bir çağrı hiç çalışmamıştır ve bir reddetme (denial) değildir.
- `tool_update`: çalışan bir aracın ilerlemesi: `call_id`, `tick`, `source` (`shell`, `powershell`, `mcp` veya `eval`) ve çağrının bildirdiği `line`, `elapsed_s`, `lines`, `bytes`, `budget_ms`, `progress` ve `total` alanlarından hangileri varsa. Shell veya PowerShell çağrısı, çıktısı geldikçe tik üretir (hiçbir şey yazdırmayan bir komut hiç tik üretmez); MCP çağrısı, sunucusu ilerleme bildirdiğinde; Eval çağrısı ise hücresi çalışırken tik üretir. Başka hiçbir araç tik üretmez; Browser veya Crewmate çağrısı, sonucu gelene kadar sessiz kalır.
- `step`: ana iş parçacığındaki bir model çağrısı: `message_id`, `model`, `usage` ve model durma nedenini belirttiğinde `stop`.
- `outcome`: turun sonucu; aşağıda açıklanmıştır.
- `close`: kapanışta bir sonraki oturum için bırakılan not: `state` (`stored`, `skipped` veya `none`), `note_chars` ve notu yazan model çağrılarının `usage` değeri; böylece her satırın kullanım değerlerini toplayan biri, sonucun kullanım değerine ulaşır. Prompt bir bağımsız değişken olarak verildiğinde not son tur içinde istenir ve `close`, o turun `outcome` satırından önce gelir; `--input rows` ile ise stdin kapandığında son `outcome` satırından sonra gelir.
- `wait`: modelde bekleme: `state` (`first_byte`, `retry`, `silence`, `loading` veya `done`) ve o durumun taşıdığı değerler, örneğin `since_ms`, `attempt` ve `of`, `delay_ms`, `reason` ve `http_status`.
- `heartbeat`: model akışı, ayrıştırılmış bir olay olmadan en az bir saniye geçtikten sonra canlılık gösterdi: hiçbir satır üretmeyen baytlar geldi. Satır başka bir şey taşımaz ve en fazla saniyede bir gelir; sıklık, sağlayıcının akış biçimine bağlıdır, dolayısıyla olaylar arasında hiç duraklamayan bir akış hiçbir heartbeat üretmez.
- `compaction`: bir compaction `started`, `progress` ya da `ended` durumunda: `trigger` (`manual`, `auto` veya `overflow`), `stage`, `fill`, `summary_tokens` ve sonda `exit` (`landed`, `cancelled` veya `failed`).
- `mode`: izin modu değişti: `mode`.
- `rate_limit`: sağlayıcının limit durumu: `status` (`allowed`, `warning` veya `rejected`), `window`, `resets_at`, `utilization` ve aşım alanları.
- `task`: bir arka plan görevi `started`, `progress` ya da `ended` durumunda: `task_id`, `task_type`, `description`, `usage`, `summary`, `status` (`completed`, `failed` veya `stopped`) ve bilindikçe `output_file`.
- `notice`: okuyucu için bir `warning` veya `error`: `text` ve bir `code` (örneğin `input_refused`).
- `command_output`: modele hiç ulaşmayan bir slash komutunun çıktısı: `command` ve `text`.
- `mission_updated`: oturumun görev defteri değişti; yeniden okuyun.
- `samples_updated`: oturumun örnekleri değişti; yeniden okuyun.

`--partial`, `--format rows` ile birlikte kullanıldığında `block_start`, `text_delta`, `reasoning_delta`, `tool_input_delta` ve `retracted` satırları ekler. Deltalar `message_id` ve `block`'a aittir; bir `retracted` satırı o mesajın deltalarını geri çeker. Kesinleşmiş metin veya araç satırı tam değerdir.

Sonuç satırı; `schema`, `turn_id`, `status`, `steps`, `wall_ms`, `usage`, `models` ve `denials` alanlarını taşır; tamamlanmada `answer`, başarısızlıkta `error` (`message`, `class`, isteğe bağlı `detail`) bulunur. `stop`, `api_ms`, `cost_usd`, istenen `structured` çıktı ve `notices` mevcut olduğunda eklenir. `wall_ms`, turun geçen süresidir. `api_ms`, turun yaptığı her model isteğinin süresinin toplamıdır (yeniden denemeler ve ana iş parçacığının yanında çalışan crewmate isteklerinin de dahil olduğu); bu nedenle istekler üst üste bindiğinde `wall_ms` değerini aşabilir. `cost_usd`, durumdan bağımsız olarak turun fiyatlandırılmış isteklerinin dolar cinsinden toplamıdır: Mercury'nin fiyatlandıramadığı bir istek (kayıtlı bir oran yok, yanıtta belirtilmiş bir maliyet yok) buna bir şey eklemez ve modelini `models` içinde kendi `cost_usd` değeri olmadan listelenmiş bırakır; alan yalnızca turda hiçbir şey fiyatlandırılmadıysa bulunmaz. Claude abonelik oturum açmasında Anthropic isteklerinin dolar fiyatı yoktur; bu nedenle ne bu istekler ne de satır bir `cost_usd` taşır; kullanım bilgisi ise kalır. Kullanım bilgisi; `input_tokens` (önbelleğe alınmış token'lar dahil), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` ve bildirildiğinde `reasoning_output_tokens` alanlarını içerir; ana iş parçacığı ve crewmate'ler üzerinden toplanır. `models`, token kullanımını modele göre ayrıştırır. `steps` yalnızca ana ajanın model çağrılarını sayar; crewmate'lerin model çağrıları, kendi `step` satırları olarak (`parent_call_id` ile etiketlenmiş biçimde) görünür.

Durum değeri `completed`, `blocked`, `refused`, `failed`, `interrupted`, `turn_limit`, `budget_limit`, `time_limit`, `schema_unmet` veya `loop_stopped` olabilir. `--max-time` (saniye ya da `10m`, `1h`) ile çalışan bir çalıştırma, süre dolduğunda bir sonraki adımda `time_limit` ile biter; devam eden model çağrısı veya araç turu kesilmez. Tamamlanan bir çalıştırma 0 koduyla, diğer sonuçlar 1 koduyla, kullanım hatası ise 2 koduyla çıkar. SIGINT ve SIGTERM, kesintiye uğrayan turun sonucu yazıldıktan sonra sırasıyla 130 ve 143 koduyla çıkar. Reddedilen bir araç çağrısı `denials` içinde listelenir. Reddetme, kimsenin yanıtlayamadığı bir soru ise (soru soran bir modda ana bilgisayarsız çalıştırma, `--mode dontAsk` ya da bir ana bilgisayarın süresi dolan sorusu) ve turdaki sonraki hiçbir araç çağrısı başarılı olmamışsa, çalıştırma `blocked` olur: yanıt korunur, `error` aracın adını ve nasıl devam edileceğini belirtir (`--allowed-tools`, başka bir `--mode` ya da soruları yanıtlayan bir ana bilgisayar) ve çalıştırma 1 koduyla çıkar. Aynı turda sonraki bir araç çağrısı başarılı olursa, tur toparlanır ve `completed` (çıkış 0) olarak biter; yanında bir uyarı `notice` satırı (`"<Tool> was not approved; the run continued with other tools."`) bulunur. Yanıtladığınız bir reddetme (bir deny kuralı, bir hook ya da hayır diyen bir ana bilgisayar yoluyla), tamamlanmış turu tamamlanmış olarak bırakır. Yanıtlanmayan bir `AskUserQuestion` çağrısı da çalıştırmayı `blocked` yapar; soru `error` içinde alıntılanır. Mercury sonucu çalıştırmanın kayıtlı sorularından okur, yanıt metninden değil; bu nedenle yalnızca yanıt metninde yazılmış bir soru `completed` ile biter. Bilinmeyen bir slash komutu `refused` olur (etkileşimli ekranın verdiği aynı cümleyle: `Unknown command: /name · /help lists commands`) ve 1 koduyla çıkar.

`--input rows`, `--format rows` gerektirir ve satır başına bir girdi nesnesi okur:

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

Girdi türleri şunlardır: `prompt` (`content` alanı ile: metin veya metin/görsel blokları), `shell` (`command` alanı ile) ve `note` (`to` ajan kimliği ve `content` alanı ile). Her biri isteğe bağlı bir `id` kabul eder; prompt ve shell satırları ayrıca `priority` (`now`, `next` veya `later`), `sent_at` ve `origin` kabul eder. Reddedilen bir girdi biçimi, `notice` satırı (`input_refused` koduyla) üretir; bozuk JSON çalıştırmayı sonlandırır. Bu satırlar yalnızca girdi taşır; izin yanıtları aşağıda açıklanan runner protokolünü kullanır.

Tüm prompt'u stdin'den okumak için `mercury run -` kullanın ya da `mercury run`'a metin aktarın. Bir prompt bağımsız değişkeninin yanında, aktarılan metin sınırlandırılmış bağlam olarak eklenir: boru kapanana ya da bir saniye boyunca sessiz kalana kadar okunur; bu nedenle veri vermeye devam eden bir akış sonuna kadar okunur, açık kalan ve sessiz bir boru ise çalıştırmayı tutmaz. Prompt yoksa ve stdin'de bir terminal varsa `run`, kullanım bilgisini yazdırır ve 2 koduyla çıkar.

`--mode <mode>`, izin duruşunu seçer. `--sovereign`, izin istemleri olmadan çalışır; `--allow-sovereign` ise bu duruşu sonradan geçiş için kullanılabilir kılar. İzin politikası ve reddetme kuralları yine geçerlidir. Sovereign moduna giren bir root kullanıcı stderr'de tek bir bildirim alır; çalıştırma devam eder.

En son konuşmayı sürdürmek için `-c`, kimlik, başlık veya seçici ile devam etmek için `-r`, yönetilen bir worktree'de çalıştırmak için `-w` ve minimal bir oturum için `--lean` kullanın. Bir `run`'ın izin isteklerini yanıtlayacak bir ana bilgisayarı yoktur: izin kuralları ve modu neyin çalışabileceğine karar verir; hâlâ onay gerektiren bir çağrı reddedilir.

### Arayüzsüz imaj

Depo kökündeki `Dockerfile`, CI ve sunucular için bir Linux x64 imajı oluşturur. Giriş noktası `mercury`, varsayılan fiili `run`'dır; bu nedenle imaj, bağlanmış bir ağaca karşı tek bir prompt çalıştırır ve çalıştırmanın koduyla çıkar:

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

İmaj; paketi, Node 24 çalışma zamanını (`PATH` üzerinde), paketlenmiş arama, shell, hata ayıklayıcı, dil ve görsel araçlarını, `git`'i ve sertifika deposunu taşır; giriş ekranı ve oturum açma akışı yoktur. Root olmayan `mercury` kullanıcısı olarak çalışır ve yapılandırma dizini konteyner içindedir (`MERCURY_CONFIG_DIR`); `/work` ise çalışma dizinidir. Renk ve fare, ürünün kendi terminal algılamasını izler; `--user 0` ise yukarıda belirtilen tek sovereign bildirimiyle root olarak çalışır.

Bir sağlayıcı anahtarı, ortam değişkeni olarak iletilir; ürünün her yerde okuduğu yazımlarla: `ANTHROPIC_API_KEY` veya `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` veya `GOOGLE_API_KEY`, `XAI_API_KEY` (kullanım göstergesi için `XAI_MANAGEMENT_API_KEY` ile), `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY` (kuruluş göstergesi için `MISTRAL_ADMIN_API_KEY` ile), `NOUS_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`, `TOGETHER_API_KEY` veya `TOGETHER_AI_API_KEY`, `COHERE_API_KEY` veya `CO_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `DASHSCOPE_API_KEY`, `MODEL_API_KEY` veya `META_API_KEY`, özel bir OpenAI uyumlu uç nokta için `MERCURY_COMPAT_API_KEY` ve yerel bir sunucu için `MERCURY_LOCAL_API_KEY`. Hiçbir anahtar yoksa çalıştırma tek satırda reddeder ve 1 koduyla çıkar. `docker run -i … mercury run -` komutu, prompt'u stdin'den okur.

### Bir oturumu barındırma

`mercury runner`, bir oturumu stdio üzerinden bir ana bilgisayara sunar: JSON-RPC 2.0, satır başına bir ileti. Ana bilgisayar önce `initialize` gönderir ve iş göndermeden önce yanıtı bekler:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

Ana bilgisayarın adı ve sürümü `host` altında iletilir; `capabilities`, `holds_asks`, `elicitation` ve `partial_rows` değerlerini bildirir. Her isteğin `id` değeri pozitif bir tam sayı olmalıdır: `id` değeri bunun dışında bir şey olan istek `-32600` yanıtını (`id: null` ile) alır; bu nedenle istekleri 1'den numaralandırın.

`queue/add`, yukarıdaki satır girdisiyle aynı prompt, shell veya note nesnesini alır. Çıktı `row` bildirimleriyle gelir. `session/facts`, oturumun durumunu okur; `session/set_mode`, izin modunu hemen değiştirir; `session/set_model` ve `session/set_effort`, modeli ve effort düzeyini değiştirir. Bir tur çalışırken yapılan bir değişiklik, tur bitene kadar bekletilir: `at: "turn_end"` ile yanıt verilir, ardından `session/applied` bunu bildirir. `turn/interrupt` bir turu durdurur; oturumu sonlandırmak için stdin'i kapatın.

İzin soruları `permission/request` olarak gelir; `kind: "tool"` veya `kind: "network"` ile. Ana bilgisayar `outcome: "allow"` veya `outcome: "deny"` ile yanıt verir; allow yanıtı düzenlenmiş `input` ve izin `rules` taşıyabilir. Geri çekilen bir soru, `$/cancel_request` iletisini ilgili `request_id` ile gönderir. `holds_asks`, sorunun zamanlayıcısının sahipliğini ana bilgisayara verir. Bir MCP sorusu `elicitation/request` kullanır, yalnızca ana bilgisayar `elicitation` bildirdiğinde; aksi halde `cancel` ile yanıtlanır.

Bilinmeyen bir method `-32601` ile, geçersiz parametreler `-32602` ile, pozitif tam sayı olmayan bir `id` `-32600` ile ve başlatmadan önceki bir istek `-32002` ile yanıtlanır. Bir kural reddi `-32010` kodudur; `error.message` içinde bir cümle ve `error.data.kind` içinde `mode`, `model`, `effort` ya da `claim` gibi bir neden bulunur. runner, bozuk bir satıra `-32700` ile yanıt verir ve devam eder; art arda üç bozuk satır oturumu sonlandırır.

### Diğer komutlar

Kullanılabilir komutlar şunları içerir:

- **`mercury health`**: tanılama raporu; sağlık sertifikası olarak da anılır. `--json` tam raporu döndürür, `--deep` derin envanteri çalıştırır ve `--fix` yönlendirmeli düzeltmeleri çalıştırır.
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**: oturum açma (`login [<family>]`), sağlayıcı ailelerini listeleme (`list`), bir hesabın oturumunun açık olup olmadığını denetleme (`status [<family>]`), oturumu kapatma (`logout [<family>]`) veya uzun ömürlü bir Anthropic token'ı üretme (`mint`).
- **`mercury models [--json]`**: oturumu açık hesapların erişebildiği modelleri yazdırır (`mercury://models` ile aynı bilgiler).
- **`mercury mcp`**: MCP sunucularını `add`, `import`, `list`, `get`, `remove`, `trust-reset` ve `serve` ile yönetir.
- **`mercury extensions`**: uzantıları kurar ve kaynaklarını yönetir. İşlemler: `list`, `sources`, `add`, `remove`, `refresh`, `install`, `trust`, `enable`, `disable`, `update`, `uninstall`, `fence`, `unfence`, `inspect` ve `scaffold`.
- **`mercury roster`**: ajan envanterini listeler.
- **`mercury usage`**: `/usage` ekranının gösterdiği kompakt rakam satırını yazdırır; `--json` tüm okumayı yazdırır: oturumu açık her sağlayıcının kullanılan ve sıfırlanan pencereleri, bildirdiği rakamlar ve krediler (her biri kaynağı ve yaşıyla birlikte) ile model başına oturum harcaması. Ekranın okuduğu biçimde okunur (açılışta olduğu gibi, oturumu açık her sağlayıcının okuyucusu bir kez örneklenir).
- **`mercury daemon run|status|stop|restart`**: arka plan daemon'ını çalıştırır, inceler, durdurur veya yeniden başlatır. Oturum koltukları (seats) `mercury runner`'ın alt süreçleridir; daemon bunların prompt'larını gönderir ve izin sorularını barındırır.
- **`mercury sessions list`** (yalın `mercury sessions` da): bu projenin kayıtlı oturumlarını en yeni olan önce listeler: kimlik, son yazılma zamanı, boyut, daemon şu an barındırıyorsa `live` ve başlık ya da ilk prompt. `--all` tüm projeleri okur, `--limit <n>` listeyi sınırlar. Kimlik, `mercury --resume <id>` ile yeniden açılır ve `sessions delete` ile kaldırılır.
- **`mercury sessions delete <id>`**: kayıtlı bir oturumu bilerek siler: dökümünü ve yanında tutulan kayıtları (receipts, resume snapshot), bir soru sorulduktan sonra. `--yes`, betikler için soruyu atlar. daemon'ın şu an barındırdığı bir oturum reddedilir; bilinmeyen bir kimlik de envantere bir ipucuyla reddedilir (Mercury içinde `/sessions`). Kayıtlı oturumlar başka türlü kendi kendine asla silinmez.
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**: yapılandırma dizinini paylaşan her oturum için yerel veya SSH bilgisayarını bir model sunucusu olarak çalıştırır (`compat/box-<name>/<model>`); doğrulanmış yerel bir ağırlık deposu ya da onaylı bir indirme kullanır. Bkz. [docs/LLM-HOST.md](../LLM-HOST.md).
- **`mercury lsp list`** ve **`mercury lsp install <server>`**: dil sunucusu kataloğu; her sunucu ikilisiyle birlikte kurulu mu, yoksa kurulum çözümüyle birlikte eksik mi bilgisi verilir. `install`, bir sunucunun çözümünü gösterir, onay ister, tam olarak onu çalıştırır (`--yes`, betikler için soruyu atlar) ve ikilinin nereye kurulduğunu bildirir. Bilinmeyen bir sunucu envanterle birlikte reddedilir. Mercury bir dil sunucusunu kendi başına asla kurmaz; bir dosya açmak yalnızca zaten kurulu olan bir sunucuyu başlatır.
- **`mercury acp`**: Agent Client Protocol üzerinden bir editöre hizmet verir; her oturum için bir runner alt süreci ile. `mercury bridge install` VS Code uzantısını kurar; `mercury bridge status` onu denetler; `mercury bridge uninstall` onu kaldırır.
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**: geçerli dizindeki Godot projesi için motor işlerini yönetir. Mercury, test paketlerini dondurulmuş bir proje kopyasından, kendi headless işçilerinde çalıştırır. Hizmet; bir derleme kapısı, yakalamalar, kare istatistikleri, kesinleşmiş profiller, iş kuyruğu erişimi, iptal ve kimliğe göre sonuçlar içerir. Bkz. [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md).
- **`mercury image <image>`**: terminalde bir görüntü gösterir.
- **`mercury install`** ve **`mercury update`** (takma ad `upgrade`): sürüm arşivlerini kurar veya günceller; `--json` ile sonuç ne olursa olsun belge stdout'a yazılır ve çıkış kodu başarısız olup olmadığını söyler. Bkz. [Kurulum](#kurulum).
- **`mercury version`** ve **`mercury help [command]`**: sürüm satırını ya da bir yardım sayfasını yazdırır; `--version` ve `--help` ile aynıdır; ikisi de bir oturum başlatmaz.

## İçinde neler var: Mneme RAG belleği, LSP, 23 dilli AST, DAP hata ayıklayıcı, web araması ve köprüler

- **Mneme hibrit RAG proje belleği.** Mneme varsayılan olarak açıktır; her projenin olgularını düz markdown konu sayfalarında tutar (`Retain`, `Recall`, `Reflect`, `Correct`). Recall, cihaz üzerinde çalışan 118 MB'lık BGE semantic embedding modelini (`bge-base-en-v1.5` `q8_0`, MIT lisanslı, her sürüm arşivinde paketlenmiş ve platformu için derlenmiş; bkz. [İsteğe bağlı bileşenler](#i̇steğe-bağlı-bileşenler)); kök ayrıştırmalı BM25 kelime sıralaması, yenilik ağırlıklandırması ve alıntı takibi ile reciprocal rank fusion (`k = 60`) aracılığıyla birleştirir. Sabitlenmiş kurallar (`pin: true`), sabitlenmiş rafta kelimesi kelimesine yüklenir ve yalnızca sizin sözünüzle değişir. Oturum başlangıcında Mercury, sabitlenmemiş olguları ve önceki notları; geçerli dalınıza, yakın zamanda değiştirilen dosyalara ve son oturumun devir notuna göre, ayrılmış bir başlangıç bütçesi içinde (`memory.startLimit`, varsayılan 4.000 karakter) puanlar. Yazma anındaki çelişki denetimleri, çelişen bir olgu kaydedilmeden önce kutupluluk, olumsuzlama ve sayı değişikliklerini yakalar. Her oturum, çıkışta bir sonraki oturumun giriş sayfası için kendi sözcükleriyle bir devir notu yazar; buna isteğe bağlı bir oturum günlüğü kaydı da eklenebilir. `/memory` bellek merkezini açar, `/memory page` ise kütüphaneyi tarayıcınızda düğüm ve kenar grafiği olarak çizer. Bkz. [docs/MNEME.md](../MNEME.md).
- **LSP kod zekâsı, 23 dilde AST yeniden yazımları, DAP hata ayıklayıcı ve `Eval` hücreleri.** Çapalı okumalar ve atomik çok dosyalı düzenlemeler (`ChangeSet`); dil sunucusu sorguları (`LspRead`) ve önce önizlenip sonra uygulanan yeniden düzenlemeler (`LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`); sözdizimi ağacı araması ve yeniden yazma (`AstSearch`, `AstEdit`), sürüm arşivlerindeki 23 dilbilgisinde (grammar) `$NAME` ve `$$$NAME` meta değişkenleriyle (her `bun install` derlemesinde 16, dilbilgisi paketinde ek 7); kalıcı Python (`python3`) ve JavaScript (Node ES modülü) kod hücreleri (`Eval`); ve bir Debug Adapter Protocol hata ayıklayıcısı (`Debug`): `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`, `netcoredbg`, `rdbg`, Dart SDK'nın hata ayıklama bağdaştırıcısı, `kotlin-debug-adapter`, elixir-ls hata ayıklama bağdaştırıcısı ve Godot'u yönetir. `Test` aracının `debug` işlemi, başarısız bir Python (`pytest`, `unittest`), JavaScript/TypeScript (`node-test`, `vitest`, `jest`), Go (`go test`) veya Rust (`cargo test`) testine doğrudan bir `Debug` oturumu içinde adım adım girer. Bkz. [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md), [değişiklik işlemleri](../CHANGE-TRANSACTIONS.md), [yapısal kalıplar](../STRUCTURAL-PATTERNS.md), [kod hücreleri](../EVAL.md) ve [hata ayıklayıcı](../DEBUGGER.md).
- **Anahtarsız `WebSearch` ve markdown `WebFetch`.** `WebSearch` tek bir kademeli zinciri izler: oturum modeli destekliyorsa önce sağlayıcının kendi canlı araması (`ProviderSearch`), ardından kayıtlı Brave veya Tavily anahtarları, ardından sorgu biçimine göre seçilen resmî API'ler (Stack Exchange, npm, PyPI, crates.io, GitHub kod araması, Hacker News Algolia, Wikipedia), ardından yapılandırılmış SearXNG JSON API'leri (`MERCURY_SEARCH_SEARXNG_INSTANCES`) ve anahtarsız DuckDuckGo sayfa kazıması (varsayılan olarak açık; `/config` içinden ya da `MERCURY_SEARCH_KEYLESS=0` ile kapatılabilir). Her yanıt 2.000 token'ın altında kalır ve yanıtı veren kaynağın adını belirtir. `WebFetch`, genel sayfaları 38.000 karakterlik bir çağrı bütçesi içinde sayfanın kendi ifadeleriyle markdown olarak okur (tarayıcı gerektiren bir sayfa, barındırılan `r.jina.ai` okuyucusu üzerinden okunur; `MERCURY_FETCH_READER=0` bunu kapatır ve özel bir ağ adresi bu okuyucuya asla gönderilmez). Bkz. [docs/ENGINES.md](../ENGINES.md).
- **Ajanlar, sağlayıcılar arası crewmate'ler (`Crewmate`), worktree'ler ve dosya kiralamaları.** İki yerleşik ajan (`mercury-crew`, her türlü devredilmiş iş için; `mercury-scout`, yalnızca okuma amaçlı keşif için) `/agents` içinde oluşturduğunuz ajan tanımlarının yanında bulunur. Oturum açmış herhangi bir sağlayıcıda crewmate başlatın, paralel işi `git worktree` kopyalarında yalıtın (`isolation: "worktree"`), paylaşılan dosyaları süreç içi proje dosyası kiralamaları (`mcp__mercury__lease_take`, `mcp__mercury__lease_release`, `mcp__mercury__lease_list`) ile koordine edin ve crewmate'leri ad ya da kimlikle `SendMessage` ve `ResumeCrewmate` komutlarıyla yönlendirin veya sürdürün. Crewmate'leri ve workflow çalıştırmalarını `/crewmates` ve `/runs` içinde izleyin. Bkz. [docs/CREW.md](../CREW.md).
- **Masaüstü bilgisayar kullanımı.** Yerel masaüstü sürücüsü kullanılabilir olduğunda varsayılan olarak açıktır. `Computer` aracı ekran görüntüsü alır ve ön plandaki uygulamada fare ile klavyeyi denetler. Mercury, harekete geçmeden önce uygulamayı adı ve kimliğiyle denetler; izin kurallarınız, oturum onayınız, erişim ayarınız veya izin modunuz eylemi zaten onaylamıyorsa onay ister; `Esc` ile durur; aynı anda yalnızca bir oturumun masaüstünü denetlemesine izin verir ve ekran görüntülerini kaydedilen konuşma dosyasının dışında tutar. Aracı kaldırmak için `MERCURY_COMPUTER_USE=0` ayarlayın. Bkz. [docs/COMPUTER-USE.md](../COMPUTER-USE.md).
- **Cihaz üzerinde Whisper ses girişi (`/voice`).** `/voice on`, ilk kullanımda 60 MB'lık İngilizce konuşma modelini (`base.en-q5_1`) indirir, SHA-256 özetini doğrular ve dikteyi etkinleştirir; `/voice off` bunu devre dışı bırakır. Konuşmak için boşluk tuşunu 1 saniye basılı tutun ve durdurmak için bırakın; ya da ses açıkken yalnızca `/voice` çalıştırarak bir kaydı başlatıp durdurun. Whisper dönüştürmeyi cihaz üzerinde yapar, bu nedenle ses verisi makineden asla çıkmaz; `MERCURY_WHISPER_MODEL`, `tiny.en-q5_1`, `small.en-q5_1`, çok dilli `base-q5_1` veya yerel bir `.gguf` dosyasını seçer. Bkz. [docs/VOICE.md](../VOICE.md).
- **Saturn cron ve oturum zamanlayıcısı (`/saturn`).** Mevcut bir oturum için bir prompt zamanlayın (`CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, `/loop`) ya da belirli bir zamanda başlayacak yeni bir oturum zamanlayın. Zamanlamalar bir kez çalışabilir ya da tekrarlanabilir. Bkz. [docs/SATURN.md](../SATURN.md).
- **VS Code (ACP), Unity, Blender, Godot ve Aseprite köprüleri.** `mercury acp`, Agent Client Protocol'ü destekleyen editörlere bağlanır. VS Code uzantısı (`mercury bridge install`) Mercury'yi bu protokol üzerinden editörün içinde çalıştırır: sohbet, oturumlar, ajanlar, çıktılar (artifacts) ve incelemeler; her prompt'un yanında editörün seçimi ve tanılamaları taşınır. Ayrı, isteğe bağlı entegrasyonlar, çalışan Unity (`MERCURY_UNITY=1`), Blender (`MERCURY_BLENDER=1`) ve Godot (`MERCURY_GODOT_TOOLS=1`) editörlerine bağlanır; Aseprite'a ise toplu erişim sağlanır (`MERCURY_ASEPRITE=1`). Bkz. [Unity](../UNITY-BRIDGE.md), [Blender](../BLENDER-BRIDGE.md), [Godot](../VULCAN-GODOT-TOOLS.md) ve [Aseprite](../ASEPRITE-BRIDGE.md).
- **Uzantılar.** Her uzantının tek bir manifest'i vardır. Bir git URL'sinden, yerel bir klasörden veya arşivden kaynak ekleyin; katkı karması (contributions hash) ile onaylanır. Bkz. [docs/EXTENSIONS.md](../EXTENSIONS.md).
- **MCPs & Skills.** Oturumların neleri yükleyeceğine dair depo başına yapılandırma; adlandırılmış ön ayarlar ve bir oturum sırasında değiştirebileceğiniz denetimlerle. Bkz. [docs/KIT.md](../KIT.md).
- **Tanılama.** Sağlık denetimi ve `/health`, tanılama kanıtlarına dayanan bir rapor üretir; `certified`, `caution` veya `fault` hükmü ve doğrulanmış düzeltmelerle birlikte. Bkz. [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md).
- **Güven ve izinler.** Çalışma alanı güveni, izin kuralları ve modları ve her oturumun reddettiği komutlar. Bkz. [docs/TRUST.md](../TRUST.md).
- **Apollo Mode**, spesifikasyon görüşmesi: bir prototip oluşturmak için kullanacağı spesifikasyonu tamamlamak üzere ajanın sorularını yanıtlayın. Bkz. [docs/APOLLO-MODE.md](../APOLLO-MODE.md).
- **Kurtarma.** Atomik yayımlama, günlüğe kaydedilmiş işlemler ve başlangıçta uzlaştırma. Bkz. [docs/DURABILITY.md](../DURABILITY.md).

Çalışma zamanı bayrakları `src/substrate/flagRegistry.ts` içinde tanımlanır, `MERCURY_*` ayarları olarak sunulur ve istek üzerine üretilir. Entegrasyon uyumluluğu [docs/COMPATIBILITY.md](../COMPATIBILITY.md) dosyasında belgelenmiştir. Tam belge dizini [docs/README.md](../README.md) dosyasındadır.

## Slash komutları

`/help`, kullanılabilir etkileşimli komutları listeler. Bulanık komut araması için `/palette` kullanın. Aşağıdaki tablo, varsayılan olarak etkin gelen yerleşik komutları `/help` içinde kullanılan kategorilere göre gruplar; canlı liste ayrıca `/samples` komutunu (`current work` altında, Samples etkinleştirildiğinde: `MERCURY_SAMPLES=1` veya Boot Menu'nün Samples satırı), `/showcase` komutunu (`MERCURY_DEV_SURFACES=1` ayarlandığında) ve tüm skill veya uzantı komutlarını içerir.

| Alan | Komutlar |
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

| Komut | Ne yapar |
| --- | --- |
| `/llmhost` | Runpod, Vast.ai veya Lambda üzerinde kiralamak için bir model seçin, kendi bilgisayarınızda çalıştırın ya da mevcut bir sunucuya bağlanın. |
| `/restart` | Bu sohbeti kurulu Mercury sürümüne taşıyın; çalışan izleyiciler ve arka plan shell'leri durur. |
| `/mcp` | Sunucuları inceleyin, oturum açın, her sunucunun araçlarını ve parametrelerini görüntüleyin, yeniden bağlanın veya bu sohbet için bir sunucuyu açıp kapatın. |

`/mouse off`, yerel metin seçimi ve kopyalama için imleci terminale geri verir. Bu tercih kaydedilir ve `/config` içinde Mouse capture olarak görünür.

Bir skill'in kullanımında zorunlu bir argüman `<…>` ile başlar. Örneğin `/update-config` ve `/debug` bir argümana ihtiyaç duyar. Tek başına gönderirseniz açıklamasını ve kullanımını görürsünüz; hiçbir tur başlamaz. Typeahead içinde seçip Enter'a basarsanız, argümanı eklemeniz için `/name ` hazır bırakılır. `/loop` zorunlu bir argüman gerektirmez ve hemen çalışır.

## Sorun bildirme

Kısa bir bildirim için [test edici formunu](https://mercury-cli.ai/report) ya da Mercury içinde `/bug --short <what you tried>` komutunu kullanın. İşletim sisteminizi, neyi denediğinizi ve neyin bozulduğunu sorar; sağlık denetimi dökümüne gerek yoktur.

Mercury içinde `/bug <what happened>` komutunu çalıştırarak, oturumu açık GitHub CLI (`gh`) üzerinden göndermeden önce raporu önizleyin. `gh` yoksa Mercury, yapılandırma ana dizini altında yerel bir taslak kaydeder ve sizi depodaki sorunlar (issues) sayfasına yönlendirir.

Hata, sağlayıcı/model veya özellik isteği şablonunu kullanarak doğrudan bir sorun (issue) da açabilirsiniz. `--version` çıktınızı, işletim sisteminizi, terminalinizi ve tam adımları ekleyin. Hata ve sağlayıcı bildirimleri ayrıca `mercury health --json` gerektirir; kaynaktan derleme için `node dist/mercury.mjs health --json` kullanın. Başarısız olan ekranın bir dökümü de yardımcı olur.

Güvenlik sorunlarını depodaki Security sekmesi üzerinden özel olarak bildirin. Bunları herkese açık sorunlara (issue) yazmayın. Bkz. [SECURITY.md](../../SECURITY.md). [CONTRIBUTING.md](../../CONTRIBUTING.md) sorunları, pull request'leri ve kontrolleri kapsar.

## Lisans

Mercury CLI, [LICENSE.md](../../LICENSE.md) içindeki Mercury Community Production Grant ile birlikte Business Source License 1.1 (`BUSL-1.1`) kapsamında lisanslanmıştır. TypeScript ve Python SDK'ları, [sdk/](../../sdk/) ve [sdk-py/](../../sdk-py/) içinde (npm ve PyPI'de `mercury-cli-sdk`), Apache License 2.0 (`Apache-2.0`) kapsamında ayrı olarak lisanslanmıştır; her biri kendi taşıdığı LICENSE dosyasıyla lisanslanır ([sdk/LICENSE](../../sdk/LICENSE) ve [sdk-py/LICENSE](../../sdk-py/LICENSE)) ve Licensed Work'ün (Lisanslı Çalışma) parçası değildir.

Mercury, Mercury Community Production Grant ile birlikte Business Source License 1.1 kapsamında kaynak kodu erişilebilir durumdadır. Lisans [LICENSE.md](../../LICENSE.md) dosyasındadır; yanında [üretim koşulları](../../MERCURY-COMMUNITY-PRODUCTION-TERMS.md) ve [marka politikası](../../TRADEMARKS.md) da bulunur. Lisans metni geçerlidir; bu bölüm bir özettir.

Kaynak kodunu okuyabilir, kopyalayabilir, değiştirebilir ve fork edebilirsiniz. Her iki topluluk eşiğinin de altında kalan kişi ve kuruluşlar, Mercury'yi üretimde ücretsiz olarak kullanarak kendi ürünlerini, ticari ürünler dahil, geliştirip satabilir. Hem konsolide yıllık gelir hem de toplam dış finansman US$1.000.000'ın altında olmalıdır.

Eşiklerden birine ulaşan uygun bir kullanıcı 90 günlük bir ek süre alır. Bundan sonra, önemli yeni işlevsellik dahil, yeni ürün çalışmaları ticari bir lisans gerektirir. Eşik aşıldığında zaten üretimde olan ürünler, ek sürenin bitmesinden önce elde edilmiş Mercury sürümleri kullanılarak, lisansın bakım koşullarına tabi olarak hâlâ sürdürülebilir.

Mercury'nin kendisini üçüncü taraflar için satmak, beyaz etiketlemek (white-label) veya barındırmak ya da bunun yerine bir alternatif sunmak, gelirinizden veya finansmanınızdan bağımsız olarak ticari bir lisans gerektirir.

Her sürüm kendi Change Date tarihinde, o sürümün yayımlanmasından üç yıl sonra Apache License 2.0'a geçer.

Ticari lisanslama ve marka izni için [mercury-cli.ai/licensing](https://mercury-cli.ai/licensing) adresini ziyaret edin. Paketlenmiş üçüncü taraf lisansları [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) dosyasında listelenmiştir.
