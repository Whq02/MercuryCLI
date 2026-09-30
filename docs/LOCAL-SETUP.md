# Local model set-up: `/localsetup`

`/localsetup` sets up a local model from inside Mercury. It finds Ollama on
this machine or offers to install it, starts the server, asks which model —
every model the server already has, and every Qwen 3.5 size it can pull that
fits this machine's memory — pulls the chosen one when the server does not
have it, sets that model's window from this machine's memory, and ends with
the model picked and a reply proven. Every step says what it will run and
asks before it runs it; nothing runs before you press Enter on that step, and
`esc` stops the road at any point and says what is done and what is not. The
choice pre-ticks nothing: `esc` on the model list keeps the model the session
is on.

LM Studio, vLLM and llama.cpp keep working: when one of them already answers
and Ollama does not list a model, the road ends on that server's model and
installs or starts nothing.

## Where it is offered

When discovery finds no local server, one line names the road on every surface
that names local models: the model picker's LOCAL section (`no local server · s
sets one up` — `s` opens the dialog there), the Boot face's local line, the
`/config` Local account row and the `/usage` popup's local block (`no sign-in —
start a local server, or /localsetup sets one up`), and the refusal a request
for an undiscovered `local/<model>` gets. Everywhere else the command is
`/localsetup`.

## The dialog

The road runs as a stepwise dialog in the same floating window every other
pop-up uses. Each step shows three lines:

1. what it found;
2. what it **will run** — the exact command or HTTP request, verbatim, on one
   line (a long line is clipped in its cell, never wrapped into a neighbour);
3. the keys: `↵ run · s skip · esc stop`.

The model step shows a list instead of a will-run line: one row per model,
then its own keys, `↑↓ choose · ↵ pick · esc keeps <the session's model>`.

