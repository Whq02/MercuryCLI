# Pixel art

Starting points to check by looking at each result.

## Plan the size

- `downsize` keeps one pixel from each block of the render, without averaging, and saves the full render beside it as `<name>.source.png`. Pick a factor that divides the render size: a 1024×1024 render saves 128×128 at `downsize: 8` and 64×64 at `downsize: 16`.
- `palette` runs after `downsize`, without dithering. A number keeps that many of the most-used colours; a `.gpl` or `.hex` path maps every pixel to a fixed palette (the media guide gives the file formats).
- Pixel Party XL downsizes by 8 on its own, and `downsize` overrides it. Other rows need `downsize` and `palette` set.

## A character from a reference

- Pixel Party XL: pass the character art as `reference_image` with `strength` about 0.5 to 0.75 (higher redraws more of it in pixel style, lower keeps more of the original), its default downsize, and `palette: 16` or the user's palette file.
- Klein or a Qwen row, which use the reference for conditioning: ask for the change in words ("Redraw this character as a 16-bit pixel-art sprite, flat colours, clean outline, plain background") and set `downsize` and `palette` yourself.
- The default Z-Image Turbo row follows the reference only through `strength`: a low value keeps the drawing but adds little pixel style, a high one the reverse. If Pixel Party XL or Klein is installed, offer it.

When the user has chosen Pixel Party XL:

```json
{"model":"pixel-party-xl","prompt":"a knight in blue armour, full body, facing right, plain background","reference_image":"knight.png","strength":0.6,"palette":16}
```

## Frames that match

- `count` returns seed variations, not frames of one motion. With `sheet` it lays them out as a contact sheet to choose a design from:

```json
{"prompt":"a small green slime monster, pixel-art sprite, plain background","count":4,"sheet":{"columns":2},"downsize":8,"palette":16}
```

- For frames of one character, such as a walk cycle or four facings: fix `seed`, keep the prompt the same apart from the pose or direction words, and reuse the reference. On an SDXL row, add `control` with `"kind": "pose"` and one prepared pose map per frame, after pulling `controlnet-sdxl-pose`.
- `sheet` lays out one call's `count` batch only. Frames from separate calls are separate files to assemble afterwards with an installed image tool.

## Enlarge for display

Scale the saved PNG by a whole number with nearest-neighbour sampling in an installed image tool; any smoothing filter blurs the pixel grid. A model upscaler, where the schema lists `upscale`, reconstructs detail instead: right for a smooth painted enlargement, wrong for crisp pixels, and it can add colours outside the palette.

## Check the result

Look at the saved PNG at its true size for stray colours, broken outlines, pixels of mixed sizes and detail off the grid. Compare it with `<name>.source.png` to tell a fault in the render from one made by downsizing.
