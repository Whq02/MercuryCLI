# Run or connect a model: `/llmhost`

Open `/llmhost` in the foreground chat. Its popup asks **Where should the
model run?** Choose a rented GPU, a box you can reach by SSH, or a server
already running. Each road reads the served models and context windows,
checks a reply, and makes the provider available in `/model` and `/logins`.
You do not need to edit provider settings by hand.

## Rent a GPU (Runpod)

1. **Enter your Runpod key once.** Create it in Runpod console → Settings →
   API Keys, with Pods and Catalog access. The input is masked and uses the
   same credential store as `/logins`, never a settings file or URL.
2. **Choose a model and GPU.** Mercury reads current Secure Cloud stock and
   hourly prices from Runpod. The price covers every GPU in the row, not
   one card. Only documented recipes that fit the available hardware appear.
   GLM-5.3-Flash choices come first, ordered by price; smaller models are
   farther down the list. A community recipe is labelled as such.
3. **Review the cost.** An optional budget shows approximately how many GPU
   hours it buys. This estimate does not set a spending limit or read the
   account balance. Storage is extra, and loading time is billed too.
4. **Confirm the hourly price.** Nothing is rented until you select the
   separate confirmation row and press Enter. If stock or price changes,
   choose and confirm again.
5. **Watch preparation.** Mercury creates a private SSH key, gives the pod
   its public key, creates the pod, downloads weights and starts the engine.
   It then opens an SSH tunnel and checks the model API. Downloading,
   building and loading can take 20–90 minutes or longer; the meter starts
   when the pod starts and continues while the model loads.
6. **Pick the served model and name the provider.** Confirm the reply check,
   then choose `compat/llmhost/<model>` in `/model`.

The **llama.cpp (GGUF)** Flash choice uses the published UD-Q4_K_XL weights
and builds the documented llama.cpp version. Its single-B300 fit is based
on the published memory requirement. GPU throughput has not been measured.
The SGLang four-B200 community choice states its 524,288-token context.
The actual served window is read from the running server before registration.

### Stop paying for a pod

The meter shows hourly rate × elapsed time as an estimate; consult Runpod
for the invoice. **Pods I’m paying for** is read from the account whenever
you reopen `/llmhost`, including pods created elsewhere.

- **Stop:** a separate confirmation releases compute but keeps the pod's
  volume disk. Storage continues to bill while stopped.
- **Terminate:** a separate confirmation deletes the pod and its volume
  disk. Copy out anything you need first.
- **Reconnect:** for a running pod prepared here, rebuild the private tunnel
  and check the saved provider after restarting Mercury.

During preparation, Escape opens the pod controls. Closing the popup or
quitting Mercury never silently stops or terminates a pod. The remote
engine keeps running, and its charges continue until you stop or terminate
it. After a failed preparation, the pod remains named in the controls so
that you can inspect it or end the rental.

## A box I can reach by SSH

Enter a host and user, or an alias from your SSH configuration. A blank user,
port or key path uses the SSH configuration or agent. Mercury reads
`nvidia-smi` and lists recipes for the GPUs it finds.

Confirm before installing or starting anything. The SSH user needs a
writable `/workspace` and enough free storage for the selected recipe.
Mercury uses `tmux` and `curl`, installing them on root-accessible systems
with `apt-get` when missing. A usable GPU container runtime runs the recipe's
image; otherwise recipes with a documented Python install use an isolated
Python environment. Preview-image recipes require that container runtime.

Leave the bank field blank to download from Hugging Face, or name a complete
local folder for the selected model. A local copy uses `rsync` over SSH;
missing shards are refused. The engine stays on the box's loopback interface,
and Mercury owns the local SSH tunnel. The final row names the remote tmux
session. Closing Mercury closes the tunnel. The remote session and any
hardware rental arranged outside Mercury keep running.

## A server that’s already running

Give a local endpoint, a direct HTTPS address, or the loopback address of an
SSH tunnel you already opened. Nothing is installed or rented on this road.

