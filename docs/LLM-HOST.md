# Run or connect a model: `/llmhost` and `mercury host`

<!-- answers: Search Hugging Face or pick a shipped recipe in `/llmhost`, bank weights and mirror Runpod volumes, rent a GPU on Runpod, Vast.ai or Lambda, run a model with `mercury host`, or connect a running server. -->

Run `/llmhost` in the foreground chat. Its popup opens on **Which model?**,
which lists 32 models across 78 recipes in `assets/host/recipes.json` alongside
a live Hugging Face search line (`model name — e.g. deepseek, qwen, glm`).
Each model row shows where it can run right now and ends with its verification
stamp. In `/model`, you can also pick a `Run a model` entry tagged
`run it → /llmhost` (`run it → /llmhost · run it on this Mac →` when a recipe
fits your Mac) to open that model's screen directly.

### Verification stamps and list order

Every recipe carries one of four verification stamps:

- **`measured`:** Mercury booted the recipe on that GPU shape and recorded its token rate, memory use and per-slot context window.
- **`documented`:** the GPU shape, launch flags, context length and reasoning effort levels come from the model author's or engine's published deployment guide or model card.
- **`community`:** the launch configuration comes from a third-party community repository.
- **`unverified`:** derived on the spot from a Hugging Face repository's file list and `config.json`; nobody has booted this exact recipe yet.

On **Which model?**, shipped models sort first by where they can run right now:

1. Already running on one of your pods
   (`running on your pod <id> · $<price>/hr · <N> conversations × <tokens> — switch →`).
2. Fits one of your computers (`fits <computer> (<N> GB) — start here →`).
3. In stock on a connected GPU provider
   (`<Provider> <shape> · $<price>/hr · in stock`), ordered by lowest hourly
   price across connected providers.
4. Out of stock or no provider connected (`no stock · watch →`,
   `Runpod · connect to check stock →` or
   `Runpod · stock unavailable · retry →`).

Within the same availability tier, rows sort by lowest hourly price, then by
verification stamp (`measured` → `documented` → `community` → `unverified`),
and then alphabetically by model name.

Below the model list, **Which model?** includes **Pods I'm paying for**, **My
computers**, `Bank · your weights`, **Refresh stock and prices**, and the
`More options →` menu (`Rent a GPU (Runpod, Vast.ai, Lambda, Hugging Face)`, `A box I can reach by SSH`,
`A server that's already running`, `One of my computers`, and
`Bank · your weights`). Each path reads the server's model list and context
windows, runs a reply check, and registers the provider in `/model` and
`/logins`.

### Search Hugging Face and derive an `unverified` recipe

Typing in **Which model?** filters the shipped list immediately by model name
(case-insensitive) under a `VERIFIED RECIPES` heading. After you type at least
3 characters (`model name — e.g. deepseek, qwen, glm`) and pause for 450 ms,
Mercury queries Hugging Face for public `text-generation` models sorted by
downloads (up to 20 results). While the request is in flight, the popup shows
`HUGGING FACE · fetching…`; when results arrive, they appear under
`HUGGING FACE · <N> results · unverified · sorted by downloads` with
`<repo id> · <params> · <format> · ↓ <downloads> · <licence> · unverified`
(plus `🔒 gated` or `🔒 private` when applicable). Pressing `Esc` clears an
active search query; pressing `Esc` again with an empty search closes the
popup. Search results stay cached for that popup so returning from a model
screen keeps your query.

- **What Mercury derives:** selecting a Hugging Face row reads up to five pages
  of the repository's file tree and its `config.json`. For GGUF repositories,
  Mercury groups complete `.gguf` weight files (ignoring standalone `mmproj`
  files and incomplete shard sets), prefers `Q4_K_M` or the next available
  4-bit quantization (`UD-Q4_K_XL`, `Q4_K_L`, `Q4_K_S`, `Q4_K`, `IQ4_XS`,
  `UD-IQ4_XS`, `IQ4_NL`, `Q4_0`, `Q4_1`, or else the largest group by bytes),
  and builds a `llama.cpp` recipe with 4 parallel slots, per-slot context up to
  `131,072` tokens, flash attention and `q8_0` KV cache. For safetensors
  repositories, Mercury builds a `vLLM` recipe (`vllm/vllm-openai:latest`, CUDA
  `13.0`) using the safetensors parameter byte counts (or file sizes),
  `--max-model-len` from `config.max_position_embeddings`,
  `--tensor-parallel-size` matching the GPU count, and `--trust-remote-code`
  only when the repository is tagged `custom_code`. Mercury adds a 20% memory
  margin (`weights × 1.2`) and picks the smallest fitting single-node shape
  from `1`, `2`, `4` or `8` GPUs across `H100` (80 GB), `H200` (141 GB), `B200`
  (180 GB) and `B300` (288 GB). Repositories requiring more than `8× B300` are
  refused with `needs more than 8× B300 (<N> GB) · no single-machine recipe`.
