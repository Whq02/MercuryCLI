# Model families

Checked 2026-10-30 against the publisher cards and media 0.2.6 code listed in `references/sources.md`. These are starting settings, not visual guarantees. No cross-family strength recipe or extra-step quality claim is assumed.

## Guidance, strength and brackets

- **CFG:** the runtime's ordinary classifier-free guidance at `cfg` 1 reduces to the positive prediction, so `negative_prompt` does not guide the bundled CFG-1 rows. SDXL and Pixel Party default to 5; Qwen base to 6. Negative prompts can affect those. A publisher's Diffusers guidance argument is not automatically the same as Mercury's CFG field. [R1, R2, E]
- **Strength:** with a reference and `strength` below 1, the pinned runtime uses floor(steps × strength) + 1 denoising steps; at 1 it keeps the full schedule. Four-step Klein is coarse: 0.3 and 0.45 both leave two steps. This is a schedule fact, not a tested identity-preservation recipe. Lower strength keeps more of the source; inside a mask it still controls how much can change. [R2, E]
- **Brackets:** the runtime attention parser multiplies `(word)` by 1.1, `(word:1.3)` by the stated weight and `[word]` by 1/1.1. The CLIP and LLM conditioning paths use this parser on prompt text; the publisher cards do not establish that weighting improves every family. Prefer plain descriptions. Literal-bracket rendering and escaping have not been visually checked here; inspect requested lettering rather than promising exact typography. [R3]

## Image rows

| Row | Mercury defaults and how to use them | Sources |
| --- | --- | --- |
| `z-image-turbo` | 9 steps, runtime CFG 1, dimension multiple 16. The publisher's 9-step example means 8 model forwards and uses Diffusers guidance 0; keep Mercury's runtime recipe, not that API number. Its example uses descriptive prose and bilingual text. A reference is denoised, not added as reference conditioning. Omit negative prompts at the default CFG. | Z, R1, E |
| `flux2-klein-4b` | 4 steps, CFG 1, multiple 16. The card's example uses 4 and 1 too. Text-to-image and reference editing share the model. Mercury accepts one reference, not the card's multi-reference interface. State the edit in words; the engine also uses the image for reference conditioning. No numeric strength recipe for identity or a masked fix is established here. | K, R1, E |
| `qwen-image-21-turbo` | 8 steps, CFG 1, multiple 32. Keep the saved schedule by omitting `steps` and `scheduler`; a different step count is refused while that schedule applies. The card demonstrates detailed prompts, editing and CFG 1. Mercury supports one reference and prompt-directed RGBA. Omit negative prompts at the default CFG. | QT, E |
| `qwen-image-21` | 40 steps, catalogue CFG 6, multiple 32. The current card demonstrates 40 steps without specifying CFG; it does not establish a better CFG for this runtime. Keep the catalogue value unless deliberately testing a change. Negative prompts apply at 6. The card's transparency form is “This is an RGBA image with transparency. <description>. The image has alpha channel and the background is transparent.” | Q, E |
| `sdxl-base-1.0` | 20 steps, CFG 5, 1024×1024, multiple 64. The card supports using the base alone; Mercury's row has no refiner. Use positive and negative prompts, denoising references and compatible SDXL extras. These step/CFG values are Mercury's recipe, not a claim that the card prescribes them. | S, E |
| `pixel-party-xl` | 25 steps, CFG 5, 1024×1024, multiple 64. The card asks for “. in pixel art style”, 8× nearest-neighbour reduction, no refiner and says init images help. Mercury appends that suffix and downsizes to 128×128, keeping the full render. Its card demonstrates the negative prompt “mixels. amateur. multiple”. | P, E |

Qwen's cards demonstrate larger dimensions than Mercury's default 1024. Larger sizes cost more memory and time; read the row and current memory before changing size. The cards' hardware timings are not Mercury completion estimates. Registered SD checkpoints use the detected family's recipe: read that checkpoint's card rather than inheriting a different row's settings. [Q, QT, E]

## ControlNet

`control` is for SD 1.5 or SDXL only, including Pixel Party. Choose the matching installed `controlnet-sd1-*` or `controlnet-sdxl-*` row. Canny computes edges from a PNG; depth and pose need prepared maps, not an ordinary photo for an absent detector. Use a map at the intended render size. Mercury defaults `control.strength` to 0.9; Diffusers' SDXL canny/depth cards recommend 0.5 for generalisation, and Xinsir's pose example uses 1.0. Those are starting points for those weights, not defaults to impose on every ControlNet. [C, E]

## LoRAs and embeddings

- `loras` entries have `path` and `weight`. Read the LoRA publisher's base model, trigger words and weight before applying it. Local files and supported Hugging Face/Civitai download links are accepted; a family mismatch is refused. No universal 0.7-to-1 recipe is retained. [E]
- Engine family matches are SD 1.x to SD 1.x, SD 2.x to SD 2.x, SDXL/Pixel Party to SDXL, SD 3 to SD 3, Z-Image to Z-Image, Klein to FLUX.2, and Qwen 2.1 to Qwen 2.1. A family match alone does not establish tensor-size or distilled/base compatibility. In particular, do not promise that a larger FLUX.2 LoRA loads on Klein 4B. Prefer an adapter whose publisher names the exact base. [E]
- `embeddings` are textual inversions for SD 1.x, SD 2.x and SDXL only, checked by tensor width. Each has `path` and optional `token`; without a token the filename stem is used. Put the token in `prompt` or `negative_prompt`. If absent from both it is appended to the positive prompt. A negative embedding needs effective negative guidance. Each request selects its set; omit the field to remove it on the next call. A changed set reloads the engine and costs time. [E]
- `clip_skip` is for SD 1.x and SDXL; use the checkpoint card's value, not an SDXL setting on a language-model encoder. [E]

## Sampling and enlargement

Leave `sampler` and `scheduler` omitted unless the selected model's card or the user's experiment calls for them. The accepted enum names and the effect of replacing Qwen's schedule are in `references/tools.md`. A popular pairing from another UI is not a per-family recommendation. [E, R1]

For photos and illustrations, `upscale` selects a whole-number enlargement and optional `upscaler` names the row. `realesrgan-x4plus` is the publisher's general-image model; `realesrgan-x4plus-anime-6b` is for anime/illustration, both native 4×. Mercury runs this after palette mapping and can bilinearly resize RGB for non-native factors. Therefore the final image is not constrained to the earlier palette or pixel grid. A particular edge-softening result still needs inspection; it is not a measured outcome of this pass. Use nearest-neighbour enlargement for crisp pixel art. [U, E]
