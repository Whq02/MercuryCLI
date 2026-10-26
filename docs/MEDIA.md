# Local images and video: `/imagesetup`

Mercury's bundled `mercury-media` extension generates images and video with
models on your own computer through `stable-diffusion.cpp`. It is off by
default. Generation uses local disk, memory and time; there is no paid
media-generation API.

## Turn it on

Open `/config`, find **Local media** (`media.enabled`), switch it on and save
with Enter. The extension connects in the current session. Switching it off
in the same place disconnects it. Enabling it does not download the runtime
or model weights.

Open `/imagesetup` to download the runtime and models. Completing a model
pull turns Local media on and connects it in the current session. The
bundled runtime needs Apple Silicon macOS, `curl` and `unzip`.
Video posters also need `ffmpeg` on PATH.

## Set up a model

1. **Read the table.** The top line shows the media folder, total memory in
   GiB and free disk space. The runtime row names `stable-diffusion.cpp` and
   its MIT licence. Each model shows its id, kind, licence and default slot,
   followed by the remaining pull size and total disk size in GB, memory in
   GiB, available seconds per image, and whether it fits. The runtime archive
   is 37.6 MB; model sizes are listed below. Shared files count once in a pull.
2. **Pull the runtime.** Use ↑↓ to select its row and press **p**. The card
   shows the download size, destination, source and licence. Its keys are
   `y download · n back`. Nothing downloads until you press **y**.
3. **Pull a model.** Select its row and press **p**, read the same card and
   confirm. Progress shows the file and bytes downloaded. Downloads check
   file size and SHA-256. **esc** pauses a download and keeps partial files;
   select the row and press **p** again to resume.
4. **Choose the defaults.** Press **d** on a model to put it in the image or
   video slot. This saves a choice without loading weights or downloading
   files. `/config` has the same **Default image model** and **Default video
   model** pickers.
5. **Try an image.** With Local media on and the runtime and selected image
   model installed, press **t**. It requests a 256×256 image of a red apple
   through the normal tool permission card, then displays the image and its
   saved path. **esc** cancels a running test or returns from its preview.
   On the table, **esc** closes the screen.

The table's fit calculation leaves 8 GiB for the operating system and other
work, and checks the model's accelerator memory requirement too. A model's
peak memory and runtime depend on dimensions, video length and other work on
your computer. The table's image timings are catalogue observations, not
promised completion times. It has no download-time estimate.

## The two default slots

The initial image slot is `z-image-turbo`; the initial video slot is
`wan22-ti2v-5b`. Omit `model` to use the default; name a model only when the
user asks for a specific one. An explicit model changes that call alone.
Changing a slot does not prevent selecting another model for a later call.
Installed models and saved default changes are available on the next
media-tool call without reconnecting.

For example, “Generate an image of a lighthouse at dusk” uses the image
slot. “Use FLUX.2 Klein 4B to edit this reference image” selects that model
for the image. “Make Wan 2.2 my default video model” changes the video slot.

Slots live in `<media.root>/config.json` as `imageModel` and `videoModel`.
The `/config` row ids `media.imageModel` and `media.videoModel` edit that
file; do not put those keys in Mercury's settings file. Explicit
`MEDIA_IMAGE_MODEL` and `MEDIA_VIDEO_MODEL` environment variables override
saved slots. Choosing a default in Mercury does not set these variables.

## Catalogue sizes and timings

Disk totals include the model's component files before sharing with another
installed model. GB means decimal gigabytes; GiB means 1024³ bytes. Memory is
the catalogue's sampled peak except for MiniMax-H3, whose 33.0 GiB is an
estimate from component sizes.

| Model id | Kind | Disk | Memory | Time | Licence |
| --- | --- | ---: | ---: | ---: | --- |
| `z-image-turbo` | Image | 11.19 GB | 16.4 GiB | 130.88 s | Apache-2.0 |
| `flux2-klein-4b` | Image, reference editing | 8.92 GB | 11.3 GiB | 65.04 s | Apache-2.0 |
| `qwen-image-21-turbo` | Image, reference editing | 14.10 GB | 18.7 GiB | 153.70 s | Qwen Research License, non-commercial |
| `qwen-image-21` | Image, reference editing | 14.10 GB | 18.8 GiB | 927.15 s | Qwen Research License, non-commercial |
| `wan22-ti2v-5b` | Video | 12.85 GB | 15.9 GiB | 1054.56 s | Apache-2.0 |
| `minimax-h3-fl2va` | Video with audio | 35.45 GB | 33.0 GiB estimate | Unmeasured | MiniMax H3 Community |

