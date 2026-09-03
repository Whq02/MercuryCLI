# Voice input

Voice input is dictation into the composer: you speak, the words land in the
composer with the cursor at the end, and you edit or send them as you would
anything you typed. Mercury never speaks aloud; the only road out of a voice
capture is the composer.

## The keys

- `/speak on` turns voice input on for this machine; `/speak off` turns it
  off (the default); bare `/speak` shows the status, the capture backend and
  the transcribing sign-in the next take would use.
- With voice input on, press `v` in an empty composer to start a capture.
  A terminal sees no key-up, so a capture is press-to-start, press-to-stop:
  press `v` again to stop it and send the take to the transcriber, or press
  `esc` to cancel it (nothing leaves the machine). With voice input off,
  `v` is the letter v.
- `/voice` is the same action as pressing `v`: start a capture, or stop
  the one running.
- The footer says `● recording · v or esc to stop` while a take runs and
  `transcribing…` while it is in flight. Every refusal is a receipt with
  its reason: no backend, no transcribing sign-in, a microphone that could
  not be opened, a take that carried only silence, a transcriber that
  answered with an error.
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
3. **No backend**: pressing `v` answers the receipt "no microphone backend",
   naming the remedy that fits the install: on a source checkout the pack
   build (`bun run setup`) or a recorder on PATH; on a release install — no
   checkout to build from — a recorder on PATH (ffmpeg or sox), with the
   platform's install command.

On macOS the first capture makes the operating system ask whether your
terminal app may use the microphone. A denied permission does not crash a
capture; the take arrives as silence, and the receipt names System Settings
→ Privacy & Security → Microphone.

## The transcribers

A finished take goes to the most recent sign-in that offers speech-to-text,
in the order of the sign-in ledger (the same order that picks the default
model):

- **OpenAI**, through an API key: the transcription endpoint, with the
  newer transcription model first and the classic one as the fallback. A
  ChatGPT subscription sign-in does not transcribe; it speaks the
  subscription backend, not the API.
- **Gemini**, through an API key: a generate-content request with the
  audio inline and a verbatim-transcript instruction. The Google account
  sign-in does not transcribe here.
- **Anthropic** offers no speech-to-text endpoint.

With no transcribing sign-in, pressing `v` answers "no sign-in transcribes
yet — /logins openai (API key) or /logins gemini" before any audio is
captured. On-device transcription is a possible follow-up; it is not part of
this release.

## The privacy line

Audio leaves the machine only to the family you signed into, and only after
you stop a take. Nothing is sent while you speak; a cancelled take is
dropped without a request; nothing is written to disk. The doctor's
INTERFACE section carries a `Voice input` row naming the backend, the
transcriber and the permission words for this machine.
