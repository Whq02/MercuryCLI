# Run or connect a model: `/llmhost` and `mercury host`

Open `/llmhost` in the foreground chat. Its popup opens on **Which model?**,
showing where each model can run right now: on a pod you already run, on this
computer or a saved SSH computer (`mercury host`), or on a GPU rented from
Runpod, Vast.ai or Lambda. `/model` also includes searchable `run it →
/llmhost` actions (`run it on this Mac →` when a model fits a local Mac) that
open the chosen model's page directly.

Selecting a model opens its page with four sections:

- **QUALITY:** the recipe's quantization or precision variants (such as 4-bit
  GGUF, NVFP4, FP8 or BF16), the required GPU count and memory, and the lowest
  current hourly price.
- **CONVERSATIONS × CONTEXT:** the GPU-memory token budget split across
  parallel conversations (for example `4 conversations × 131,072 tokens`).
- **THINKING:** the default reasoning level, which you can change per request
  at any time with `/effort`.
- **WHERE:** running pods you can switch to at no extra cost, computers you own
  that fit the model, in-stock rental rows from Runpod, Vast.ai and Lambda,
  `Connect <vendor> →` rows for unconfigured vendors, and `No stock · watch →`
  when Runpod has no current stock.

From the first screen you can also open **Pods I'm paying for**, **My
computers**, **Refresh stock and prices**, or **Other roads →** (`Rent a GPU`,
`A box I can reach by SSH`, `A server that's already running`, `One of my
computers`, and `Fast-load (keep weights near the GPU)`). Every path reads the
served models and context windows, checks a reply, and registers the provider
for `/model` and `/logins`.

## Rent a GPU (Runpod, Vast.ai and Lambda)

1. **Connect a GPU provider.** Paste a Runpod, Vast.ai or Lambda API key into
   the masked field. The key is verified against the provider's instance list
   and saved in Mercury's credential store (`0600`), never in a settings file
   or URL. Vast.ai and Lambda rentals are new in 1.0.0-beta.40 and verified
   against the vendors' published APIs on fixtures (live rental runs were not
   performed).
2. **Choose a model and GPU shape.** Mercury reads live stock and hourly prices
   for the whole shape (every GPU and node in the recipe). Single-node and
   multi-node recipes span `GLM-5.3-Flash`, `Nemotron 3.5 Super VL 120B`,
   `Qwen3.8-27B`, `DeepSeek-V4.1-Flash-1017`, `GLM-5.3` (FP8 and BF16), `Kimi
   K3`, `Qwen3.8-2.4T-A95B` (FP8 and NVFP4), `DeepSeek V4 Pro`,
   `MiMo-V2.6-Pro-RL` and `Mistral Large 3 675B`. Trillion-parameter recipes
   include multi-node Runpod Instant Clusters and display total hourly compute,
   per-node disk allocations, weight download sizes, estimated download times
   at 0.5 to 1 GB/s per node, and model-licence notices.
3. **Tune before renting (optional).** On the rental confirmation screen,
   choose **Tune** to adjust model quality, `conversations × context` splits
   against the visible GPU-memory allowance (12 GB per GPU engine reserve plus
   documented KV cache bytes per token), and default thinking level before a
   pod is created.
4. **Confirm the hourly price.** Nothing is rented until you select the
   confirmation row and press Enter. Confirmation states the per-step setup
   estimate (engine startup, weight download and model load) plus the vendor's
   storage and SSH-key notices. Both `llama.cpp` GGUF recipes (`GLM-5.3-Flash`
   and `Nemotron 3.5 Super VL 120B`) use the prebuilt CUDA 13 engine image
   (`ghcr.io/whq02/mercury-llamacpp`), skipping source compilation when the
   preinstalled `llama-server` binary is present.
5. **Background preparation and ready notice.** A detached background worker
   creates or registers the SSH key, provisions the pod or cluster, downloads
   weights, starts the engine on remote loopback, opens a local SSH tunnel,
   registers the provider (`compat/pod-<id>/<model>`), and checks a reply.
   Closing `/llmhost` with `Esc` or clicking outside leaves setup running in
   the background; Mercury posts a notice in chat when the model is ready (with
   the exact `/model compat/pod-<id>/<model>` command) or if setup stalls.

### Watch for stock on Runpod

