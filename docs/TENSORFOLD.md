# TensorFold: `/tensorfold` and `/model`

TensorFold is a local inference engine for Apple silicon (Metal) and NVIDIA
GPUs on Linux (CUDA). Mercury runs the TensorFold binary (`tensorfold` or
`tensorfold-native`), connects to its `/v1/models` and `/v1/chat/completions`
endpoints, and never changes model weights.

Mercury ships three qualified starting points for TensorFold `1.2.2`, each
trained to a `256k` (`262,144`-token) context window:

- **`Nemotron Lightning`** (`TensorFold/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit`, served as `local/nemotron-lightning`): ordered first on Macs with under 64 GiB of memory (including 48 GB Macs) and on pre-M5 Apple silicon.
- **`Qwen3.8 27B`** (`TensorFold/Qwen3.8-27B-MLX-4bit`, served as `local/qwen3.8-27b`): paired automatically with its speculative drafter (`z-lab/Qwen3.8-27B-DFlash2` via `--drafter`). It is ordered first on M5 or newer Macs with 64 GiB or more of memory and on Linux CUDA, and second on 48 GB Macs (`steadier on long tasks · prefill ~350 tok/s · takes most of this Mac's memory`).
- **`Qwen3.5 2B`** (`mlx-community/Qwen3.5-2B-MLX-4bit`, pinned to revision `93760be4f1f69842a46bc13dbdc0f19e291392a3` and served as `local/qwen3.5-2b` with `--prompt-cache-gib 1`): the starting point that fits 8–16 GB Macs and backs the `2B (TensorFold)` helper model.

Any other MLX, NVFP4 or EXL3 safetensors checkpoint in the Hugging Face cache
(`~/.cache/huggingface/hub`, `$HF_HUB_CACHE` or `$HF_HOME/hub`) whose model
family TensorFold supports is listed as `on disk` (`note      unqualified by TensorFold`). Choosing `other checkpoint` (`a Hugging Face repository id`) reads a repository from Hugging Face (`Hugging Face · MLX, NVFP4 or EXL3 checkpoints, not GGUF`). GGUF repositories are refused with `GGUF is llama.cpp's format · /localsetup serves it`, and gated repositories are refused with `a gated repository · pull takes no token`.

## Opening `/tensorfold` and what the groups show

TensorFold lives in two adjacent groups: `TENSORFOLD` (models on this Mac or
Linux GPU) and `TENSORFOLD HOST` (another Mac or Linux server on your network,
or a rented GPU pod).

In `/model`, `TENSORFOLD` and `TENSORFOLD HOST` follow the picker's ordering
rule: the current model's group comes first, then groups by most recent use,
with `TENSORFOLD HOST` directly beneath `TENSORFOLD`. On a fresh install where
no model has been chosen yet on a machine that can run TensorFold, `TENSORFOLD`
and `TENSORFOLD HOST` appear first in `/model`, and the first-run sign-in list
puts `TensorFold` first (`TensorFold — run <model> on this Mac, no account (/tensorfold)`
or `TensorFold — install and run <model> on this Mac, no account (/tensorfold)`).
Once you pick another provider, `/model` returns to recency order.

When a cloud model is current, both groups open folded in `/model`:

```text
▸ TENSORFOLD · 1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served
▸ TENSORFOLD HOST · no host · a server on your network or a rented GPU pod
```

Pressing `→` on `TENSORFOLD` unfolds the top rows (any served model, the best
fit for this machine, and checkpoints on disk) with the remaining starting
points behind `↓ N more · ↵ unfolds the rest`. `↓` from the last row reaches
that line; `↵` or `→` on it unfolds every starting point and `other checkpoint`
(as does pressing `→` a second time on `TENSORFOLD`), and `←` folds the group.

Running `/tensorfold` in chat (or `mercury /tensorfold` at launch, or
`/tensorfold <owner/repo>` to inspect a repository id) opens the TensorFold
control panel with `TENSORFOLD` unfolded in full, `TENSORFOLD HOST` beneath it,
and a live status line in the footer above the key legend. In `/localsetup`,
step 1 on macOS and Linux also includes a `TensorFold` row
(`serve an MLX model on this Mac · /tensorfold` on macOS,
`serve an MLX model on this machine's NVIDIA GPU · /tensorfold` on Linux) that
opens `/tensorfold`.

