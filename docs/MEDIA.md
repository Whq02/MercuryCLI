# Local images and video

Mercury includes a local image and video extension, off by default. Generation
uses `stable-diffusion.cpp` on your computer. Enabling the extension does not
download a runtime or model weights.

## Turn it on

Open `/config`, search for **Local media**, switch it on and press Enter to
save. The extension connects in the current session. Turn it off the same way.
`/extensions` lists `mercury-media`; its off row points to `/config`.

Open `/imagesetup` to install the runtime and choose models. The bundled runtime
is for Apple Silicon macOS. Video posters need `ffmpeg` on PATH.

## Set up a model

The screen lists the runtime and models, installed files, disk space, memory,
licences and available image timings. Shared components count once in a pull.

- **↑↓** selects the runtime or a model.
- **p** opens a download card showing the size, destination, source and licence.
  **y** downloads; **n** goes back. Downloads resume and check SHA-256.
- **d** makes the selected model the default for its image or video slot.
- **t** generates a 256×256 test image with the selected image model. It uses
  the normal tool permission card, then displays the image and its saved path.
- **esc** pauses a download, cancels a test, returns from an image preview, or
  closes the screen. A paused download keeps its partial file; **p** resumes it.

The fit calculation reserves 8 GiB for the operating system and other work. It
compares the model's memory requirement with total memory and its active
components with memory usable by the local accelerator. Image size, video
length and other applications affect available memory.

## Default slots

There is one image slot and one video slot. Initially they name
`z-image-turbo` and `wan22-ti2v-5b`. `/config` has catalogue pickers for both;
`/imagesetup` uses the same slots.

An omitted `model` uses the slot. Asking for a particular model selects that
model for the call without changing the slot. For example:

- “Generate an image of a lighthouse at dusk.”
- “Use FLUX.2 Klein 4B to edit this reference image.”
- “Make Wan 2.2 my default video model.”
- “Generate a short video with MiniMax-H3.”

The generation permission card names the model, dimensions, steps and output
folder. Model licences still apply when you select a different model.

## Storage and settings

The default storage folder is `~/.mercury/media`, under Mercury's configuration
home. Change **Media folder** in `/config` to use another absolute path.
Changing the folder does not move existing weights.

Mercury settings contain `media.enabled` and `media.root`. For development,
`media.serverPath` in user settings selects a built `server.js` instead of the
bundled server; its companion config, setup and catalogue files must be present.

The slot values live only in `<media.root>/config.json`, as `imageModel` and
`videoModel`. The `/config` row ids `media.imageModel` and `media.videoModel`
refer to that file. Do not put them in Mercury's settings file; `/health`
points to their storage location if you do.

The media config also accepts `outputs`, `logs`, `jobCap`, `ports`, `nice` and
`deadlines`. `outputs` and `logs` may be relative to the media folder. A
`jobCap` of `0` has no job limit. Image and video ports default to `0` for
automatic selection. The default process priority is `nice: 10`.

Mercury passes `MEDIA_ROOT` to the server. Explicit `MEDIA_IMAGE_MODEL` and
`MEDIA_VIDEO_MODEL` environment variables override the file's slots. Mercury
does not set those overrides when you choose a default.

Generated files normally go into the project's `media/` folder. An `outputs`
setting selects another destination; `MEDIA_OUTPUT_DIR` overrides that setting.
Without a project or configured output folder, the server uses
`~/Desktop/mercury-media`.

## Bundled catalogue

Disk sizes include each model's components. The memory column uses peak memory
where available; otherwise it uses the catalogue's resident size or a
weights-plus-workspace estimate. The screen reads these figures from the
catalogue. Disk uses decimal GB; memory uses GiB.

| Model id | Kind | Disk | Memory | Licence |
| --- | --- | ---: | ---: | --- |
| `z-image-turbo` | Image | 11.19 GB | 16.37 GiB | Apache-2.0 |
| `flux2-klein-4b` | Image and reference editing | 8.92 GB | 11.32 GiB | Apache-2.0 |
| `qwen-image-21-turbo` | Image and reference editing | 14.10 GB | 18.67 GiB | Qwen Research License, non-commercial |
| `qwen-image-21` | Image and reference editing | 14.10 GB | 18.83 GiB | Qwen Research License, non-commercial |
| `wan22-ti2v-5b` | Video | 12.85 GB | 15.90 GiB | Apache-2.0 |
| `minimax-h3-fl2va` | Video | 35.45 GB | 33.02 GiB | MiniMax H3 Community |

Z-Image and Klein share the Qwen3 encoder. The two Qwen-Image models share
their encoder, vision projection and VAE. The pull card shows only the
components still needed.

Apache-2.0 permits personal and commercial use with its licence and notice
requirements. Qwen Research weights are for non-commercial use. MiniMax H3's
community licence excludes the US, EU, UK and South Korea without a separate
licence. In its applicable territories, commercial use up to US$20 million in
yearly revenue requires displaying “MiniMax H3”; higher revenue requires
written authorisation. Read the publishers' terms before downloading:
[Z-Image](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo),
[Klein](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B),
[Qwen-Image](https://huggingface.co/Qwen/Qwen-Image-2.1),
[Wan](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B), and
[MiniMax H3](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE).
The runtime uses the MIT licence; the media server uses Apache-2.0.

## Other local models

Add or override entries in `<media.root>/catalog.json`, then reconnect the
extension. Each model needs an id, image/video kind, licence, supported engine
recipe, generation defaults and component slots. Each component names a file
under `models/` and its byte size. Add `residentBytes` for the fit calculation.

The architecture and weight format must be supported by the installed
`sd-server`. A catalogue entry does not download custom files. Place your
weights in the named locations; the model then appears in the setup screen and
default pickers. It can also be selected by id in a generation call.

## Agent tools

- `media_models` lists the catalogue, installed sizes, licences and defaults.
- `media_status` reads the image and video engines, their models and memory.
- `media_set_default` changes one slot without loading a model.
- `image_generate` and `video_generate` accept an optional model id, prompt,
  dimensions, steps and seed. Images can take a reference when the model
  supports editing; video can take a starting image.
- `media_jobs` lists ongoing work. Generation returns a job id by default;
  `media_result` reads the result and inline preview. `wait: true` waits for the
  finished image or video poster.

Use `/health` if Local media is on but the storage folder or runtime is missing.
It points to `/imagesetup`.
