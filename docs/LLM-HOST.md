# Run or connect a model: `/llmhost` and `mercury host`

<!-- answers: Search Hugging Face or pick a shipped recipe in `/llmhost`, bank weights and mirror Runpod volumes, rent a GPU (Runpod, Vast.ai, Lambda, Hugging Face, Hyperstack, Verda or DigitalOcean), run `mercury host`, or connect a running server. -->

Run `/llmhost` in the foreground chat. **Which model?** lists 32 models across
78 recipes alongside Hugging Face search. Rows show the model, where it can run
and its hourly price. Choosing a row opens the model; nothing is rented before
you confirm the price.

In `/model`, a `Run a model` entry tagged `run it → /llmhost` opens the same
screen. A fitting Mac also shows `run it on this Mac →`.

Alongside the models, **Which model?** includes **Machines I'm paying for**, **My
computers**, `Bank · your weights`, **Refresh stock and prices**, and the
`More options →` menu (`Rent a GPU (Runpod, Vast.ai, Lambda, Hugging Face, Hyperstack, Verda, DigitalOcean)`, `A box I can reach by SSH`,
`A server that's already running`, `One of my computers`,
`Bank · your weights`, and `Private recipes · none · choose a file →`). Each connection path reads the server's model list and context
windows, runs a reply check, and registers the provider in `/model` and
`/logins`.

**Private recipes** opens **Which private recipes file?** from `More options →`
or a private model's screen. The row shows
`Private recipes · <path> · <N> rows · replaces the shipped list`.
Enter an absolute path; candidates include the saved choice, `MERCURY_HOST_RECIPES_FILE`
and `host/private-recipes.json` under the config home, in that precedence order.
Mercury checks JSON and recipe fields, names missing files, zero valid rows or
an invalid row and field, and previews the models before **Use this file**.
The choice is saved in `host/recipes-file.json` and survives restarts; **Which
model?** refreshes immediately with `private` tags. Only use recipes you trust;
they can contain install commands.

### Search Hugging Face

Type a model name to filter the `MODELS` list. After 3 characters and a 450 ms
pause, Mercury searches Hugging Face for up to 20 text-generation models,
sorted by downloads. The search placeholder is
`model name — e.g. deepseek, qwen, glm`.

Results appear under `HUGGING FACE · <N> results`, with the repository,
parameter count, format, downloads and licence when supplied. `gated` or
`private` identifies restricted repositories. `Esc` clears a search; a second
`Esc` closes the popup. Results stay cached while the popup is open.

Selecting a result reads its files and configuration to choose an engine and
GPU shape. GGUF uses `llama.cpp`; safetensors uses `vLLM`. The model screen
shows quality, context and weights size, followed by the available rentals.
A file the engine cannot load is refused before renting, with the reason and
an alternative format where available. The recipe stays in session memory
and is saved with a rental or stock watch; it does not change the shipped list.

- **Gated repositories:** selecting a `gated` row without a Hugging Face
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
  `Hugging Face is unreachable` under `HUGGING FACE` and keeps the model list
  active.

### The model screen

The model screen shows the selected **QUALITY**, **CONVERSATIONS × CONTEXT**,
**THINKING** level and **WEIGHTS** size. Use `Choose quality →` for another
variant, `/effort` to change thinking, or **Tune** on the rental confirmation
for the conversation/context split.

Below those values are the actions:

- **Already running:** switch to an existing machine without another rental.
- **Rent:** provider, GPU shape, hourly rate and location. The confirmation
  names the weights source and any storage charges.
- **My computers:** start on a fitting computer.
- **Bank:** open your local weights and kept volumes.
- **Watch stock** or **No stock · watch:** set a rental price ceiling.
- **Connect** and **Refresh:** connect a provider or refresh its stock.

## The Bank screen (`Bank · your weights`) and kept weights volumes