Each model row uses the picker's columns: label, model id (`local/<name>` or
`compat/<provider>/<name>`), state (`on disk`, `↓ 20 GB`, `current`, `serving`,
`pulling 31%`, `starting`, `refused`, `exited`, `does not fit`), context window
(`32k ctx` through `256k ctx`), and memory or host (`28.5 GiB` projected,
`2.8 GiB in use` while serving, `unqualified`, the host name, or the pod GPU).
A model served by TensorFold appears only in its TensorFold group and is not
duplicated under **LOCAL MODELS**.

When `/tensorfold` opens, the cursor lands on the served row if one is running,
or on the best fit: the first starting point in rank that fits the machine at a
`64k` (`65,536`-token) window or larger. Nothing downloads or starts until you
press `↵`; the framed row's card shows `window`, `memory`, `pull` and `will run`.

| Key | Action on TensorFold rows |
| --- | --- |
| `↑↓` · `tab` · `esc` | Move selection, focus search, or close the popup; closing never stops an active install, pull or server start. |
| `↵` | Switch to a `serving` row; serve and switch on an `on disk` row; pull, serve and switch on an unpulled starting point; install, pull, serve and switch when TensorFold is not installed; pair or connect on a host row; open `/llmhost` on `rent a GPU pod`; type a repository id on `other checkpoint`. |
| `←→` (`ctrl+w`) | Step the context window across `32k`, `64k`, `128k` and `256k` (`ctrl+w` steps right). On a served row Mercury started, pressing `↵` restarts it at the selected window. |
| `s` | Stop what Mercury started (a pull, a starting server, a running server, or compute billing on a rented pod). When this session uses the model, the first `s` asks `s again stops it · this session uses it`. |
| `t` | Terminate a rented GPU pod under `TENSORFOLD HOST`, deleting its disk and ending all billing. |
| `w` | Copy the `sudo sysctl iogpu.wired_limit_mb=<N>` command when macOS's GPU wired-memory limit blocks a model or window. |
| `c` | Copy the one-line TensorFold support string to the clipboard. |
| `n` | Share a Mercury-started local server on your local network with a scoped key and pairing code, or stop sharing and bind back to `127.0.0.1`. |

## This Mac (and Linux CUDA)

### Install through Homebrew or the Linux release archive

On macOS, Mercury looks for `tensorfold-native` or `tensorfold` on `PATH`,
`/opt/homebrew/bin`, `/usr/local/bin` and `~/.tensorfold/bin`. When none is
installed, `/tensorfold` shows `install TensorFold` (`Homebrew · ashhart/tensorfold`)
and runs `brew install ashhart/tensorfold/tensorfold`. If Homebrew is not
installed, the card shows `needs     Homebrew · brew.sh installs it, then /tensorfold again`.

On Linux with an NVIDIA GPU and driver R580 or newer (CUDA 13), `install TensorFold`
(`release archive · checksum verified`) downloads
`tensorfold-1.2.2-linux-x86_64.tar.gz` (or `tensorfold-1.2.2-linux-aarch64.tar.gz`)
and its `.sha256` file into `~/.local/share/mercury-host/runtime/tensorfold`,
checks `sha256sum -c`, extracts the archive with `--strip-components=1`, and
removes the archive files. If no NVIDIA GPU is found or the driver is older
than R580, the footer reports `no NVIDIA GPU found` or
`driver <version> · TensorFold needs R580 or newer`.

### Pull, serve and switch

The framed row's card previews the exact commands before anything runs:

```text
window    32k 64k [128k] 256k · ←→ changes it
memory    weights 15 + drafter 3.6 + cache 8 + runtime 2 GiB · prompt cache ≤16 GiB
pull      into ~/.cache/huggingface/hub · 38 GB free on this disk
will run  tensorfold pull TensorFold/Qwen3.8-27B-MLX-4bit
          tensorfold pull z-lab/Qwen3.8-27B-DFlash2
          tensorfold serve TensorFold/Qwen3.8-27B-MLX-4bit --drafter z-lab/Qwen3.8-27B-DFlash2 …
```

