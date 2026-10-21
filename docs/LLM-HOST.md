# Run or connect a model: `/llmhost` and `mercury host`

Run `/llmhost` in the foreground chat. Its popup opens on **Which model?**,
which lists the supported models and where each one can run right now: on a pod
you already have running, on this computer or a saved SSH computer (`mercury
host`), or on a GPU rented from Runpod, Vast.ai or Lambda. In `/model`, you can
also search for `run it → /llmhost` (`run it on this Mac →` when a model fits
your Mac) to open that model's page directly.

Selecting a model opens its page with four sections:

- **QUALITY:** the recipe's quantization or precision variants (such as 4-bit
  GGUF, NVFP4, FP8 or BF16), the required GPU count and memory, and the lowest
  current hourly price.
- **CONVERSATIONS × CONTEXT:** how the GPU-memory token budget splits across
  parallel conversations (for example `4 conversations × 131,072 tokens`).
- **THINKING:** the default reasoning level, which `/effort` can change per
  request.
- **WHERE:** running pods you can switch to at no extra cost, computers you own
  that fit the model, in-stock rental rows from Runpod, Vast.ai and Lambda,
  `Connect <vendor> →` rows for unconfigured vendors, and `No stock · watch →`
  when Runpod is out of stock.

From the first screen you can also open **Pods I'm paying for**, **My
computers**, **Refresh stock and prices**, or the `Other roads →` menu (`Rent a
GPU`, `A box I can reach by SSH`, `A server that's already running`, `One of my
computers`, and `Fast-load (keep weights near the GPU)`). Each option reads the
server's model list and context windows, runs a reply check, and registers the
provider in `/model` and `/logins`.

## Rent a GPU (Runpod, Vast.ai and Lambda)

1. **Connect a GPU provider.** Paste a Runpod, Vast.ai or Lambda API key into
   the masked field. Mercury verifies the key against the provider's instance
   list and saves it in the credential store (`0600`), never in a settings file
   or URL. Vast.ai and Lambda rentals are new in 1.0.0-beta.40 and verified
   against the vendors' published APIs on fixtures (live rental runs were not
   performed).
2. **Choose a model and GPU shape.** Mercury reads live stock and hourly prices
   for the full shape (every GPU and node in the recipe). Single-node and
   multi-node recipes cover `GLM-5.3-Flash`, `Nemotron 3.5 Super VL 120B`,
   `Qwen3.8-27B`, `DeepSeek-V4.1-Flash-1017`, `GLM-5.3` (FP8 and BF16), `Kimi
   K3`, `Qwen3.8-2.4T-A95B` (FP8 and NVFP4), `DeepSeek V4 Pro`,
   `MiMo-V2.6-Pro-RL` and `Mistral Large 3 675B`. Trillion-parameter recipes
   include multi-node Runpod Instant Clusters and list total hourly compute,
   per-node disk sizes, weight download sizes, estimated download times at 0.5
   to 1 GB/s per node, and model-licence terms.
3. **Tune before renting (optional).** On the rental confirmation screen,
   select **Tune** to pick the quantization, `conversations × context` split
   (calculated against a 12 GB per-GPU engine reserve and the model's documented
   KV cache bytes per token), and default thinking level before creating the
   pod.
4. **Confirm the hourly price.** Nothing is rented until you select the
   confirmation row and press Enter. The confirmation screen shows the time
   estimate for each setup step (engine startup, weight download and model load)
   alongside the vendor's storage and SSH-key terms. The two `llama.cpp` GGUF
   recipes (`GLM-5.3-Flash` and `Nemotron 3.5 Super VL 120B`) use the prebuilt
   CUDA 13 engine image (`ghcr.io/whq02/mercury-llamacpp`) and skip source
   compilation when the image's `llama-server` binary is present.
5. **Background preparation and ready notice.** A detached background worker
   creates or registers the SSH key, provisions the pod or cluster, downloads
   the weights, starts the engine on remote loopback, opens a local SSH tunnel,
   registers the provider (`compat/pod-<id>/<model>`), and checks a reply. If
   you close `/llmhost` with `Esc` or click outside, setup keeps running in the
   background and posts a chat notice when the model is ready (with the `/model
   compat/pod-<id>/<model>` command) or if setup stalls.

### Watch for stock on Runpod

When a model is out of stock on Runpod, select **Watch for stock and rent at
this price or less** (or enter a lower hourly ceiling). A background worker
polls the Runpod catalogue every 5 seconds (12 requests per minute) for up to
12 hours. As soon as a fitting shape appears at or below your ceiling, the
worker creates the pod and starts setup. Active watches are listed under **Pods
I'm paying for** with `$0.00 billed while watching` and a **Cancel** action.

### Fast-load kept weights disks (Runpod)

Open `/llmhost` → `Other roads →` → **Fast-load (keep weights near the GPU)**
to store a model's weights on a Runpod network volume (in a single data centre)
or global volume.

- **Prepare now:** rents the cheapest fitting GPU pod, downloads the pinned
  Hugging Face revision, checks every file's size and SHA-256, writes a sample
  manifest, and terminates the temporary pod.
- **At the next rental:** creates the volume now and downloads the weights the
  next time you rent that model variant.

