[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [Italiano](README.it.md) | [Dansk](README.da.md) | [日本語](README.ja.md) | [Polski](README.pl.md) | [Русский](README.ru.md) | [Bosanski](README.bs.md) | [العربية](README.ar.md) | [Norsk](README.no.md) | [Português (Brasil)](README.pt-BR.md) | [ไทย](README.th.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [বাংলা](README.bn.md) | [Ελληνικά](README.el.md) | [Tiếng Việt](README.vi.md)

# Mercury CLI

Mercury CLI (mercury-cli.ai, แพ็กเกจ npm `mercury-tech-cli`) ช่วยให้คุณรันเอเจนต์เขียนโค้ด AI ในเทอร์มินัลของคุณ ภายในรีโพซิทอรี git ของคุณเองบน macOS, Linux และ Windows

เว็บไซต์: [mercury-cli.ai](https://mercury-cli.ai) · รีโพซิทอรี: [github.com/Whq02/MercuryCLI](https://github.com/Whq02/MercuryCLI) (`Whq02/MercuryCLI`) · npm: `mercury-tech-cli`

เอเจนต์อ่านและแก้ไขไฟล์ รันคำสั่ง shell ไล่ดูทีละขั้นผ่านการทดสอบและดีบักเกอร์ และตรวจสอบผลลัพธ์ คุณเป็นผู้เลือกผู้ให้บริการโมเดล โมเดล และสิ่งที่เอเจนต์ได้รับอนุญาตให้ทำ:

- **Session Concourse แบบหลายเซสชันและ worktree แยกกัน:** รันหลายเซสชันควบคู่กันบน Session Concourse (`/concourse`) และมอบงานขนานให้ crewmates ข้ามผู้ให้บริการ (`Crewmate`) ใน checkout ของ `git worktree` ที่แยกกัน โดยใช้ lease ไฟล์ของโปรเจกต์ เพื่อไม่ให้เอเจนต์ที่ทำงานขนานเขียนทับกัน
- **ผู้ให้บริการโมเดล 22 ราย, `/llmhost` และ `/localsetup`:** ทำให้ผู้ให้บริการทั้ง 22 รายลงชื่อเข้าใช้ไว้พร้อมกันได้ (OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot/Kimi, Z.AI/GLM, OpenRouter, Hugging Face, xAI/Grok, Meta/Muse, Mistral, Nous Portal, OpenCode Zen, Qwen, MiniMax, Together AI, Cohere, Groq, Cerebras, Fireworks AI, Melious AI, OrcaRouter) และสลับผู้ให้บริการกับโมเดลได้กลางแชท เปิด `/llmhost` เพื่อเลือกโมเดล ตรวจสอบ quantization การแบ่ง `conversations × context` และระดับ thinking แล้วรันบน GPU ที่เช่า (Runpod, Vast.ai หรือ Lambda) บนคอมพิวเตอร์ของคุณ (`mercury host`) หรือบนเซิร์ฟเวอร์ที่มีอยู่แล้ว หรือรัน `/localsetup` เพื่อติดตั้งหรือเชื่อมต่อ Ollama ควบคู่กับ LM Studio, vLLM และ llama.cpp
- **หน่วยความจำโปรเจกต์แบบ hybrid RAG ของ Mneme:** ใช้โมเดล semantic embedding BGE 118 MB ที่รันบนอุปกรณ์ (`bge-base-en-v1.5`) ร่วมกับการจัดอันดับคำแบบ BM25 และการติดตาม citation กฎที่ปักหมุดซึ่งคงข้อความเดิมทุกตัวอักษร (pinned rules) บริบทตอนเริ่มต้นที่รับรู้ branch การตรวจความขัดแย้งตอนบันทึก โน้ตส่งต่อระหว่างเซสชัน และกราฟเบราว์เซอร์ `/memory page`
- **เครื่องมือ compiler, AST และ DAP debugging:** เชื่อมต่อ LSP code intelligence และการ refactor แบบดูตัวอย่างก่อนนำไปใช้ (`LspRead`, `LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`) การค้นหาและเขียนโครงสร้าง AST ด้วย tree-sitter ใน 23 ภาษา (`AstSearch`, `AstEdit`) debugger แบบ Debug Adapter Protocol ในตัว (`Debug`) ผ่าน `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv` สำหรับไล่เทสต์ Python, Node, Go และ Rust ที่ล้มเหลวทีละขั้น และ `Eval` cells ของ Python และ JavaScript ที่คงสถานะไว้ได้
- **`WebSearch` ที่ไม่ต้องใช้คีย์ และ `WebFetch` แบบ markdown:** ค้นหาผ่าน provider-native search คีย์ Brave หรือ Tavily API อย่างเป็นทางการ (Stack Exchange, npm, PyPI, crates.io, GitHub, Hacker News, Wikipedia) SearXNG และ DuckDuckGo ที่ไม่ต้องใช้คีย์ และดึงเอกสารสาธารณะเป็น markdown ภายในงบ 38,000 ตัวอักษรต่อการเรียกหนึ่งครั้ง
- **การควบคุมเดสก์ท็อป, เสียง Whisper, การจัดตารางด้วย Saturn และบริดจ์ของ editor:** ควบคุมแอปพลิเคชันบนเดสก์ท็อป (`Computer`) ถอดเสียงพูดแบบกดค้างเพื่อพูดด้วย Whisper บนอุปกรณ์ (`/voice`) จัดตารางเซสชันแบบทำซ้ำหรือครั้งเดียวด้วย Saturn (`/saturn`) และเชื่อมต่อกับ VS Code ผ่าน Agent Client Protocol (`mercury acp`) พร้อมกับ Unity, Blender, Godot และ Aseprite
- **การสร้างวิดีโอ (`Video`):** ส่ง prompt และไฟล์อ้างอิงของโปรเจกต์ไปยังตัวสร้าง MiniMax ที่ตั้งค่าไว้ ([docs/VIDEO.md](../VIDEO.md)) แล้วบันทึกไฟล์ MP4 ที่สร้างขึ้น และเฟรมตัวอย่าง PNG ความยาว 1 วินาที (ไม่บังคับ) ลงในโปรเจกต์ของคุณ

Mercury ถูกใช้เพื่อสร้าง Mercury เอง โดยรันหลายเซสชันและหลายโมเดลข้ามงานที่ยาวนาน สิ่งที่ยากที่สุดคือการติดตามงานเหล่านั้น ว่าอะไรยังรันอยู่ อะไรเปลี่ยนไปแล้ว และอะไรต้องการการตัดสินใจ แต่ละเซสชันจะเขียนโน้ตส่งต่อของตัวเองเมื่อจบงาน และเซสชันถัดไปจะอ่านโน้ตนั้นหนึ่งครั้งตอนเริ่มต้นควบคู่กับกฎที่ฉันปักหมุดไว้ เพื่อป้องกันไม่ให้บริบทของเซสชันหนึ่งปนเปื้อนอีกเซสชัน

![พรอมต์ที่ส่งให้ตัวประสานงานบนกระดานเซสชันจะเปิดสองเซสชัน แต่ละเซสชันอยู่ใน worktree ของตัวเอง เซสชันหนึ่งถามก่อนแก้ไข และทั้งสองเซสชันจบงานพร้อมให้ตรวจสอบการเปลี่ยนแปลง](../media/session-board-stream.gif)

Mercury เป็นซอฟต์แวร์โอเพนซอร์สภายใต้ Apache License 2.0 เช่นเดียวกับ SDK ใน [sdk/](../../sdk/) และ [sdk-py/](../../sdk-py/)

## การติดตั้ง

มี archive ของรีลีสสำหรับ Mac ที่ใช้ Apple silicon และ Intel, Linux x64 และ arm64, และ Windows x64 และ arm64 ติดตั้ง `git` แยกต่างหาก เพราะแต่ละ archive มี Node และ ripgrep รวมอยู่แล้ว จึงไม่จำเป็นต้องติดตั้ง Node แยก

เลือกวิธีติดตั้งหนึ่งวิธี:

```sh
curl -fsSL https://mercury-cli.ai/install | sh     # macOS และ Linux (x64 และ arm64)
irm https://mercury-cli.ai/install.ps1 | iex        # Windows (x64 และ arm64) ใน PowerShell 7
brew install Whq02/mercury/mercury                 # Homebrew: macOS และ Linux x64
npm install -g mercury-tech-cli                    # npm; `bun install -g mercury-tech-cli` คือแพ็กเกจเดียวกัน
mise use -g npm:mercury-tech-cli                   # mise ผ่านแพ็กเกจ npm
```

ที่อยู่สำหรับติดตั้งจะเก็บจำนวนคำขอสคริปต์โดยประมาณ แยกตามแหล่งที่มาและตามวัน UTC (การติดตั้งที่เสร็จสมบูรณ์จะไม่ถูกนับ) ตัวนับไม่เก็บที่อยู่ IP, สตริง user-agent หรือ cookie

เปิดเทอร์มินัลใหม่ หรือรันบรรทัด `export PATH=…` ที่ตัวติดตั้ง shell แสดงออกมา แล้วรัน `mercury --version` เพื่อตรวจสอบ และรัน `mercury` จากรีโพซิทอรีเพื่อเริ่ม [การรันครั้งแรก](#การรันครั้งแรก) บน Windows PowerShell และหลังการติดตั้งด้วย Homebrew, npm, bun หรือ mise คำสั่ง `mercury` ใช้งานได้ในเทอร์มินัลเดียวกัน

<details>
<summary>เส้นทางการติดตั้ง การอัปเดต และการตรวจสอบรีลีส</summary>

### ความแตกต่างของวิธีติดตั้ง

ตัวติดตั้ง shell และ PowerShell จะดึงรีลีสล่าสุดสำหรับแพลตฟอร์มของคุณ ตรวจสอบ SHA-256 กับ `SHA256SUMS.txt` แตกไฟล์ แล้วรันคำสั่ง `mercury install` ที่อยู่ใน archive นั้นเอง

Homebrew และแพ็กเกจ npm ถูกปักหมุดไว้กับรีลีสเฉพาะรุ่นหนึ่ง และจะถูกเผยแพร่ใหม่หลังจากมี tag จึงอาจตามหลังรีลีสล่าสุดได้ คำสั่ง Homebrew ใช้ชื่อ tap เต็ม `Whq02/mercury/mercury` (`mercury` ที่ไม่มี tap ใน `homebrew-core` เป็นโปรแกรมอื่น) แพ็กเกจ npm `mercury-tech-cli` เป็นตัวเปิดโปรแกรม (launcher) ที่ดาวน์โหลดรีลีสที่ปักหมุดไว้ และ mise ก็ติดตั้งแพ็กเกจเดียวกันนี้ `mercury install --uninstall` จะลบรีลีสที่ติดตั้งไว้และ shim ของคำสั่ง แต่คงการตั้งค่าและเซสชันของคุณไว้ (หากติดตั้งตัวเปิด npm ไว้ ให้รัน `npm uninstall -g mercury-tech-cli` ด้วย)

การติดตั้ง Mercury เป็นระดับผู้ใช้ ไม่ต้องใช้สิทธิ์ผู้ดูแลระบบ และคุณสามารถรันคำสั่งติดตั้งซ้ำได้อย่างปลอดภัย

### เส้นทางการติดตั้ง

รีลีสแต่ละเวอร์ชันอยู่ใต้ config home ที่ `~/.mercury/versions/<version>` (บน Windows คือ `%USERPROFILE%\.mercury\versions`) คำสั่ง `mercury` ถูกติดตั้งไว้ที่ `~/.local/bin` บน macOS และ Linux หรือ `%LOCALAPPDATA%\Mercury\bin` บน Windows

`mercury install` จะเพิ่มโฟลเดอร์ของคำสั่งลงใน PATH เพียงครั้งเดียว ด้วยบรรทัดที่มีการป้องกันไว้ในไฟล์เริ่มต้นของ shell หรือด้วยรายการในผู้ใช้ PATH ของ Windows เทอร์มินัลใหม่จะรับการเปลี่ยนแปลงนี้โดยอัตโนมัติ

### การอัปเดต

ใช้ `mercury update` กับวิธีติดตั้งทุกแบบ

สำหรับการติดตั้งที่ทำด้วยตัวติดตั้ง shell หรือ PowerShell หรือด้วย `mercury install` คำสั่งนี้จะอัปเดต Mercury ในที่เดิม `--check` ตรวจหาการอัปเดต `--status` รายงานสถานะการอัปเดต และ `--rollback` ย้อนกลับไปยังเวอร์ชันก่อนหน้า ซึ่งยังคงอยู่บนดิสก์

สำหรับ Homebrew คำสั่งจะถามก่อนรัน `brew upgrade Whq02/mercury/mercury` ค่าเริ่มต้นคือไม่ ให้พิมพ์ `y` เพื่ออนุมัติ Mercury แสดงผลลัพธ์ของคำสั่งแบบสตรีม และตรวจสอบเวอร์ชันที่ติดตั้งหลังจากนั้น ใช้ `--yes` เพื่อข้ามการถามในสคริปต์

ตัวเปิด npm ใช้โครงสร้างรีลีสเดียวกับตัวติดตั้ง และส่งต่อการทำงานแต่ละครั้งไปยังรีลีสที่ติดตั้งไว้ ดังนั้น `mercury update` จึงอัปเดตการติดตั้ง npm ในที่เดิมผ่านช่องทางอัปเดตของ Mercury เอง `npm update -g mercury-tech-cli` เปลี่ยนเฉพาะรีลีสที่แพ็กเกจติดตั้งไว้ในการรันครั้งแรกเท่านั้น ข้อนี้ใช้กับการใช้ mise ด้วยเช่นกัน

`--check` อ่านรายการรีลีสชุดเดียวกันสำหรับทุกวิธีติดตั้ง และบอกว่าคุณต้องอัปเดตการติดตั้งของตัวเองอย่างไร เมื่อมีการอัปเดต หน้าแรกจะแสดง `vX.Y.Z available · mercury update` หนึ่งครั้งที่มุมขวาล่าง และแชทจะแสดงการแจ้งเตือนเดิมจนกว่าคุณจะอัปเดต ตั้งค่า `MERCURY_UPDATE_NOTICE=0` เพื่อซ่อนทั้งสองอย่าง

คำขอติดตั้งและอัปเดตดึงรายการรีลีสสาธารณะและ archive แบบไม่ระบุตัวตน คุณรันได้โดยไม่ต้องมีบัญชีหรือโทเคน หากคำขอแบบไม่ระบุตัวตนถูกปฏิเสธ Mercury จะตรวจสอบ GitHub CLI (`gh`) ที่ลงชื่อเข้าใช้อยู่

หลังอัปเดต Mercury จะตรวจสอบว่าคำสั่งบน PATH ของคุณชี้ไปยังการติดตั้งที่อัปเดตแล้วหรือไม่ หากมีการติดตั้งอื่นที่มีลำดับความสำคัญสูงกว่า หรือคำสั่งที่อัปเดตแล้วหายไปจาก PATH มันจะอธิบายปัญหาและวิธีแก้ไข `mercury health` รายงานปัญหาเดียวกันนี้ด้วย

### การตรวจสอบรีลีส

ก่อนเปิดใช้งานรีลีส Mercury จะตรวจสอบ archive ของรีลีสกับ `SHA256SUMS.txt` นอกจากนี้ยังต้องการ payload ที่ลงนามด้วยคีย์รีลีสของ Mercury ซึ่งอยู่ในรายชื่อผู้เชื่อถือ (trust roster) ที่ฝังมาในตัวโปรแกรม ก่อนนำการอัปเดตเข้าสู่ขั้นเตรียม หากลายเซ็นถูกปฏิเสธ การติดตั้งที่ใช้งานอยู่จะไม่เปลี่ยนแปลง

ใช้ `--allow-unsigned` เพื่อยอมรับ payload ที่ไม่มีลายเซ็น Mercury ยังคงปฏิเสธคีย์ลงนามที่ไม่รู้จัก บล็อกลายเซ็นที่ผิดรูปแบบ และเนื้อหาที่ถูกดัดแปลง ผลลัพธ์ของคำสั่งและบันทึกในเครื่องจะแสดงให้เห็นทั้งคู่ว่าคุณอนุญาต payload ที่ไม่มีลายเซ็น

archive ของรุ่นเผยแพร่มีลายเซ็น เรียกใช้ `mercury health` เพื่อตรวจสอบลายเซ็นของรุ่นที่ติดตั้ง

archive ที่ไม่มีลายเซ็นของรุ่นเผยแพร่จะถูกระบุว่าไม่มีลายเซ็น การติดตั้งและการอัปเดตจะปฏิเสธ archive นั้น เว้นแต่คุณจะส่ง `--allow-unsigned`

[docs/TRUST.md](../TRUST.md) อธิบายผลการตรวจสอบและวิธีตรวจ archive ด้วยตนเอง [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) ครอบคลุมการตรวจสอบตอนเริ่มต้น

### หมายเหตุเกี่ยวกับแพลตฟอร์ม

มี archive ของรีลีสสำหรับทุกแพลตฟอร์มที่ระบุไว้ข้างต้น เครื่องอื่นทุกเครื่องจะบิลด์จากซอร์ส

มี archive ของรุ่นเผยแพร่สำหรับ Intel Mac

</details>

## ข้อกำหนดเบื้องต้น

archive ของรีลีสมาพร้อม Node 24 LTS ตัวเปิด `mercury install` และ `mercury update` ใช้รันไทม์ที่รวมมานี้ ส่วน `git` เป็นข้อกำหนดเดียวที่ต้องติดตั้งแยกสำหรับตัวรีลีสเอง

หากต้องการบิลด์จากซอร์ส คุณต้องมี:

- **Node 24 LTS** ในช่วงที่รองรับ `>=24.20.0 <25` `.node-version` ปักหมุดแพตช์ที่ใช้สำหรับการบิลด์และรวมอยู่ใน archive ของรีลีส
- **bun 1.4.4** สำหรับการบิลด์ ไม่ได้รวมมากับรีลีส
- **git** บน Windows ให้รัน PowerShell 7 ภายใน Windows Terminal หรือเทอร์มินัลของ VS Code ดู [docs/INSTALL-WINDOWS-FROM-SOURCE.md](../INSTALL-WINDOWS-FROM-SOURCE.md)

เวอร์ชัน Node ขั้นต่ำรวมการแก้ไขสำหรับ nodejs/node#56645 ต่ำกว่า 24.20.0 คำสั่ง headless `run` ที่เรียกใช้เครื่องมือจะถูกยกเลิกเมื่อออกจากโปรแกรมบน Windows

ตัวเปิดจะเลือก Node ตามลำดับนี้: ไบนารี `MERCURY_NODE` ที่ระบุไว้อย่างชัดเจน รันไทม์ที่รวมมา แล้วจึงเป็นการติดตั้ง Node ที่เข้ากันได้บน PATH หากไม่มีรันไทม์ ตัวเปิดจะรายงานข้อผิดพลาด

### เชลล์บน Windows

archive ของรีลีสรวม shell engine ที่เข้ากันได้กับ bash ของ Mercury (`brush`) และบน Windows engine นี้จะให้บริการเครื่องมือ Bash เป็นค่าเริ่มต้น โดยค้นหาโปรแกรม `.cmd` หรือ `.bat` เช่น `npm` ด้วยชื่อสั้นผ่าน PATHEXT ส่ง `%VAR%` และ `^` ให้ไฟล์ batch โดยไม่เปลี่ยนแปลง รันโปรแกรมที่ระบุด้วยพาธสัมพัทธ์หลัง `cd` และคงสถานะของ shell ไว้ระหว่างการเรียกแต่ละครั้ง ไม่ต้องใช้ `bash.exe` ของ Git for Windows เมื่อมีการติดตั้งไว้ `MERCURY_SHELL_ENGINE=system` หรือ `system` ใน `/config` ภายใต้ Shell engine จะให้เครื่องมือ Bash ทำงานผ่าน `bash.exe` เพียงอย่างเดียว

อ่านแถว `shell` ของ health check เพื่อดูว่า shell ใดกำลังทำงานอยู่และเพราะเหตุใด คือ engine ที่รวมมา (ค่าเริ่มต้นบน Windows หรือถูกเปิดใช้โดยการปักหมุดหรือการตั้งค่า) หรือ Git Bash เมื่อปิด engine แล้ว หรือไม่มีแพ็กของ engine

บน macOS และ Linux shell ของระบบเป็นค่าเริ่มต้น ตั้งค่า `MERCURY_SHELL_ENGINE=brush` หรือเลือก `brush` ใน `/config` ภายใต้ Shell engine เพื่อให้เครื่องมือ Bash ทำงานบน engine ที่รวมมาด้วยที่นั่นเช่นกัน พร้อมคงสถานะของ shell ไว้

บิลด์จากซอร์สที่ไม่มีแพ็ก engine หรือ Git for Windows ยังเริ่มทำงานได้ แต่เครื่องมือ Bash จะใช้ไม่ได้ เครื่องมือ PowerShell ยังคงใช้ได้ และการวินิจฉัย `shell` จะอธิบายวิธีคืนการรองรับ Bash

## การบิลด์จากซอร์ส

Mercury บิลด์ด้วย bun และรันบน Node 24 LTS ติดตั้ง [ข้อกำหนดสำหรับการบิลด์จากซอร์ส](#ข้อกำหนดเบื้องต้น) รวมถึง bun 1.4.4:

```sh
curl -fsSL https://bun.com/install | bash -s -- bun-v1.4.4           # macOS และ Linux
powershell -c "& ([scriptblock]::Create((irm https://bun.com/install.ps1))) -Version 1.4.4"       # Windows ใน PowerShell 7
bun --version                                      # 1.4.4
```

จากนั้น ในโคลนของรีโพซิทอรีนี้:

```sh
bun run setup                      # ครั้งเดียว; bun install + แพ็กที่ vendor ไว้
bun run build.ts                   # เขียน dist/mercury.mjs + dist/manifest.json
node dist/mercury.mjs --version
node dist/mercury.mjs
node dist/mercury.mjs health --json
```

### การรองรับเทอร์มินัล

อินเทอร์เฟซแบบเต็มหน้าจอต้องใช้ TTY จริง แต่ไม่มีขนาดเทอร์มินัลขั้นต่ำ เลย์เอาต์เต็มเริ่มที่ 100 คอลัมน์ × 26 แถว หน้าต่างที่เล็กกว่าจะใช้เลย์เอาต์แบบกระชับ

Mercury ใช้สี 24 บิตเมื่อเทอร์มินัลประกาศการรองรับผ่าน `COLORTERM=truecolor` หรือถูกระบุว่าเป็น iTerm2, Ghostty, WezTerm, Kitty, Windows Terminal หรือ VS Code เทอร์มินัลอื่นใช้ 256 สี รวมถึง Terminal ของ Apple บน macOS 15 และเก่ากว่า

แถว Terminal color ของ health check จะรายงานระดับสีที่ตรวจพบและเหตุผล ตั้งค่า `MERCURY_TRUECOLOR=1` สำหรับเทอร์มินัลที่รองรับทรูคัลเลอร์แต่ไม่ได้ประกาศไว้ หรือ `MERCURY_TRUECOLOR=0` เพื่อบังคับใช้ 256 สี

### ส่วนประกอบเสริม

`setup` ดาวน์โหลดแพ็กความสามารถที่รวมมา ได้แก่ pyright, debugpy, js-debug, grammar เพิ่มเติม, รันไทม์ Node ของแพลตฟอร์ม และ brush หากการดาวน์โหลดล้มเหลว แพ็กนั้นจะถูกข้ามไป และการบิลด์กับเครื่องมือที่ได้รับผลกระทบจะรายงานว่าขาดส่วนประกอบนั้น การรัน `bun install` เพียงอย่างเดียวจะได้บิลด์ที่ไม่มีแพ็กเหล่านี้

หากต้องการบิลด์การรองรับเสียง ให้รัน `setup` เมื่อติดตั้ง Rust แล้ว ซึ่งจะบิลด์ `native/voice` หากต้องการบิลด์ `native/whisper` ด้วย ให้เพิ่ม cmake เมื่อติดตั้ง Rust แล้ว `setup` จะบิลด์ desktop driver addon (`native/desktop`) ที่เครื่องมือ `Computer` ใช้งานด้วย เมื่อติดตั้ง Rust แล้ว `setup` ก็จะบิลด์ local embedding addon (`native/embed`, `bun run scripts/vendor/build-embed.ts`) และดาวน์โหลดโมเดล BGE ขนาด 118 MB (`bun run scripts/vendor/fetch-embed-models.ts --default`) หากไม่มี cargo แพ็กนี้จะถูกข้าม setup จะแจ้งให้ทราบ และการค้นหาหน่วยความจำ Mneme จะทำได้เพียงการจับคู่คำ ทุก archive ของรีลีสมีแพ็ก embedding ที่บิลด์มาสำหรับแพลตฟอร์มนั้น บน Linux และ Windows การคำนวณทำงานบน vectorised kernel ทำให้ Recall ตามความหมายใช้เวลาประมาณหนึ่งในสิบของวินาที (บน macOS ซึ่งใช้ Accelerate จะเร็วกว่า เหลือเพียงไม่กี่ส่วนร้อยของวินาที) หากการบิลด์ native ขาดเครื่องมือที่ต้องใช้ setup จะข้ามการบิลด์นั้น และ health check จะรายงาน addon ที่หายไป shell engine ของ Windows ก็ถูกคอมไพล์บนเครื่องของคุณด้วย เพราะ upstream ไม่มีไบนารีสำหรับ Windows

ดู [เชลล์บน Windows](#เชลล์บน-windows) และ [docs/TERMINAL-RUNTIME.md](../TERMINAL-RUNTIME.md) สำหรับ shell engine `brush`

การบิลด์เขียนลงเฉพาะ `dist/` การตั้งค่าและเซสชันอยู่ใน `~/.mercury` หรือไดเรกทอรีที่ตั้งด้วย `MERCURY_CONFIG_DIR` และจะถูกสร้างตอนรันครั้งแรก บน Windows ให้รัน `node dist\mercury.mjs` โดยตรง

### การติดตั้งบิลด์จากซอร์สเป็นคำสั่ง

`scripts/ops/deploy-runtime.sh` เผยแพร่บิลด์ของ clean tree ไปยังโฟลเดอร์ใหม่ `<config home>/runtime/builds/<build>` และชี้ `runtime/current` ไปที่โฟลเดอร์นั้น (`runtime/dist` คือชื่อเก่าของลิงก์เดียวกัน) `scripts/ops/deploy-launcher.sh` ติดตั้งตัวเปิดที่ `<config home>/bin/mercury` เพิ่มไดเรกทอรีนั้นลงใน PATH สำหรับ zsh:

```sh
echo 'export PATH="$HOME/.mercury/bin:$PATH"' >> ~/.zshrc
```

ตัวเปิดจะหยุดพร้อมข้อผิดพลาดหากไม่มีรันไทม์ และจะไม่สลับไปใช้บิลด์อื่น การเลือก Node เป็นไปตามลำดับใน [ข้อกำหนดเบื้องต้น](#ข้อกำหนดเบื้องต้น) สำหรับการติดตั้งรีลีส ให้รัน `mercury install` หรือ `mercury update` ซึ่งจะไม่แตะต้องโค้ดที่ checkout จากซอร์ส ดู [การอัปเดต](#การอัปเดต)

[AGENTS.md](../../AGENTS.md) เป็นคู่มือสั้น ๆ สำหรับการบิลด์และการรัน [BUILD-NOTES.md](../../BUILD-NOTES.md) อธิบายการบิลด์โดยละเอียดกว่า

## การรันครั้งแรก

ในการรันแบบโต้ตอบครั้งแรก ให้เลือกลักษณะที่ปรากฏ (appearance) แล้วลงชื่อเข้าใช้ผู้ให้บริการ หน้าจอจะแสดงตัวอย่างธีมขณะที่คุณเลื่อนดู True Black เป็นค่าเริ่มต้น ส่วนตัวเลือกอื่นคือธีม oasis dark และ Black and white ซึ่งไม่ระบายสีใดเลย ใช้สีตัวอักษรและพื้นหลังของเทอร์มินัลเอง เหมือนวิธีที่ Mercury แสดงผลบนเทอร์มินัลที่ไม่มีสี คุณเปลี่ยนได้ภายหลังด้วย `/appearance`

คุณยังเลือก "sign in later" เพื่อดูโปรแกรมโดยไม่เชื่อมต่อบัญชีได้ เมื่อคีย์ของผู้ให้บริการในสภาพแวดล้อมของคุณลงชื่อเข้าใช้ผู้ให้บริการนั้นอยู่แล้ว ขั้นตอนลงชื่อเข้าใช้จะไม่ถูกถาม จากนั้นขั้นตอน Guardrails จะเตือนให้คุณตรวจสอบการแก้ไขและคำสั่งของ Mercury และเตือนว่าสิ่งที่มันอ่านอาจมีคำสั่งสำหรับโมเดลซ่อนอยู่ ในเทอร์มินัลที่ Mercury รู้วิธีตั้งค่า (Terminal.app, ตระกูล VS Code, Alacritty, Zed) ขั้นตอน Terminal keys สามารถตั้งค่าการผูกคีย์ขึ้นบรรทัดใหม่ในการตั้งค่าของเทอร์มินัลเอง (บน Terminal.app ของ macOS จะตั้ง `Option+Enter` สำหรับขึ้นบรรทัดใหม่ และปิดเสียงกระดิ่งของเทอร์มินัลในทุกโปรไฟล์ ซึ่งมีผลหลังรีสตาร์ท Terminal.app; ในตระกูล VS Code, Alacritty และ Zed จะเขียน `Shift+Enter` สำหรับขึ้นบรรทัดใหม่) ขั้นตอนนี้ปิดอยู่จนกว่าคุณจะเลือกเปิด และจะเก็บสำรองไว้หนึ่งชุด

ต่อมา Mercury จะถามว่าคุณเชื่อถือโฟลเดอร์ที่เปิดอยู่หรือไม่ ไม่มีสิ่งใดที่ถูกร้องขอโดยการกำหนดค่า workspace จะทำงานก่อนที่คุณจะให้ความเชื่อถือนั้น การให้ความเชื่อถือครอบคลุมทั้งรีโพซิทอรี หากปฏิเสธ Mercury จะออก ดู [docs/TRUST.md](../TRUST.md)

การเปิดแบบโต้ตอบปกติจะแสดงหน้าจอหลัก มีรายการเมนูสิบรายการ โดย Continue Last Session จะปรากฏก็ต่อเมื่อคุณมีประวัติเซสชันแล้ว:

- **New Session in \<folder\>** เริ่มเซสชันใหม่ในโฟลเดอร์ปัจจุบัน
- **Continue Last Session** กลับไปยังแชทล่าสุดของคุณ
- **Boot Menu** กำหนดค่าเซสชันถัดไป รวมถึง motion, crewmates และ workflows
- **MCPs & Skills** เลือกสิ่งที่เซสชันถัดไปจะโหลด ดู [docs/KIT.md](../KIT.md)
- **Agents** สร้างและแก้ไขเอเจนต์
- **Health Check** ตรวจสอบการติดตั้ง
- **Saturn Scheduler** จัดตารางเซสชัน ดู [docs/SATURN.md](../SATURN.md)
- **Logins** เชื่อมต่อบัญชีผู้ให้บริการ
- **Session Concourse** เปิดรายการเซสชันของโปรเจกต์ปัจจุบัน
- **Sessions · Projects** ให้คุณเลือกเซสชันหรือรีโพซิทอรี

รายการเมนูจะเปิดทับหน้าจอหลัก และ `Esc` จะกลับไปยังรายการที่คุณเลือก รายการเซสชันจะเปิดบนหน้าจอแยกต่างหาก ซึ่งเข้าถึงได้ด้วย `Shift+→` เช่นกัน อาร์กิวเมนต์ prompt, `--continue` หรือ `--resume` จะพาคุณไปยังแชททันที

### Motion, crewmates และ workflows

ส่วน Performance ของ Boot Menu มีการตั้งค่า Motion: `auto`, `full`, `reduced` หรือ `off` ซึ่งควบคุมแอนิเมชันตอนว่างในอินเทอร์เฟซ และยังมีให้ใช้ใน `/config` ด้วย

ภายใต้ Agents สวิตช์ Crewmates และ Workflows เป็นตัวกำหนดว่าเซสชันใหม่จะได้รับเครื่องมือ Crewmate และ Workflow หรือไม่ การปิดสวิตช์จะลบเครื่องมือที่สอดคล้องกันออก และความพยายามสร้างงานประเภทนั้นจะได้คำอธิบายเดียวกันกลับมา ภายในเซสชัน `/crewmates on|off` และ `/workflows on|off` จะเปลี่ยนการตั้งค่าที่ขอบเขตของเทิร์นถัดไป

## วงจรการทำงานประจำวัน: Session Concourse, git worktrees และ crewmates

### การเริ่มเซสชันและการแยก worktree

กด `Enter` ที่ New Session เพื่อสร้างเซสชันในโฟลเดอร์ปัจจุบันด้วยโมเดลค่าเริ่มต้นของคุณ Mercury จะเปิดแชทและเพิ่มเซสชันเข้าไปในรายการเซสชันพร้อมกัน และมันจะเตรียมโปรเซสไว้เบื้องหลังเมนูเพื่อลดงานตอนเริ่มต้น

การเริ่มเซสชันอื่นไม่ได้หยุดเซสชันก่อนหน้า คุณปล่อยให้งานทำงานต่อไปและไปทำงานที่อื่นได้ เปิดด้วย `--worktree [name]` (หรือขอ `worktree` ในแชทเพื่อรัน `EnterWorktree`) เพื่อให้เซสชันมีสาขาและ checkout ของตัวเองภายใต้ `.mercury/worktrees/` crewmates ที่ทำงานขนานก็สามารถรันใน worktree ที่แยกกันและประสานงานไฟล์ที่ใช้ร่วมกันด้วย lease ไฟล์ของโปรเจกต์ได้เช่นกัน ดู [ภายในประกอบด้วย](#ภายในประกอบด้วย-mneme-rag-memory-lsp-ast-23-ภาษา-dap-debugger-การค้นหาเว็บ-และบริดจ์) และ [docs/CREW.md](../CREW.md)

### การทำงานในแชท

อธิบายงานด้วยภาษาธรรมดา เอเจนต์จะอ่าน แก้ไข รัน และตรวจสอบโค้ดภายใต้โหมดสิทธิ์ที่คุณเลือก การเรียกเครื่องมือจะแสดงขณะที่กำลังทำงาน ทั้งแบบการ์ดกะทัดรัดหรือพร้อมเอาต์พุตเต็ม เลือกการแสดงผลได้ใน `/config` ภายใต้ Tool output การตั้งค่านี้จะถูกบันทึกไว้สำหรับการเปิดครั้งถัดไป

ใช้ `/model` และ `/effort` เพื่อปรับเซสชัน `/permissions` ควบคุมว่าอะไรรันได้โดยไม่ต้องอนุมัติ และอะไรต้องถามก่อน

ตรวจสอบการเปลี่ยนแปลงด้วย `/diff` ตามแหล่งที่มา ไฟล์ และ hunk `! <command>` รันคำสั่ง shell ในแชทพร้อมแสดงส่วนท้ายของเอาต์พุตแบบสด `/runs` แสดง shell และ crewmates ที่กำลังรันอยู่ (`/tasks` เปิดบอร์ดเดียวกัน) และ `/crewmates` เปิดมุมมอง Crew แบบสด ระหว่างเทิร์น `/clear` จะบันทึกแชทปัจจุบันและเปิดเซสชันใหม่ ส่วน `/restart` ย้ายแชทไปยังบิลด์ Mercury ที่เพิ่งติดตั้ง `/title` ตั้งชื่อแชท และ `/help` แสดงรายการคำสั่งที่ใช้ได้

### การสลับระหว่างหน้าจอ

`Shift+←` และ `Shift+→` สลับระหว่างหน้าจอที่ใช้ได้ในขณะนั้น การเปิดครั้งแรกจะมีหน้าจอหลักและรายการเซสชัน หน้าจอแชทจะถูกเพิ่มเมื่อเซสชันได้รับโฟกัส และถูกลบออกเมื่อแชทสุดท้ายปิดลง คำแนะนำปุ่มจะแสดงเฉพาะการเคลื่อนที่ที่ทำได้

การปิดแชททุกอันจะพาคุณกลับไปยังหน้าจอหลัก ใช้ `--chat` เพื่อให้มีเฉพาะหน้าจอหลักและแชท โดยไม่มีรายการเซสชัน `--concourse-off` จะบันทึกการตั้งค่านี้สำหรับการเปิดครั้งถัดไป และ `--concourse-on` หรือ `/config` จะเปิดกลับมา

### การจัดการเซสชันบน Session Concourse

เปิดรายการเซสชันด้วย `/concourse` หรือ `Shift+→` จากหน้าจอหลัก รายการจะแสดงเซสชันที่กำลังรันของโปรเจกต์ปัจจุบันก่อน ตามด้วยแชทที่บันทึกไว้ซึ่งไม่ได้รันอยู่ เรียงจากใหม่ไปเก่า

เซสชันที่กำลังรันแต่ละอันจะมีช่อง NOW แสดงกิจกรรมปัจจุบันของมัน เลือกแถวแล้วกด `Enter` เพื่อกลับไปยังแชท ขณะที่เซสชันอื่นยังรันต่อไป เซสชันที่ crash จะยังอยู่ในรายการเซสชันด้วยป้าย NEEDS YOU พร้อมเหตุผล จนกว่าคุณจะปล่อยมัน

[docs/SESSIONS.md](../SESSIONS.md) ครอบคลุมวงจรชีวิตของเซสชัน

## ผู้ให้บริการและโมเดล: การลงชื่อเข้าใช้, `/localsetup` และ `/llmhost`

ใช้ `/logins` เพื่อเชื่อมต่อผู้ให้บริการ คำสั่งนี้จะเปิดแคตตาล็อกการลงชื่อเข้าใช้ชุดเดียวกับที่ใช้ระหว่างการตั้งค่า `/accounts` จัดการช่องผู้ให้บริการที่เชื่อมต่อไว้หลังจากนั้น

- **OpenAI:** การสมัครสมาชิก ChatGPT หรือคีย์ API
- **Anthropic:** การสมัครสมาชิก Claude, การลงชื่อเข้าใช้ Console หรือคีย์ API
- **OpenRouter:** เข้าถึงแคตตาล็อกผ่าน OAuth หรือคีย์ API คำขอโมเดลจะปฏิเสธการเก็บข้อมูลและต้องการทุกพารามิเตอร์ตั้งแต่เริ่มต้น `/config → OpenRouter routing policy` กำหนดตัวเลือก fallback และ zero-data-retention; เลือก open เพื่อผ่อนคลายนโยบายและปล่อยให้การกำหนดเส้นทางเป็นหน้าที่ของ OpenRouter
- **Google Gemini:** Sign in with Google, คีย์ API หรือ OAuth client ของคุณเอง Sign in with Google รัน Gemini ด้วยโควตาของแพ็กเกจที่บัญชี Google นั้นถืออยู่ (บัญชีฟรี, Google AI Pro หรือ Google AI Ultra) ผ่าน client Antigravity ของ Google เอง: prompt, schema ของเครื่องมือ และผลลัพธ์ของเครื่องมือจะถูกส่งไปยัง endpoint Code Assist ของ Google ภายใต้ client นั้นและบัญชีที่ลงชื่อเข้าใช้ และ `/model` จะแสดงรายการโมเดลที่ Google ให้บริการแก่บัญชีนั้น คีย์ API หรือ OAuth client ของคุณเองจะเรียกเก็บเงินกับโปรเจกต์ Cloud แทน
- **Hugging Face:** การลงชื่อเข้าใช้ด้วย device code หรือโทเคน Hub
- **Kimi (Moonshot):** การลงชื่อเข้าใช้ด้วย device code หรือคีย์ API
- **GLM (Z.AI):** คีย์การสมัครสมาชิก GLM Coding Plan หรือคีย์ API แบบจ่ายตามการใช้งานทั่วไป `/logins zai` เก็บอย่างใดอย่างหนึ่งและบันทึกแพ็กเกจ `ZAI_API_KEY` ก็ใช้ได้เช่นกัน โดยมี `ZAI_KEY_PLAN=coding|general` ระบุแพ็กเกจ (ถ้าไม่ตั้งค่า Mercury จะอ่านแพ็กเกจจากรายการโมเดลของคีย์นั้นเอง)
- **DeepSeek:** คีย์ API จากแพลตฟอร์ม DeepSeek (`/logins deepseek` หรือ `DEEPSEEK_API_KEY`)
- **xAI (Grok):** ลงชื่อเข้าใช้ด้วยการสมัครสมาชิก Grok ของคุณ (SuperGrok / X Premium) หรือวางคีย์ API ผ่าน `/logins xai`
- **Meta (Muse):** Sign in with Meta (การสมัครสมาชิก Muse Code, device code ในเบราว์เซอร์ของคุณ) หรือคีย์ Model API แบบจ่ายตามการใช้งาน Sign in with Meta แลก device code กับ endpoint OIDC ของ Meta (`https://auth.meta.com/oidc/device/authorization/` และ `/oidc/device/token/`) ภายใต้ public client id ของ Muse Code แล้วส่งโทเคนบัญชีที่ได้ไปยัง `https://api.meta.ai/muse-code/key` เพียงครั้งเดียวเพื่อสร้างคีย์ API ของการสมัครสมาชิก (และอ่าน `/usage` แบบจำกัดเพื่อดูระดับแพ็กเกจและช่วงการใช้งาน) จากนั้นส่งเฉพาะคีย์ที่สร้างขึ้นนั้นในทุกคำขอโมเดลไปยัง `https://api.meta.ai/v1` คีย์ Model API ที่วางเข้ามา หรือ `MODEL_API_KEY` / `META_API_KEY` จะเรียกเก็บเงินแบบจ่ายตามการใช้งาน

- **Qwen:** คีย์ QwenCloud (Token Plan หรือจ่ายตามการใช้งาน) หรือคีย์ Alibaba Cloud Model Studio (จ่ายตามการใช้งาน, Token Plan หรือ Coding Plan) ซึ่งจะถูกตรวจสอบบน endpoint ของตัวเองก่อนจัดเก็บ คีย์ของแพ็กเกจจะแสดงรายการโมเดลของแพ็กเกจ โดย Qwen3.8 Max ขึ้นก่อน
- **MiniMax:** คีย์ Open Platform หรือคีย์การสมัครสมาชิก M Plan
- **Together AI** และ **Cohere:** คีย์ API
- **Groq**, **Cerebras** และ **Fireworks AI:** คีย์ API; คีย์ของตระกูลใดก็ได้สามารถมาจากคำสั่งที่ระบุไว้ใน `credentials.keyCommands.<family>`

Mistral, Nous Portal และ OpenCode Zen ก็เชื่อมต่อผ่าน `/logins` ได้เช่นกัน รวมเป็นตระกูลผู้ให้บริการที่ลงชื่อเข้าใช้ได้ 22 ตระกูล เซิร์ฟเวอร์โมเดลในเครื่อง (Ollama, LM Studio, vLLM และ llama.cpp) และ endpoint ที่เข้ากันได้กับ OpenAI แบบกำหนดเองทำงานได้โดยไม่ต้องลงชื่อเข้าใช้ผู้ให้บริการ รัน `/localsetup` เพื่อติดตั้งหรือเริ่ม Ollama, ดึงโมเดลที่พอดีกับหน่วยความจำของคุณ, ตั้งค่า context window ของมัน หรือเชื่อมต่อกับเซิร์ฟเวอร์ LM Studio, vLLM หรือ llama.cpp ที่กำลังรันอยู่ ([docs/LOCAL-SETUP.md](../LOCAL-SETUP.md)) แต่ละผู้ให้บริการใช้โปรโตคอล ข้อมูลประจำตัว และการจัดการข้อผิดพลาดของตัวเอง และคำขอจะไม่ย้อนไปยังผู้ให้บริการอื่นเลย ดู [docs/ENGINES.md](../ENGINES.md)

`/llmhost` แสดงรายการโมเดลที่คุณโฮสต์ได้ และบอกว่าแต่ละโมเดลรันได้ที่ใดในขณะนี้: บน GPU ที่เช่าจาก Runpod, Vast.ai หรือ Lambda, บนคอมพิวเตอร์ของคุณหรือคอมพิวเตอร์ SSH ที่บันทึกไว้ (`mercury host`) หรือบนเซิร์ฟเวอร์โมเดลที่มีอยู่แล้ว แต่ละหน้าโมเดลแสดงตัวเลือก quantization, วิธีที่งบหน่วยความจำ GPU ถูกแบ่งให้การสนทนาที่ทำงานขนาน (`conversations × context`) และระดับ thinking เริ่มต้น (ซึ่ง `/effort` เปลี่ยนได้ในแต่ละคำขอ) การเช่า GPU ต้องยืนยันราคารายชั่วโมงอย่างชัดเจน และการตั้งค่าจะดำเนินต่อในพื้นหลังหากคุณปิดป๊อปอัป บน Runpod คุณยังปรับคุณภาพ การแบ่ง context และ thinking ได้ก่อนเช่า หรือบน pod ที่กำลังรันอยู่ (`Tune`) เก็บน้ำหนักโมเดลไว้บน volume ที่โหลดเร็ว และตั้งการเฝ้าสต็อก 5 วินาทีได้ การเช่า Vast.ai และ Lambda เป็นฟีเจอร์ใหม่ใน 1.0.0-beta.40 และได้รับการตรวจสอบกับ API ที่ผู้ให้บริการเผยแพร่ด้วย fixture ทดสอบ (ไม่ได้มีการเช่าจริง) ดู [docs/LLM-HOST.md](../LLM-HOST.md)

เซสชันใหม่ใช้ผู้ให้บริการที่คุณเชื่อมต่อล่าสุดและโมเดลที่ใหม่ที่สุดซึ่งบัญชีนั้นใช้ได้ โมเดลที่บัญชีเข้าถึงไม่ได้จะถูกข้าม หากผู้ให้บริการนั้นไม่มีโมเดลที่ใช้งานได้ Mercury จะตรวจผู้ให้บริการที่เชื่อมต่อล่าสุดรายถัดไป การเลือกนี้เกิดขึ้นตอนเริ่มเซสชัน คำขอที่ล้มเหลวในเซสชันที่มีอยู่แล้วจะยังคงอยู่กับผู้ให้บริการเดิม

`/model` อธิบายการเลือก คำที่เป็นชื่อตระกูลจะเลือกโมเดลที่ใหม่ที่สุดของตระกูลนั้น: `/model grok`, `/model deepseek`, `/model kimi` หรือ `/model glm` เมื่อไม่มีผู้ให้บริการที่เชื่อมต่อ หน้าจอหลักและ `/model` จะชี้ให้คุณไปที่ `/logins` ส่วน `/defaultprovider` ให้คุณกำหนดผู้ให้บริการให้เป็นตัวเลือกล่าสุดอย่างชัดเจน

การเข้าถึงผู้ให้บริการยังคงขึ้นอยู่กับข้อกำหนดและความพร้อมใช้งานของผู้ให้บริการนั้น ใบอนุญาตของ Mercury ไม่ได้มาแทนที่ข้อกำหนดเหล่านั้น

## CLI แบบ headless: `mercury run`, Docker และตัวรัน JSON-RPC

บิลด์เดียวกันนี้รันได้โดยไม่ต้องมีอินเทอร์เฟซแบบโต้ตอบ `node dist/mercury.mjs --help` แสดงทุกแฟลก

`mercury run "<prompt>"` รัน prompt โดยไม่มี terminal UI:

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` พิมพ์คำตอบ เหตุผลของเทิร์นที่ล้มเหลวจะส่งไปยัง stderr
- `json` พิมพ์แถว `outcome` สุดท้ายเป็นออบเจกต์ JSON หนึ่งออบเจกต์
- `rows` เขียนออบเจกต์ JSON หนึ่งออบเจกต์ต่อหนึ่งบรรทัด: `session` จากนั้นเป็น `turn` พร้อมแถว `text`, `reasoning`, `tool_call`, `tool_result` และ `step` ของมัน และจบด้วย `outcome` แถวการรอ ความคืบหน้าของเครื่องมือ งานเบื้องหลัง และการแจ้งเตือนมีแถวของตัวเอง ทุกแถวมี `seq`, `timestamp` และ `session_id` แถวภายในเทิร์นมีหมายเลข `turn` ของเทิร์นนั้นด้วย `seq` นับสตรีมของการรันนี้เริ่มจาก 1 ส่วน `turn` นับเทิร์นของเซสชัน ดังนั้นการรันที่ต่อจากการสนทนาที่บันทึกไว้ (`-c`, `-r`, `--fork`) จะนับหมายเลขเทิร์นต่อจากเทิร์นที่มีอยู่แล้ว และแถว `session` ของมันจะระบุการสนทนาที่ต่ออยู่ใน `resume_of`

ประเภทของแถวผลลัพธ์ แยกตามฟิลด์ `type`:

- `session`: แถวเปิด ได้แก่ `version`, `build` (ตัวอักษรฐานสิบหกสิบสองตัวแรกของทรีที่ bundle ถูกบิลด์มา ตามที่ `mercury daemon status` แสดง จะไม่มีเมื่อไม่มี manifest อยู่ข้าง bundle), `resume_of` (ในการรันที่ต่อเนื่อง คือ session id ของการสนทนาที่ต่ออยู่ ซึ่งเหมือนกับ `session_id` เว้นแต่การรันนั้นถูก fork), `cwd`, `model`, `mode`, `tools`, `mcp_servers`, `commands`, `agents`, `skills` และ `extensions` ที่เซสชันมี รวมถึง `tools_withheld` (มีเมื่อกฎ deny กักเครื่องมือไว้ด้วยชื่อเปล่า โดยแต่ละรายการมี `tool`, `rule` และ `source`)
- `turn`: เทิร์นที่ `started` หรือ `waiting` พร้อม `turn_id` และ `model`, `message_ids` กับจำนวน `agents` เมื่อทราบ
- `text`: บล็อกข้อความที่ตกลงแล้ว ได้แก่ `message_id`, `block`, `text` และ `phase` (`commentary` หรือ `final_answer`)
- `reasoning`: บล็อกการให้เหตุผลที่ตกลงแล้ว ได้แก่ `message_id`, `block`, `text` หรือ `redacted: true`
- `tool_call`: การเรียกเครื่องมือ ได้แก่ `call_id`, `tool`, `input` พร้อม `message_id` และ `block`
- `tool_result`: ผลของการเรียก ได้แก่ `call_id`, `status` (`ok`, `error`, `aborted` หรือ `refused`) และ `output` การเรียกที่โมเดลสร้างผิดรูปมากจนถูกปฏิเสธก่อนรัน (เครื่องมือที่ไม่รู้จัก อาร์กิวเมนต์ที่ไม่ใช่ JSON ที่ถูกต้อง หรือไม่ตรงกับ schema ของเครื่องมือ) ยังคงได้คู่ของมัน คือแถว `tool_call` ที่มีอาร์กิวเมนต์ตามที่ส่งมา (`{}` เมื่อไม่ใช่ออบเจกต์) และแถว `tool_result` ที่มี status เป็น `refused` โดย `output` คือเหตุผล จากนั้นจะตามด้วย `notice` สำหรับการแก้ไข การเรียกเช่นนี้ไม่เคยรันและไม่ถือเป็นการปฏิเสธ (denial)
- `tool_update`: ความคืบหน้าจากเครื่องมือที่กำลังรัน ได้แก่ `call_id`, `tick`, `source` (`shell`, `powershell`, `mcp` หรือ `eval`) และส่วนใดก็ได้ของ `line`, `elapsed_s`, `lines`, `bytes`, `budget_ms`, `progress` และ `total` ที่การเรียกรายงาน การเรียก shell หรือ PowerShell จะ tick ขณะที่เอาต์พุตมาถึง (คำสั่งที่ไม่พิมพ์อะไรจะไม่ tick เลย) การเรียก MCP เมื่อเซิร์ฟเวอร์รายงานความคืบหน้า การเรียก Eval ขณะเซลล์ของมันทำงาน เครื่องมืออื่นไม่ tick และการเรียก Browser หรือ Crewmate จะเงียบจนกว่าจะได้ผลลัพธ์
- `step`: การเรียกโมเดลหนึ่งครั้งของเธรดหลัก ได้แก่ `message_id`, `model`, `usage` และ `stop` เมื่อโมเดลบอกเหตุผลที่หยุด
- `outcome`: ผลลัพธ์ของเทิร์น อธิบายไว้ด้านล่าง
- `close`: โน้ตที่ทิ้งไว้ให้เซสชันถัดไปตอนปิด ได้แก่ `state` (`stored`, `skipped` หรือ `none`), `note_chars` และ `usage` ของการเรียกโมเดลที่เขียนโน้ตนั้น เพื่อให้ผู้อ่านที่รวม usage ของทุกแถวได้ผลเท่ากับของ outcome เมื่อให้ prompt เป็นอาร์กิวเมนต์ โน้ตจะถูกขอภายในเทิร์นสุดท้าย และ `close` มาก่อน `outcome` ของเทิร์นนั้น ส่วนเมื่อใช้ `--input rows` โน้ตจะตามหลัง `outcome` สุดท้ายเมื่อ stdin ปิด
- `wait`: การรอโมเดล ได้แก่ `state` (`first_byte`, `retry`, `silence`, `loading` หรือ `done`) พร้อมตัวเลขที่สถานะนั้นมี เช่น `since_ms`, `attempt` และ `of`, `delay_ms`, `reason` และ `http_status`
- `heartbeat`: สตรีมของโมเดลแสดงสัญญาณชีวิตหลังจากผ่านไปอย่างน้อยหนึ่งวินาทีโดยไม่มีอีเวนต์ที่ถูกแยกวิเคราะห์ คือมีไบต์เข้ามาแต่ไม่ได้ผลิตแถวใด แถวนี้ไม่มีข้อมูลอื่น และปรากฏอย่างมากวินาทีละหนึ่งครั้ง ความถี่ขึ้นอยู่กับรูปแบบการสตรีมของผู้ให้บริการ ดังนั้นสตรีมที่ไม่เคยหยุดระหว่างอีเวนต์จะไม่ส่งแถวนี้เลย
- `compaction`: การ compaction ที่ `started`, อยู่ใน `progress` หรือ `ended` ได้แก่ `trigger` (`manual`, `auto` หรือ `overflow`), `stage`, `fill`, `summary_tokens` และเมื่อจบจะมี `exit` (`landed`, `cancelled` หรือ `failed`)
- `mode`: โหมดสิทธิ์เปลี่ยนแล้ว ได้แก่ `mode`
- `rate_limit`: สถานะขีดจำกัดของผู้ให้บริการ ได้แก่ `status` (`allowed`, `warning` หรือ `rejected`), `window`, `resets_at`, `utilization` และฟิลด์ overage
- `task`: งานเบื้องหลังที่ `started`, อยู่ใน `progress` หรือ `ended` ได้แก่ `task_id`, `task_type`, `description`, `usage`, `summary`, `status` (`completed`, `failed` หรือ `stopped`) และ `output_file` เมื่อทราบแล้ว
- `notice`: `warning` หรือ `error` สำหรับผู้อ่าน ได้แก่ `text` และ `code` เช่น `input_refused`
- `command_output`: เอาต์พุตของคำสั่ง slash ที่ไม่เคยถึงโมเดล ได้แก่ `command` และ `text`
- `mission_updated`: บัญชีงาน (task ledger) ของเซสชันเปลี่ยนแล้ว ให้อ่านใหม่
- `samples_updated`: ตัวอย่าง (samples) ของเซสชันเปลี่ยนแล้ว ให้อ่านใหม่

`--partial` ร่วมกับ `--format rows` จะเพิ่มแถว `block_start`, `text_delta`, `reasoning_delta`, `tool_input_delta` และ `retracted` Delta เป็นของ `message_id` และ `block` ส่วนแถว `retracted` จะเพิกถอน delta ของข้อความนั้น แถว text หรือ tool ที่ตกลงแล้วคือค่าที่สมบูรณ์

Outcome (ผลลัพธ์ของเทิร์น) มี `schema`, `turn_id`, `status`, `steps`, `wall_ms`, `usage`, `models` และ `denials` โดยมี `answer` เมื่อเสร็จสมบูรณ์ และ `error` (`message`, `class`, `detail` ที่ไม่บังคับ) เมื่อล้มเหลว `stop`, `api_ms`, `cost_usd`, เอาต์พุต `structured` ที่ร้องขอ และ `notices` จะถูกรวมไว้เมื่อมี `wall_ms` คือเวลาที่ผ่านไปของเทิร์น `api_ms` คือผลรวมระยะเวลาของทุกคำขอโมเดลที่เทิร์นส่งออก (รวมการลองใหม่และคำขอของ crewmates ที่ทำงานคู่ขนานกับเธรดหลัก) จึงอาจเกิน `wall_ms` เมื่อคำขอซ้อนทับกัน `cost_usd` คือจำนวน USD ของคำขอที่มีราคาในเทิร์น ไม่ว่าสถานะจะเป็นอะไร คำขอที่ Mercury คิดราคาไม่ได้ (ไม่มีอัตราในไฟล์ ไม่มีค่าใช้จ่ายระบุในการตอบกลับ) จะไม่เพิ่มอะไรให้ค่านี้ และโมเดลนั้นยังคงแสดงใน `models` โดยไม่มี `cost_usd` ของตัวเอง ฟิลด์นี้จะหายไปก็ต่อเมื่อไม่มีอะไรในเทิร์นถูกคิดราคาเลย เมื่อล็อกอินด้วยการสมัครสมาชิก Claude คำขอ Anthropic ไม่มีราคาเป็นดอลลาร์ ดังนั้นทั้งคำขอและแถวจึงไม่มี `cost_usd` แต่ usage ยังคงอยู่ usage ประกอบด้วย `input_tokens` (รวม cached tokens), `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` และเมื่อมีการรายงาน `reasoning_output_tokens` โดยรวมจากเธรดหลักและ crewmates `models` แยก usage ของโทเคนตามโมเดล `steps` นับเฉพาะการเรียกโมเดลของเอเจนต์หลัก ส่วนการเรียกโมเดลของ crewmates จะปรากฏเป็นแถว `step` ของตัวเองที่มีแท็ก `parent_call_id`

Status (สถานะ) คือ `completed`, `blocked`, `refused`, `failed`, `interrupted`, `turn_limit`, `budget_limit`, `time_limit`, `schema_unmet` หรือ `loop_stopped` การรันภายใต้ `--max-time` (วินาที หรือ `10m`, `1h`) จะจบด้วย `time_limit` ที่ขั้นตอนถัดไปเมื่อหมดเวลา การเรียกโมเดลหรือรอบเครื่องมือที่กำลังดำเนินอยู่จะไม่ถูกตัด การรันที่เสร็จสมบูรณ์จะออกด้วยรหัส 0 ผลอื่นออกด้วย 1 และข้อผิดพลาดการใช้งานออกด้วย 2 SIGINT และ SIGTERM ออกด้วย 130 และ 143 หลังจาก outcome ของเทิร์นที่ถูกขัดจังหวะถูก flush แล้ว การเรียกเครื่องมือที่ถูกปฏิเสธจะแสดงอยู่ใน `denials` เมื่อการปฏิเสธเป็นคำขอที่ไม่มีใครตอบได้ (การรันที่ไม่มี host ในโหมดที่ถาม เช่น `--mode dontAsk` หรือคำขอของ host ที่หมดอายุ) และไม่มีการเรียกเครื่องมือที่สำเร็จตามมาในเทิร์น การรันจะเป็น `blocked` คำตอบจะถูกเก็บไว้ `error` ระบุชื่อเครื่องมือและวิธีดำเนินการต่อ (`--allowed-tools`, `--mode` อื่น หรือ host ที่ตอบคำขอ) และการรันออกด้วย 1 หากการเรียกเครื่องมือครั้งต่อมาในเทิร์นเดียวกันสำเร็จ เทิร์นจะกู้คืนและจบเป็น `completed` (รหัส 0) พร้อม `notice` คำเตือน (`"<Tool> was not approved; the run continued with other tools."`) การปฏิเสธที่คุณตอบเองแล้ว (ผ่านกฎ deny, hook หรือ host ที่ปฏิเสธ) ทำให้เทิร์นที่เสร็จแล้วยังคงเป็น completed การเรียก `AskUserQuestion` ที่ไม่มีคำตอบก็ทำให้การรันจบเป็น `blocked` เช่นกัน โดยคำถามจะถูกอ้างอิงใน `error` Mercury อ่านผลลัพธ์จากคำขอที่บันทึกไว้ของการรัน ไม่เคยอ่านจากข้อความตอบกลับ ดังนั้นคำถามที่เขียนเฉพาะในข้อความตอบกลับจะจบเป็น `completed` คำสั่ง slash ที่ไม่รู้จักจะเป็น `refused` พร้อมประโยคเดียวกับที่หน้าจอโต้ตอบให้ (`Unknown command: /name · /help lists commands`) และออกด้วย 1

`--input rows` ต้องใช้ `--format rows` และอ่านอ็อบเจกต์อินพุตหนึ่งรายการต่อบรรทัด:

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

ประเภทอินพุตคือ `prompt` พร้อม `content` (ข้อความหรือบล็อกข้อความ/รูปภาพ), `shell` พร้อม `command` และ `note` พร้อม `to` (agent id) และ `content` แต่ละประเภทรับ `id` เสริมได้ ส่วนแถว prompt และ shell ยังรับ `priority` (`now`, `next` หรือ `later`), `sent_at` และ `origin` ได้ด้วย รูปร่างอินพุตที่ถูกปฏิเสธจะสร้าง `notice` ที่มีรหัส `input_refused` ส่วน JSON ที่ผิดรูปจะจบการรัน แถวเหล่านี้มีเฉพาะอินพุต คำตอบการอนุญาตใช้โปรโตคอลรันเนอร์ด้านล่าง

ใช้ `mercury run -` หรือส่งข้อความเข้า `mercury run` ผ่าน pipe เพื่ออ่าน prompt ทั้งหมดจาก stdin เมื่อใช้คู่กับอาร์กิวเมนต์ prompt ข้อความจาก pipe จะถูกต่อท้ายเป็นบริบทที่มีขอบเขตชัดเจน pipe จะถูกอ่านจนกว่าจะปิดหรือเงียบไปหนึ่งวินาที ดังนั้นสตรีมที่ยังส่งข้อมูลต่อเนื่องจะถูกอ่านจนจบ และ pipe ที่เปิดค้างไว้แต่เงียบจะไม่ยึดการรัน เมื่อไม่มี prompt และ stdin เป็นเทอร์มินัล `run` จะพิมพ์วิธีใช้และออกด้วย 2

`--mode <mode>` เลือกท่าทีสิทธิ์ `--sovereign` รันโดยไม่มีการถามสิทธิ์ และ `--allow-sovereign` ทำให้ท่าทีนั้นพร้อมให้สลับไปใช้ภายหลัง นโยบายสิทธิ์และกฎ deny ยังคงใช้งานอยู่ ผู้ใช้ root ที่เข้าสู่โหมด sovereign จะได้รับการแจ้งเตือนหนึ่งครั้งบน stderr และการรันยังคงดำเนินต่อไป

ใช้ `-c` เพื่อต่อการสนทนาล่าสุด `-r` เพื่อกลับไปยังการสนทนาตาม ID, ชื่อเรื่อง หรือตัวเลือก `-w` เพื่อรันใน worktree ที่จัดการไว้ และ `--lean` สำหรับเซสชันขั้นต่ำ `run` ไม่มี host ให้ตอบคำขอสิทธิ์ กฎสิทธิ์และโหมดของมันเป็นตัวกำหนดว่าอะไรรันได้ และการเรียกที่ยังต้องอนุมัติจะถูกปฏิเสธ

### อิมเมจแบบ headless

`Dockerfile` ที่รากของรีโพซิทอรีบิลด์อิมเมจ Linux x64 สำหรับ CI และเซิร์ฟเวอร์ จุดเข้าคือ `mercury` และคำสั่งเริ่มต้นคือ `run` ดังนั้นอิมเมจจะรัน prompt หนึ่งรายการกับทรีที่ mount ไว้ แล้วออกด้วยรหัสของการรันนั้น:

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

อิมเมจประกอบด้วย bundle, รันไทม์ Node 24 ของมัน (อยู่บน `PATH`), เครื่องมือค้นหา shell debugger เครื่องมือด้านภาษา และเครื่องมือด้านรูปภาพที่ vendor ไว้, `git` และ certificate store ไม่มีหน้าจอเข้าสู่ระบบและไม่มีขั้นตอนลงชื่อเข้าใช้ มันรันด้วยผู้ใช้ที่ไม่ใช่ root ชื่อ `mercury` โดยมี config home อยู่ภายในคอนเทนเนอร์ (`MERCURY_CONFIG_DIR`) และ `/work` คือไดเรกทอรีทำงาน สีและเมาส์เป็นไปตามการตรวจจับเทอร์มินัลของผลิตภัณฑ์เอง และ `--user 0` จะรันด้วยสิทธิ์ root พร้อมการแจ้งเตือน sovereign หนึ่งครั้งที่กล่าวไว้ข้างต้น

คีย์ของผู้ให้บริการจะส่งเข้ามาเป็นตัวแปรสภาพแวดล้อม โดยใช้การสะกดชื่อเดียวกับที่ผลิตภัณฑ์อ่านทุกที่: `ANTHROPIC_API_KEY` หรือ `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY` หรือ `GOOGLE_API_KEY`, `XAI_API_KEY` (และ `XAI_MANAGEMENT_API_KEY` สำหรับมิเตอร์การใช้งาน), `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `MISTRAL_API_KEY` (และ `MISTRAL_ADMIN_API_KEY` สำหรับมิเตอร์ขององค์กร), `NOUS_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`, `TOGETHER_API_KEY` หรือ `TOGETHER_AI_API_KEY`, `COHERE_API_KEY` หรือ `CO_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `DASHSCOPE_API_KEY`, `MODEL_API_KEY` หรือ `META_API_KEY`, `MERCURY_COMPAT_API_KEY` สำหรับ endpoint ที่เข้ากันได้กับ OpenAI แบบกำหนดเอง และ `MERCURY_LOCAL_API_KEY` สำหรับเซิร์ฟเวอร์ในเครื่อง ถ้าไม่มีคีย์ การรันจะปฏิเสธในหนึ่งบรรทัดและออกด้วย 1 `docker run -i … mercury run -` อ่าน prompt จาก stdin

### โฮสต์เซสชัน

`mercury runner` ให้บริการเซสชันแก่โฮสต์ผ่าน stdio: JSON-RPC 2.0 หนึ่งข้อความต่อหนึ่งบรรทัด โฮสต์จะส่ง `initialize` ก่อนและรอคำตอบก่อนส่งงาน:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

ชื่อและเวอร์ชันของโฮสต์อยู่ภายใต้ `host` และ `capabilities` ประกาศ `holds_asks`, `elicitation` และ `partial_rows` ทุก `id` ของคำขอต้องเป็นจำนวนเต็มบวก คำขอที่ `id` เป็นค่าอื่นจะได้รับคำตอบ `-32600` พร้อม `id: null` ดังนั้นควรนับหมายเลขคำขอเริ่มจาก 1

`queue/add` รับอ็อบเจกต์ prompt, shell หรือ note แบบเดียวกับอินพุตแถวด้านบน เอาต์พุตมาถึงในรูปการแจ้งเตือน `row` `session/facts` อ่านสถานะของเซสชัน `session/set_mode` เปลี่ยนโหมดสิทธิ์ทันที `session/set_model` และ `session/set_effort` เปลี่ยนโมเดลและระดับ effort ส่วนการเปลี่ยนแปลงที่ทำขณะเทิร์นกำลังรันจะถูกพักไว้จนกว่าเทิร์นจะจบ โดยตอบกลับด้วย `at: "turn_end"` แล้ว `session/applied` จะแจ้งให้ทราบ `turn/interrupt` หยุดเทิร์น และปิด stdin เพื่อจบเซสชัน

คำขอสิทธิ์จะมาในรูป `permission/request` พร้อม `kind: "tool"` หรือ `kind: "network"` โฮสต์ตอบด้วย `outcome: "allow"` หรือ `outcome: "deny"` โดย allow อาจมี `input` ที่แก้ไขแล้วและ `rules` ของสิทธิ์มาด้วย คำขอที่ถูกถอนจะส่ง `$/cancel_request` พร้อม `request_id` `holds_asks` ทำให้โฮสต์เป็นเจ้าของนาฬิกาของคำขอ คำถามของ MCP จะใช้ `elicitation/request` ก็ต่อเมื่อโฮสต์ประกาศ `elicitation` เท่านั้น มิฉะนั้นจะได้รับคำตอบ `cancel`

เมธอดที่ไม่รู้จักได้คำตอบ `-32601` พารามิเตอร์ที่ไม่ถูกต้องได้ `-32602` `id` ที่ไม่ใช่จำนวนเต็มบวกได้ `-32600` และคำขอก่อนการ initialize ได้ `-32002` การปฏิเสธตามกฎคือ `-32010` โดยมีประโยคอยู่ใน `error.message` และเหตุผลอยู่ใน `error.data.kind` เช่น `mode`, `model`, `effort` หรือ `claim` รันเนอร์ตอบบรรทัดที่รูปแบบผิดด้วย `-32700` แล้วทำงานต่อ บรรทัดที่รูปแบบผิดติดกันสามบรรทัดจะทำให้มันสิ้นสุด

### คำสั่งอื่น ๆ

คำสั่งที่ใช้ได้มีดังนี้:

- **`mercury health`**: รายงานการวินิจฉัย หรือที่เรียกว่า health certificate `--json` คืนรายงานทั้งหมด `--deep` รันการสำรวจเชิงลึก และ `--fix` รันการแก้ไขแบบมีคำแนะนำ
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**: ลงชื่อเข้าใช้ (`login [<family>]`) แสดงรายการตระกูลผู้ให้บริการ (`list`) ตรวจว่าบัญชีลงชื่อเข้าใช้อยู่หรือไม่ (`status [<family>]`) ออกจากระบบ (`logout [<family>]`) หรือสร้างโทเคน Anthropic อายุยาว (`mint`)
- **`mercury models [--json]`**: พิมพ์โมเดลที่บัญชีที่ลงชื่อเข้าใช้เข้าถึงได้ (ข้อมูลเดียวกับ `mercury://models`)
- **`mercury mcp`**: จัดการเซิร์ฟเวอร์ MCP ด้วย `add`, `import`, `list`, `get`, `remove`, `trust-reset` และ `serve`
- **`mercury extensions`**: ติดตั้งส่วนขยายและจัดการแหล่งที่มาของมัน การดำเนินการ: `list`, `sources`, `add`, `remove`, `refresh`, `install`, `trust`, `enable`, `disable`, `update`, `uninstall`, `fence`, `unfence`, `inspect` และ `scaffold`
- **`mercury roster`**: แสดงรายการ inventory ของเอเจนต์
- **`mercury usage`**: พิมพ์บรรทัดตัวเลขแบบกระชับที่หน้าจอ `/usage` แสดง `--json` พิมพ์ค่าอ่านทั้งหมด ได้แก่ หน้าต่างของผู้ให้บริการที่ลงชื่อเข้าใช้แต่ละราย พร้อมการใช้งานและเวลารีเซ็ต ตัวเลขและเครดิตที่แต่ละรายงาน พร้อมแหล่งที่มาและอายุของข้อมูล และการใช้จ่ายของเซสชันแยกตามโมเดล โดยอ่านตามวิธีที่หน้าจออ่าน (ตัวอ่านของผู้ให้บริการที่ลงชื่อเข้าใช้แต่ละรายถูกสุ่มตัวอย่างหนึ่งครั้ง เหมือนตอนเปิดหน้าจอ)
- **`mercury daemon run|status|stop|restart`**: รัน ตรวจสอบ หยุด หรือรีสตาร์ท daemon เบื้องหลัง seat ของเซสชันคือโพรเซสลูก `mercury runner` และ daemon ส่ง prompt ของมันพร้อมโฮสต์คำขอสิทธิ์ของมัน
- **`mercury sessions list`** (หรือ `mercury sessions` เปล่า): แสดงรายการเซสชันที่บันทึกไว้ของโปรเจกต์นี้ เรียงจากใหม่ไปเก่า ได้แก่ id, เวลาที่เขียนล่าสุด, ขนาด, `live` เมื่อ daemon โฮสต์อยู่ตอนนี้ และชื่อเรื่องหรือ prompt แรก `--all` อ่านทุกโปรเจกต์ `--limit <n>` จำกัดจำนวนรายการ id คือค่าที่ `mercury --resume <id>` เปิดใหม่และ `sessions delete` ลบ
- **`mercury sessions delete <id>`**: ลบเซสชันที่บันทึกไว้หนึ่งรายการโดยตั้งใจ ทั้ง transcript และบันทึกที่เก็บไว้ข้างกัน (ใบเสร็จ, snapshot สำหรับการกลับมาทำต่อ) หลังถามยืนยัน `--yes` ข้ามคำถามสำหรับสคริปต์ เซสชันที่ daemon โฮสต์อยู่ตอนนี้จะถูกปฏิเสธ และ id ที่ไม่รู้จักจะถูกปฏิเสธพร้อมคำแนะนำไปยัง roster (`/sessions` ภายใน Mercury) เซสชันที่บันทึกไว้จะไม่ถูกลบเองโดยอัตโนมัติ
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**: รันคอมพิวเตอร์ในเครื่องหรือผ่าน SSH เป็นเซิร์ฟเวอร์โมเดลให้ทุกเซสชันที่ใช้ config home ร่วมกัน (`compat/box-<name>/<model>`) โดยใช้คลังน้ำหนักในเครื่องที่ตรวจสอบแล้วหรือการดาวน์โหลดที่ยืนยันแล้ว ดู [docs/LLM-HOST.md](../LLM-HOST.md)
- **`mercury lsp list`** และ **`mercury lsp install <server>`**: แคตตาล็อก language server แต่ละเซิร์ฟเวอร์ถูกติดตั้งแล้ว (พร้อม binary) หรือยังไม่มี (พร้อมวิธีติดตั้ง) `install` แสดงวิธีติดตั้งของเซิร์ฟเวอร์ ถามยืนยัน รันคำสั่งนั้นตรงตัว (`--yes` ข้ามคำถามสำหรับสคริปต์) และรายงานว่า binary ถูกวางไว้ที่ใด เซิร์ฟเวอร์ที่ไม่รู้จักจะถูกปฏิเสธพร้อม roster Mercury ไม่เคยติดตั้ง language server เองโดยอัตโนมัติ การเปิดไฟล์เพียงเริ่มเซิร์ฟเวอร์ที่ติดตั้งไว้แล้วเท่านั้น
- **`mercury acp`**: ให้บริการ editor ผ่าน Agent Client Protocol โดยมีโพรเซสลูก runner สำหรับแต่ละเซสชัน `mercury bridge install` ติดตั้งส่วนขยาย VS Code `mercury bridge status` ตรวจสอบ และ `mercury bridge uninstall` ถอนการติดตั้ง
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**: จัดการงาน engine สำหรับโปรเจกต์ Godot ในไดเรกทอรีปัจจุบัน Mercury รัน suite บน headless worker ของตัวเองจากสำเนาโปรเจกต์ที่ตรึงไว้ บริการนี้ประกอบด้วยเกตการคอมไพล์ การจับภาพ สถิติเฟรม โปรไฟล์ที่เสถียร การเข้าถึงคิวงาน การยกเลิก และผลลัพธ์ตาม ID ดู [docs/VULCAN-GODOT-TOOLS.md](../VULCAN-GODOT-TOOLS.md)
- **`mercury image <image>`**: แสดงรูปภาพในเทอร์มินัล
- **`mercury install`** และ **`mercury update`** (alias `upgrade`): ติดตั้งหรืออัปเดต archive ของรีลีส ด้วย `--json` เอกสารจะอยู่บน stdout ไม่ว่าผลจะเป็นอะไร และรหัสออกบอกว่าล้มเหลวหรือไม่ ดู [การติดตั้ง](#การติดตั้ง)
- **`mercury version`** และ **`mercury help [command]`**: พิมพ์บรรทัดเวอร์ชันหรือหน้าความช่วยเหลือ เหมือนกับ `--version` และ `--help` ไม่มีอันไหนเริ่มเซสชัน

## ภายในประกอบด้วย: Mneme RAG memory, LSP, AST 23 ภาษา, DAP debugger, การค้นหาเว็บ และบริดจ์

- **หน่วยความจำโปรเจกต์แบบ hybrid RAG ของ Mneme.** Mneme เปิดใช้งานโดยค่าเริ่มต้น โดยเก็บข้อเท็จจริงของแต่ละโปรเจกต์ไว้ในหน้าหัวข้อ markdown ธรรมดา (`Retain`, `Recall`, `Reflect`, `Correct`) Recall ผสาน semantic embedding model BGE ขนาด 118 MB ที่รันบนอุปกรณ์ (`bge-base-en-v1.5` `q8_0`, MIT, รวมอยู่ในทุก archive ของรีลีสและบิลด์สำหรับแพลตฟอร์มนั้น; ดู [ส่วนประกอบเสริม](#ส่วนประกอบเสริม)) เข้ากับการจัดอันดับคำแบบ BM25 ที่ทำ stemming การถ่วงน้ำหนักตามความใหม่ และการติดตาม citation ผ่าน reciprocal rank fusion (`k = 60`) กฎที่ปักหมุด (`pin: true`) จะโหลดตามต้นฉบับบนชั้นที่ปักหมุด และเปลี่ยนแปลงเฉพาะตามคำสั่งของคุณ ตอนเริ่มเซสชัน Mercury จะให้คะแนนข้อเท็จจริงที่ไม่ได้ปักหมุดและโน้ตก่อนหน้า โดยเทียบกับ branch ปัจจุบัน ไฟล์ที่แตะล่าสุด และโน้ตส่งต่อของเซสชันที่แล้ว ภายในงบเริ่มต้นเฉพาะ (`memory.startLimit`, ค่าเริ่มต้น 4,000 ตัวอักษร) การตรวจความขัดแย้งตอนบันทึกจะจับการกลับขั้ว การปฏิเสธ และการสลับตัวเลข ก่อนที่ข้อเท็จจริงที่ขัดแย้งจะถูกบันทึก เมื่อจบเซสชันแต่ละครั้ง จะเขียนโน้ตส่งต่อด้วยคำของตัวเองสำหรับหน้าเริ่มต้นของเซสชันถัดไป พร้อมรายการบันทึกเซสชันแบบไม่บังคับ `/memory` เปิดศูนย์กลางหน่วยความจำ และ `/memory page` วาดคลังข้อมูลในเบราว์เซอร์ของคุณเป็นกราฟโหนดกับเส้นเชื่อม ดู [docs/MNEME.md](../MNEME.md)
- **LSP code intelligence, การเขียนโครงสร้าง AST ใหม่ใน 23 ภาษา, DAP debugger และเซลล์ `Eval`.** การอ่านแบบมีจุดยึด (anchored reads) และการแก้ไขหลายไฟล์แบบอะตอมมิก (`ChangeSet`) การสืบค้น language server (`LspRead`) และการ refactor แบบดูตัวอย่างแล้วค่อยนำไปใช้ (`LspRename`, `LspMoveSymbol`, `LspMoveFile`, `LspCodeAction`, `LspFormat`) การค้นหาและเขียนโครงสร้างไวยากรณ์ (`AstSearch`, `AstEdit`) ด้วยตัวแปร meta `$NAME` และ `$$$NAME` ข้าม 23 grammar ในแพ็กเกจรีลีส (16 ตัวในทุกการบิลด์ `bun install` บวก 7 ตัวในแพ็ก grammar) เซลล์โค้ด Python (`python3`) และ JavaScript (ES module ของ Node) ที่คงสถานะไว้ (`Eval`) และ debugger แบบ Debug Adapter Protocol (`Debug`) ที่ขับเคลื่อน `debugpy`, `js-debug`, `lldb`, `gdb`, `dlv`, `netcoredbg`, `rdbg`, debug adapter ของ Dart SDK, `kotlin-debug-adapter`, debug adapter ของ elixir-ls และ Godot เครื่องมือ `Test` มีการทำงาน `debug` ที่จะพาเทสต์ Python (`pytest`, `unittest`), JavaScript/TypeScript (`node-test`, `vitest`, `jest`), Go (`go test`) หรือ Rust (`cargo test`) ที่ล้มเหลว เข้าสู่เซสชัน `Debug` ได้ทันทีเพื่อไล่ทีละขั้น ดู [docs/LANGUAGE-SERVICE.md](../LANGUAGE-SERVICE.md), [ธุรกรรมการเปลี่ยนแปลง](../CHANGE-TRANSACTIONS.md), [รูปแบบเชิงโครงสร้าง](../STRUCTURAL-PATTERNS.md), [เซลล์โค้ด](../EVAL.md) และ [debugger](../DEBUGGER.md)
- **`WebSearch` ที่ไม่ต้องใช้คีย์ และ `WebFetch` แบบ markdown.** `WebSearch` เดินตามลำดับเดียว: provider-native live search ก่อน เมื่อโมเดลของเซสชันรองรับ (`ProviderSearch`) จากนั้นคีย์ Brave หรือ Tavily ที่บันทึกไว้ จากนั้น API ทางการที่เลือกตามรูปแบบของคำค้น (Stack Exchange, npm, PyPI, crates.io, GitHub code search, Hacker News Algolia, Wikipedia) จากนั้น JSON API ของ SearXNG ที่ตั้งค่าไว้ (`MERCURY_SEARCH_SEARXNG_INSTANCES`) และสุดท้ายคือการดึงหน้าเว็บของ DuckDuckGo แบบไม่ต้องใช้คีย์ (เปิดตามค่าเริ่มต้น ปิดได้ใน `/config` หรือด้วย `MERCURY_SEARCH_KEYLESS=0`) คำตอบทุกครั้งจะไม่เกิน 2,000 โทเคนและระบุแหล่งที่ตอบ `WebFetch` อ่านหน้าสาธารณะเป็น markdown ด้วยถ้อยคำของหน้านั้นเอง ภายในงบ 38,000 ตัวอักษรต่อการเรียก (หน้าที่ต้องใช้เบราว์เซอร์จะถูกอ่านผ่าน reader ที่โฮสต์ไว้ `r.jina.ai` เว้นแต่ตั้ง `MERCURY_FETCH_READER=0` และที่อยู่เครือข่ายส่วนตัวจะไม่ถูกส่งไปที่นั่นเลย) ดู [docs/ENGINES.md](../ENGINES.md)
- **เอเจนต์, crewmates ข้ามผู้ให้บริการ (`Crewmate`), worktrees และ lease ไฟล์.** มีเอเจนต์ในตัวสองตัว (`mercury-crew` สำหรับงานที่มอบหมายทุกประเภท และ `mercury-scout` สำหรับการลาดตระเวนแบบอ่านอย่างเดียว) อยู่ข้างนิยามเอเจนต์ที่คุณสร้างใน `/agents` เปิด crewmates บนผู้ให้บริการใดก็ได้ที่ลงชื่อเข้าใช้ แยกงานขนานใน checkout `git worktree` (`isolation: "worktree"`) ประสานไฟล์ที่ใช้ร่วมกันด้วย lease ไฟล์ของโปรเจกต์ในโพรเซส (`mcp__mercury__lease_take`, `mcp__mercury__lease_release`, `mcp__mercury__lease_list`) และชี้นำหรือเรียก crewmates กลับมาทำต่อด้วยชื่อหรือ id ผ่าน `SendMessage` และ `ResumeCrewmate` ติดตาม crewmates และการรัน workflow ใน `/crewmates` และ `/runs` ดู [docs/CREW.md](../CREW.md)
- **การควบคุมคอมพิวเตอร์เดสก์ท็อป.** เปิดใช้งานโดยค่าเริ่มต้นเมื่อ native desktop driver พร้อมใช้งาน เครื่องมือ `Computer` จับภาพหน้าจอและควบคุมเมาส์กับคีย์บอร์ดในแอปพลิเคชันที่อยู่หน้าสุด Mercury ตรวจสอบแอปด้วยชื่อและตัวตนก่อนลงมือ ขออนุมัติเว้นแต่กฎสิทธิ์ การอนุญาตในเซสชัน การตั้งค่าการเข้าถึง หรือโหมดสิทธิ์ของคุณอนุญาตการกระทำนั้นอยู่แล้ว หยุดเมื่อกด `Esc` อนุญาตให้มีเพียงหนึ่งเซสชันควบคุมเดสก์ท็อปในแต่ละครั้ง และเก็บภาพหน้าจอให้อยู่นอกไฟล์บทสนทนาที่บันทึกไว้ ตั้งค่า `MERCURY_COMPUTER_USE=0` เพื่อลบเครื่องมือออก ดู [docs/COMPUTER-USE.md](../COMPUTER-USE.md)
- **การป้อนข้อมูลเสียงด้วย Whisper บนอุปกรณ์ (`/voice`).** `/voice on` ดาวน์โหลดโมเดลภาษาอังกฤษขนาด 60 MB (`base.en-q5_1`) ในการใช้งานครั้งแรก ตรวจสอบ SHA-256 digest ของมัน และเปิดการพิมพ์ด้วยเสียง `/voice off` ปิดการใช้งาน กดค้างแถบเว้นวรรค 1 วินาทีเพื่อพูด แล้วปล่อยเพื่อหยุด หรือรัน `/voice` เปล่า ๆ เพื่อเริ่มและหยุดการบันทึก (take) ขณะเปิดเสียงอยู่ Whisper ถอดเสียงบนอุปกรณ์ เสียงจึงไม่ออกจากเครื่อง และ `MERCURY_WHISPER_MODEL` เลือก `tiny.en-q5_1`, `small.en-q5_1`, `base-q5_1` หลายภาษา หรือไฟล์ `.gguf` ในเครื่อง ดู [docs/VOICE.md](../VOICE.md)
- **ตัวจัดตาราง cron และเซสชันด้วย Saturn (`/saturn`).** กำหนดเวลา prompt ให้เซสชันที่มีอยู่แล้ว (`CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`, `/loop`) หรือกำหนดให้เซสชันใหม่เริ่มในเวลาที่ตั้งไว้ ตารางเวลาทำงานครั้งเดียวหรือเกิดซ้ำได้ ดู [docs/SATURN.md](../SATURN.md)
- **บริดจ์สำหรับ VS Code (ACP), Unity, Blender, Godot และ Aseprite.** `mercury acp` เชื่อมต่อกับ editor ที่รองรับ Agent Client Protocol ส่วนขยาย VS Code (`mercury bridge install`) รัน Mercury ใน editor ผ่านโปรโตคอลนั้น ได้แก่ แชท เซสชัน เอเจนต์ artifact และ review โดยมีการเลือกและการวินิจฉัยของ editor ติดมากับทุก prompt การผสานรวมแยกต่างหากที่ต้องเปิดใช้เองเชื่อมกับ editor Unity (`MERCURY_UNITY=1`), Blender (`MERCURY_BLENDER=1`) และ Godot (`MERCURY_GODOT_TOOLS=1`) ที่กำลังรันอยู่ พร้อมการเข้าถึงแบบแบตช์ไปยัง Aseprite (`MERCURY_ASEPRITE=1`) ดู [Unity](../UNITY-BRIDGE.md), [Blender](../BLENDER-BRIDGE.md), [Godot](../VULCAN-GODOT-TOOLS.md) และ [Aseprite](../ASEPRITE-BRIDGE.md)
- **ส่วนขยาย (Extensions).** แต่ละ extension มี manifest หนึ่งไฟล์ เพิ่มแหล่งจาก git URL โฟลเดอร์ในเครื่อง หรือ archive ซึ่งได้รับการอนุมัติด้วย contributions hash ดู [docs/EXTENSIONS.md](../EXTENSIONS.md)
- **MCPs & Skills.** การตั้งค่าแยกตามรีโพซิทอรีว่าเซสชันจะโหลดอะไร พร้อม preset ที่มีชื่อ และตัวควบคุมที่เปลี่ยนได้ระหว่างเซสชัน ดู [docs/KIT.md](../KIT.md)
- **การวินิจฉัย.** health check และ `/health` สร้างรายงานที่อิงหลักฐานการวินิจฉัย พร้อมคำตัดสิน `certified`, `caution` หรือ `fault` และการแก้ไขที่ตรวจสอบแล้ว ดู [docs/HEALTH-CERTIFICATE.md](../HEALTH-CERTIFICATE.md)
- **ความเชื่อถือและสิทธิ์.** ความเชื่อถือของ workspace กฎสิทธิ์และโหมด และคำสั่งที่ทุกเซสชันปฏิเสธ ดู [docs/TRUST.md](../TRUST.md)
- **Apollo Mode** การสัมภาษณ์เพื่อกำหนดสเปก: ตอบคำถามของเอเจนต์เพื่อให้สเปกที่มันจะใช้สร้างต้นแบบสมบูรณ์ ดู [docs/APOLLO-MODE.md](../APOLLO-MODE.md)
- **การกู้คืน.** การเผยแพร่แบบอะตอมมิก การดำเนินการที่บันทึกลงจอร์นัล และการปรับให้ตรงกันตอนเริ่มต้น ดู [docs/DURABILITY.md](../DURABILITY.md)

แฟล็กรันไทม์นิยามไว้ใน `src/substrate/flagRegistry.ts` เปิดเผยเป็นการตั้งค่า `MERCURY_*` และแสดงผลเมื่อต้องการ ความเข้ากันได้ของการผสานรวมมีเอกสารใน [docs/COMPATIBILITY.md](../COMPATIBILITY.md) ดัชนีเอกสารฉบับเต็มคือ [docs/README.md](../README.md)

## คำสั่ง slash

`/help` แสดงรายการคำสั่งโต้ตอบที่ใช้ได้ ใช้ `/palette` สำหรับการค้นหาคำสั่งแบบ fuzzy ตารางด้านล่างจัดกลุ่มคำสั่งในตัวที่เปิดใช้งานโดยค่าเริ่มต้นตามหมวดหมู่ที่ `/help` ใช้ ส่วนรายการสดยังรวม `/samples` ภายใต้ `current work` เมื่อเปิด Samples (`MERCURY_SAMPLES=1` หรือแถว Samples ของ Boot Menu), `/showcase` เมื่อตั้ง `MERCURY_DEV_SURFACES=1` และคำสั่งจาก skill หรือ extension ใด ๆ ด้วย

| หมวด | คำสั่ง |
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

| คำสั่ง | การทำงาน |
| --- | --- |
| `/llmhost` | เลือกโมเดลที่จะเช่าบน Runpod, Vast.ai หรือ Lambda, รันบนคอมพิวเตอร์ของคุณ หรือเชื่อมต่อกับเซิร์ฟเวอร์ที่มีอยู่แล้ว |
| `/restart` | ย้ายแชทนี้ไปยังบิลด์ Mercury ที่ติดตั้งไว้; การ watch และ background shell ที่กำลังรันจะหยุด |
| `/mcp` | ตรวจสอบเซิร์ฟเวอร์ ลงชื่อเข้าใช้ ดูเครื่องมือและพารามิเตอร์ของแต่ละเซิร์ฟเวอร์ เชื่อมต่อใหม่ หรือเปิด/ปิดเซิร์ฟเวอร์สำหรับแชทนี้ |

`/mouse off` คืนตัวชี้เมาส์ให้เทอร์มินัลเพื่อให้เลือกและคัดลอกข้อความแบบเนทีฟได้ การตั้งค่านี้ถูกบันทึกไว้และปรากฏใน `/config` เป็น Mouse capture

ในวิธีใช้ของ skill อาร์กิวเมนต์ที่จำเป็นจะขึ้นต้นด้วย `<…>` ตัวอย่างเช่น `/update-config` และ `/debug` ต้องมีอาร์กิวเมนต์ ถ้าส่งคำสั่งนั้นเพียงลำพัง คุณจะได้คำอธิบายและวิธีใช้ โดยไม่มีเทิร์นเริ่มขึ้น เลือกคำสั่งใน typeahead แล้วกด Enter จะทิ้ง `/name ` ไว้ให้คุณเพิ่มอาร์กิวเมนต์ `/loop` ไม่มีอาร์กิวเมนต์ที่จำเป็นและจะทำงานทันที

## การรายงานปัญหา

สำหรับรายงานสั้น ๆ ให้ใช้ [แบบฟอร์มสำหรับผู้ทดสอบ](https://mercury-cli.ai/report) หรือ `/bug --short <what you tried>` ภายใน Mercury แบบฟอร์มจะถามระบบปฏิบัติการ สิ่งที่คุณลองทำ และสิ่งที่พัง ไม่จำเป็นต้องมี health dump

รัน `/bug <what happened>` ภายใน Mercury เพื่อดูตัวอย่างรายงานก่อนส่งผ่าน GitHub CLI (`gh`) ที่ลงชื่อเข้าใช้ไว้ หากไม่มี `gh` Mercury จะบันทึกฉบับร่างลงในเครื่องภายใต้ config home และชี้ไปยังหน้า issues ของรีโพซิทอรี

คุณยังเปิด issue ได้โดยตรงโดยใช้เทมเพลต bug, provider/model หรือ feature request ระบุผลลัพธ์ `--version`, ระบบปฏิบัติการ, เทอร์มินัล และขั้นตอนที่แน่นอน รายงาน bug และ provider ยังต้องมี `mercury health --json` หรือ `node dist/mercury.mjs health --json` สำหรับบิลด์จากซอร์ส ทรานสคริปต์ของหน้าจอที่ล้มเหลวจะช่วยได้มาก

รายงานปัญหาด้านความปลอดภัยให้ส่งแบบส่วนตัวผ่านแท็บ Security ของรีโพซิทอรี อย่านำขึ้น issue สาธารณะ ดู [SECURITY.md](../../SECURITY.md) [CONTRIBUTING.md](../../CONTRIBUTING.md) ครอบคลุม issue, pull request และการตรวจสอบ

## ใบอนุญาต

Mercury CLI ได้รับอนุญาตภายใต้ Apache License 2.0 (`Apache-2.0`) ใน [LICENSE.md](../../LICENSE.md) SDK ของ TypeScript และ Python ใน [sdk/](../../sdk/) และ [sdk-py/](../../sdk-py/) (`mercury-cli-sdk` บน npm และ PyPI) ได้รับอนุญาตภายใต้ Apache License 2.0 (`Apache-2.0`) เช่นกัน ตามไฟล์ LICENSE ที่แต่ละตัวมาด้วย ([sdk/LICENSE](../../sdk/LICENSE) และ [sdk-py/LICENSE](../../sdk-py/LICENSE))

การใช้ชื่อและเครื่องหมายของ Mercury อยู่ภายใต้ [นโยบายเครื่องหมายการค้า](../../TRADEMARKS.md) ใบอนุญาตของบุคคลที่สามที่รวมมาจะแสดงอยู่ใน [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)
