---
name: image-generation
description: Use when making or editing images with Mercury image generation: prompts, reference images, pixel art, pipelines, workflows, upscaling or video. Not for installing Mercury, sign-in or setup questions.
argument-hint: "<image to make or edit>"
---
# Image generation

“Use Mercury image generation to make a pixel-art character from this reference” loads this skill. “How do I install Mercury or sign in?” does not: the mercury-docs skill answers it from Mercury's documentation, as it does questions about how `/imagesetup` or `/config` work.

Reference paths are relative to the base directory above. For setup read `docs/MEDIA.md`, the media guide the mercury-docs skill ships. The call shapes are in `references/tools.md`, family choices in `references/families.md`, sprites in `references/pixel-art.md`, editable work in `references/pipelines.md`, and dated sources in `references/sources.md`.

## Before the first render

1. **Load the tools.** Discover the deferred media tools by the names the tool list supplies. If none exists, `/health` names what is missing; the user enables Local media in `/config` or finishes a pull in `/imagesetup`.
2. **Read the state.** Before any render, call `media_status` for engine state and memory, then `media_models` for installed rows, default slots, sizes and licences. Neither loads weights. Use these results before choosing a model or size. Missing runtime or weights need the user's download confirmation in `/imagesetup`; do not start a pull yourself.
3. **Choose the model and destination.** Use the model the user names; otherwise omit `model`. Offer a better installed row with its reason, never switch silently. `media_set_default` changes a slot only when the user asks. Read the selected row's licence before commercial work. Calls use local time, disk and memory; a rented host also keeps billing during setup and rendering. Read the host section below before sending inputs remotely.
4. **Build the request.** Read the tool's live schema and `references/tools.md`. Send only the fields you are using. Omit unused optional fields entirely; never send `null` or an empty placeholder. For text-only generation, omit `reference_image`, `strength` and `mask`. Tool schemas differ from pipeline step inputs; do not copy job controls into a step.

## Make and edit

5. Read the selected row in `references/families.md`. Start with its steps, size and sampling defaults. Describe the subject, composition, light and requested text. At CFG 1, omit `negative_prompt`; write what should be present. Bracket emphasis is runtime syntax, not a promise of better prompting.
6. Inspect a reference before calling. `reference_image` is a local PNG, JPEG or WebP path, not an attachment id or URL. Match its aspect ratio and the row's dimension multiple, or the engine centre-crops it. `mask` is a PNG at the reference's source size: white paints, black keeps. Lower `strength` keeps more of the source; higher redraws more. It also shortens the schedule on values below 1, so few-step rows have coarse control.
7. Keep `seed` fixed while changing one thing. `count` makes sequential seed variations, not animation frames. Match `control`, `loras` and `embeddings` to the model family. Read the family reference before choosing `sampler`, `scheduler`, `cfg`, `clip_skip` or `upscaler`.
8. Call `image_generate`. `wait: true` waits; otherwise keep the returned job id, use `media_jobs` for progress and `media_result` with `job_id` for the image. Its `timeout` is seconds, defaults to 0, and expiring does not cancel the render. Do not submit a duplicate while the job is running.
9. Look at the returned image and, for pixel detail, the saved PNG at native size. Give the saved path and the change the user asked for. Use result values when settings matter; never claim a queued or refused call made an image. Keep a failed result's reason in the detail with the next action.

Tool: `image_generate`
```json
{"prompt":"a red fox wearing a green scarf, sitting in snow","reference_image":"fox.png","mask":"scarf-mask.png","strength":0.75,"seed":42}
```

## When a call is refused

Read the named field and remedy. For an invalid or unused field, correct or omit it and call the same media tool again with the intended request. Do not retry a permission denial or a download needing approval. If generation still cannot run, say why and what the user can do next. Never replace the media engine with a script, drawing library or another generator without explaining the change and getting the user's agreement. A refused call has made no image; do not describe it as a render.

## Keep the work editable

A pipeline is a JSON document of named image steps whose inputs can refer to earlier outputs. Use `pipeline_describe`, save the document, then `pipeline_validate` and `pipeline_run`. Edit the step's inputs in that file and rerun from its id. The source stays editable; each run saves images and a separate record under the project's `media/`. `references/pipelines.md` gives the call order, reuse rules and step shapes.

For ComfyUI, `image_generate` with `workflow` and `dry: true` reads one render request without rendering. `pipeline_import_workflow` makes an editable document instead; `pipeline_export_workflow` exports a mappable document. Read the mapping before running; unsupported nodes or steps are named, not silently dropped. The pipeline reference also covers `export_workflow` for a single request.

## A rented host

`media.host` selects a running SSH rental in `/imagesetup`; choosing it does not rent a new machine. Do not change it merely to make a render fit. The download card names the destination; the runtime row names the machine and backend. Media details show the machine, model, dimensions, steps, references and output folder; pipeline details also show the name and starting step.

On that host, the prompt and settings travel over the private SSH tunnel, along with referenced images, masks, control maps, palette files, local LoRAs and embeddings. Workflow dependencies are resolved and sent as needed, not the whole project. Runtime and weights run there. The pipeline source and downloaded outputs stay local; images, batch frames, video posters and pipeline records return to the project's `media/` (ordinary generations can use a configured output folder). Pipeline dry runs send the document without image files; imports and exports can transfer their referenced inputs, and exports are written locally. Remote async jobs survive a disconnected client; reconnect and use `media_result`. A lost host is not replaced automatically. `/llmhost` manages the still-billing rental.

## Finish for the intended use

- Pixel art: use `references/pixel-art.md`. Nearest-neighbour enlargement preserves the grid; a learned upscaler can change edges and colours. Use the available Aseprite tool for exact sprite edits and sheets, not as an undisclosed replacement for a failed render.
- Video: use `video_generate`, not an image batch. Its starting-image field is `image`. Give `frames` or `seconds`, never both; `references/tools.md` has the units, row sizes and memory controls. Inspect the returned poster and sample frames before describing motion.
- User-facing text says what the image is, its saved path, material time/disk/memory or rental cost, and what to do next. Do not add process labels or verification badges to an image, row or status line. Source uncertainty belongs in these references, not a decorative caption.
