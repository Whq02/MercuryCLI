# Pixel art

## Saved size, grid and palette

Generate at the model row's native render size and set output resolution via `downsize` (integer factor dividing width and height; nearest-neighbour sampling, keeping the full render). Lowering `width`/`height` alters generation itself. `pixel-party-xl` already adds its suffix and 8x `downsize`; do not stack a second reduction unintendedly.

`palette` quantizes colours without dithering while preserving alpha. Dominant background shades can crowd out small subject colours: inspect before quantizing and pass an explicit palette when subject colours must hold.

## Reference and frames

Klein and Qwen condition on `reference_image`; Z-Image only denoises it. Fix `seed`, change one setting at a time, and inspect the downsized sprite rather than only the full render.

Tool: `image_generate`
```json
{"model":"pixel-party-xl","prompt":"a knight in blue armour, full body, facing right, plain background","reference_image":"knight.png","seed":42}
```

`count` varies seeds and `sheet` builds a contact sheet (pipeline `sheet` preserves input order), not a coherent walk cycle. Check silhouette, scale and palette across frames; pose `control` can guide SDXL poses when installed.

## Exact editing and enlargement

For pixel-exact fixes, layers, palette audits or animation tags, use Aseprite's batch tool schema (A in `references/sources.md`; headless batch CLI, never a live GUI window, and never a silent substitute for a refused render). Enlarge sprites with integer nearest-neighbour scaling rather than `upscale` so the pixel grid and palette stay exact, and inspect the saved PNG at 1:1.