When you rent a model with a kept weights disk, startup checks file sizes,
modification times, the first and last 64 MB, and eight seeded 1 MB samples per
large file in a few seconds (or runs **Verify fully** on demand) and starts the
engine without downloading the weights again. Volumes bill monthly even when no
pod is running and appear in **Pods I'm paying for** with a delete confirmation.

### Manage or stop paying for a rental

Reopen `/llmhost` and select **Pods I'm paying for** to check running pods,
clusters, Runpod volumes and active stock watches across all connected vendors.
Each row lists the vendor, current setup step or status, hourly rate, elapsed
time and estimated compute spend so far.

- **Tune (Runpod single-node `llama.cpp` pods):** change `conversations ×
  context` or default thinking and reload `llama-server` in place without
  re-downloading weights. If the reload fails, Mercury restores the previous
  launch script.
- **Stop (Runpod and Vast.ai pods):** stops GPU compute billing while keeping
  the pod or container disk. Storage continues to bill while stopped. Lambda
  instances and Runpod clusters cannot be stopped and bill until terminated.
- **Terminate:** deletes the pod, cluster or instance after confirmation and
  checks the vendor's instance list to confirm it is gone. On Runpod pods with
  an attached fast-load disk, Mercury asks whether to keep or delete the weights
  volume. Terminating a pod also removes its model entry from `/model`.
- **Logs and Resume setup:** inspect the vendor log tail or restart a stalled
  setup job.

Stock watches, multi-node clusters, fast-load weights disks and in-place Tune
reloads are supported on Runpod only; choosing them for Vast.ai or Lambda
explains that limit without sending a request.

## Run a model on your own computer: `My computers` and `mercury host`

Open `/llmhost` and choose **My computers** (or `Other roads →` → **One of my
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
weights), and installs a user login service (`launchd` on macOS, `systemd
--user` on Linux, Scheduled Task on Windows) bound to loopback. For remote
computers it also opens a persistent SSH tunnel, and for every computer it
registers `compat/box-<name>/<model>` across all sessions sharing the config
home.

The computer screen and `mercury host status` report the engine, model, busy
slots and last measured token rate. When you stop the service, the model row
stays in `/model` as `box <name> · engine stopped — /llmhost starts it`, so
picking a stopped computer never asks for an API key. `uninstall` removes the
service definition and leaves downloaded weights on disk.

## A box I can reach by SSH

In `/llmhost` → `Other roads →` → **A box I can reach by SSH**, enter a host
and user or an alias from your SSH config. Mercury runs `nvidia-smi` over SSH
and lists the recipes that fit those GPUs. Nothing is installed or started
until you confirm. You can use a local weight folder on that machine or download
weights from Hugging Face into `/workspace`. The engine binds to remote
loopback and Mercury opens a local SSH tunnel.

## A server that's already running

In `/llmhost` → `Other roads →` → **A server that's already running**, connect
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
its API base URL, label, dialect and, for SGLang, `sessionAffinityHeader:
"x-session-id"`, alongside `models["compat/<name>/<model>"].contextWindow` and
supported `efforts`. A `contextWindow` set for that model in user settings
overrides the window reported by the server.

- **Reasoning and `/effort`:** `/effort` lists the reasoning levels the model
  supports (`low`, `high`, `max` on GLM-5.3, GLM-5.3-Flash, DeepSeek V4.1/V4
  Pro and Kimi K3; `low`, `medium`, `xhigh` on Qwen3.8; named thinking values
  from `/api/show` on Ollama). Requests send
  `chat_template_kwargs.reasoning_effort` on `llama.cpp` and top-level
  `reasoning_effort` on `vLLM`, `SGLang`, `Ollama` and `Kimi K3`. If a server
  rejects the effort field with HTTP 400 before streaming any content, Mercury
  retries once without that field and posts a notice.
- **Multi-turn reasoning replay:** SGLang, vLLM, llama.cpp and Kimi K3
  conversations keep assistant `reasoning_content` across tool turns and
  continuations, and SGLang requests set `chat_template_kwargs: {
  clear_thinking: false }`.
- **Slot affinity and prefill liveness:** on `llama.cpp` servers that report
  multiple slots in `GET /props`, each conversation reuses the same `id_slot`
  with `cache_prompt: true`. During long prompt prefills on self-hosted
  servers, Mercury polls server liveness (`GET /slots` on `llama.cpp`;
  `/health`, `/` or `/v1/models` on `vLLM`, `SGLang`, `Ollama` and `LM Studio`)
  instead of timing out after 30 seconds, and streaming tool-call arguments
  keep crewmate activity timers alive.

## A rented pod through a manual SSH tunnel

If you started a model server on a pod yourself with its API bound to remote
loopback, open an SSH tunnel from your terminal:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:30000:127.0.0.1:30000 user@pod.example
```

Leave that connection running, open `/llmhost` → `Other roads →` → **A server
that's already running**, and enter `http://127.0.0.1:30000/v1`.

## Check, change or remove a server

In `/model`, an unreachable keyless endpoint shows `Retry this server →`, and
an unreachable custom endpoint shows `Retry this server →` and `Remove this
endpoint →`. You can also open `/llmhost` → `Other roads →` → **A server
that's already running** and pick a registered server to:

- **Check a reply again:** refresh its model list and run a reply check with
  the saved address and key.
- **Change the address and check it:** run discovery at a new address without
  sending the old stored key, credential command or custom headers.
- **Remove the provider and its stored key:** delete the endpoint and its
  stored key from Mercury while leaving the server running.
