# Voice input

Voice input is dictation into the composer: you speak, the words land in the
composer with the cursor at the end, and you edit or send them as you would
anything you typed. Mercury never speaks aloud; the only road out of a voice
capture is the composer.

## The keys

- `/speak on` turns voice input on for this machine; `/speak off` turns it
  off (the default); bare `/speak` shows the status, the transcriber the
  next take would use and your default, the capture backend.
  `/speak options` chooses the transcriber; `/speak download` fetches the
  on-device model.
- With voice input on, press space in an empty composer to start a capture.
  A terminal sees no key-up, so a capture is press-to-start, press-to-stop:
  press space again to stop it and send the take to the transcriber, or
  press `esc` to cancel it (nothing leaves the machine). With voice input
  off, space is a space.
- `/voice` is the same action as pressing space: start a capture, or stop
  the one running.
- The footer says `● recording · space or esc to stop` while a take runs and
  `transcribing…` while it is in flight. Every refusal is a receipt with
  its reason: no backend, nothing to transcribe with, a microphone that
  could not be opened, a take that carried only silence, a transcriber
  that answered with an error.
- A take is bounded at five minutes; at the bound Mercury stops it, says
  so, and transcribes what it has.

## The capture backends

A take is 16 kHz mono 16-bit audio held in memory. It is never written to
disk unless the debug directory in the flag registry
(`src/substrate/flagRegistry.ts`, `MERCURY_VOICE_DEBUG_WAV_DIR`) asks for a
copy. The backend is chosen in this order; `/speak` and the doctor name the
one that is live:

1. **The voice pack**: Mercury's own native addon over the platform's audio
   layer (CoreAudio on macOS, WASAPI on Windows, ALSA on Linux), built from
   the repository's `native/voice` sources with cargo by
   `bun run scripts/vendor/build-voice.ts`, which `bun run setup` runs last.
   It is built rather than fetched: a machine without a Rust toolchain
   builds and runs Mercury without it, and the build and the doctor say so.
   Release archives carry the pack for their platform when the packaging
   host could build it.
2. **A recorder already on PATH**: `sox`, `arecord` (Linux) or `ffmpeg`.
   These are used only when you have installed them yourself; Mercury never
   vendors them.
3. **No backend**: pressing space answers the receipt "no microphone backend",
   naming the remedy that fits the install: on a source checkout the pack
   build (`bun run setup`) or a recorder on PATH; on a release install — no
   checkout to build from — a recorder on PATH (ffmpeg or sox), with the
   platform's install command.

On macOS the first capture makes the operating system ask whether your
terminal app may use the microphone. A denied permission does not crash a
capture; the take arrives as silence, and the receipt names System Settings
→ Privacy & Security → Microphone.

## The transcribers

A finished take goes to the first transcriber that can serve, in this order:

1. **On this machine.** Mercury's own on-device transcriber: whisper.cpp,
   built from the repository's `native/whisper` sources into a pack beside
   the bundle by `bun run scripts/vendor/build-whisper.ts` (which
   `bun run setup` runs; it needs cargo and cmake), with a Whisper speech
   model in the config home. Nothing leaves the machine. The model is a
   one-time download: with the pack present and no model, `/speak on` and
   bare `/speak` name the door — a 60 MB download, Whisper base.en
   (English, MIT) into `<config-home>/models/whisper` — and
   `/speak download` fetches it from the pinned address, verifying the size
   and the digest before the file takes its name; until then a cloud
   family serves. The other models — `tiny.en-q5_1` (smaller, faster, less
   accurate), `small.en-q5_1` (more accurate, three times the size) and the
   multilingual `base-q5_1` for speech that is not English — are listed in
   `vendor/whisper-models.lock.json`; `/speak download <name>` fetches one,
   and `MERCURY_WHISPER_MODEL` picks it for a session, by name or by the
   path of a ggml file. Release archives carry the pack for their platform
   when the packaging host could build it. The x86-64 pack is compiled for
   CPUs with AVX2, FMA and F16C (every desktop CPU since 2013); a machine
   below that floor is told so and served by a cloud family.
2. **A signed-in family with a speech-to-text endpoint**, in the order of
   the sign-in ledger (the same order that picks the default model):
   - **OpenAI**, through an API key: the transcription endpoint, with the
     newer transcription model first and the classic one as the fallback. A
     ChatGPT subscription sign-in does not transcribe; it speaks the
     subscription backend, not the API.
   - **Gemini**, through an API key: a generate-content request with the
     audio inline and a verbatim-transcript instruction. The Google account
     sign-in does not transcribe here.
   - **Anthropic** offers no speech-to-text endpoint.

`/speak options` lists the transcribers this install can use — the
on-device one with its model and pack, and each family with a
speech-to-text slot, signed in or not — marks the one that would serve now,
and `/speak options <name>` (`on-device`, `openai`, `gemini`) makes one
your default: the choice is saved in the config home and survives a
restart; `/speak options default` restores the shipped default. A saved
choice that cannot serve — a family no longer signed in, a pack or model
gone — is named in `/speak`, in the recording receipt and in the doctor
row, and the shipped default serves; nothing is replaced silently.

`MERCURY_VOICE_TRANSCRIBER` overrides the saved choice for one session:
`on-device`, `cloud` (the ledger walk), or a family id such as `openai`; a
pin that cannot serve says so in the receipt, in `/speak` and in the doctor
row, and never falls back silently. With nothing to transcribe with, pressing space
answers "nothing transcribes yet — <the on-device reason>; or /logins openai
(API key) or /logins gemini" before any audio is captured. The doctor's
`Voice input` row names the engine, the model and the pack, the families
signed in but not used, and the cost: about 80 MB more memory while the
default model is loaded, and every core for a moment per take.

## The privacy line

With the on-device transcriber, audio never leaves the machine: the take is
decoded here, and nothing is written to disk. With a cloud family, audio
leaves the machine only to that family, and only after you stop a take.
Nothing is sent while you speak; a cancelled take is dropped without a
request. The doctor's INTERFACE section carries a `Voice input` row naming
the backend, the transcriber and the permission words for this machine.
