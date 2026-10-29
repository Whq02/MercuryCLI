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
bundled runtime runs on Apple Silicon macOS, x64 Windows and x64 Linux.
Apple Silicon gets the Metal build; Windows gets the Vulkan build, or the
CUDA 12 build when an NVIDIA card is present. Linux uses Vulkan or builds
CUDA from source when an NVIDIA card is present, as described below.
There is no build for arm64 Windows or arm64 Linux yet. On macOS and Linux
the pull needs `curl` and `unzip`; Windows needs nothing beyond PowerShell
5.1. Video posters, and on Windows and Linux image previews larger than
1024 pixels, also need `ffmpeg` on PATH.

## Run on a rented GPU

In `/imagesetup`, select the runtime row and press Enter. Choose a running
single-machine rental from `/llmhost`, or **Local images and video** to use
your own computer. The choice is saved as `media.host`; an empty value selects
the local engine. Only rentals with SSH access appear. Rent a machine through
`/llmhost` first if needed; choosing it here never creates another rental.

Press **p** on the runtime, then on the model. The download card names the
machine as its destination. Models use the same catalogue, licences, file
sizes and SHA-256 checks. Setup runs on the rented machine, and its hourly
price continues to apply during downloads, compilation and generation.
The runtime row names the machine and the backend actually installed.