Open `/llmhost` and select `Bank · your weights` (on **Which model?**, under
`More options →`, or from a model screen's `Bank · …` row). Opening the Bank
screen does not require a GPU provider API key until you mirror or delete a
provider's volume.

1. **Choose or discover the bank folder.** Mercury checks `<config>/host/bank.json`
   for a saved folder, then checks for an existing `~/mercury-model-bank`,
   `~/models`, `/Volumes/*/mercury-model-bank` or `/mnt/*/mercury-model-bank`
   (`~\mercury-model-bank` or `~\models` on Windows). If none exists, **Where
   should the bank live?** prompts for an absolute path on your computer,
   creates the folder, and records it in `bank.json`. Each model's files are
   stored under `<bank>/<namespace>--<repo>` with a `SHA256SUMS` manifest.
   An existing folder can be recognised by matching checksums or a model-naming
   manifest or `config.json`, so its spelling alone never decides. **Change folder**
   opens the same folder prompt and refreshes the table after your choice.
   Existing weights are not moved or deleted.
2. **Read the status line and table.** The summary shows the folder, free
   space, banked model count and size, and any kept volumes' monthly rate.
   The table has `MODEL`, `SIZE`, `BANKED`, `CHECK` and `VOLUME` columns.
   `CHECK` shows `failed · v` when a file check failed. Press `Enter` for the
   path, error and volume detail; `v` runs the check again.
3. **Run background bank and volume actions.** Five single-key shortcuts work on
   the Bank table and on a model screen:

- **`b` (`bank`):** after confirmation, starts a background job (`bank-<id>`)
  that installs `huggingface_hub` in `~/.local/share/mercury-host/hf`, runs
  `hf download` for the recipe's revision and file list (passing your stored
  Hugging Face token in `HF_TOKEN` when signed in so gated repositories
  download), hashes every file in one streaming pass, writes `SHA256SUMS`,
  verifies the files, and posts a chat notice when done. Interrupted downloads
  leave partial files in the folder; `b` resumes. If already banked, `b` lets you
  choose `Verify instead (no download)` or
  `Bank again`.
- **`v` (`verify`):** starts a background job (`verify-<id>`) that streams every
  file in the model's folder, checks file sizes, `SHA256SUMS` digests and any
  manifest SHA-256 or git blob hashes, updates the check result, and posts a
  chat notice naming the file if a byte differs.
- **`m` (`mirror`):** opens volume setup for a shipped, derived or private recipe
  with a trusted file manifest. For a private bank, Mercury builds that manifest
  from `SHA256SUMS`, the remaining config and tokenizer files, and the Hugging
  Face revision in its download receipts or source URL. Missing files, mixed
  revisions or a size mismatch are explained before anything is rented. Choose
  `Runpod network volume · one data centre · $0.07/GB/month` (`$0.07/GB/month`
  up to 1,000 GB, `$0.05/GB/month` above 1,000 GB, attached to pods in that
  data centre) or
  `Runpod global volume (beta) · any data centre · $0.09/GB/month + IOPS` (or
  `My own bank over SSH · mercury host`). Then choose **Prepare now**
  (rents the cheapest single-node Runpod pod in stock there, any GPU shape,
  downloads the files from Hugging Face directly onto the volume next to the GPUs,
  checks every file against the manifest, writes
  `SHA256SUMS`, `SIZES.json` and `SAMPLES.json`, and terminates the temporary
  pod) or **At the next rental** (creates the volume now and fills it from
  Hugging Face the next time you rent that model). Nothing is uploaded from your
  local drive. When a volume is already kept, `m` lets you run
  `Verify fully · rent a temporary pod to check every file` or
  `Delete weights disk`. When you rent a model with a kept volume, startup
  checks file sizes, modification times, the first and last 64 MB, and eight
  seeded 1 MB samples per large file against `SAMPLES.json` in a few seconds
  and skips downloading weights again.
- **`d` (`drop`):** deletes a kept Runpod or Vast.ai weights volume after
  confirmation while leaving the local bank on your drive untouched. Vast.ai
  refuses deletion while an instance uses the volume; terminate that instance first.
- **`k` (`keep safe`):** on a banked model, copies the bank to another drive
  this computer can see and checks every file, mirrors it to a Runpod volume,
  or saves a first-boot upload of your bank for Vast.ai and Lambda rentals at a
  measured upload speed; each choice shows its time estimate first.

