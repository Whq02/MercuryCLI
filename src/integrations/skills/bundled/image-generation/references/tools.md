# Capability and video notes

The connected tool's live schema owns accepted fields, units, bounds and enums; read it before calling a recipe and omit unexposed options. Pipeline step inputs have a separate schema from job inputs.

## Hidden setting interactions

- Result polling (`timeout`) and the render deadline are separate clocks: an expired poll does not cancel the job; retrieve the existing job ID via `media_result` rather than submitting again.
- `reference_image` is a local file path (not an attachment ID or URL) and centre-crops on aspect mismatch. `mask` matches the reference's dimensions (white edits, black preserves). Denoising `strength` is distinct from `control` strength.
- `dry` resolves without diffusion, except `dry` with `export_workflow` writes the workflow file; imports/exports can also read or transfer referenced files (`references/pipelines.md`).
- `count` varies seeds rather than generating animation frames. Postprocessing runs in order: render, `downsize`, `palette`, `upscale`, `sheet` (learned enlargement runs after palette reduction and can alter grid/colours).
- Passing an explicit `scheduler` replaces Qwen Turbo's saved sigma schedule; omit it unless testing another schedule.

## Video

Use `video_generate` (not an image batch) with `image` for a starting frame, and pass `frames` or `seconds`, never both. Check the row's dimensions, fps and frame formula: Wan 2.2 uses 4n+1 frames (rounding seconds down) and MiniMax H3 uses 17n+5 at 24 fps (rounding up). `vae_backend`, `vae_tile_size` and `temporal_decode_frames` trade decode memory against speed (larger temporal chunks use more memory) without changing the diffusion model.

Tool: `video_generate`
```json
{"prompt":"a sailboat crossing a calm lake, fixed camera","seed":42}
```

Inspect the delivered clip and frames, not just its poster, before claiming motion or consistency. Only inputs exposed in the connected schema are callable.
