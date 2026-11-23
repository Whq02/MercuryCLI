---
name: image-generation
description: Use when making or editing images with Mercury image generation: prompts, reference images, pixel art, pipelines, workflows, upscaling or video. Not for installing Mercury, sign-in or setup questions.
argument-hint: "<image to make or edit>"
---
# Image generation

“Use Mercury image generation to make a pixel-art character from this reference” loads this skill. “How do I install Mercury or sign in?” does not: use mercury-docs. Existing PhotoCraft documents, LightCraft libraries and FilmCraft timelines belong to their app skills unless generation is requested.

## Capabilities before a render

Discover connected media tools and read their live schemas; never send unexposed fields or widen the toolset to force a recipe. For setup, use `docs/MEDIA.md` (which the mercury-docs skill ships) and `/imagesetup`.

Before any render, call `media_status` then `media_models`. Use these results before choosing a model or size (neither loads weights). Pass `model` only when named; changing the default slot requires the user's ask. Check the row's licence and hosting terms before commercial or remote use.

Omit unused optional fields entirely; never send `null` or empty placeholders. For text-only generation, omit `reference_image`, `strength` and `mask`. Keep the row's recipe defaults unless deliberately testing a change. Read only the one reference needed, relative to this skill's base:

- `references/tools.md` - live schema rules, postprocessing order, job clocks and video generation.
- `references/families.md` - model rows, CFG, denoising strength, ControlNet, LoRAs, embeddings and upscalers.
- `references/pixel-art.md` - sprite downsizing, palette reduction, reference sheets and Aseprite handoff.
- `references/pipelines.md` - editable `.pipeline.json` files, ComfyUI workflow import/export and `media.host` execution.
- `references/sources.md` - publisher cards, pinned runtime commits and repository owners.

## Request and inspect

Inspect reference images first and set visible success criteria (composition, lettering, identity, grid, alpha). Fix `seed` and vary one parameter at a time when comparing; fixed seeds do not guarantee identity or frame consistency.

Reuse the returned job ID rather than submitting duplicates; a queued job is not a finished image. Inspect outputs at native size (for video, inspect both poster and sample frames before claiming motion), stop when criteria are met, and report the saved path and settings/cost.

For an invalid field, correct or omit it and call the same media tool again. Do not retry a permission denial or unapproved download. Never substitute a script, drawing library or another generator without explaining the change and getting the user's agreement.
