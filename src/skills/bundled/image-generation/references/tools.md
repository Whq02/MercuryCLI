# Capability and video notes

The connected tool's live schema owns accepted fields, units, bounds and enums. Read it before using a recipe. Source-build support is not evidence that a session exposes the same capability; omit unsupported options rather than translating them by guesswork. Pipeline step inputs are a different schema from job inputs.

## Effects that settings can hide

- Result waiting and the render deadline are different clocks. A result wait expiring does not cancel the render; retrieve the existing job rather than launching another.
- A reference is a local image, not an attachment ID or URL. An aspect-ratio mismatch can centre-crop it. A mask matches the reference's source dimensions: white paints, black keeps. Denoising strength is not ControlNet strength.
- `dry` resolves a request without diffusion, but `dry` with `export_workflow` writes a file. Imports/exports can also read or transfer dependencies; see `references/pipelines.md`.
- `count` makes seed variations, not animation frames. Postprocessing order is render, downsize, palette, upscale, sheet. Learned enlargement can undo grid/palette constraints.
- An explicit scheduler replaces Qwen Turbo's fixed sigma schedule. Keep the saved schedule unless deliberately testing another; more steps are not automatically better.

These are implementation notes, not a second input inventory. Source basis and dates: E in `references/sources.md`.

## Video

Use video generation, not an image batch. Its starting-image field is `image`; choose `frames` or `seconds`, not both. Read the selected row's size, frame pattern and fps; one family's valid count may be invalid for another.

Historical CODE reading 2026-10-30 (E): Wan uses a 4n+1 frame pattern and rounds seconds down; MiniMax H3 uses 17n+5 at 24 fps and rounds up. CPU VAE, spatial tiling and temporal decode controls affect decoding memory/time, not the diffusion model's identity. A larger temporal decode chunk costs more memory. Read current row/schema defaults instead of copying its deadlines and numeric bounds here.

Tool: `video_generate`
```json
{"prompt":"a sailboat crossing a calm lake, fixed camera","seed":42}
```

This leaves length/size at the selected row's defaults. Inspect the delivered clip, not just its poster, before claiming motion or consistency. H3's publisher audio-video or multi-reference interface is not proof that the connected tool exposes every input. Publisher evidence: V in `references/sources.md`.