- **What `unverified` commits you to:** the derived recipe stays in session
  memory (and on the pod record if you rent or watch it) without altering
  `assets/host/recipes.json`. The model screen opens with
  `RECIPE · unverified — recipe derived from the repo's config and file list a moment ago (engine <engine> · <format> · <N> GB); nobody has booted this exact recipe yet. The price is confirmed before anything is rented; the pod guard terminates a pod that never answers.`
- **Gated repositories:** selecting a `🔒 gated` row without a Hugging Face
  token keeps you on the list and shows
  `gated · sign in with /logins huggingface`. When signed in
  (`/logins huggingface` or `HF_TOKEN`), Mercury sends your bearer token; if
  your account has not accepted the model's licence terms (HTTP 401 or 403),
  Mercury shows
  `gated · your Hugging Face account has no access to <repo> · accept its terms at https://huggingface.co/<repo>`.
- **Non-chat repositories:** if a repository's pipeline tag, tags or
  `config.json` architectures describe vision-only, embeddings, classification,
  speech, audio, video, seq2seq or encoder models, or if the repository has no
  `.gguf` or `.safetensors` weights, the row reads `— not a chat model` with
  its reason (`— not a chat model (<reason>)`) and cannot be rented.
- **Offline or unreachable:** if Hugging Face does not answer within 5 seconds
  or returns an error, the popup shows
  `Hugging Face is unreachable · the verified list is shown` under
  `HUGGING FACE` (or `Hugging Face is unreachable · nothing was derived` when
  picking a row) and keeps the shipped list active.

### The model screen

Selecting a shipped or derived model opens its screen with a top recipe summary
line (or the `RECIPE · unverified — …` line) and five sections:

- **QUALITY:** each quantization or precision variant for the model (such as
  `Balanced · 4-bit (recommended)`, `Best quality · 8-bit FP8` or
  `Fast crew · NVFP4`), the required GPU shape and memory, the lowest current
  hourly price, and the context window. When a model has multiple variants,
  `Choose quality →` switches between them.
- **CONVERSATIONS × CONTEXT:** how the GPU memory budget splits across parallel
  conversations (for example
  `4 × 131k — measured to fit · lead + 3 crew (recommended)`), calculated with
  a 12 GB per-GPU engine reserve and the recipe's documented KV cache bytes per
  token.
- **THINKING:** the default reasoning level, with
  `(change any time with /effort)`.
- **WEIGHTS:** the download size from Hugging Face, whether the weights are
  banked on your computer (`banked ✓ on <folder> (verified <date>)` or
  `not banked`), and whether a Runpod fast-load volume is ready
  (`fast-load volume ✓ <DC> — boots in ~<N> min` or
  `no fast-load volume — first boot downloads (~<M> min)`).
- **WHERE:**
  - `Already running · pod <id> · switch now · nothing to pay` for running pods
    you can switch to immediately.
  - In-stock rental rows across every connected provider, sorted cheapest
    first:
    `Rent · <Provider> <shape> · $<price>/hr · <data centre or region> · in stock · <provider stamp> · <boot source>`.
    Runpod rows carry `verified on a live rental 2026-10-21`; Vast.ai and
    Lambda rows carry `API only — not yet booted`. Each row ends with
    `boots from your volume` when a kept Runpod fast-load volume matches that
    data centre (or is a global volume), or `downloads the weights first` when
    the pod downloads weights on first boot.
  - Computers from **My computers** (`fits (<N> GB) — start here →`,
    `too small: <N> GB, needs <M>`, or `no local recipe for this model`).
  - The **Bank** row
    (`Bank · b bank the weights to <folder> (<size>, hash-verified) — your own copy, kept on your drive`
    when unbanked, or
    `Bank · weights banked ✓ on <folder> · v verify again · m mirror to a fast-load volume ($0.07/GB·month)`
    when banked).
  - `Watch stock · across every provider above · tell me when the cheapest shape comes back`
    (or
    `No stock · watch · across every provider above · tell me when the cheapest shape comes back`
    when no connected provider has stock).
  - `<Provider> · no stock for this quality · Refresh →` for connected
    providers without stock for the selected variant, and `Connect Runpod →`,
    `Connect Vast.ai →` or `Connect Lambda →` for unconfigured providers.