On an x64 Linux NVIDIA machine, setup builds `sd-server` from the pinned
`e41fbcf455e0fbb45e08bd535b00d6cba865e921` source with CUDA enabled, using the
machine's CUDA toolkit. It keeps the build log and records the binary's hash,
which is checked before starting it again. If compilation fails, setup uses
the pinned Linux Vulkan archive and the runtime row shows **Vulkan**.
The upstream [CUDA build instructions](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf455e0fbb45e08bd535b00d6cba865e921/docs/build.md#build-with-cuda)
describe the toolkit requirement.

Image and video calls travel over the private SSH tunnel. Reference images,
masks, control images, palette files and local LoRAs named in a call are sent
to that machine. Results, including full images, batch frames and video
posters, are saved to the project's `media/` folder, or the configured local
output folder. Results include `remote` with the machine's name. Async jobs
continue on the machine if the local client closes; `media_result` retrieves
their output when you reconnect. A stopped machine or lost tunnel fails the
call rather than starting a replacement. Use `/llmhost` to manage the rental.

## Set up a model

1. **Read the table.** The top line shows the media folder, total memory in
   GiB and free disk space. The runtime row names `stable-diffusion.cpp`, the
   build it pulls for this computer (Metal, Vulkan or CUDA 12) and its MIT
   licence. Each model shows its id, kind, licence and default slot,
   followed by the remaining pull size and total disk size in GB, memory in
   GiB, available seconds per image, and whether it fits. The runtime
   download is 37.6 MB on macOS, 29.7 MB for Vulkan on Windows, 907.0 MB for
   CUDA 12 (the engine and NVIDIA's runtime libraries) and 37.6 MB for Vulkan
   on Linux; model sizes are listed below. Shared files count once in a pull.
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

## Your own checkpoints and LoRAs

Use `/imagesetup add "/path/to/model.safetensors"` to register a local
checkpoint, or name a `.gguf` file. Complete SD 1.x, SD 2.x, SDXL and SD 3
checkpoints are recognised from their tensors, including compatible smaller
UNets, inpainting checkpoints and SD 1.x/SDXL image-editing variants. Separate
UNets, encoders and VAEs need a component catalogue entry instead. The row
uses the existing controls and shows `your own file` as its licence label;
your file still carries its publisher's terms. Disk size comes from the file;
memory is estimated. Local files are copied into the media folder unless
already there, leaving the original unchanged.

The same command accepts a Hugging Face `resolve` link or a Civitai model
download link. Mercury reads the header first and refuses unsupported files
before pulling their weights. The existing download card asks for confirmation.
The first completed pull records a SHA-256; later pulls and checkpoint loads
check that hash. Registered rows appear on the next `media_models` call
without reconnecting.

Give `image_generate` a `loras` array to apply local LoRAs or download links:

```json
{"prompt":"A cottage beside a river","loras":[{"path":"/path/to/style.safetensors","weight":0.8}]}
```

Each LoRA must match the selected model's family. The result names the files
and weights applied. Omit `loras`, or pass an empty array, for an image without
LoRAs. LoRA links use the same download and hash checks as checkpoints.

## Textual-inversion embeddings

Give `image_generate` an `embeddings` array alongside `loras`, for example
`[{"path":"/path/to/style.safetensors"}]`. Local `.safetensors` and `.gguf`
files and public Hugging Face `resolve` links are accepted. Their tensor
widths must match SD 1.x, SD 2.x or SDXL; other families are refused before
loading. Links use the same download and SHA-256 checks as LoRAs.

The filename without its extension is the prompt token; `token` can override
it. Mention the token in the positive or negative prompt to choose where it
applies. A token absent from both is appended to the positive prompt. The
result names each source, token, family and hash. Each request selects its
own embedding set; omitting `embeddings` leaves the next request without
those embeddings. Changing the set reloads the engine.

The runtime's `--embd-dir` flag selects the directory. Its
[embedding loader](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf/examples/common/common.cpp#L847)
and [CLIP conditioning](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf/src/conditioning/conditioner.hpp#L272)
describe the token and text-encoder matching.

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
the catalogue's sampled peak except for MiniMax-H3, whose 33.02 GiB is an
estimate from component sizes.

| Model id | Kind | Disk | Memory | Time | Licence |
| --- | --- | ---: | ---: | ---: | --- |
| `realesrgan-x4plus-anime-6b` | Image upscaler | 0.02 GB | 2.02 GiB estimate | Unmeasured | BSD-3-Clause |
| `realesrgan-x4plus` | Image upscaler | 0.07 GB | 2.06 GiB estimate | Unmeasured | BSD-3-Clause |
| `z-image-turbo` | Image | 11.19 GB | 16.37 GiB | 130.88 s | Apache-2.0 |
| `flux2-klein-4b` | Image, reference editing | 8.92 GB | 11.32 GiB | 65.04 s | Apache-2.0 |
| `qwen-image-21-turbo` | Image, reference editing | 14.10 GB | 18.67 GiB | 153.70 s | Qwen Research License, non-commercial |
| `qwen-image-21` | Image, reference editing | 14.10 GB | 18.83 GiB | 927.15 s | Qwen Research License, non-commercial |
| `wan22-ti2v-5b` | Video | 12.85 GB | 15.90 GiB | 1054.56 s | Apache-2.0 |
| `minimax-h3-fl2va` | Video with audio | 35.45 GB | 33.02 GiB estimate | Unmeasured | MiniMax H3 Community |
| `sdxl-base-1.0` | Image | 7.11 GB | 11.27 GiB estimate | Unmeasured | CreativeML Open RAIL++-M |
| `pixel-party-xl` | Image, pixel art | 7.11 GB | 11.27 GiB | 96.11 s | CreativeML OpenRAIL-M |
| `controlnet-sd1-canny` | Image control | 0.72 GB | 2.67 GiB estimate | Unmeasured | CreativeML OpenRAIL-M |
| `controlnet-sd1-depth` | Image control | 0.72 GB | 2.67 GiB estimate | Unmeasured | CreativeML OpenRAIL-M |
| `controlnet-sd1-pose` | Image control | 0.72 GB | 2.67 GiB estimate | Unmeasured | CreativeML OpenRAIL-M |
| `controlnet-sdxl-canny` | Image control | 2.50 GB | 4.33 GiB estimate | Unmeasured | CreativeML Open RAIL++-M |
| `controlnet-sdxl-depth` | Image control | 2.50 GB | 4.33 GiB estimate | Unmeasured | CreativeML Open RAIL++-M |
| `controlnet-sdxl-pose` | Image control | 2.50 GB | 4.33 GiB estimate | Unmeasured | Apache-2.0 |

ControlNet memory figures cover the control component; the image model also
needs memory. Timings depend on the chosen image model and dimensions.

Image timings are for 1024×1024: Z-Image at 9 steps, Klein at 4, Qwen Turbo
at its fixed 8-step schedule, Qwen Base at 40 and Pixel Party XL at 25.
The SDXL base row copies Pixel Party's memory figure as an estimate for the
same architecture. The Wan timing is for
832×480, 17 frames, 20 steps, with CPU VAE decoding. MiniMax-H3 has no
measured clip time or peak-memory figure.

Z-Image and Klein share their text encoder. The two Qwen-Image models share
their encoder, vision projection and VAE. The pull card counts only what is
still needed.

An SDXL model is downloaded as four files, the UNet, both CLIP text encoders
and the VAE, and is stored as one 7.11 GB file once the download completes;
the four files are removed. The download therefore needs 14.2 GB free in the
media folder, the four files and the finished file together, plus a 1 GiB
margin; the row says `needs disk space` below that. The two SDXL models share
their encoders and VAE as downloads but each ends as its own file, so pulling
the second downloads those 1.97 GB again. Pixel Party XL appends
`. in pixel art style` to the prompt, renders at 1024×1024 and saves the image
at 128×128 with the full render beside it as `<name>.source.png`.

Read the publishers' terms before downloading:
[Z-Image](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo),
[Klein](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B),
[Qwen-Image](https://huggingface.co/Qwen/Qwen-Image-2.1),
[Wan](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B),
[MiniMax H3](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE),
[SDXL base](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0),
[Pixel Party XL](https://huggingface.co/pixelparty/pixel-party-xl) and
[SDXL-VAE-FP16-Fix](https://huggingface.co/madebyollin/sdxl-vae-fp16-fix).
The Qwen Research weights are non-commercial. MiniMax H3 has territorial and
commercial-use restrictions; the pull card includes its licence notice. The
Pixel Party XL card asks that the model is not hosted elsewhere; the pull
takes it from the author's repository, and the pull card says so.
The media server is Apache-2.0 and the runtime is MIT; weights keep their
own terms.

## What the agent can use

| Tool | What it does |
| --- | --- |
| `media_models` | Lists models, licences, installed sizes and defaults without loading weights. |
| `media_status` | Reads both engines, their models, state and memory without starting them. |
| `media_set_default` | Saves an image or video default without loading it. |
| `image_generate` | Generates a PNG from a prompt, with an optional reference image, denoising strength and mask, or from a ComfyUI workflow file. |
| `video_generate` | Generates video from a prompt and optional starting image. Use frames or seconds, never both. |
| `media_jobs` | Lists jobs and their generation progress. |
| `media_result` | Reads a job's result, saved path and image or video poster; it can wait for completion. |

Generation returns a job id by default. `wait: true` waits for the image or
video poster. `image_generate` also accepts `downsize`, a whole-number
factor: the saved PNG is the render sampled once per block of that size with
nearest-neighbour sampling, and the full render stays beside it as
`<name>.source.png`. A `media_result` wait expiring does not cancel the render.
Closing the submitting client cancels its unfinished jobs; completed files
remain available. Image previews are at most 1024 pixels on their long side;
the full image stays on disk. Video uses WebM when supported by the runtime,
otherwise AVI, with a PNG poster.

The **Local image** or **Local video** permission card names the effective
model, dimensions, steps and output folder, plus the prompt and any reference.
Video details include length and fps. An omitted model is identified as the
default for that kind.

## Reference images and masks

Give `image_generate` a local PNG or JPEG as `reference_image` to start from
an existing image. WebP is also accepted. This works with SD 1.x, SDXL,
Z-Image, Qwen and Klein. `strength` is the denoising strength from 0 to 1,
defaulting to 0.75; lower values keep more of the original. Klein and Qwen
also use the image for reference conditioning. The result names the reference
and strength.

Add `mask` to repaint part of the image: a local PNG with white where you
want paint and black where you want to keep the content. It must have the
same dimensions as the reference. These families can use their ordinary
weights for masked denoising; a separate inpainting checkpoint is not
required. The engine centre-crops the reference to the requested aspect
ratio and resizes it to the render size, using nearest-neighbour sampling;
the mask follows the same crop with nearest-exact sampling. A changed
reference size is reported in the result. The Local image permission card
keeps the inputs together: `Reference: dragon.png · strength 0.6 · mask mask.png`.

For example, ask to turn a horse blue using its saved PNG at strength 0.35,
or supply a mask over its head to change just that part. Paths can be
absolute or relative to the project's `cwd`. Both mask and strength need a
reference image.

The engine's [image preprocessing](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf/docs/image_preprocessing.md)
and [native image API](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf/examples/server/api.md#post-sdcppv1img_gen)
describe the resize and mask inputs.

## Samplers and schedulers

`image_generate` accepts `sampler` and `scheduler` for that request alone,
for example `{"sampler":"dpm++2m","scheduler":"karras"}`. Omit either to
keep the selected family's default. Unknown names return the supported list.
The result names the sampler and scheduler from the runtime's resolved
[generation record](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf/docs/generation_metadata.md).
An explicit scheduler replaces a model's fixed sigma schedule, including
Qwen Turbo's; omitting it preserves that schedule and its step count.

The runtime's `--sampling-method` list is `euler`, `euler_a`, `heun`, `dpm2`,
`dpm++2s_a`, `dpm++2m`, `dpm++2mv2`, `ipndm`, `ipndm_v`, `lcm`,
`ddim_trailing`, `tcd`, `res_multistep`, `res_2s`, `er_sde`, `euler_cfg_pp`,
`euler_a_cfg_pp`, `euler_ge`, `dpm++2m_sde`, `dpm++2m_sde_bt` and `lms`.
Its `--scheduler` list is `discrete`, `karras`, `exponential`, `ays`, `gits`,
`sgm_uniform`, `simple`, `smoothstep`, `kl_optimal`, `lcm`, `bong_tangent`,
`ltx2`, `logit_normal`, `flux2`, `flux`, `beta` and `llada_image`;
`normal` selects `discrete`. These are passed through the
[native image API's sample parameters](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf/examples/server/api.md#post-sdcppv1img_gen).

## Guided images, batches and pixel-art palettes

`image_generate` accepts `control: { image, kind, strength }` with an SD 1.5
or SDXL checkpoint. Use `kind: "canny"` for edges computed from a PNG;
`"depth"` and `"pose"` take a prepared depth map or pose drawing, and no
detector turns a photo into one. Strength defaults to `0.9`. Pull the matching
`controlnet-sd1-*` or `controlnet-sdxl-*` row in `/imagesetup` before the first
render. A missing control returns the row to pull; it does not download
weights silently. Control rows are not image defaults.

The SD 1.5 rows use [lllyasviel's Canny](https://huggingface.co/lllyasviel/control_v11p_sd15_canny),
[depth](https://huggingface.co/lllyasviel/control_v11f1p_sd15_depth) and
[pose](https://huggingface.co/lllyasviel/control_v11p_sd15_openpose) weights,
about 723 MB each under CreativeML OpenRAIL-M. SDXL uses
[Diffusers Canny](https://huggingface.co/diffusers/controlnet-canny-sdxl-1.0)
and [depth](https://huggingface.co/diffusers/controlnet-depth-sdxl-1.0), under
CreativeML Open RAIL++-M, and [Xinsir pose](https://huggingface.co/xinsir/controlnet-openpose-sdxl-1.0),
under Apache-2.0, about 2.50 GB each. A pull prepares the weights locally,
then removes the downloaded source; allow room for both files plus 1 GiB.
The pull card shows the source and licence.

`count` takes 1 to 16. Frames render one after another with `seed`, `seed+1`
and so on, and each is saved. Add `sheet: { columns: 2 }` to arrange them in
a PNG grid, left to right and then down. Columns cannot exceed the count.
The result lists every frame path and seed; the sheet also stores the seeds
in its PNG text metadata. `downsize` applies to each frame before the grid.

`palette: 16` keeps the 16 most-used colours and maps other pixels to the
nearest colour, without dithering. A `.gpl` or `.hex` file path uses a fixed
palette of 2 to 256 colours instead. A `.hex` file has one `RRGGBB` colour
per line, optionally prefixed with `#`. Palette mapping follows downsizing
and preserves alpha. For a four-frame pixel-art sheet, use `count: 4`,
`downsize: 4`, `palette: 16` and `sheet: { columns: 2 }`.

## Upscalers

Pull `realesrgan-x4plus-anime-6b` (17.94 MB, 4×) or `realesrgan-x4plus`
(67.04 MB, 4×) through its existing `/imagesetup` row. Both are
[RealESRGAN](https://github.com/xinntao/Real-ESRGAN) weights under BSD-3-Clause,
pinned by release URL, size and SHA-256. Upscaler rows cannot be image defaults.

Set `upscale: 4` on `image_generate`; optional `upscaler` selects a row by id.
Otherwise an installed matching row is chosen, preferring fewer passes.
A missing model returns the row to pull, without downloading. Whole-number
factors such as 2, 3 and 4 are accepted: the model runs at its native scale,
then RGB is resized bilinearly to the requested factor if needed. Larger
factors use repeated passes. The runtime allows at most four passes and
8192 pixels on either native-output axis. `upscale: 1` leaves it off.

The order is render, `downsize`, `palette`, upscale, then optional sheet.
Upscaling may introduce colours beyond the palette. Each frame is saved at
the enlarged size, and the result names the upscaler and factor. Alpha is kept
with nearest-neighbour resizing. The runtime's
[ESRGAN guide](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf/docs/esrgan.md)
describes `.pth` weights and `--upscale-model` for CLI generation. Mercury uses
`--hires-upscalers-dir` and the separate
[upscale API](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf/examples/server/api.md#post-sdcppv1upscale)
so its postprocessing runs in this order without another diffusion pass.

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

For component models, put entries in `<media.root>/catalog.json`.
Each entry needs an id, kind, licence, supported
engine recipe, generation defaults and component slots; files name relative
paths under `models/` and byte sizes. Supply memory budgets for the fit
calculation. Place the weights at those paths yourself; adding a catalogue
entry does not download them. The model appears in setup and the default
pickers and can be requested by id. The installed engine must support its
architecture and weight format; a catalogue entry alone cannot add support.
A catalogue can also define a recipe family under `recipes`, in the
engine's user-recipe format, and name it in `runtime.families` when the
pulled runtime runs it, and in `runtime.componentFamilies` when it loads
the family's component files directly; a family named only in
`runtime.families` needs a `checkpoint` entry on its recipe, and its rows are
stored as one file after their download. A row whose family is not named is
not listed.

## ComfyUI workflows

Give `image_generate` a `workflow`: the path of a ComfyUI workflow JSON, either
the editor's save file (nodes and links) or the API-format export. Mercury
reads the graph from its SaveImage or PreviewImage node back to the checkpoint
and turns it into one ordinary image request: the same fields as any other
call, through the same engine. Fields given alongside `workflow`, such as
`seed`, `width` or `model`, override what the graph says. The result names the
workflow file, its format, and the mapping: which node became which field,
the nodes that were skipped and why, and the fields you overrode. `dry: true`
returns that mapping and the request without rendering. The Local image
permission card shows the resolved model, size, steps, reference and prompt
with a `Workflow:` line naming the file.

| ComfyUI node | Becomes |
| --- | --- |
| `CheckpointLoaderSimple` | `model`: the catalogue row or registered checkpoint whose file name matches `ckpt_name`; otherwise refused by name. Name `model` in the call to choose a row instead. |
| `LoraLoader`, `LoraLoaderModelOnly` | `loras`, in the order they are chained. `strength_model` is the weight; a `LoraLoader` with a different `strength_clip` is refused, because the runtime applies one strength to both. |
| `CLIPSetLastLayer` | `clip_skip` (`-2` becomes `2`); it must sit on both prompts with the same value. |
| `CLIPTextEncode` | `prompt` and `negative_prompt`. `embedding:name` references become the token with its file in `embeddings`. |
| `EmptyLatentImage` | `width`, `height`; a `batch_size` above 1 becomes `count`, rendered with seed, seed+1 and so on. |
| `LoadImage` into `VAEEncode` | `reference_image`; width and height come from the image, rounded down to the model's multiple. |
| `VAEEncodeForInpaint`, `SetLatentNoiseMask` | `mask`. The mask may be the transparent area of the `LoadImage` (the editor's mask painter) or a `LoadImageMask` channel; `grow_mask_by` is applied. The pixels under the mask keep their colour. |
| `KSampler`, `KSamplerAdvanced` | `seed`, `steps`, `cfg`, `sampler`, `scheduler`; `denoise` becomes `strength` when an image feeds the latent. An advanced sampler must run every step with noise added. |
| `ControlNetLoader` with `ControlNetApply` or `ControlNetApplyAdvanced` | `control`: the kind from the file name (`canny`, `depth` or `pose`) or a catalogue control row, the image and the strength. A `Canny` node before a canny ControlNet is replaced by the engine's own edge detection. The advanced node must apply from 0 to 1. |
| `UpscaleModelLoader` with `ImageUpscaleWithModel` | `upscaler` and `upscale` from the catalogue row matching the file name. |
| `VAEDecode`, `SaveImage`, `PreviewImage` | The render, saved by Mercury. |
| `PrimitiveNode`, `Reroute`, `Note`, `MarkdownNote` | Values and wires pass through; notes are listed as annotations. |

Every other node on the path to the saved image is refused by name with its
id, for example `node 14 (FaceDetailer) is not supported by the local
runtime`, and one refusal lists every problem at once; nothing is dropped
silently. A node that does not lead to the saved image is listed as skipped,
as ComfyUI would not run it either. Bypassed nodes pass their input through;
a muted node on the path is refused. A second checkpoint, sampler, ControlNet
or upscaler is refused: one workflow is one render.

Sampler names map onto the runtime's list: `euler`, `euler_cfg_pp`,
`euler_ancestral`, `euler_ancestral_cfg_pp`, `heun`, `dpm_2`, `lms`,
`dpmpp_2s_ancestral`, `dpmpp_2m`, `dpmpp_2m_sde`, `dpmpp_2m_sde_gpu`, `lcm`,
`ipndm`, `ipndm_v`, `res_multistep` and `er_sde`; ComfyUI runs `ddim` as
Euler, so it maps to `euler`. Schedulers `normal`, `karras`, `exponential`,
`sgm_uniform`, `simple`, `beta` and `kl_optimal` keep their names. Any other
sampler or scheduler is refused with the supported list. Seeds above
9007199254740991 are refused.

Image, LoRA and embedding file names are resolved beside the workflow file,
or by an absolute path; a LoRA or embedding Mercury has applied before is
found by its file name in the media folder's registry. A checkpoint is
matched by the file name you registered with `/imagesetup add`.

Add `export_workflow` with a path to write any image request, with or
without `workflow`, as a ComfyUI API-format workflow JSON with the nodes
above: `{"prompt":"a cottage","model":"sdxl-base-1.0","dry":true,"export_workflow":"cottage.json"}`.
Omitted settings are written as the values the render would use. Importing
the exported file gives the same request. Samplers and schedulers without a
ComfyUI name, such as `tcd` or `ays`, cannot be exported and are refused by
name. The file is never overwritten.

The node inputs follow ComfyUI's [core node definitions](https://github.com/comfyanonymous/ComfyUI/blob/fd7639f477050e5c25b68fc38a9c2a6b6d988211/nodes.py)
and [sampler names](https://github.com/comfyanonymous/ComfyUI/blob/fd7639f477050e5c25b68fc38a9c2a6b6d988211/comfy/samplers.py);
the request fields are the runtime's
[`img_gen` fields](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf/examples/server/api.md#post-sdcppv1img_gen):
`clip_skip`, `strength`, `seed`, `sample_params.guidance.txt_cfg`, the
`lora` array and the `init_image`, `mask_image` and `control_image` inputs.

## Pipelines

Save an editable image pipeline as `<name>.pipeline.json` in your project,
beside its `media/` folder. Named steps can use local files or the outputs of
earlier steps. A run writes its images and a record under the project's
`media/`, even when another output folder is configured. It leaves the
pipeline file unchanged.

```json
{
  "version": 1,
  "name": "Small landscape",
  "steps": [
    {"id": "draw", "kind": "generate", "inputs": {"prompt": "a small landscape", "seed": 7}},
    {"id": "small", "kind": "downsize", "inputs": {"image": {"step": "draw", "output": "image"}, "factor": 2}},
    {"id": "save", "kind": "output", "inputs": {"image": {"step": "small", "output": "image"}}}
  ]
}
```

| Tool | What it does |
| --- | --- |
| `pipeline_describe` | Without a pipeline, lists project pipeline files, the schema and step kinds. With `pipeline`, describes its steps and outputs. |
| `pipeline_validate` | Checks a pipeline and returns every error with its step id and field. |
| `pipeline_run` | Runs the whole pipeline, or starts at `step`. `dry: true` returns the plan without rendering or writing files. |
| `pipeline_import_workflow` | Reads `workflow`, a ComfyUI file, and returns an editable pipeline. Optional `name` sets its name; `destination` saves it without overwriting a file. |
| `pipeline_export_workflow` | Writes `pipeline` to `destination` as a ComfyUI API workflow. Refuses every unmappable step by id and kind; never overwrites a file. |

`pipeline` accepts a file path or the document itself. `cwd` defaults to the
session's project. For example, `{"pipeline":"landscape.pipeline.json","dry":true}`
plans a run; `{"pipeline":"landscape.pipeline.json","step":"small","wait":true}`
runs from `small` and waits for its image. Otherwise the run returns a job id;
use `media_jobs` and `media_result` for progress and results.

The step kinds are `generate`, `edit`, `control`, `upscale`, `downsize`,
`palette`, `sheet`, `file`, `output` and `workflow-import`. Generation steps
accept the image settings from `image_generate`; edit needs a reference,
and control needs its control image and kind. `file` copies a local image
into the run; `output` selects an image to return. `workflow-import` expands
a ComfyUI file into inspectable steps through the workflow mapper.

Every step offers `image`, a single path, and `images`, an array of paths.
Use `{"step":"draw","output":"image"}` as an image input, or an `images`
reference for a sheet. References must name an earlier step and the right
output type. Unsupported kinds, fields and references are refused by step
id rather than omitted.

A run from `step` reuses earlier outputs only while their inputs and saved
file hashes still match. Changed or missing ancestors run again; the chosen
step and later steps always run again. `resume` selects an earlier run record
explicitly; otherwise Mercury uses the latest compatible record. A whole
run does not reuse earlier results.

The Local image card includes `Pipeline: <name> · step <id>`. Results carry
the selected `outputs`, every step's saved paths in `steps[].files`, and
`recordPath`, the saved `media/pipeline-<run-id>.json`. The record retains the
pipeline document and hash, step settings, models,
seeds, saved file hashes and failures. Editing the source does not change
that record. A pipeline with several renders or post-processing that ComfyUI
cannot express is refused on export, with the affected step ids.