Pressing `↵` runs the needed steps in sequence, waits for `/health` and
`/v1/models`, verifies a short reply with thinking off, and switches the
session to `local/<name>` (`● TensorFold serves <name> · <window> on 127.0.0.1:<port> · this session's model`).
While a checkpoint is pulling, the row shows `pulling <N>%` and the live footer
shows downloaded gigabytes, transfer rate in `MB/s` and remaining minutes;
pressing `s` stops the pull (`s stops, the download resumes next time`) and
partial blobs in `~/.cache/huggingface/hub` resume on the next pull. While the
engine loads weights into memory, the footer shows
`starting <name> on 127.0.0.1:<port> · loading · <N> s`.

Mercury checks `127.0.0.1:8080` first. When `8080` is occupied by another
local server (such as `llama.cpp` from `/localsetup` or a keyed server),
Mercury picks the next free port from `8081` upward, notes
`port      8081 · 8080 answers as llama.cpp · Mercury remembers it` in the card,
and records the port in `<config home>/tensorfold/served.json` and
`<config home>/local-setup/tensorfold-hosts.json`. Before starting a model,
Mercury also checks free memory; if free memory is more than 2 GiB short of the
projected load, Mercury refuses the start and names any running local server
that can free memory (`ollama stop frees its model`,
`s on Mercury's own llama.cpp server stops it`).

### The context window (`←→`) and the prompt cache

The `window` strip steps across `32k`, `64k`, `128k` and `256k` (`←→` or
`ctrl+w`). Mercury picks the largest rung that fits usable memory and never
uses TensorFold's 8k quick-start default. Rungs that do not fit appear in amber
with the memory needed and the largest fitting rung (`256k needs 36.5 GiB, 36.0 GiB usable · ← 128k fits`).
On a served row started by Mercury, stepping `←→` to another rung and pressing
`↵` stops the service and restarts it at the new `--context` value
(`↵ restarts it at 128k`).

For `qwen3_5` checkpoints where prompt caching is opt-in (`Qwen3.5 2B` and
other non-27B `qwen3_5` checkpoints), Mercury passes `--prompt-cache-gib 1` and
includes that 1 GiB in the memory projection (`service   tensorfold · started by Mercury · prompt cache 1 GiB`).
For `Qwen3.8 27B` and `Nemotron Lightning`, Mercury omits `--prompt-cache-gib`
so TensorFold allocates its prompt cache from the room remaining under its
70%-of-RAM cap (`prompt cache ≤16 GiB`). If TensorFold refuses an explicit
`--prompt-cache-gib` budget because it would cross 70% of system memory, the
next start leaves the prompt cache to the engine default.

### The macOS GPU wired-memory limit (`w`)

Every fit verdict is marked `an estimate`. TensorFold's admission floor
requires `weights + 2 GiB ≤ 70%` of system RAM; on macOS, Mercury reads the live
GPU working-set limit from Metal (`recommendedMaxWorkingSetSize`) or
`iogpu.wired_limit_mb` (falling back to 70% of RAM).

When a model or window passes the 70% floor but needs more memory than macOS
currently lets the GPU wire (including `Qwen3.8 27B` on a Mac with under 48 GB
of RAM, such as a 32 GB Mac), and raising the wired limit with a 4 GiB margin
leaves at least 4 GiB for macOS, the card shows:

```text
fit       needs the GPU limit raised · w · an estimate
will run  sudo sysctl iogpu.wired_limit_mb=28672
cost      asks for your password (sudo) · leaves 4.0 GiB for macOS · resets at reboot; restart the engine after it
```

When raising the limit leaves under 8 GiB for macOS, the `cost` line adds
`· tight — quit other apps first`; when less than 4 GiB would remain for macOS,
the card advises `lower the window or choose a smaller model` instead. Mercury
prints the `sudo sysctl iogpu.wired_limit_mb=<N>` line and never runs `sudo`
itself: pressing `w` copies the command to the clipboard
(`copied · run it in a terminal (it asks for your password) · then /tensorfold again`).
Raising `iogpu.wired_limit_mb` lets the weights and KV cache wire on a 32 GB
Mac, while TensorFold's 70%-of-RAM prompt-cache ceiling remains unchanged.

