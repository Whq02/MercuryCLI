# Local models: `/localsetup`

`/localsetup` can pull a GGUF from Hugging Face or start one already in the
Bank. It also sets up Ollama and connects to running servers. Nothing is
selected for you. Use the arrow keys and Enter to choose; Escape keeps your
current model.

## Pull a GGUF from Hugging Face

Choose **Hugging Face** and enter a repository id such as `author/model-GGUF`.
You can also open the file list directly with `/localsetup author/model-GGUF`.

The list shows each complete GGUF quantisation, its download size and the
projected memory for its context window. Split GGUF files appear as one choice.
The window is the largest fitting 32k, 64k, 128k or 256k rung, never above the
model's trained maximum. The calculation uses the GGUF header's attention
geometry and includes the vision projector's weights. A file without enough
header information to calculate memory cannot be started through this dialog.

Choose the file you want. If the repository has one `mmproj` vision projector,
it accompanies the model; if it has several, choose one from the next list.
The pull asks before downloading and shows the combined size and Bank folder.
The Bank uses the configured folder or an existing model-bank folder; otherwise
it creates `~/mercury-model-bank` after you accept the pull.

Downloads use the Bank's Hugging Face downloader, pinned to the repository
revision and selected files. Interrupted downloads remain in the Bank and
resume on the next pull. File sizes and hashes must match the repository
manifest before the model starts. Gated repositories use your Hugging Face
sign-in from `/logins huggingface`; accept the repository's access terms first.

The next question shows the llama-server command and its memory requirement.
Mercury uses its locally built llama.cpp engine when present, then
`llama-server` on PATH or Homebrew. If none is installed, install llama.cpp and
open `/localsetup` again; on macOS, `brew install llama.cpp` supplies it.
Models carrying NextN/MTP tensors start with `--spec-type draft-mtp` so those
weights are loaded too. An engine without that support needs updating.

The server listens only on `127.0.0.1:8080`. An occupied port is not replaced.
Available memory is checked again immediately before loading; free memory and
retry if other applications leave too little room.

After the server answers with the selected model and window, Enter selects
`local/<GGUF filename without .gguf>` and requests a short reply. The server
remains running as the `local-gguf` project service, available to later Mercury
sessions. The **Service** tool can inspect its logs or stop it. Escape or a
failure before setup finishes stops only the server this dialog started.
Existing servers keep running. Downloads stay in the Bank.

## Use the Bank

Choose **Bank** to list GGUF models registered by Bank downloads. Pick a model,
then accept the server command. The files are hashed again before starting;
no download is needed. `/llmhost` uses the same Bank.

## Use Ollama or a running server

Choose **Ollama / running server** to use the existing server setup:

- Discover Ollama, LM Studio, vLLM or llama.cpp. An existing compatible server
  can supply a model without installing anything.
- If needed, find or install Ollama, then start it. Each command asks first;
  commands needing administrator access say so.
- Choose an installed model or a listed Ollama pull. Sizes and memory fit are
  shown before the pull; its progress updates in the dialog.
- Set the chosen model's window from its cache geometry and available model
  memory, then select it and request a short reply.

The window setting is the same one used by `/config` → Local model window and
the model picker's `w` key. Ollama retains its own model store and server
settings. A server started through the Ollama path remains running after the
dialog closes.

`MERCURY_LOCAL_PROBE_TARGETS` controls discovery; `none` disables it. A custom
probe list must include the GGUF server to rediscover it after setup. Without
a custom list, Mercury remembers servers started by the GGUF dialog. Discovery
shows a model only while its server answers.
