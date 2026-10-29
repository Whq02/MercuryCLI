# Model families

Starting points drawn from each model's card and the engine's recipes, not guarantees: look at every result and change one thing at a time. Advice marked unverified is reasoned from the engine's code and has not been checked with a render.

## Strength and steps

With `reference_image` and a `strength` below 1, the engine runs `floor(steps × strength) + 1` steps from part-way down the schedule. On the four-step Klein row, strength therefore moves in quarters: 0.3 and 0.45 both run two steps. Rows that accept other `steps` values can be given more for finer control; whether extra steps lower quality on the distilled rows is unverified.

## Prompt weights

In every family, `(word)` raises a word's weight by 1.1, `(word:1.3)` sets it and `[word]` lowers it by 1.1. Escape literal brackets as `\(`, `\)`, `\[` and `\]`. Whether weights help the rows with a language-model text encoder (Z-Image, Klein and Qwen) is untested; plain description is the style their guides document.

## z-image-turbo (Z-Image Turbo)

The initial default. Guidance-distilled, so it runs at CFG 1 and `negative_prompt` has no effect. Keep its 9 steps (8 model passes, per its card). Write detailed natural prose and quote text to be drawn: its card highlights bilingual text rendering. A reference acts through `strength` alone, with no reference conditioning. Its card rates the variety between seeds as low, so neighbouring seeds look alike; vary the wording instead. Sizes are multiples of 16.

## flux2-klein-4b (FLUX.2 Klein 4B)

Distilled to 4 steps at CFG 1, so `negative_prompt` has no effect. Black Forest Labs' prompting guide asks for prose rather than keyword lists, with the lighting described; the model gets exactly what you write, with no rewriting. It uses the reference for conditioning as well as through `strength`, so an edit can be an instruction such as "make the jacket red" with the image as `reference_image`. For the same character in a new pose or style, try `strength` 0.75 to 1 and let the reference hold identity; for a small fix, about 0.3 to 0.5 with a mask (both unverified). LoRAs must be FLUX.2 family; one made for a larger FLUX.2 model passes the family check but may not load on the 4B (unverified). A pixel-art LoRA author reports that the distilled model degrades their LoRA and recommends the Klein base model, which Mercury's catalogue does not include; that is one community report. Sizes are multiples of 16.

## qwen-image-21-turbo (Qwen-Image 2.1 Turbo)

A fixed eight-step schedule at CFG 1: omit `steps` (another value is refused) and leave `negative_prompt` empty. Its guidance favours long, detailed prompts. It uses the reference for conditioning, and its card says edits keep the identity of people and products. For a transparent background, its card's prompt form is: "This is an RGBA image with transparency. <description>. The image has alpha channel and the background is transparent." Sizes are multiples of 32. It is trained for larger images than Mercury's 1024 default; larger sizes are accepted, but their time and memory are unmeasured.

## qwen-image-21 (Qwen-Image 2.1)

40 steps by default. Mercury's catalogue runs it at CFG 6, so `negative_prompt` applies here. Upstream examples disagree (some run it at CFG 1), and which suits it better is unsettled. Prompts, reference conditioning, transparency and sizes are as for the Turbo row.

## sdxl-base-1.0 and checkpoints added with `/imagesetup add`

These run above CFG 1 by default (SDXL at 5, SD 1.x and 2.x at 7.5, SD 3 at 7), so `negative_prompt` works; a one-step sdxs checkpoint runs at CFG 1. Native sizes are 1024×1024 for SDXL and 512×512 for SD 1.x and 2.x, in multiples of 64 (8 for SD 3). A reference acts through `strength`; only the 8-channel image-editing variants add reference conditioning. ControlNet, LoRAs and embeddings come from this ecosystem.

## pixel-party-xl (Pixel Party XL)

An SDXL fine-tune at CFG 5 and 25 steps, so `negative_prompt` works; its card's example is `mixels. amateur. multiple`. Mercury appends ". in pixel art style" and saves a 128×128 PNG from the 1024×1024 render (`downsize` 8), keeping the full render as `<name>.source.png`. Its card says init images help, so a reference suits it. SDXL LoRAs and the SDXL ControlNet rows apply.

## ControlNet

`control` works with an SD 1.5 or SDXL checkpoint only, Pixel Party XL included; pull the matching `controlnet-sd1-*` or `controlnet-sdxl-*` row first. `canny` computes edges from a PNG and keeps outlines or line art. `depth` keeps layout and volume, and `pose` keeps a figure's pose; both need a prepared map, because Mercury has no detector. The default strength is 0.9. The Diffusers SDXL canny and depth cards use 0.5 for better generalisation, so if a result looks traced, try 0.5 to 0.7; the Xinsir SDXL pose card uses 1.0 and warns that thin pose lines can be unstable. Make the control image the render size; behaviour at other sizes is unchecked.

## LoRAs

Each entry in `loras` must match the row's family, such as an SDXL LoRA on an SDXL row. Start at the weight the LoRA's card gives and include its trigger words; without a card value, 0.7 to 1 is a common community range, not a rule. The result names each file and weight applied.

## Fields some builds add

Use these only when the live `image_generate` schema lists them.

- `sampler` and `scheduler`: the engine's recipes keep Euler for the distilled rows. On SD and SDXL rows, `dpm++2m` with `karras` at 20 to 30 steps is a popular community pairing. Ancestral samplers such as `euler_a` and `dpm++2s_a` add noise at every step, so the image keeps changing as the step count changes; tune a fixed seed with a non-ancestral one.
- `cfg`: defaults to the row's catalogue value. At 1, `negative_prompt` has no effect; the distilled rows are made to run at 1.
- `clip_skip`: SD 1.x and SDXL only; set it when a checkpoint's card asks for it.
- `embeddings`: textual inversions for SD 1.x, 2.x and SDXL. A negative embedding's token goes in `negative_prompt`, which needs CFG above 1.
- `upscale` and `upscaler`: a RealESRGAN row from `media_models` enlarges the saved image, `realesrgan-x4plus` for general images and `realesrgan-x4plus-anime-6b` for anime and illustration. It reconstructs detail, softens hard pixel edges and can add colours outside a palette.
- `workflow`, `dry` and `export_workflow`: `workflow` fills the request from a ComfyUI workflow JSON, with fields you give taking precedence, and the result lists which node became which field; `dry` returns that mapping without rendering, so check it first; `export_workflow` writes the request as a ComfyUI API workflow.