When a model has no Runpod stock, choose **Watch for stock and rent at this
price or less** (or set a lower hourly ceiling). A background worker polls the
Runpod catalogue every 5 seconds (12 requests per minute) for up to 12 hours.
When a fitting shape appears at or under your ceiling, it creates the pod
immediately and starts setup. Active watches appear under **Pods I'm paying
for** with `$0.00 billed while watching` and a **Cancel** action.

### Fast-load kept weights disks (Runpod)

Open `/llmhost` → **Other roads →** → **Fast-load (keep weights near the GPU)**
to keep a model's weights on a Runpod network volume (in a chosen data centre)
or global volume.

- **Prepare now:** rents the cheapest fitting GPU pod, downloads the pinned
  Hugging Face revision, verifies every file's size and SHA-256, writes a
  sample manifest, and terminates the temporary pod.
- **At the next rental:** creates the volume now and fills it the next time you
  rent that model variant.

When you rent a model with a kept weights disk, warm startup checks file sizes,
modification times, the first and last 64 MB, and eight deterministic 1 MB
samples per large file in seconds (or runs **Verify fully** on demand) and
starts the engine without re-downloading weights. Volumes bill monthly even
when no pod is running and appear in **Pods I'm paying for** with their own
delete confirmation.

### Manage or stop paying for a rental

Reopen `/llmhost` and select **Pods I'm paying for** to inspect live pods,
clusters, Runpod volumes and active stock watches across all connected
vendors. Each row shows the vendor, current setup step or status, hourly rate,
elapsed time and estimated compute spend so far.

- **Tune (Runpod single-node `llama.cpp` pods):** change `conversations ×
  context` or default thinking and reload the running `llama-server` in place
  without re-downloading weights, with automatic rollback to the previous
  launch script if the reload fails.
- **Stop (Runpod and Vast.ai pods):** releases GPU compute while keeping the
  pod or container disk. Storage continues to bill while stopped. Lambda
  instances and Runpod clusters have no Stop operation and bill until
  termination.
- **Terminate:** deletes the pod, cluster or instance after confirmation and
  verifies its absence from the vendor's instance list. On Runpod pods with an
  attached fast-load disk, Mercury asks whether to keep or delete the weights
  volume. Terminating a pod removes its model registration from `/model`.
- **Logs and Resume setup:** read the vendor log tail or restart a stalled
  setup job.

Stock watches, multi-node clusters, fast-load weights disks and in-place Tune
reloads are Runpod-only; selecting them for Vast.ai or Lambda explains that
boundary without making a request.

## Run a model on your own computer: `My computers` and `mercury host`

Open `/llmhost` and choose **My computers** (or **Other roads →** → **One of my
computers**), or run `mercury host` from the command line:

```sh
mercury host status
mercury host recipes [box]
mercury host add <name> --host <host> [--user <user>] [--port <port>] [--key <path>]
mercury host start [box] [--recipe <id>] [--bank <path> | --download <dir>] [--yes]
mercury host stop [box]
mercury host restart [box]
mercury host logs [box]
mercury host uninstall [box] [--yes]
```

Mercury inspects this computer (or a saved SSH computer across macOS, Linux and
Windows), lists Ollama and GGUF recipes that fit its memory, checks any local
weight bank against `SHA256SUMS` before startup (or asks before downloading
weights), installs and starts a user-level login service (`launchd` on macOS,
`systemd --user` on Linux, Scheduled Task on Windows) bound to loopback, opens
a persistent SSH forwarder for remote computers, and registers
`compat/box-<name>/<model>` for every session sharing the configuration home.

The computer screen and `mercury host status` show the engine, model, reported
busy slots and last measured token rate. Stopping the service keeps the model
row visible in `/model` with `box <name> · engine stopped — /llmhost starts
it`, so selecting a stopped computer never prompts for an API key.
`uninstall` removes Mercury's service definition without deleting downloaded
weights.

## A box I can reach by SSH

Under **Other roads →** → **A box I can reach by SSH**, enter a host and user
or an alias from your SSH configuration. Mercury runs `nvidia-smi` over SSH and
lists recipes that fit the detected GPUs. Confirm before installing or starting
anything. You can point at a complete local weight folder (copied with `rsync`
over SSH) or download from Hugging Face into `/workspace`. The engine binds to
the remote loopback interface and Mercury opens a local SSH tunnel.