### Servers started outside Mercury and the TensorFold app

- **Started outside Mercury:** If a TensorFold server is already running on
  `127.0.0.1` that Mercury did not start, `/tensorfold` lists it as `serving`
  and shows `window    <N>k · set when it started outside Mercury, which does not stop or restart it`,
  while the `TENSORFOLD` heading subtracts its footprint (`33.2 of 36.0 GiB usable left · 1 serving`).
  Mercury never stops or restarts an outside server. If its served window is
  under the `32k` floor Mercury requires (`window    8k · under the 32k Mercury needs`),
  `/health` reports a warning and `/tensorfold` can start a separate server on
  the next free port. If `127.0.0.1:8080` requires authentication
  (`127.0.0.1:8080 asks for a key`), setting `MERCURY_LOCAL_API_KEY` with a
  `mercury[inference]` key lets Mercury list and use it; otherwise `/tensorfold`
  serves on `8081`.
- **The TensorFold app (`TensorFold.app`):** On macOS, the desktop TensorFold
  app starts its own `tensorfold-native` process on a random loopback port and
  key each launch. When Mercury detects `TensorFold.app` serving a model in the
  process tree, it never lists that server as a pairable row, refuses to start
  a second copy (`the TensorFold app is already serving on this Mac · quit the app first — two copies won't fit`),
  and shows `the app is serving <model>` (`paste from its API tab`) with
  `instead   s serves it with Mercury · quit the app first — two copies won't fit`.

## Another Mac on your network

`TENSORFOLD HOST` connects to a TensorFold server on another Mac or Linux
machine on your local network. Tools (`Bash`, `Read`, `Edit`, `Write` and the
rest of the roster) always run on the computer where you run Mercury; the
serving machine only runs model inference.

- **Sharing a model with `n`:** On a model Mercury is serving locally, the card
  shows `network   not shared · n shares it on this network`. Pressing `n`
  writes a random scoped key (`mercury[inference]: <key>`) to
  `<config home>/local-setup/tensorfold/api-key` (`0600`), restarts the server
  with `--host 0.0.0.0 --api-key-file`, advertises it on the local network
  (`_mercury-tf._tcp` via `dns-sd` on macOS or `avahi-publish-service` on
  Linux), and shows a 6-digit one-time pairing code:
  `pairing code <code> · another Mac on your network lists <name> under TENSORFOLD HOST and asks for it once · plain HTTP on your home or office network, not across the internet`.
  While shared, the card reads `network   shared · keyed · n stops sharing`;
  pressing `n` again stops the network announcement and restarts the server on
  `127.0.0.1` (`restarting on this Mac only`).
- **Pairing by the one-time code:** On another Mac or Linux machine on the same
  network, the announced host appears under `TENSORFOLD HOST` as `not paired`
  (`pair      ↵ asks once for the pairing code shown on <host>`). Press `↵`,
  type the 6-digit code (`type the pairing code · ↵ pair · esc back`), and
  press `↵`. Mercury exchanges the code once (valid for 10 minutes, up to 3
  attempts) for the server's address and scoped key, stores the host in
  `<config home>/local-setup/tensorfold-hosts.json` (`0600`), and lists the
  served model under `TENSORFOLD HOST`.
- **Connecting by typed address:** To attach to a server started by hand (or
  from Windows), choose `a server on your network` (`its address`) under
  `TENSORFOLD HOST`, press `↵`, and enter `host:port`
  (`type host:port, e.g. studio.local:8080`). When attaching to a keyed server
  started outside Mercury, paste the `mercury[inference]: <key>` line into the
  key file on the serving Mac (`paste this one line into the key file on the serving Mac`)
  or set `MERCURY_LOCAL_API_KEY`.
