# Voice input

Voice input is on-device dictation into the composer. Speak, then edit or send
the transcript as you would typed text. Mercury does not speak aloud, and voice
audio never leaves the machine.

## Turn voice on or off

- `/voice on` prepares Whisper and turns dictation on. The first use downloads
  the default English speech model, `base.en-q5_1` (60 MB, MIT), into
  `<config-home>/models/whisper`. The download verifies the byte count and SHA-256
  digest before installing the file. Later uses reuse the verified model.
- `/voice off` turns dictation off. The setting survives a restart; voice input
  is off by default.
- While voice input is on, bare `/voice` starts a capture or stops the running
  capture. `/voice capture` does the same. While off, bare `/voice` says that
  voice input is off and names `/voice on`.

## Dictate

Hold space for 1 s to speak, release it to stop, or press `esc` to cancel.
The transcript lands at the end of the draft, separated from existing words by
one space. A single space press types normally; a shorter hold types the spaces
it held back. With voice off, space is a space.

A terminal reports a hold through key repeat. Keep other keys still while
holding space. If key repeat is off, use `/voice` to start and stop without
holding a key. The footer shows `recording` during a take and `transcribing…`
while Whisper decodes it. A take stops automatically after five minutes.

## Whisper and speech models

The release archive carries the Whisper driver for its platform, including
Windows ARM64. The speech model downloads separately on first use. Whisper runs
on the CPU, or uses Metal on Apple silicon. The x86-64 driver requires AVX2, FMA
and F16C. An unsupported CPU or a driver that cannot load is reported with its
reason; voice does not switch to a remote service.

A build without the driver refuses `/voice on`, naming the platform and the
remedy recorded in its manifest. Source builds prepare it with
`bun run scripts/vendor/build-whisper.ts` (Rust and cmake), then rebuild Mercury.
A failed model download does not enable voice and removes the partial file; retry
`/voice on` after resolving the reported error.

`MERCURY_WHISPER_MODEL` selects another model from the catalogue or a ggml file
already on disk. The catalogue includes `tiny.en-q5_1`, `small.en-q5_1`, and the
multilingual `base-q5_1`. With a catalogue model selected, `/voice on` downloads
that model if needed and names its size. The catalogue's sizes and digests are
in `vendor/whisper-models.lock.json`.

## Microphone and privacy

Capture uses Mercury's native voice driver when available, otherwise an
installed `sox`, `arecord` (Linux), or `ffmpeg`. Without a capture backend, the
receipt names the remedy for the installation. On macOS the terminal needs
microphone permission in System Settings → Privacy & Security → Microphone.
Windows controls it in Settings → Privacy & security → Microphone.

Audio stays in memory during capture and decoding. Cancelling drops the take.
`MERCURY_VOICE_DEBUG_WAV_DIR` explicitly saves debug copies; the health check
names the directory when enabled. `/health` also reports the capture backend,
Whisper driver, model, CPU floor, and microphone permission information.
