# Connect a model server: `/llmhost`

`/llmhost` connects Mercury to a model server you already run: a GPU server,
a rented pod reached through an SSH tunnel, or a local OpenAI-compatible
endpoint. It reads the models and their served context windows, checks a
reply, and makes the server available in `/model` and `/logins`. You do not
need to edit provider settings by hand.

Open `/llmhost` in the foreground chat. It has its own popup, separate from
`/localsetup`. It does not install an engine, download weights, start a server
or rent hardware.

## The steps

1. **The server address.** Enter the OpenAI-compatible API base, such as
   `http://127.0.0.1:30000/v1`. A bare server address gets `/v1` appended;
   include the full base path when using a reverse proxy. Mercury reads only
   the address you give, not a list of nearby servers.
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

Escape stops the current operation. Before registration, nothing is saved.
After registration, the provider stays saved even if you stop the reply check
or the server refuses it. A failed check is shown as a failure, not readiness.

## What Mercury saves

The endpoint lives under `compatProvider.<name>` in user settings: its API
base, label, dialect and, for SGLang, `sessionAffinityHeader: "x-session-id"`.
The model list and served windows are refreshed from the server rather than
written as fixed limits. An explicit per-model `contextWindow` setting takes
precedence over the server's reading.

A supplied key uses the same auth-scoped credential store as `/logins`.
`MERCURY_COMPAT_<NAME>_API_KEY` takes precedence when set; for a hyphenated
name, the environment name uses underscores. A conflicting environment pin
must be cleared before changing that endpoint's address or key.

SGLang and vLLM requests retain assistant reasoning across tool turns.
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

Open `/llmhost` again to see registered servers. Choose one to:

- **Check a reply again:** refresh its models and check a selected model with
  the saved endpoint and credential.
- **Change the address and check it:** repeat discovery at the new address.
  The old stored key, credential command and extra headers are not sent to
  that address; provide the new server's key if needed.
- **Remove the provider and its stored key:** confirm removal from Mercury.
  The server keeps running, and environment variables are not changed.

A reply check measures one request, not sustained GPU throughput. For rented
hardware, read the rental provider's dashboard for elapsed rental time,
storage charges and the bill; the model server's token counts are not a
measurement of those charges.