### Connection steps

1. **The server address.** Enter the OpenAI-compatible API base, such as
   `http://127.0.0.1:30000/v1`. A bare server address gets `/v1` appended;
   include the full base path when using a reverse proxy. Mercury contacts
   only the address you give.
2. **The server dialect.** Mercury looks for SGLang, vLLM, llama.cpp or Ollama
   metadata. Confirm the detected dialect, or choose SGLang, vLLM, llama.cpp,
   Ollama, LM Studio, chat completions or Responses. If the server does not
   identify itself, you choose the dialect explicitly.
3. **The key.** A server that requires authentication asks for a masked key
   before discovery can finish. Otherwise, leave the key field blank or give
   the key needed for replies. It stays in memory until you confirm
   registration; it is never written into a settings file.
4. **The model.** Pick a model from the server's list. Each row shows the
   served window when stated, for example `1,048,576 tokens · served window`.
   An unstated window says so; Mercury does not infer it from a model name.
   Nothing is pre-chosen: use the arrow keys, then Enter.
5. **Name, register and check.** Choose a provider name, default `llmhost`,
   using lowercase letters, digits or hyphens. Confirm saving the endpoint
   and requesting one short reply. The popup shows the answer, elapsed time
   and, when returned by the server, output tokens and whole-turn tokens/s.
6. **Use the provider.** `/model` lists `compat/llmhost/<model>` and `/logins`
   has the provider's key row immediately. Registration leaves the current
   session model unchanged; choose the new model when you want to use it.

On the existing-server road, Escape stops the current operation. Before
registration, nothing is saved.
After registration, the provider stays saved even if you stop the reply check
or the server refuses it. A failed check remains marked as failed.

## What Mercury saves

The endpoint lives under `compatProvider.<name>` in user settings: its API
base, label, dialect and, for SGLang, `sessionAffinityHeader: "x-session-id"`.
The model list and served windows are refreshed from the server. An explicit
per-model `contextWindow` setting takes precedence over the server's reading.

A supplied key uses the same auth-scoped credential store as `/logins`.
`MERCURY_COMPAT_<NAME>_API_KEY` takes precedence when set; for a hyphenated
name, the environment name uses underscores. A conflicting environment pin
must be cleared before changing that endpoint's address or key.

SGLang, vLLM and llama.cpp requests retain assistant reasoning across tool turns.
SGLang requests also send `chat_template_kwargs: { clear_thinking: false }`.
For SGLang's cache-aware router, configure the router to use `x-session-id`;
Mercury sends the session identity in that header but does not configure the
router. These settings do not guarantee a particular cache hit rate or speed.

## A rented pod through an SSH tunnel

Start the model server on the pod using its documented recipe. Keep its API
bound to the pod's loopback interface, then open a tunnel from your terminal:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:30000:127.0.0.1:30000 user@pod.example
```

Leave that connection running. In Mercury, open `/llmhost` and enter
`http://127.0.0.1:30000/v1`. Choose the served model, name the provider and
confirm the reply check. If port 30000 is already in use locally, change the
first port in the tunnel and use that port in `/llmhost`.

For a direct remote address, use HTTPS. An SSH tunnel protects traffic to a
pod without publishing its model API on the internet. Any server key is still
entered in the masked key field, never embedded in the URL.

## Check, change or remove a server

Open `/llmhost`, choose **A server that’s already running**, then choose a
registered server to:

- **Check a reply again:** refresh its models and check a selected model with
  the saved endpoint and credential.
- **Change the address and check it:** repeat discovery at the new address.
  The old stored key, credential command and extra headers are not sent to
  that address; provide the new server's key if needed.
- **Remove the provider and its stored key:** confirm removal from Mercury.
  The server keeps running, and environment variables are not changed.

A reply check reports one request's duration and token count. Use the model
server's metrics for sustained GPU throughput. For rented hardware, read the
rental provider's dashboard for elapsed rental time, storage charges and
the bill.