- **Plain HTTP on your own network:** Every network host card states
  `plain HTTP on your home or office network, not across the internet`. The
  scoped `mercury[inference]` key permits `/v1/chat/completions` and
  `/v1/models` only, keeping TensorFold's memory and weight-changing routes
  closed. Across an untrusted network, place the server behind an SSH tunnel or
  TLS proxy first.

## A rented GPU pod

Under `TENSORFOLD HOST`, the `rent a GPU pod` row (`Runpod or Vast.ai, through /llmhost`)
rents a cloud CUDA pod for TensorFold:

```text
pod       RTX 5090 32 GB · $0.89/h on Runpod · billing starts when it boots
serves    Qwen3.8 27B at 128k with TensorFold 1.2.2 for CUDA
through   /llmhost rents it, installs TensorFold, pulls, serves, then this session switches · s stops the pod and its billing
```

Pressing `↵` (`↵ rent and switch`) opens `/llmhost` on the TensorFold recipe
([LLM-HOST.md](LLM-HOST.md)). TensorFold recipes appear under `TENSORFOLD HOST`
and in `/llmhost`.

- **GPU classes and setup:** Mercury supports `RTX 5090` (32 GB),
  `RTX PRO 6000` (96 GB), `GB10` (128 GB), `A100` (80 GB), `RTX A6000` (48 GB)
  and `RTX 3090` (24 GB), and lists `RTX 4090` (24 GB), `L40S` (48 GB) and `L4`
  (24 GB) as `ships · unqualified by TensorFold`. `H100`, `H200`, `B200`,
  `B300` and `GB300` are refused before renting (`the 1.2.2 archive holds no sm_90 machine code and no PTX`).
  On the rented pod, setup checks for NVIDIA driver R580 or newer (CUDA 13.0),
  downloads the release archive into `/workspace/mercury-host/<recipe-id>`,
  verifies both its SHA-256 checksum and its Ed25519 signature, sets
  `HF_HOME=/workspace/huggingface`, runs `tensorfold-native pull` before
  `tensorfold-native serve` (`--host 0.0.0.0 --port 8080 --api-key-file`), and
  opens the local SSH tunnel. Public checkpoints only are pulled on a pod
  (`TensorFold pulls public checkpoints only · a gated or private model is not served on a pod yet`).
- **The key Mercury holds:** When a pod is registered, Mercury generates a
  random 24-byte key in `<config home>/host/tensorfold/<id>.key` (`0600`),
  writes `mercury[inference]: <key>` to `api-key` (`0600`) on the pod, checks
  `/health` for liveness and `GET /v1/models` with the bearer key for
  readiness, and removes the local key file when the pod is unregistered.
- **Pod rows from the rental on, `s` stops and `t` terminates:** From the
  moment you confirm the rental in `/llmhost`, the pod row appears under
  `TENSORFOLD HOST` with its state:
  - `setting up`: shows the current provisioning step (`now       <step>`).
  - `serving` (or `current`): ready for turns as `compat/pod-<id>/<model>`,
    showing `$<price>/h on <Runpod|Vast.ai> · <elapsed> · ~$<spend> so far · s stops the pod and its billing`.
  - `paused` or `failed`: shows the cause and `next      Resume or Terminate in /llmhost`.
  - `stopping` and `stopped`: pressing `s` on a billing pod stops GPU compute
    billing (`<machine> stopped · compute billing ended · ~$<spend> so far · the disk bills until you terminate it in /llmhost`).
  While a pod is `stopped`, its container or volume disk continues to bill at
  the vendor's storage rate until terminated. Pressing `t` on the pod row
  (`t terminates the pod`), or selecting **Terminate** under `/llmhost` →
  **Machines I’m paying for**, deletes the pod, confirms its removal from the
  vendor's instance list, and ends all billing.

## Windows

TensorFold has no native Windows release yet. On Windows, the `TENSORFOLD`
group in `/model` and `/tensorfold` stays folded and reads
`no Windows release yet` (and the `/tensorfold` footer reads
`nothing served here · TensorFold runs on a host`).

`TENSORFOLD HOST` opens unfolded on Windows: you can connect to a TensorFold
server on another Mac or Linux machine on your network (`a server on your network`)
or rent a GPU pod (`rent a GPU pod` on Runpod or Vast.ai through `/llmhost`).
On first run on Windows, the sign-in step lists
`TensorFold — on a host: a server on your network or a rented GPU pod (/tensorfold)`.

