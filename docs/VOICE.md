# Voice input

Voice input is on-device dictation into the composer. Speak, then edit or send
the transcript as you would typed text. Mercury does not speak aloud, and voice
audio never leaves the machine.

## Turn voice on or off

- `/voice on` prepares Whisper and turns dictation on. The first use downloads
  the default English speech model, `base.en-q5_1` (60 MB, MIT), into
  `<config-home>/models/whisper`. Mercury checks the file's byte count and
  SHA-256 digest before installing it, and reuses the verified file on later
  runs.
- `/voice off` turns dictation off. The setting survives a restart; voice input
  is off by default.
- While voice input is on, bare `/voice` (or `/voice capture`) starts or stops
  a take. While off, bare `/voice` reports that voice input is off and points to
  `/voice on`.

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

If a build has no Whisper driver, `/voice on` refuses and prints the platform
and the manifest remedy. In a source checkout, run
`bun run scripts/vendor/build-whisper.ts` (requires Rust and cmake) and rebuild
Mercury.
A failed model download does not enable voice and removes the partial file; retry
`/voice on` after resolving the reported error.

`MERCURY_WHISPER_MODEL` selects another model from the catalogue or a ggml file
already on disk. The catalogue includes `tiny.en-q5_1`, `small.en-q5_1`, and the
multilingual `base-q5_1`. With a catalogue model selected, `/voice on` downloads
that model if needed and names its size. The catalogue's sizes and digests are
in `vendor/whisper-models.lock.json`.

## Microphone and privacy

Capture uses Mercury's native voice driver when available, or an installed
`sox`, `arecord` (Linux) or `ffmpeg`. If no capture backend is found, the error
message shows how to install one. On macOS the terminal needs
microphone permission in System Settings → Privacy & Security → Microphone.
Windows controls it in Settings → Privacy & security → Microphone.

Audio stays in memory during capture and decoding. Cancelling drops the take.
Set `MERCURY_VOICE_DEBUG_WAV_DIR` to save debug WAV files; `/health` lists that
directory when set, along with the capture backend, Whisper driver, speech
model, CPU floor and microphone permission status.