Local banking (`b`) and verification (`v`) run on your computer at `$0.00`.
Runpod fast-load volumes (`m`) bill monthly whether or not a pod is running
until you delete them with `d` or under **Machines I'm paying for**.

### Keep the weights on a Vast.ai machine (`Vast.ai volume`)

Vast.ai sells **local volumes only**: a volume is created on one physical
machine, only an instance on that same machine can mount it, it cannot be
resized or moved, and it bills per GB-month at that machine's rate for its
whole size whether or not an instance is running (nothing bills while the
machine is offline). Mercury therefore keeps a model's weights **on one
Vast.ai machine**: a rental of that model on that machine boots from the
volume; a rental on any other machine downloads the weights as before.

With Vast.ai connected, `m` on a banked model row shows
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

Once kept, the Bank names the Vast.ai machine and its volume charge. The
rental confirmation shows the volume's monthly amount beside the hourly
rental price. A rental on that machine mounts the volume, checks the files
and skips downloading them again; other machines need another source.
The launch command also points the engine's compiled-kernel caches at the
volume (SGLang's cache directory and its DeepGEMM cache, DeepGEMM's own JIT
cache, FlashInfer, Torch inductor, Triton, CUDA and vLLM). Later boots on that
machine can reuse those compiled kernels; the first boot fills the caches.
CUDA-graph capture still runs on each boot.

A kept Vast.ai volume appears under **Machines I'm paying for** as
`Vast.ai volume <id> · Vast.ai machine <id> · <hosting tag> · <billing> · weights`
with the current stock on that machine (`4× B200 in stock on that machine at $…/hr`
or `no stock on that machine right now · w watch it`, where `w` arms a stock
watch that prefers that machine). `d` deletes it after confirmation and checks
the volume list to confirm it is gone; Vast.ai refuses to delete a volume while
an instance still uses it, and Mercury reports that refusal with the volume
still billing. Terminating a rental that uses the volume asks whether to keep
or delete it. A Vast.ai volume never attaches to a Runpod pod and a Runpod
disk never attaches to a Vast.ai instance.

## Rent a GPU (Runpod, Vast.ai, Lambda, Hugging Face, Hyperstack, Verda and DigitalOcean)

1. **Connect a GPU provider.** Paste a Runpod, Vast.ai, Lambda, Hyperstack or DigitalOcean API key (Verda uses `client_id:client_secret`) into
   the masked field; Hugging Face uses the sign-in `/logins huggingface` saved
   (an HF endpoint runs the model on hardware Hugging Face sells and hands back
   an address, with no SSH). Mercury verifies a key against the provider's
   instance list and saves it in the credential store (`0600`), never in a
   settings file or URL. Connected API-key vendors have
   **Replace key / Remove key** controls on the model screen. A replacement is
   checked before the saved key changes; removal does not stop rentals or bills.
   Hugging Face uses **Sign out with /logins huggingface**. Device-code sign-in
   requests `write-endpoints` for Inference Endpoints management, including
   viewing, creating and deleting endpoints. If an HTTP 403 notice says your
   sign-in lacks this permission, sign in again with `/logins huggingface`.
   A pasted token needs the Inference Endpoints permission from
   https://huggingface.co/settings/tokens.
   Hyperstack registers the SSH public key in the selected environment; Verda
   and DigitalOcean register it on the account.
   Hyperstack bills per minute, including a public IP charge; `/workspace` uses local storage that is deleted on termination. Verda prepays ten-minute compute increments with unused time refunded, charges separately for its root disk, and does not publish an egress price here; termination permanently deletes that root disk and verifies its absence. DigitalOcean bills per second with a five-minute minimum and includes local disk; Mercury lists its on-demand H100/H200 sizes; B200 and the spot/contract-only B300 are left out. Powering off these instances does not end compute billing.