To run local model weights directly on a Windows machine, use `/localsetup`
([LOCAL-SETUP.md](LOCAL-SETUP.md)), which pulls and serves GGUF checkpoints on
`llama-server` (`llama.cpp`) or connects Ollama or LM Studio.

## The helper model setting

In `/config`, `Helper model` (default `off`) runs a small local model for
Mercury's own background jobs whatever main model the session uses:
`titles and summaries ✓ · the judge ✓ · compaction ✗ · a small model can drop details`.
Below it in `/config`, `Helper model for compaction` (default
`off · a small model can drop details`) opts session compaction into the helper
model when turned on.

`Helper model` has four choices:

- **`off`** (default): background jobs use the session's provider route.
- **`2B (TensorFold)`** (`~5.0 GiB · an estimate`): serves
  `mlx-community/Qwen3.5-2B-MLX-4bit` (`local/qwen3.5-2b`) at a `32k` window
  with `--prompt-cache-gib 1` as a separate `tensorfold-helper` project service
  on its own free loopback port. Requires TensorFold installed
  (`install TensorFold`) and the 2B checkpoint on disk
  (`pull the 2B in /tensorfold`).
- **`4B (llama.cpp)`** (`~8.0 GiB · an estimate`): serves a banked Qwen3.5 4B
  GGUF checkpoint on `llama-server` as the `mercury-helper` service on its own
  free port (`pull it first · /localsetup` when not in the Bank).
- **`the session's local model`**: reuses the session's active local model when
  that model's prompt cache has multiple slots. When the session is on
  `qwen3.8-27b` on TensorFold (whose prompt cache holds a single conversation),
  this choice is unavailable with the reason
  `its prompt cache holds one conversation · a helper request would evict this session's`;
  `2B (TensorFold)` and `4B (llama.cpp)` run on a separate server process so
  helper calls never evict the main session's prompt cache.

When a helper model is enabled, the `TENSORFOLD` group heading appends
`· helper 2B` (or `4B`, or the session model name) and `/health` adds a
`Helper model` row.

## Effort and `reasoning_effort`

Mercury's effort dial (`/effort`, or `ctrl+e` in `/model`: `low`, `medium`,
`high`, `xhigh`, `max`) and thinking toggle (`⌥T`) are sent on every
`/v1/chat/completions` request to TensorFold; there is no thinking toggle on
the server card.

- Turning thinking off (`⌥T`) or setting effort to `low` sends
  `reasoning_effort: "none"`.
- Setting effort to `medium`, `high`, `xhigh` or `max` with thinking on sends
  `reasoning_effort` at that level along with `thinking_budget` (`4096` tokens
  at `medium`, `16384` at `high`, `32768` at `xhigh`, `65536` at `max`,
  bounded to leave `2048` tokens of `max_tokens` for the answer).

TensorFold reports the level it applied in `tensorfold.reasoning_effort`; when
a checkpoint's template maps the requested effort to a nearest supported level,
Mercury's effort stamp shows the applied level.

## `/usage` per turn

Every streaming request to TensorFold includes `stream_options.include_usage: true`.
TensorFold's final usage chunk and `tensorfold` runtime block return prompt and
completion token counts, cached input tokens, reasoning tokens, decode rate
(`tokens_per_second`), decode duration, time to first token, prefill duration,
applied `reasoning_effort`, and speculative draft acceptance
(`draft_acceptance`).

When the session's model is on TensorFold, `/usage` shows a `last turn` line
under **Local models usage**:

```text
last turn · qwen3.8-27b · ~78 tok/s · first token in 72 ms · prefill 160 ms · 4,570 in (4,180 cached) · 312 out (140 thinking) · effort medium · drafts 26% accepted
```

Once two or more turns have completed in the session, `/usage` adds a session
summary line:

```text
this session · 5 turns · ~76 tok/s on average · 24,120 in (20,510 cached · 85%) · 1,480 out
```

