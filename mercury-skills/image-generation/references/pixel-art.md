# Pixel art

## Saved size, grid and palette

Start at the selected row's render size and choose saved size with downsize. Reducing render dimensions changes generation, not just the final pixel count. Nearest-neighbour downsize samples without averaging and keeps the full source render; use a factor that divides the dimensions.

Palette reduction runs after downsize, without dithering, preserving alpha. Selecting the most-used colours is not selecting a representative spread: background shades can displace a small subject's colours. Inspect before reducing; an explicit palette can preserve the subject/background colours that matter. Reduction is not automatic outline cleanup. Historical CODE evidence: E in `references/sources.md`.

Pixel Party supplies its suffix and default 8x downsize; do not add a second reduction accidentally. Publisher P in `references/sources.md` asks for nearest reduction and says init images help. Its hosting caveat is in the family reference.

## Reference and frames

Inspect the character and intended saved size. No universal strength preserves identity. Klein/Qwen add reference conditioning; Z-Image denoises a reference without that added conditioning. Change one setting at a fixed seed and compare the saved sprite, not only the full render.

Tool: `image_generate`
```json
{"model":"pixel-party-xl","prompt":"a knight in blue armour, full body, facing right, plain background","reference_image":"knight.png","seed":42}
```

This is appropriate when Pixel Party is the selected model and the live schema exposes the reference field. A batch varies seeds; a sheet is a contact sheet, not a walk cycle. For poses/facings, inspect silhouette, features, scale and palette across outputs. Fixed seeds and references do not guarantee consistency. Matching pose controls can guide SDXL frames when available; the pipeline sheet's input order sets frame order.

## Exact editing and enlargement

Use the available sprite editor's own schema for exact corrections or animation assembly. Aseprite's batch bridge is not a visible GUI; preview and sheet export do not prove an open window. Keep a native sprite source when editability matters. Do not substitute it for a refused generator without agreement. A in `references/sources.md` names its owner.

Use integer nearest-neighbour enlargement for a crisp grid. A learned upscaler reconstructs detail after palette reduction, and non-native enlargement can resample RGB; it can introduce colours and mixed pixel sizes. Inspect the saved PNG at native size, compare the full source to separate generation from downsize artifacts, and recheck palette/alpha after enlargement or hand edits. Stop when the requested sprite/grid is achieved, not after a fixed number of variants. [U, E]