2. **Choose a model and GPU shape.** Mercury reads live stock and hourly prices
   for the full shape (every GPU and node in the recipe) across the 32 shipped
   models (78 recipes in `assets/host/recipes.json` version 2, including
   GLM-5.3-Flash, Nemotron 3.5 Super VL 120B, Qwen3.8-27B,
   DeepSeek-V4.1-Flash-1017, GLM-5.3, Kimi K3, Qwen3.8-2.4T-A95B,
   DeepSeek-V4-Pro-0813, MiMo-V2.6-Pro-RL, Mistral Large 3 675B,
   Beam 1.0 501B-A23B, Hy4-preview 780B, Step 5 Preview 604B-A27B,
   MiniMax-M3 427B-A23B, Inkling 952B, Inkling-Small 266B,
   Nemotron 3 Ultra 550B-A55B, LongCat-2.0 1.8T, Ling-3.1-flash 572B,
   Qwen3.8-Flash-Next 180B-A6B, MiMo-V2.6-Flash-RL 309B-A15B,
   gpt-oss-120b and Gemma 4 31B) plus models from
   Hugging Face search. Large single-node and multi-node Runpod Instant Cluster
   recipes list total hourly compute, per-node disk sizes, weight download
   sizes, estimated download times at 0.5 to 1 GB/s per node, and model-licence
   terms.
3. **Tune before renting (optional).** Select **Tune** to choose quality,
   `conversations × context` and default thinking before creating the rental.
   Choices use the recipe's memory budget; an oversized choice names the
   larger shape it needs.
4. **Confirm the hourly price.** Nothing is rented until you select the
   confirmation row and press Enter. It names the model, GPU shape, rate,
   weights source, storage charges and deletion consequences. **Weights** lets
   you choose Hugging Face, a private repository, this computer's Bank or a
   kept volume. Unavailable choices say what action is needed. A private
   repository uses your Hugging Face sign-in on the rented machine; a Bank
   upload bills compute throughout the transfer. Billing starts on creation
   and continues after you close the popup.
5. **Background preparation and ready notice.** A detached background worker
   creates or registers the SSH key, provisions the pod or cluster, downloads
   the weights, starts the engine on remote loopback, opens a local SSH tunnel,
   registers the provider (`compat/pod-<id>/<model>`), and checks a reply. If
   you close `/llmhost` with `Esc` or click outside, setup keeps running in the
   background and posts a chat notice when the model is ready or if setup
   stops. The chat that rented the machine switches to its model when it is
   ready; a chat that has since closed gets the `/model compat/pod-<id>/<model>`
   command instead.

### Watch for stock across connected providers

From a model screen, choose **Watch stock** or **No stock · watch**. Then
select **Watch for stock and
rent at this price or less** (or choose **Set a lower price ceiling** / **Set a
price ceiling**). A background worker polls every connected provider (Runpod,
Vast.ai, Lambda, Hugging Face, Hyperstack, Verda and DigitalOcean) once every 5 seconds (12 stock checks per minute each)
for up to 12 hours. As soon as a fitting shape appears at or below your
ceiling, the first provider with stock rents it (or the cheapest shape when
several providers answer in the same round) and starts setup. Active watches
are listed under **Machines I'm paying for** with `$0.00 billed while watching` and
a **Cancel** action.

### Vendor hiccups and setup pauses

Transient vendor read errors (`HTTP 429`, `HTTP 5xx` and network timeouts)
retry with exponential backoff from 5 seconds up to 60 seconds, honouring a
longer `Retry-After`. If the vendor still does not answer within the 4-minute
read budget, setup pauses without terminating the machine.

No setup check ever terminates a rented machine on its own. When setup trips
on a confirmed fault, Mercury pauses the setup, leaves the machine running,
closes its tunnel, and posts one notice naming the cause, the machine, the
hourly rate it still bills, and the two choices:
`setup paused · <cause> · <Vendor> pod <id> · $<rate>/hr still billing · Resume or Terminate in /llmhost`.
**Resume setup** under **Machines I'm paying for** starts the setup again on
the same machine (a download continues from what already arrived; a running
engine is reused); **Terminate** deletes it. The row shows `paused`; open it
for the cause and recovery actions. The causes:

- **Engine death while loading weights:** if the engine process exits or logs
  `out of memory` (`OOM`), `failed to load model`, `error loading model`,
  `GGML_ASSERT`, `terminate called` or `CUDA error`, setup pauses immediately
  with
  `the engine died loading the weights: <the engine's own first error line>`.
  The cause line is read from the whole engine log instead of its last lines, so
  a crash's stack trace never stands in for it; when no error line was logged,
  the engine's last plain line (such as `Aborted (core dumped)`) is named. When
  the engine reported tensors it does not use, the notice adds
  `the engine set aside <N> tensors it does not use (e.g. blk.45.nextn.eh_proj.weight)`;
  when the engine's own line says the architecture is unknown or unsupported,
  it adds
  `the engine does not know this file's layout; it needs a newer llama.cpp than the engine image carries`
  (and on an `OOM`, adds
  `the shape was too small for this quality; choose a larger GPU shape`).
- **Engine silence:** if the engine is still not answering `/health` after the
  setup budget and has printed nothing new for 10 minutes, setup pauses with
  `Engine not ready. The engine printed nothing new for <N> min after its <M> min setup budget; it may still be loading on the machine`
  and the engine's last lines. The engine keeps running on the machine;
  Resume waits for it again.
- **Weight download stall or timeout:** a remote watchdog monitors disk and
  network progress every 30 seconds (`downloading weights on the machine · <X> of <Y> GB`).
  If less than 1 GB arrives over 10 minutes (`under 1 GB in 10 min`) or the
  download passes its deadline (`30 + ceil(weightsGb / 6)` minutes), the
  download stops and setup pauses with
  `Download stalled at <X> GB of <Y> GB (under 1 GB in 10 min)`
  (or, when a kept weights volume was attached, adds the volume, what it holds
  and its monthly charge: `weights disk <id> is kept with <X> GB downloaded and bills <price>`).
  Resume downloads again from what arrived; a temporary preparation pod for a
  kept volume pauses the same way and is released only once the weights are
  kept.
- **SSH key refusal:** a `RUNNING` pod that rejects SSH login with
  `Permission denied (publickey)` is retried every poll until it accepts the
  key or the setup deadline passes. A fresh container may answer before the
  vendor installs the account key.
  If the deadline passes first, setup pauses with
  `the machine never accepted Mercury's SSH key before the setup deadline · <vendor key notice>`.
  For a running Vast.ai instance, Mercury first attaches the same SSH key to
  that instance and retries for up to four more minutes. If the key is still
  refused, the pause says `Mercury attached the SSH key to this instance and retried`.
- **Pod missing from the vendor:** if the vendor returns `HTTP 404` during
  setup there is nothing to pause; Mercury checks the vendor's instance list
  without sending a terminate call and reports
  `the vendor no longer lists pod <id> · nothing to terminate · if it still bills, Machines I'm paying for shows it`.
- **Engine death after setup:** the keep-alive loop reads the engine's own log
  before it reconnects a dropped tunnel. An engine that exited after it was
ready pauses the record with the machine up and its weights on disk:
  `<Vendor> pod <id> · <engine error> · paused, $<rate>/hr still billing · Resume or Terminate in /llmhost`.
  The engine line is shown without its log prefixes and with byte counts in GB.
  When the engine ran out of GPU memory, the notice says what happened in the
  engine's terms, without judging the shape (the shape held the weights; the
  conversation outgrew the budget):
  `the engine ran out of GPU memory at <N>k tokens of context · the recipe's budget was <M> · Resume restarts it; a shorter conversation or the Tune screen's smaller context fits`
  (the tokens held and the budget are read from the engine's own startup plan
  and last batch line when it printed them). A request sent to that rental from
  the chat is answered at once with one line instead of a network-outage
  reconnect countdown, because the engine is down while the network is fine:
  `<Vendor> pod <id> · the engine ran out of GPU memory at <N>k tokens of context (the recipe's budget was <M>): <engine line> · the machine stays up and bills $<rate>/hr · Resume in /llmhost restarts the engine; a shorter conversation or the Tune screen's smaller context fits`.
  **Resume setup** starts the engine from the folder it loaded its weights
  from (checked on the machine first); nothing is uploaded or downloaded again.
  The two-hour rule covers this pause like any other.