Image timings are for 1024×1024: Z-Image at 9 steps, Klein at 4, Qwen Turbo
at its fixed 8-step schedule and Qwen Base at 40. The Wan timing is for
832×480, 17 frames, 20 steps, with CPU VAE decoding. MiniMax-H3 has no
measured clip time or peak-memory figure.

Z-Image and Klein share their text encoder. The two Qwen-Image models share
their encoder, vision projection and VAE. The pull card counts only what is
still needed.

Read the publishers' terms before downloading:
[Z-Image](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo),
[Klein](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B),
[Qwen-Image](https://huggingface.co/Qwen/Qwen-Image-2.1),
[Wan](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B) and
[MiniMax H3](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE).
The Qwen Research weights are non-commercial. MiniMax H3 has territorial and
commercial-use restrictions; the pull card includes its licence notice.
The media server is Apache-2.0 and the runtime is MIT; weights keep their
own terms.

## What the agent can use

| Tool | What it does |
| --- | --- |
| `media_models` | Lists models, licences, installed sizes and defaults without loading weights. |
| `media_status` | Reads both engines, their models, state and memory without starting them. |
| `media_set_default` | Saves an image or video default without loading it. |
| `image_generate` | Generates a PNG from a prompt, with a reference image when the model supports editing. |
| `video_generate` | Generates video from a prompt and optional starting image. Use frames or seconds, never both. |
| `media_jobs` | Lists jobs and their generation progress. |
| `media_result` | Reads a job's result, saved path and image or video poster; it can wait for completion. |

Generation returns a job id by default. `wait: true` waits for the image or
video poster. A `media_result` wait expiring does not cancel the render.
Closing the submitting client cancels its unfinished jobs; completed files
remain available. Image previews are at most 1024 pixels on their long side;
the full image stays on disk. Video uses WebM when supported by the runtime,
otherwise AVI, with a PNG poster.

The **Local image** or **Local video** permission card names the effective
model, dimensions, steps and output folder, plus the prompt and any reference.
Video details include length and fps. An omitted model is identified as the
default for that kind.

## Files and settings

**Media folder** (`media.root`) defaults to `~/.mercury/media` under Mercury's
config home. It holds the runtime, `models/`, media configuration and logs.
Choose another absolute path in `/config` if needed. Changing the folder
does not move existing weights.

Generated files normally land in the project's `media/` folder. In
`<media.root>/config.json`, `outputs` chooses another folder; a relative
value is resolved under the media folder. `MEDIA_OUTPUT_DIR` overrides it.
Without an output setting or project, files go to `~/Desktop/mercury-media`.

The media config also accepts `logs`, `jobCap`, `deadlines`, `ports` and
`nice`. `jobCap: 0` leaves job count unlimited. Both ports default to `0`
for automatic selection; `nice` defaults to `10`. `media.enabled` and
`media.root` belong to Mercury's settings; the slots belong to the media
config.

In `/health`, **Local media** shows whether it is off, the media folder, or
a missing folder or runtime with `/imagesetup` as the next step. It also
points out slot keys placed in Mercury's settings instead of the media config.

## Limits and other local models

There is one engine for images and one for video, each processing one render
at a time. Before loading weights, the server checks available memory. A
video job that fits leaves the image model loaded; otherwise it waits for the
other work to finish and unloads idle weights. The next request reloads them.
Engines unload after five idle minutes.

Wan starts at 832×480 and MiniMax-H3 at 864×480, in either orientation.
Smaller requests return the size requirement without rendering. Their other
catalogue sizes are 1280×704 and 1344×768 respectively. Wan uses `4n+1`
frames; MiniMax-H3 uses `17n+5` at 24 fps. Seconds round down for Wan and up
for MiniMax-H3. Z-Image and Klein dimensions must be divisible by 16;
Qwen-Image and video dimensions by 32. On Metal, video uses CPU VAE decoding
by default while diffusion remains on the GPU.

To add another local model, put entries in `<media.root>/catalog.json` and
reconnect the extension. Each entry needs an id, kind, licence, supported
engine recipe, generation defaults and component slots; files name relative
paths under `models/` and byte sizes. Supply memory budgets for the fit
calculation. Place the weights at those paths yourself; adding a catalogue
entry does not download them. The model appears in setup and the default
pickers and can be requested by id. The installed engine must support its
architecture and weight format; a catalogue entry alone cannot add support.