## A server that's already running

Under **Other roads →** → **A server that's already running**, connect a local
endpoint, a direct HTTPS address, or the loopback address of an SSH tunnel you
already opened.

### Connection steps

1. **The server address.** Enter the OpenAI-compatible API base, such as
   `http://127.0.0.1:30000/v1`. A bare server address gets `/v1` appended;
   include the full base path when using a reverse proxy. Mercury contacts
   only the address you give.
2. **The server dialect.** Mercury checks for SGLang, vLLM, llama.cpp or Ollama
   metadata. Confirm the detected dialect, or choose SGLang, vLLM, llama.cpp,
   Ollama, LM Studio, chat completions or Responses.
3. **The key.** A server that requires authentication asks for a masked key
   before discovery finishes. Keyless servers can leave the field blank. The
   key is stored in Mercury's credential store, never in a settings file.
4. **The model.** When the server lists one model, Mercury selects it
   automatically. When it lists several, pick one from the list; each row shows
   its served window when reported, such as `1,048,576 tokens · served window`.
5. **Name, register and check.** Choose a provider name (default `llmhost`),
   confirm registration, and run the short reply check. The popup shows the
   reply, elapsed time and, when usage is returned, output tokens and
   whole-turn tokens/s.
6. **Use the provider.** `/model` lists `compat/llmhost/<model>` and `/logins`
   shows the provider immediately.

## What Mercury saves and sends on the wire

The endpoint is saved under `compatProvider.<name>` in user settings with its
API base, label, dialect and, for SGLang, `sessionAffinityHeader:
"x-session-id"`, plus `models["compat/<name>/<model>"].contextWindow` and
supported `efforts`. An explicit per-model `contextWindow` in settings takes
precedence over the server's reported window.

- **Reasoning and `/effort`:** `/effort` lists the model's supported reasoning
  levels (`low`, `high`, `max` on GLM-5.3, GLM-5.3-Flash, DeepSeek V4.1/V4 Pro
  and Kimi K3; `low`, `medium`, `xhigh` on Qwen3.8; named thinking values from
  `/api/show` on Ollama). Requests send `chat_template_kwargs.reasoning_effort`
  on `llama.cpp` and top-level `reasoning_effort` on `vLLM`, `SGLang`, `Ollama`
  and `Kimi K3`. If a server rejects the effort field with HTTP 400 before
  streaming content, Mercury retries once without the field and shows a notice.
- **Multi-turn reasoning replay:** SGLang, vLLM, llama.cpp and Kimi K3
  conversations preserve assistant `reasoning_content` across tool turns and
  continuations, and SGLang requests include `chat_template_kwargs: {
  clear_thinking: false }`.
- **Slot affinity and prefill liveness:** on `llama.cpp` servers reporting
  multiple slots in `GET /props`, each conversation attaches to a consistent
  `id_slot` with `cache_prompt: true`. During long prompt prefills on
  self-hosted dialects, Mercury polls server liveness (`GET /slots` on
  `llama.cpp`; `/health`, `/` or `/v1/models` on `vLLM`, `SGLang`, `Ollama` and
  `LM Studio`) so active prefills are not cut at 30 seconds, while streaming
  tool-call arguments keep crewmate activity timers alive.

## A rented pod through a manual SSH tunnel

If you started a model server on a pod yourself with its API bound to remote
loopback, open an SSH tunnel from your terminal:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:30000:127.0.0.1:30000 user@pod.example
```

Leave that connection running, open `/llmhost` → **Other roads →** → **A server
that's already running**, and enter `http://127.0.0.1:30000/v1`.

## Check, change or remove a server

In `/model`, an unreachable keyless endpoint shows `Retry this server →`, and
an unreachable custom endpoint shows `Retry this server →` and `Remove this
endpoint →`. You can also open `/llmhost` → **Other roads →** → **A server
that's already running** and select a registered server to:

- **Check a reply again:** refresh its models and run a reply check with the
  saved endpoint and credential.
- **Change the address and check it:** repeat discovery at a new address
  without forwarding the old stored key, credential command or custom headers.
- **Remove the provider and its stored key:** delete the endpoint from Mercury
  and clear its stored key while leaving the server itself untouched.