- **Link dropped after setup:** five failed reconnects pause the rental without
  terminating it. The notice names the rented machine, reconnect count and
  hourly rate still billing: `Resume or Terminate in /llmhost`.
  Resume reopens the tunnel on the same port; an answering engine is reused
  without restarting it or downloading weights. The notice detail includes
  the last engine lines when they can be read, or `engine log unread`.

The only automatic terminate is the two-hour rule: a rental whose setup pause
has gone unanswered for 2 hours, or a ready rental that no model request has
reached for 2 hours (the keep-alive poll does not count; only a completed
request through its `/model` entry does, which a Tune reload also counts as
activity), is terminated by the background sweep. It posts
`<name> · no model request reached it for 2 hours · terminating <Vendor> pod <id> · it bills $<rate>/hr until it is gone`
(or `the setup pause went unanswered for 2 hours`), terminates the machine,
reads the vendor's instance list to confirm it is gone, removes the `/model`
entry, and posts
`<Vendor> pod <id> terminated · nothing more bills`
(a kept weights volume is never deleted by the sweep; the notice names it and
its monthly charge instead). The sweep looks every 5 minutes; nothing
terminates earlier than two hours. An unanswered pause after setup names its
cause: `the engine died and the pause went unanswered for 2 hours` or
`the link dropped and the pause went unanswered for 2 hours`.

If the vendor's instance list cannot be read to confirm deletion, Mercury never
claims the pod is gone; it posts
`termination sent; <Vendor> did not confirm (<reason>) — check Machines I'm paying for`.

### Manage or stop paying for a rental

Reopen `/llmhost` and select **Machines I'm paying for** to check live rentals,
clusters, Runpod and Vast.ai volumes, and active stock watches. The model menu
counts only live machines returned by the vendors; failed local records,
volumes and watches are left out of that count. Each vendor says how many machines it returned, `none`,
`no instances`, `no endpoints` or `unread`; an unread vendor adds `+?` to the
count instead of claiming a complete zero. Rows use the vendor's own name:
`Runpod pod`, `Vast.ai instance`, `Lambda instance` or `HF endpoint`.
Vendor read errors appear once at the top, with their HTTP status and details
behind the vendor row. A rejected credential stays parked until it changes.
Each machine row shows its state, hourly rate and available spend estimate.
Mercury remembers a rental's link drops across restarts. When Vast.ai lists
the same physical machine again, its offer stays selectable but follows
unaffected machines.
If only weights disks cannot be read, the machines remain listed:
`weights disks unread; storage may still bill`; transient reads try up to three
times, and the detail row names the failed request and cause and shows **Retry**.

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
- **Logs and Resume setup:** read the last lines of the engine log on the
  machine (the vendor's log when Mercury has none for it) or restart a paused
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
  `Kimi K3`. If a server rejects a reasoning parameter or value, Mercury keeps
  your selected effort and thinking, reports the server remedy and does not retry
  at default effort.
- **Multi-turn reasoning replay:** SGLang, vLLM, llama.cpp and Kimi K3
  conversations keep assistant `reasoning_content` across tool turns and
  continuations, and SGLang requests set
  `chat_template_kwargs.clear_thinking: false`. The
  `chat_template_kwargs.thinking` switch follows the session: `true` when
  thinking is on and `false` when off, whether or not an effort level is set.
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
- **Slot affinity and long prompts:** on `llama.cpp` servers with multiple
  slots, each conversation reuses its `id_slot` with `cache_prompt: true`.
  Mercury uses `llama.cpp` and SGLang metrics to allow time for long prompts,
  and checks server liveness instead of timing out after 30 seconds. The
  spinner shows its verb, elapsed time, token count and rate; interrupted
  streams show a concise reconnect or error line.

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