## The Bank screen (`Bank · your weights`) and Runpod fast-load volumes

Open `/llmhost` and select `Bank · your weights` (on **Which model?**, under
`More options →`, or from a model screen's `Bank · …` row). Opening the Bank
screen does not require a GPU provider API key until you mirror or drop a
Runpod volume.

1. **Choose or discover the bank folder.** Mercury checks `<config>/host/bank.json`
   for a saved folder, then checks for an existing `~/mercury-model-bank`,
   `~/models`, `/Volumes/*/mercury-model-bank` or `/mnt/*/mercury-model-bank`
   (`~\mercury-model-bank` or `~\models` on Windows). If none exists, **Where
   should the bank live?** prompts for an absolute path on your computer,
   creates the folder, and records it in `bank.json`. Each model's files are
   stored under `<bank>/<namespace>--<repo>` with a `SHA256SUMS` manifest.
2. **Read the status line and table.** The status line shows the bank folder
   path, free disk space on the drive, how many models are banked
   (`Banked: <N> of <M> models · <size>`), the last verification date, and any
   kept Runpod fast-load volumes with their total size and monthly rate. The
   table lists one row per weight repository across five columns: `MODEL`,
   `SIZE`, `BANKED` (`✓ <drive>`, `— b to bank`, `… <step>`, or
   `… <done>/<total> files · b resumes`), `VERIFIED` (`✓ <YYYY-MM-DD>`,
   `✗ <YYYY-MM-DD>`, or blank), and `VOLUME` (`✓ <DC> · boots ~<N> min`,
   `… preparing in <DC>`, `✗ failed in <DC> · d to drop`, `— m to mirror` when
   banked, or `—`). Pressing `Enter` on a row shows its local path,
   verification status and volume state.
3. **Run background bank and volume actions.** Four single-key shortcuts work on
   the Bank table and on a model screen:

- **`b` (`bank`):** after confirmation, starts a background job (`bank-<id>`)
  that installs `huggingface_hub` in `~/.local/share/mercury-host/hf`, runs
  `hf download` for the recipe's revision and file list (passing your stored
  Hugging Face token in `HF_TOKEN` when signed in so gated repositories
  download), hashes every file in one streaming pass, writes `SHA256SUMS`,
  verifies the files (`verified against the pinned manifest` for shipped
  manifests or `verified against the download` otherwise), and posts a chat
  notice when done. If a download is interrupted, partial files remain in the
  folder and pressing `b` resumes; if the model is already banked, `b` lets you
  choose `Verify instead (no download)` or
  `Bank again · re-check against Hugging Face`.
- **`v` (`verify`):** starts a background job (`verify-<id>`) that streams every
  file in the model's folder, checks file sizes, `SHA256SUMS` digests and any
  manifest SHA-256 or git blob hashes, updates the `VERIFIED` date, and posts a
  chat notice naming the file if a byte differs.
- **`m` (`mirror to volume`):** opens Runpod fast-load volume setup for a
  shipped recipe with a weight manifest. Choose
  `Runpod network volume · one data centre · $0.07/GB/month` (`$0.07/GB/month`
  up to 1,000 GB, `$0.05/GB/month` above 1,000 GB, attached to pods in that
  data centre) or
  `Runpod global volume (beta) · any data centre · $0.09/GB/month + IOPS` (or
  `My own bank over SSH · mercury-host road`). Then choose **Prepare now**
  (rents the cheapest fitting Runpod pod, downloads the files from Hugging Face
  directly onto the volume next to the GPUs, checks sizes and SHA-256s, writes
  `SHA256SUMS`, `SIZES.json` and `SAMPLES.json`, and terminates the temporary
  pod) or **At the next rental** (creates the volume now and fills it from
  Hugging Face the next time you rent that model). Nothing is uploaded from your
  local drive. When a volume is already kept, `m` lets you run
  `Verify fully · rent a temporary pod for full SHA256` or
  `Delete weights disk`. When you rent a model with a kept volume, startup
  checks file sizes, modification times, the first and last 64 MB, and eight
  seeded 1 MB samples per large file against `SAMPLES.json` in a few seconds
  and skips downloading weights again.