The latest turn's `first reply in <N> ms · ~<M> tok/s` also appears on the
served row's card in `/model` and in `/tensorfold`'s live footer.

## The support line and `/health`

Mercury composes a one-line support string containing engine, hardware and flag
facts, with nothing from your prompts or conversation:

```text
TensorFold 1.2.2 · Metal · Apple M5 Pro · macOS 26.0 · TensorFold/Qwen3.8-27B-MLX-4bit + z-lab/Qwen3.8-27B-DFlash2 · --context 131072 · Mercury 1.0.6
```

For a server on another Mac or a rented pod, the host name (`studio.local` or
`pod-<id>`) replaces the local chip, and `--prompt-cache-gib <N>` is included
when set. Pressing `c` on any TensorFold row in `/model` or `/tensorfold`
copies this line to the clipboard (`copied the support line`). Every TensorFold
warning receipt in the chat feed (refused memory fit, occupied port, macOS GPU
limit, unexpected exit, failed pull, tight free memory) also ends with
`· c copies the support line`.

In `/health` (and `mercury health --json`), when TensorFold is installed,
serving, exited, or running under `TensorFold.app`, the `AUTH` section includes:

- **`TensorFold`** (`id: "tensorfold"`):
  - `✓ ok`: `<model> on <address> · <window> served · <GiB> in use · <N> streams · TensorFold <version> · <Metal|CUDA> · <chip> · started by Mercury (service tensorfold)` (or `started outside Mercury`), with any missing optional library in the detail line (`optional libraries: ...`).
  - `▲ warn`: `<model> on <address> serves an 8k window · under the 32k Mercury needs · started outside Mercury` (fix: `/tensorfold serves it again at 32k or more`).
  - `· info`: `<address> answers with a key · /health shows status only · model and window read from /v1/models: <model> · <window>` for a keyed server; `the app is serving <model> · paste from its API tab · s serve with Mercury instead (quit the app first — two copies won't fit)` when `TensorFold.app` is serving; or `TensorFold <version> installed · nothing served` (fix: `/tensorfold`).
  - `✕ fail`: `the tensorfold service exited · <last stderr line>` (fix: `/tensorfold starts it again`).
- **`support`** (`id: "tensorfold-support"`, status `info`): the composed
  support line.
- **`Helper model`** (`id: "helper-model"`): present whenever `Helper model` is
  not `off`, showing the chosen helper, its server address or
  `starting when first needed`, and
  `titles and summaries ✓ · the judge ✓ · compaction ✗ · a small model can drop details`
  (or `warn` with fix `/config → Helper model` when unavailable).

## The local prompt profile

When a session or a crewmate runs on a local model (`local/<model>` on
TensorFold, `llama.cpp`, Ollama, LM Studio or vLLM) or on a rented TensorFold
pod (`compat/pod-<id>/<model>`), Mercury applies the local prompt profile:

- **Compact system prompt and core tools:** Mercury replaces the full cloud
  system prompt with a shorter local prompt and sends full JSON schemas for the
  core tools only (`Bash` or `PowerShell`, `Read`, `Edit`, `Write`, `Glob`,
  `Grep`, `ToolSearch`, and `StructuredOutput` when requested), with concise
  parameter descriptions. All other tools wait behind `ToolSearch` on a
  names-only `"Deferred tools:"` list (except tools marked `alwaysLoad`).
- **Stable prefix for prompt caching:** Per-session volatile text (initial git
  status, session lineage, startup memory and the session scratchpad path)
  moves out of the system message on the local route so the prefix (`system`
  plus `tools` before the first user message) stays byte-identical across turns
  and across fresh sessions in the same project, preserving TensorFold prompt
  cache hits.
- **Server-aware tool batching:** On TensorFold and other local servers that
  handle parallel tool calls, the prompt instructs the model to batch
  independent reads and pair an edit with its verification check in one
  message; on `llama.cpp`, it instructs the model to make one tool call per
  message.

The local prompt profile is on by default (`MERCURY_LOCAL_PROMPT_PROFILE`). Set
`MERCURY_LOCAL_PROMPT_PROFILE=0` in your environment to turn it off and send
the full cloud system prompt and tool roster to local models.
