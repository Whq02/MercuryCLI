# Calls and units

Read the live schemas before sending a request. These are the media 0.2.6 input names, checked 2026-10-30. Empty tools take an empty object. Other optional fields are omitted, never filled with null. Nested names below describe the object shape; do not send dotted keys.

## Input inventory

| Tool | Input fields, including nested fields |
| --- | --- |
| `media_status` | none |
| `media_models` | none |
| `media_jobs` | none |
| `media_set_default` | `kind`, `model` |
| `media_result` | `job_id`, `timeout` |
| `image_generate` | `prompt`, `negative_prompt`, `width`, `height`, `steps`, `seed`, `cwd`, `wait`, `model`, `workflow`, `dry`, `export_workflow`, `cfg`, `clip_skip`, `reference_image`, `strength`, `mask`, `loras`, `loras[].path`, `loras[].weight`, `embeddings`, `embeddings[].path`, `embeddings[].token`, `sampler`, `scheduler`, `upscale`, `upscaler`, `downsize`, `control`, `control.image`, `control.kind`, `control.strength`, `count`, `sheet`, `sheet.columns`, `palette` |
| `video_generate` | `prompt`, `negative_prompt`, `width`, `height`, `steps`, `seed`, `cwd`, `wait`, `model`, `image`, `frames`, `seconds`, `fps`, `timeout_seconds`, `vae_tiling`, `vae_tile_size`, `vae_backend`, `temporal_decode_frames` |
| `pipeline_describe` | `pipeline`, `cwd` |
| `pipeline_validate` | `pipeline`, `cwd` |
| `pipeline_run` | `pipeline`, `cwd`, `step`, `dry`, `wait`, `resume` |
| `pipeline_import_workflow` | `workflow`, `name`, `destination`, `cwd` |
| `pipeline_export_workflow` | `pipeline`, `destination`, `cwd` |

`media_status` reads current engines, memory and selected models without starting them. `media_models` lists defaults, installed rows, sizes and licences without loading weights. `media_set_default` needs both `kind` (image or video) and `model`; it saves a slot, not a render. `media_jobs` finds the job and its progress; `media_result` needs `job_id`. Its `timeout` is a wait in seconds, 0 to 86400, default 0, not a render deadline.

## Image settings

- Give a nonempty `prompt`, or `workflow` that supplies one. Prompts allow up to 12000 characters. `model` is a catalogue id, omitted for the default. `cwd` is the project directory; relative paths resolve there, and normal outputs go in its `media/` unless another output folder is configured.
- `width` and `height` are pixels, whole numbers 64 to 4096; the selected model's multiple and minimum still apply. `steps` is a whole number 1 to 1000. Omit these for the row defaults, not arbitrary low values to make a job fit.
- `seed` is a whole number from -1 to 9007199254740991. Omitted or -1 chooses a random seed. `count` is 1 to 16, sequential seeds; `sheet.columns` is 1 to 16 and no greater than the count.
- `reference_image` takes a local image path. `strength` is 0 to 1, default 0.75. Both `strength` and `mask` need a reference; a mask is a PNG at its source dimensions.
- `cfg` is a scale from 0 to 100, not a percentage. Omit it for the selected recipe/catalogue value. `clip_skip` is 1 to 12, with 1 skipping no CLIP layers; use it only for SD 1.x or SDXL and when the checkpoint's card asks.
- Each `loras` entry needs `path` and finite `weight`; there is no universal weight range. Each `embeddings` entry needs `path`; optional `token` starts with a letter or digit and otherwise contains letters, digits, dot, underscore or hyphen. Both need the family checks in the family reference. Links can download files; disclose the transfer and use only sources the user authorised.
- `control` needs `image` and `kind`; `canny`, `depth` and `pose` name the bundled map kinds, not a closed schema enum. Other prepared-map kinds need a catalogue row. Its `strength` is any finite nonnegative number, default 0.9, distinct from denoising strength.
- `downsize` is a whole-number factor 1 to 64, not a target pixel size. `palette` is an integer colour count 2 to 256 or a local .gpl/.hex path. Order: render, downsize, palette, upscale, sheet.
- `upscale` is a positive whole-number factor; 1 means off. `upscaler` selects an installed row and requires a factor above 1. Native scale is 4 on the two bundled RealESRGAN rows. Other factors run enough native passes then bilinearly resize RGB to the requested size. Alpha uses nearest-neighbour. At most four native passes and 8192 pixels on either native-output axis; no automatic pull on missing weights.
- `wait` and `dry` are booleans, default false. `dry` returns the resolved request and mapping without rendering; with `export_workflow` it still writes the export. Workflow paths and export limits are in the pipeline reference.