- **`d` (`drop from volume`):** deletes the model's Runpod fast-load volume
  after confirmation (`Delete weights disk?`) while leaving the local bank on
  your drive untouched.

Local banking (`b`) and verification (`v`) run on your computer at `$0.00`.
Runpod fast-load volumes (`m`) bill monthly whether or not a pod is running
until you delete them with `d` or under **Pods I'm paying for**.

### Keep the weights on a Vast.ai machine (`Vast.ai volume`)

Vast.ai sells **local volumes only**: a volume is created on one physical
machine, only an instance on that same machine can mount it, it cannot be
resized or moved, and it bills per GB-month at that machine's rate for its
whole size whether or not an instance is running (nothing bills while the
machine is offline). Mercury therefore keeps a model's weights **on one
Vast.ai machine**: a rental of that model on that machine boots from the
volume; a rental on any other machine downloads the weights as before.

With Vast.ai connected, `m` on a banked model row offers
`Vast.ai volume · keep on one Vast.ai machine · per GB-month at the machine's rate`
beside the Runpod volumes (when Runpod is not connected, `m` opens the Vast.ai
choice directly). The steps:

1. **Which Vast.ai machine keeps the weights?** lists the machines that sell
   volume space for the model's size (the manifest's bytes plus room for the
   engine's compiled kernels, e.g. `556 GB volume` for a 510 GB model), the
   machines with stock for the model's shape first, each with its hosting tag,
   the rental price on it and the volume's rate:
   `machine <id> · datacenter · NL · 4× B200 in stock at $9.31/hr · volume $0.20/GB-month → $111.20/month for 556 GB`
   or `no 4× B200 stock right now` when the machine sells space but has no
   GPU shape for the model today.
2. **When should the weights be prepared?** `Prepare now` rents the cheapest
   instance **on that machine** with room (any GPU shape; it only downloads),
   downloads the files from Hugging Face onto the volume mounted at
   `/workspace/mercury-weights`, verifies every file against the pinned or
   bank-built manifest, then terminates the temporary instance and checks the
   instance list to confirm it is gone. `At the next rental on that machine`
   creates the volume now and fills it the next time you rent that model
   there. Nothing is uploaded from your drive.
3. **Confirm Vast.ai volume** names the machine, the size, the billing
   (`$111.20/month for its 556 GB ($0.20/GB-month, the machine's rate), with or without an instance`)
   and, for Prepare now, the temporary instance and its hourly price
   (`a temporary 1× RTX PRO 6000 instance at $1.35/hr on that machine`). Nothing
   is created before this confirmation.

Once kept, the model's Bank row reads
`weights kept on Vast.ai machine <id> (<n> GB, <billing>) · a rental on that machine boots in ~<m> min · other machines download`,
its `WEIGHTS` line adds `Vast.ai volume ✓ machine <id>`, and the Vast.ai offer
on that machine reads `machine <id> · boots from your Vast.ai volume on its machine`
while offers on other machines still say `downloads the weights first`. Renting
that offer attaches the volume at creation, checks the kept files in a few
seconds (the sampled check described above) and skips the download; the
rental confirmation names the volume's monthly amount beside the hourly price.
The launch command also points the engine's compiled-kernel caches at the
volume (SGLang's cache directory and its DeepGEMM cache, DeepGEMM's own JIT
cache, FlashInfer, Torch inductor, Triton, CUDA and vLLM), so a second boot on
that machine skips the kernel tuning as well as the download; the first boot
on the volume still tunes once.

A kept Vast.ai volume appears under **Pods I'm paying for** as
`Vast.ai volume <id> · Vast.ai machine <id> · <hosting tag> · <billing> · weights`
with the current stock on that machine (`4× B200 in stock on that machine at $…/hr`
or `no stock on that machine right now · w watch it`, where `w` arms a stock
watch that prefers that machine). `d` deletes it after confirmation and checks
the volume list to confirm it is gone; Vast.ai refuses to delete a volume while
an instance still uses it, and Mercury reports that refusal with the volume
still billing. Terminating a rental that uses the volume asks whether to keep
or delete it. A Vast.ai volume never attaches to a Runpod pod and a Runpod
disk never attaches to a Vast.ai instance.

