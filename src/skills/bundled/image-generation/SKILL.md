---
name: image-generation
description: Use when making or editing images with Mercury image generation: prompts, reference images, pixel art, pipelines, workflows, upscaling or video. Not for installing Mercury, sign-in or setup questions.
argument-hint: "<image to make or edit>"
---
# Image generation

“Use Mercury image generation to make a pixel-art character from this reference” loads this skill. “How do I install Mercury or sign in?” does not: use mercury-docs. An existing PhotoCraft document, LightCraft library or FilmCraft timeline belongs to its app skill, not automatically to a generator.

## Capabilities before a render

Discover the available media tools and read their live schemas. A shipped guide can describe fields the connected server does not expose. Do not send those fields or install/widen the toolset to make a recipe fit. For setup, use `docs/MEDIA.md`, which the mercury-docs skill ships, and the user's `/imagesetup` surface.

Before any render, call `media_status` then `media_models`. Use these results before choosing a model or size. Neither loads weights. Use the named model; otherwise omit `model`. A default-slot change requires the user's ask. Check the selected row's licence and hosting restrictions before commercial or remote work.

Omit unused optional fields entirely; never send `null` or empty placeholders. For text-only generation, omit `reference_image`, `strength` and `mask`. Use the selected recipe's defaults unless testing a deliberate change. Read only the relevant reference, relative to this skill's base:

- Capability and video gotchas: `references/tools.md`.
- Selected model, guidance or adapter: `references/families.md`.
- Sprites, grid and palette: `references/pixel-art.md`.
- Editable pipeline, workflow import/export or remote inputs: `references/pipelines.md`.
- Dated evidence and implementation owners: `references/sources.md`.

## Request and inspect

Inspect reference images first. Define the task's visible success conditions: composition, requested text, identity, grid or alpha as relevant. Keep a seed fixed and change one setting when comparing variants; a seed does not guarantee identity or animation consistency.

Keep the returned job ID and retrieve that job rather than submitting a duplicate. Inspect the actual image at native size; for video inspect the poster and sample frames before claiming motion. Compare against the requested outcome and stop when it is met. Report the saved path and relevant settings or cost, not a queued job as an existing image.

For an invalid field, correct or omit it and call the same media tool again. Do not retry a permission denial or an unapproved download. Never substitute a script, drawing library or another generator without explaining the change and getting the user's agreement. A refused call made no image.
