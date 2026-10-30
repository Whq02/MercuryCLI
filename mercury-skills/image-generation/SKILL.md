---
name: image-generation
description: Use when making or editing images with Mercury image generation: model choice, prompts, reference strength, masks, ControlNet, LoRAs, seeds, pixel art and upscaling. Not for installing Mercury, sign-in or setup questions.
argument-hint: "<image to make or edit>"
---
# Image generation

“Use Mercury image generation to make a pixel-art character from this reference” loads this skill. “How do I install Mercury or sign in?” does not: the mercury-docs skill answers it from Mercury's documentation, as it does questions about how `/imagesetup` or `/config` work.

Reference paths below are relative to the base directory above. For setup, the model table and worked field examples, read `docs/MEDIA.md`, the media guide the mercury-docs skill ships: invoke that skill and read the page from its base directory.

## Before the first render

1. **Load the tools.** The media tools (`media_status`, `media_models`, `image_generate`, `media_result`) are deferred: load them with ToolSearch, naming them as the deferred-tools list spells them. If no media tool exists, Local media is off or not connected; `/health` says which, and the user switches it on in `/config` or by finishing a model pull in `/imagesetup`.
2. **Read the live schema.** Send only the fields you are using and that the `image_generate` schema lists. Omit unused optional fields entirely; never send `null` or an empty placeholder. For text-only generation, omit `reference_image`, `strength` and `mask`. Unknown keys are refused, and builds differ. Some builds add `sampler`, `scheduler`, `cfg`, `clip_skip`, `embeddings`, `upscale`, `upscaler`, `workflow`, `dry` or `export_workflow`; use one only when the schema lists it.
3. **Read the state.** Before any render, call `media_status` for engine state and memory, then `media_models` for installed rows, default slots, sizes and licences. Neither loads weights. Use these results before choosing a model or size. A missing runtime or model is pulled in `/imagesetup` after the user confirms its download card, so name the row and stop there.
4. **Choose the model.** Use the model the user names; otherwise omit `model` and the default slot applies. If another installed row suits the job better, say which and why and let the user decide; never switch silently. When the purpose is commercial or unknown and the row's licence restricts that use, say so.

## Make the image

5. **Write for the family.** Read the row's entry in `references/families.md` first. Rows that run at CFG 1 ignore `negative_prompt`, so describe what you want rather than what to avoid. Keep the row's default steps and size unless the job needs otherwise.
6. **Inspect the reference.** `reference_image` and `mask` take local file paths, and a mask must be a PNG; if the user pasted an image with no path in view, ask for the file. Look at the reference, then match `width` and `height` to its aspect ratio, rounded to the row's size multiple, or the engine centre-crops it. A mask is white where to paint and black where to keep, at the reference's pixel size.
7. **Set strength by intent.** Low keeps the reference and high redraws it. With the row's steps it also decides how many denoising steps run, so it is coarse on few-step rows. It still applies inside a mask, so replacing an object needs a high value.
8. **Mind the brackets.** Every family reads `(word)` and `[word]` as weights. Write `\(` and `\)` for literal brackets, as in text on a sign (`\\(` inside a JSON string), and put words to be drawn in quotes.
9. **Match the extras.** `control` (ControlNet), `loras` and embeddings must suit the row's family; `references/families.md` says which rows take which.
10. **Iterate in small steps.** Fix `seed` and change one thing per render. `count` renders `seed`, `seed+1` and so on with identical inputs: variations to choose from, not animation frames. Reuse the seed the result reports.
11. **Render, look, report.** `wait: true` holds the call until the image is ready; for a long render, submit without it and poll `media_result`, whose expired `timeout` does not cancel the job. Look at the returned preview before saying it worked, and report the saved path, model, seed and settings from the result, not from the request.
12. **Enlarge with intent.** A model upscaler (`upscale`, where the schema lists it) reconstructs detail: suited to photos and illustrations, but on pixel art it softens edges and adds colours outside the palette. Enlarge pixel art by a whole-number nearest-neighbour scale instead. Without an upscaler field, say so rather than passing off a resize as one. `references/pixel-art.md` covers sprites, palettes and frames.

## When a call is refused

Read the named field and remedy. For an invalid or unused field, correct or omit it and call the same media tool again with the intended request. Do not retry a permission denial or a download needing approval. If generation still cannot run, say why and what the user can do next. Never replace the media engine with a script, drawing library or another generator without explaining the change and getting the user's agreement. A refused call has made no image; do not describe it as a render.

A masked repaint of a saved image at a fixed seed:

```json
{"prompt":"a red fox wearing a green scarf, sitting in snow","reference_image":"fox.png","mask":"scarf-mask.png","strength":0.75,"seed":42}
```

Video is `video_generate`, with frames or seconds but not both; the media guide lists each video row's minimum size.

For a model's or a LoRA's own advice, read its publisher's card first and label community advice as such. When a site refuses a fetch (robots rules, a challenge or a backoff), respect the refusal and use another source.