## Sampling names

Omit `sampler` and `scheduler` to keep the family's defaults. Do not translate a publisher's spelling by guesswork; workflow import does its own mapping. An explicit scheduler clears Qwen Turbo's fixed sigma schedule; only change it deliberately, not to work around a step refusal.

Sampler enum: `euler`, `euler_a`, `heun`, `dpm2`, `dpm++2s_a`, `dpm++2m`, `dpm++2mv2`, `ipndm`, `ipndm_v`, `lcm`, `ddim_trailing`, `tcd`, `res_multistep`, `res_2s`, `er_sde`, `euler_cfg_pp`, `euler_a_cfg_pp`, `euler_ge`, `dpm++2m_sde`, `dpm++2m_sde_bt`, `lms`.

Scheduler enum: `discrete`, `karras`, `exponential`, `ays`, `gits`, `sgm_uniform`, `simple`, `smoothstep`, `kl_optimal`, `lcm`, `bong_tangent`, `ltx2`, `logit_normal`, `flux2`, `flux`, `beta`, `llada_image`, `normal`. The last selects discrete in the runtime. These are accepted names, not recommendations for every model.

## Video

1. Read `media_status` then `media_models`, just as for images. Omit `model` unless the user names one. Keep a video job asynchronous when its duration would hold the conversation.
2. Give `prompt` and optionally a local starting image as `image`, not the image-generation reference field. Give either `frames` (whole number 1 to 4096) or `seconds` (positive, at most 120), never both. `fps` is frames per second, a whole number 1 to 240, default the row's value or 24.
3. Wan's row `wan22-ti2v-5b` starts at 832×480, 49 frames, 24 fps and 20 steps; minimum 832×480 in either orientation. Its frame count must be 4n+1; seconds round down to that pattern. MiniMax's `minimax-h3-fl2va` starts at 864×480, 56 frames, 24 fps and 20 steps; minimum 864×480 in either orientation. It requires 17n+5 frames and 24 fps; seconds round up. Both use dimension multiples of 32. These are Mercury's row settings, not the publishers' memory or speed promises.
4. `timeout_seconds` is the total job deadline including model loading, 1 to 86400 seconds; row defaults are 7200 for Wan and 10800 for MiniMax. This is separate from the result wait timeout. `vae_tiling` toggles spatial tiling; temporal tiling remains enabled. `vae_tile_size` is 128 to 4096 image pixels. `vae_backend` accepts `metal` or `cpu`; it changes the VAE, not diffusion. On Metal the video rows default to CPU VAE. Wan's `temporal_decode_frames` is 1 to 16 latent frames per pass; larger values use more memory.
5. Retrieve with `media_result`, open the poster and inspect sample frames before claiming motion or consistency. The full clip is WebM or AVI according to runtime support, not an image sheet. MiniMax's row includes audio; this tool does not expose the publisher's multi-reference or last-frame inputs.

Tool: `video_generate`
```json
{"prompt":"a sailboat moving slowly across a calm lake, fixed camera","seed":42}
```

This uses the selected row's length and size. After reading the slot, choose its supported frame count for the requested duration; do not reuse another family's count. Sources V and E in `references/sources.md` distinguish the publisher's capabilities from Mercury's interface.