## Rent a GPU (Runpod, Vast.ai, Lambda and Hugging Face)

1. **Connect a GPU provider.** Paste a Runpod, Vast.ai or Lambda API key into
   the masked field; Hugging Face uses the sign-in `/logins huggingface` saved
   (an HF endpoint runs the model on hardware Hugging Face sells and hands back
   an address, with no SSH). Mercury verifies a key against the provider's
   instance list and saves it in the credential store (`0600`), never in a
   settings file or URL. On the model screen, Runpod rental rows carry
   `verified on a live rental 2026-10-21`, and Vast.ai, Lambda and Hugging Face
   rows carry `API only — not yet booted`.
2. **Choose a model and GPU shape.** Mercury reads live stock and hourly prices
   for the full shape (every GPU and node in the recipe) across the 32 shipped
   models (78 recipes in `assets/host/recipes.json` version 2, including
   `GLM-5.3-Flash`, `Nemotron 3.5 Super VL 120B`, `Qwen3.8-27B`,
   `DeepSeek-V4.1-Flash-1017`, `GLM-5.3`, `Kimi K3`, `Qwen3.8-2.4T-A95B`,
   `DeepSeek-V4-Pro-0813`, `MiMo-V2.6-Pro-RL`, `Mistral Large 3 675B`,
   `Beam 1.0 501B-A23B`, `Hy4-preview 780B`, `Step 5 Preview 604B-A27B`,
   `MiniMax-M3 427B-A23B`, `Inkling 952B`, `Inkling-Small 266B`,
   `Nemotron 3 Ultra 550B-A55B`, `LongCat-2.0 1.8T`, `Ling-3.1-flash 572B`,
   `Qwen3.8-Flash-Next 180B-A6B`, `MiMo-V2.6-Flash-RL 309B-A15B`,
   `gpt-oss-120b` and `Gemma 4 31B`) plus any `unverified` recipe derived from
   Hugging Face search. Large single-node and multi-node Runpod Instant Cluster
   recipes list total hourly compute, per-node disk sizes, weight download
   sizes, estimated download times at 0.5 to 1 GB/s per node, and model-licence
   terms.
3. **Tune before renting (optional).** On the rental confirmation screen,
   select **Tune** to pick the quantization, `conversations × context` split
   (calculated against a 12 GB per-GPU engine reserve and the model's documented
   KV cache bytes per token), and default thinking level before creating the
   pod.
4. **Confirm the hourly price.** Nothing is rented until you select the
   confirmation row and press Enter. The confirmation screen shows the time
   estimate for each setup step (engine startup, weight download and model
   load), the recipe's verification status, and the vendor's storage and SSH-key
   terms. The two shipped `llama.cpp` GGUF recipes (`GLM-5.3-Flash` and
   `Nemotron 3.5 Super VL 120B`) use a prebuilt CUDA 13 `llama.cpp` container
   image and skip source compilation when the image's `llama-server` binary is
   present.
5. **Background preparation and ready notice.** A detached background worker
   creates or registers the SSH key, provisions the pod or cluster, downloads
   the weights, starts the engine on remote loopback, opens a local SSH tunnel,
   registers the provider (`compat/pod-<id>/<model>`), and checks a reply. If
   you close `/llmhost` with `Esc` or click outside, setup keeps running in the
   background and posts a chat notice when the model is ready (with the
   `/model compat/pod-<id>/<model>` command) or if setup stops.

### Watch for stock across connected providers

From a model screen
(`Watch stock · across every provider above · tell me when the cheapest shape comes back`
or
`No stock · watch · across every provider above · tell me when the cheapest shape comes back`)
or when a model has no stock on the rental flow, select **Watch for stock and
rent at this price or less** (or choose **Set a lower price ceiling** / **Set a
price ceiling**). A background worker polls every connected provider (Runpod,
Vast.ai and Lambda) once every 5 seconds (12 catalogue reads per minute each)
for up to 12 hours. As soon as a fitting shape appears at or below your
ceiling, the first provider with stock rents it (or the cheapest shape when
several providers answer in the same round) and starts setup. Active watches
are listed under **Pods I'm paying for** with `$0.00 billed while watching` and
a **Cancel** action.

### Vendor hiccups and rental failure cleanup

