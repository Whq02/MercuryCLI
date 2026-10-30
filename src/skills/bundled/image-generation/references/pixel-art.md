# Pixel art

## Plan the saved size

- `downsize` samples one pixel per block without averaging, keeping the full render as <name>.source.png. A factor of 8 turns 1024×1024 into 128×128; 16 turns it into 64×64. Pick a factor that divides the render dimensions.
- `palette` runs after downsize without dithering, preserving alpha. An integer keeps the most-used colours; a .gpl or .hex path maps pixels to the supplied palette. This is colour reduction, not automatic outline cleanup.
- Pixel Party XL supplies downsize 8 unless overridden; other rows have no such default. Its publisher asks for 8× nearest-neighbour reduction and says init images help. See sources P and E in `references/sources.md` (checked 2026-10-30).

## A character from a reference

Inspect the character and desired output size first. When the user chooses Pixel Party, pass the saved image as `reference_image`; omit `strength` for the engine's 0.75 default, then adjust one value after looking. There is no sourced universal strength for keeping identity. Klein and Qwen also condition on the reference, so describe the edit in words and set downsize/palette deliberately. Z-Image uses denoising without that added conditioning. Offer a different installed row when appropriate; do not change models silently.

Tool: `image_generate`
```json
{"model":"pixel-party-xl","prompt":"a knight in blue armour, full body, facing right, plain background","reference_image":"knight.png","seed":42,"palette":16}
```

## Frames and exact editing

`count` varies seeds, not poses in one motion. `sheet` lays out that call's batch as a contact sheet. This call makes four design variations:

Tool: `image_generate`
```json
{"prompt":"a small green slime monster, pixel-art sprite, plain background","count":4,"sheet":{"columns":2},"downsize":8,"palette":16}
```

For a walk cycle or four facings, keep the seed, reference and art direction; change the pose words. On SDXL, a matching installed pose ControlNet can guide each frame using a prepared pose map. Neither fixed seeds nor reference conditioning guarantee consistent frames; inspect silhouettes, features, scale and palette. A pipeline's sheet step can assemble outputs from several calls or files; its order sets the frame order.

For exact corrections or animation assembly, load the available Aseprite tool and its schema. Start with its status operation. It runs batch mode, not a GUI, and does not install the app. Its draw and parts operations work on a native .aseprite/.ase file; palette-check reports off-palette pixels without changing them. Render returns a nearest-neighbour PNG preview at a positive integer scale without resizing the sprite. Export saves a sprite sheet and optional frame metadata. The run-script operation can import PNG frames into a native sprite through Lua and asks permission for that code; do not invent an import operation. Fixed operations keep paths inside the working project. See `docs/ASEPRITE-BRIDGE.md` through mercury-docs. [A]

## Enlarge and inspect

For a crisp display enlargement, use a whole-number nearest-neighbour scale in an available image tool. A learned upscaler reconstructs detail; Mercury applies it after palette reduction, and non-native factors use bilinear RGB resizing. It can change the grid and introduce colours outside the palette, so use it only when that painted enlargement is wanted. [U, E]

Look at the saved PNG at native size for stray colours, broken outlines and mixed pixel sizes. Compare with the full source render to distinguish render detail from downsize effects. With a palette, inspect colours again after any upscaling or hand edits. Tell the user the saved size and path, and the next useful change; do not add verification labels to the image.