A step that ran shows its result under it (the exit code and the last line of
its output, or the request's answer) and the dialog moves to the next step. A
`sudo` inside a command is said in the words before Enter. `s` skips a step
that can be skipped (a pull of a model that already exists). `esc` leaves
everything as it stands.

## The steps

1. **Find a server.** The four local servers are probed (Ollama, LM Studio,
   vLLM, llama.cpp; `MERCURY_LOCAL_PROBE_TARGETS` is honoured). Ollama
   answering — with models or with none — jumps to step 4. LM Studio, vLLM or
   llama.cpp answering with a model, while Ollama lists none, ends the road at
   step 6 with that server's model. Nothing answering goes on to step 2.
2. **Find Ollama on this machine.** In order: `ollama` on PATH, the app
   (`/Applications/Ollama.app`, `~/Applications/Ollama.app`), Homebrew (`brew
   list --formula ollama` when `brew` exists), the Linux service (`systemctl
   status ollama`, `/usr/local/bin/ollama`), the Windows app
   (`%LOCALAPPDATA%\Programs\Ollama\ollama app.exe`, `ollama` on PATH). Found
   means step 3; not found means the install offer.
   - **Offer the install** — the documented road for this system, from
     ollama.com/download. macOS: `brew install ollama` when Homebrew is
     present (no drag-to-Applications step), otherwise the app download
     (`curl -fsSL -o ~/Downloads/Ollama.dmg https://ollama.com/download/Ollama.dmg`,
     then `open ~/Downloads/Ollama.dmg`). Linux: `curl -fsSL
     https://ollama.com/install.sh | sh` (it needs `sudo` for the service, and
     the step says so). Windows: `https://ollama.com/download/OllamaSetup.exe`,
     downloaded then started (`start OllamaSetup.exe`); the dialog waits for
     the binary to appear.
3. **Start the server.** macOS app: `open -a Ollama`; Homebrew: `brew
   services start ollama` (falling back to `ollama serve` detached, with its
   log under the config home, when `brew services` is absent); Linux:
   `systemctl start ollama` (sudo said) or `ollama serve` detached; Windows:
   `start "" "ollama app.exe"`. The step then waits for `GET /api/version`,
   bounded at 60 seconds, and the row counts. The server's environment is not
   touched here: the Local Server page owns the knobs.
4. **Choose the model.** The list has two parts. First, every model the server
   already has (`GET /api/tags`), each with its size and trained window
   (`qwen3.5:27b · on the server · 17.0 GB · trained 256k`); the model the
   session is on is marked `current`. Then what the server can pull: the
   Qwen 3.5 family as ollama.com/library/qwen3.5 lists it — 0.8b, 2b, 4b, 9b,
   27b, 35b, 122b — each sized against this machine by the same fit rule the
   window step uses (the published weights plus the KV cache at the trained
   maximum against the memory usable for models): `pull 17 GB · fits · 256k`,
   `pull 6.6 GB · fits · 128k`, or `pull 81 GB · does not fit`. A size the
   server already lists is not offered twice. When no local model is set up
   yet, the tested `qwen3.5:9b` row says so (`the tested one`) — a suggestion,
   never a choice made for you. No row is pre-chosen: `↑↓` moves onto a row,
   `↵` picks it, and `esc` keeps the model the session is on and ends the road
   (`the model stays local/qwen3.5:27b`). The rest of the road runs for the
   chosen model.
   - **Pull it** when the server does not list it: `POST /api/pull
     {"model":"<tag>","stream":true}` through the API, no terminal, its
     progress rows (`pulling manifest`, `pulling <digest> 12%`, `verifying
     sha256 digest`, `writing manifest`, `success`) drawn as one line that
     updates in place. The library size is said before Enter and the exact
     size shows with the first row; `s` skips the pull (the window step then
     ends the road, since the tag is not listed).
5. **Set the window from this machine's memory.** The machine's memory, the
   chosen model's KV geometry (`POST /api/show`) and the projected load decide
   the largest of 32k · 64k · 128k · 256k — never above the trained maximum —
   that fits within the usable ceiling, and the figures are said (`256k ·
   15.8 GiB weights + 16.0 GiB cache of 36.9 GiB usable (48.0 GiB box)`). The
   choice is written as the per-model window setting for `local/<tag>`, the
   same setting the picker's `w` row and `/config` → Local model window write.
   On a machine under 16 GiB of memory, a window picked there by hand that
   fits but leaves little room (under a tenth of the usable memory, or under
   1 GiB) is warned beside the pick with the biggest smaller window that
   leaves room — `64k leaves 0.2 GiB of 6.0 GiB usable (8.0 GiB box) · 32k
   leaves 1.2 GiB` — while auto stays the biggest window that fits.
   Nothing is written to the server's environment.
6. **Pick and prove.** The session's model is set to `local/<tag>` (or the
   found server's model) through the same road `/model <id>` takes — a model
   the session is already on settles as a no-op — then one bounded turn
   (`reply with the single word ready`) runs on the native `/api/chat` road
   and the dialog shows the reply's first line with its timings: the load, and
   the ingest at the measured pace. The last row reads `ready ·
   local/qwen3.5:27b · 256k window · reply in 41 s · esc closes`.

## What it never does

It never reads or writes the server's environment (`OLLAMA_*`), never starts a
second server beside one that answers, never installs over LM Studio, vLLM or
llama.cpp, never chooses a model for you, and never runs a command you did not
press Enter on. Every command it runs is the one the will-run line showed.

## What it leaves behind

The server runs on after Mercury exits, started the way this system runs it:
the app, the Homebrew service, the systemd service, or a detached `ollama
serve` whose output goes to `local-setup/ollama-serve.log` under the config
home. The model lives in Ollama's own store, where `ollama list` shows it.
Under Mercury's config home the road writes two settings and nothing else: the
per-model window for the chosen `local/<tag>` (the one `/config` → Local model
window and the picker's `w` row read back) and the session's saved model. A
second `/localsetup` finds the server answering and goes straight to the
choice, with the session's model marked current; `MERCURY_LOCAL_PROBE_TARGETS`
points the road at a server on another host or port.