During pod or cluster setup and termination checks, transient vendor read
errors (`HTTP 429`, `HTTP 5xx` and network timeouts across Runpod, Vast.ai and
Lambda) do not immediately stop setup. Each read retries with exponential
backoff from 5 seconds up to 60 seconds (honouring any longer `Retry-After`
header) within a 4-minute read budget. While waiting, the pod status shows
`<Vendor> read failed (HTTP 503) · retrying in <N> s · attempt <k>`, and once
the vendor answers again it records
`<Vendor> <operation> read recovered · continuing`. If the vendor still does
not answer after 4 minutes, setup pauses without terminating the pod and posts
`<Vendor> did not answer <operation> reads for 4 min (HTTP 503 ×<N>)` followed
by `setup paused · Resume retries · /llmhost → Pods I'm paying for`.

When a standalone pod rental hits a confirmed setup failure instead of a
transient read hiccup, Mercury terminates the instance through the vendor API,
reads the vendor's instance list to confirm it is gone, removes any registered
`/model` entry, and posts one notice naming the cause, cleanup status and
whether anything still bills:

- **Engine death while loading weights:** if the engine process exits or logs
  `out of memory` (`OOM`), `failed to load model` or `CUDA error`, setup stops
  immediately and reports
  `the engine died loading the weights: <log tail> · pod terminated and verified absent · nothing more bills`
  (and on an `OOM`, adds
  `the shape was too small for this quality; choose a larger GPU shape`).
- **Weight download stall or timeout:** a remote watchdog monitors disk and
  network progress every 30 seconds (`downloading weights · <X> GB of <Y> GB`).
  If less than 1 GB arrives over 10 minutes (`under 1 GB in 10 min`) or the
  download passes its deadline (`30 + ceil(weightsGb / 6)` minutes), Mercury
  terminates the pod and reports
  `Download stalled at <X> GB of <Y> GB (under 1 GB in 10 min) · pod terminated and verified absent · nothing more bills`
  (or, when a Runpod fast-load volume was attached, names the kept volume and
  its monthly charge).
- **SSH key refusal:** if a `RUNNING` pod rejects SSH login with
  `Permission denied (publickey)` three times in a row, Mercury terminates the
  pod and reports
  `the pod did not accept Mercury's SSH key · <vendor key notice> · pod terminated and verified absent · nothing more bills`.
- **Pod missing from the vendor:** if the vendor returns `HTTP 404` during
  setup, Mercury checks the vendor's instance list without sending a redundant
  terminate call and reports
  `the vendor no longer lists pod <id> · nothing to terminate · if it still bills, Pods I'm paying for shows it`.

If the vendor's instance list cannot be read to confirm deletion, Mercury never
claims the pod is gone; it posts
`termination sent; <Vendor> did not confirm (<reason>) — check Pods I'm paying for`.

### Manage or stop paying for a rental

Reopen `/llmhost` and select **Pods I'm paying for** to check running pods,
clusters, Runpod volumes and active stock watches across all connected vendors.
Each row lists the vendor, current setup step or status, hourly rate, elapsed
time and estimated compute spend so far.

- **Tune (Runpod single-node `llama.cpp` pods):** change
  `conversations × context` or default thinking and reload `llama-server` in
  place without re-downloading weights. If the reload fails, Mercury restores
  the previous launch script.
- **Stop (Runpod and Vast.ai pods):** stops GPU compute billing while keeping
  the pod or container disk. Storage continues to bill while stopped. Lambda
  instances and Runpod clusters cannot be stopped and bill until terminated.
- **Terminate:** deletes the pod, cluster or instance after confirmation and
  checks the vendor's instance list to confirm it is gone. On Runpod pods with
  an attached fast-load volume, Mercury asks whether to keep or delete the
  weights disk (`Keep the weights disk (<price>)` or
  `Delete the weights disk too`). Terminating a pod also removes its model
  entry from `/model`.
- **Logs and Resume setup:** inspect the vendor log tail or restart a paused
  setup job.

Multi-node clusters and in-place `Tune` reloads are supported on Runpod only;
kept weights volumes exist on Runpod (one data centre or any) and on Vast.ai
(one machine); choosing a Runpod-only feature for Vast.ai or Lambda explains
that limit without sending a request.

## Run a model on your own computer: `My computers` and `mercury host`

Open `/llmhost` and choose **My computers** (or `More options →` → **One of my
computers**), or run `mercury host` from the command line:

```sh
mercury host status [box]
mercury host recipes [box]
mercury host add <name> --ssh <host> --os darwin|linux|windows [--user <user>] [--port <port>] [--key <path>]
mercury host start <box|this-computer> <recipe> (--bank <folder> | --download <folder>) [--yes]
mercury host stop <box>
mercury host restart <box>
mercury host logs <box>
mercury host uninstall <box>
```

Mercury checks this computer (or a saved SSH computer on macOS, Linux or
Windows), lists Ollama and GGUF recipes that fit its memory, verifies any local
weight bank against `SHA256SUMS` before startup (or asks before downloading
weights), and installs a user login service (`launchd` on macOS,
`systemd --user` on Linux, Scheduled Task on Windows) bound to loopback. For
remote computers it also opens a persistent SSH tunnel, and for every computer
it registers `compat/box-<name>/<model>` across all sessions sharing the config
home.

The computer screen and `mercury host status` report the engine, model, busy
slots and last measured token rate. When you stop the service, the model row
stays in `/model` as `box <name> · engine stopped — /llmhost starts it`, so
picking a stopped computer never asks for an API key. `uninstall` removes the
service definition and leaves downloaded weights on disk.

## A box I can reach by SSH

In `/llmhost` → `More options →` → **A box I can reach by SSH**, enter a host
and user or an alias from your SSH config. Mercury runs `nvidia-smi` over SSH
and lists the recipes that fit those GPUs. Nothing is installed or started
until you confirm. You can use a local weight folder on that machine (checked
for all shards and any required `mmproj` vision projector) or download weights
from Hugging Face into `/workspace`. The engine binds to remote loopback and
Mercury opens a local SSH tunnel.

## A server that's already running

In `/llmhost` → `More options →` → **A server that's already running**, connect
a local server, a direct HTTPS URL, or the local port of an SSH tunnel you
already opened.

### Connection steps

1. **The server address.** Enter the OpenAI-compatible API base URL, such as
   `http://127.0.0.1:30000/v1`. Mercury appends `/v1` to a bare host and port;
   include the full path when connecting through a reverse proxy. Mercury
   contacts only the address you enter.
2. **The server dialect.** Mercury probes for SGLang, vLLM, llama.cpp or Ollama
   metadata. Confirm the detected dialect, or pick SGLang, vLLM, llama.cpp,
   Ollama, LM Studio, chat completions or Responses.
3. **The key.** If the server requires authentication, Mercury prompts for a
   masked key before finishing discovery. Leave the field blank for keyless
   servers. Keys are stored in Mercury's credential store, never in a settings
   file.
4. **The model.** If the server lists a single model, Mercury selects it
   automatically. If it lists several, pick one; each row shows the server's
   reported context window, such as `1,048,576 tokens · served window`.
5. **Name, register and check.** Pick a provider name (default `llmhost`),
   confirm registration, and run the reply check. The popup displays the reply,
   elapsed time and, when the server returns usage numbers, output tokens and
   whole-turn tokens/s.
6. **Use the provider.** The model appears in `/model` as
   `compat/llmhost/<model>` and the provider appears in `/logins`.

## What Mercury saves and sends on the wire

Mercury saves the endpoint under `compatProvider.<name>` in user settings with
its API base URL, label, dialect and, for SGLang,
`sessionAffinityHeader: "x-session-id"`, alongside
`models["compat/<name>/<model>"].contextWindow` and supported `efforts`. A
`contextWindow` set for that model in user settings overrides the window
reported by the server.

- **Vision projectors and image inputs:** both shipped `llama.cpp` GGUF recipes
  download their vision projector (`mmproj-F16.gguf` for `GLM-5.3-Flash` and
  `mmproj-BF16.gguf` for `Nemotron 3.5 Super VL 120B`), include it in the
  weight manifest and bank checks, and pass `--mmproj` to `llama-server`.
  Mercury reads image capability from `GET /props` (`modalities.vision`) on
  `llama.cpp`, `GET /model_info` (`has_image_understanding`) on `SGLang`,
  `POST /api/show` (`capabilities`) on `Ollama`, and `input_modalities` on
  `/v1/models`. If a `llama.cpp` server runs without a projector, Mercury
  reports
  `this server runs <model> without its vision projector — rent it again with the recipe that carries one (/llmhost), or start the server with --mmproj`;
  starting the same server with `--mmproj` re-enables image turns and the
  `Computer` tool without changing models.
- **Reasoning and `/effort`:** `/effort` lists the reasoning levels the model
  supports (from the recipe's verified `efforts` list or `/api/show` on
  `Ollama`). Requests send `chat_template_kwargs.reasoning_effort` on
  `llama.cpp` and top-level `reasoning_effort` on `vLLM`, `SGLang`, `Ollama` and
  `Kimi K3`. If a server rejects the `reasoning_effort` or
  `chat_template_kwargs` parameter name with HTTP 400 before streaming content,
  Mercury retries once without that field and posts a notice; if the server
  rejects a specific reasoning value, Mercury keeps your selected effort and
  reports the server's refusal.
- **Multi-turn reasoning replay:** SGLang, vLLM, llama.cpp and Kimi K3
  conversations keep assistant `reasoning_content` across tool turns and
  continuations, and SGLang requests set
  `chat_template_kwargs: { clear_thinking: false }`.
- **Tool schemas and plain-words engine refusals:** `llama.cpp` accepts local
  `#/…` JSON schema pointers, `$defs` and `oneOf`/`anyOf`. Every shipped
  Mercury tool (including `Computer`, whose `sequence` steps use a flat
  one-level schema) passes directly; if a custom or MCP tool carries a bare
  `$ref: "#"` or external reference on `llama.cpp`, Mercury refuses the request
  before dispatch and names the tool and schema fault:
  `llama.cpp cannot take the <Tool> tool's schema: <fault> — the request was not sent and no tools were removed; update its schema before retrying`.
  No tools are removed; repair the schema before retrying. If a server reports that tool calling is disabled
  (`tools: false` in `SGLang` `/model_info`, `llama.cpp`
  `chat_template_caps` or `Ollama` `/api/show`), Mercury stops before sending
  the request and reports
  `<Engine> reports no tool-call support for '<model>' — select a tool-capable model or enable the model's tool parser on this server, then retry`.
  When `llama.cpp`, `vLLM`, `SGLang`, `Ollama` or `LM Studio` returns an HTTP
  4xx/5xx refusal, Mercury names the cause and remedy, such as starting `vLLM`
  with `--enable-auto-tool-choice` and the model's `--tool-call-parser`,
  configuring `SGLang` with `--tool-call-parser` or `--reasoning-parser`,
  starting `llama.cpp` with `--mmproj`, or sending base64 image data to
  `Ollama`.
- **Slot affinity, prefill speed and live stream status:** on `llama.cpp`
  servers that report multiple slots in `GET /props`, each conversation reuses
  the same `id_slot` with `cache_prompt: true`. On `llama.cpp` and `SGLang`,
  Mercury reads `/metrics` (`llamacpp:prompt_tokens_seconds` or SGLang prompt
  and TTFT counters) to estimate prompt ingestion time, extends the first-byte
  allowance by that duration, and displays
  `reading <N>k tokens of context · ~<duration>` on the turn spinner. Once
  response headers arrive, the spinner and context compaction row show
  `waiting for the first token`, then `thinking` with a live
  `↓ ~<N> thinking tokens` count during reasoning, and `writing` with the
  growing token count and `~<rate> tok/s` as reply tokens stream. During long
  prefills, Mercury polls server liveness (`GET /slots` on `llama.cpp`;
  `/health`, `/` or `/v1/models` on `vLLM`, `SGLang`, `Ollama` and `LM Studio`)
  instead of timing out after 30 seconds, and shows
  `no tokens for <duration> · reconnecting (<k> of <N>)` or
  `connection dropped · reconnecting (<k> of <N>)` when reconnecting an
  interrupted stream.

## A rented pod through a manual SSH tunnel

If you started a model server on a pod yourself with its API bound to remote
loopback, open an SSH tunnel from your terminal:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:30000:127.0.0.1:30000 user@pod.example
```

Leave that connection running, open `/llmhost` → `More options →` → **A server
that's already running**, and enter `http://127.0.0.1:30000/v1`.

## Check, change or remove a server

In `/model`, an unreachable keyless endpoint shows `Retry this server →`, and
an unreachable custom endpoint shows `Retry this server →` and
`Remove this endpoint →`. You can also open `/llmhost` → `More options →` →
**A server that's already running** and pick a registered server to:

- **Check a reply again:** refresh its model list and run a reply check with
  the saved address and key.
- **Change the address and check it:** run discovery at a new address without
  sending the old stored key, credential command or custom headers.
- **Remove the provider and its stored key:** delete the endpoint and its
  stored key from Mercury while leaving the server running.
