# Model families

Source basis: media 0.2.9 (`src/extensions/bundled/mercury-media/server/manifest.json` and catalog.json, CODE inspected 2026-11-13; publisher cards read 2026-10-30 in `references/sources.md`). Read the connected `media_models` row before applying these defaults.

## Guidance, strength and brackets

- **CFG:** at `cfg` 1, classifier-free guidance reduces to the positive prediction, so `negative_prompt` has no effect on CFG-1 rows (`z-image-turbo`, `flux2-klein-4b`, `qwen-image-21-turbo`). `sdxl-base-1.0` and `pixel-party-xl` default to 5, `qwen-image-21` to 6; negative prompts apply there. Diffusers guidance arguments do not map 1:1 to Mercury `cfg`. [R1, R2, E]
- **Strength:** with `reference_image` and `strength` < 1, the runtime runs floor(steps * strength) + 1 denoising steps (full schedule at 1; coarse on 4-step Klein, where 0.3 and 0.45 both run 2 steps). Lower `strength` preserves more of the source, including inside a `mask`. [R2, E]
- **Brackets:** the prompt parser weights `(word)` by 1.1, `(word:1.3)` by 1.3 and `[word]` by 1/1.1 across CLIP and LLM conditioners. Prefer plain prose and inspect rendered text visually. [R3]

## Image rows

| Row | Mercury defaults and usage | Sources |
| --- | --- | --- |
| `z-image-turbo` | 9 steps, CFG 1, multiple 16. Keep runtime CFG 1 (publisher's Diffusers guidance 0 = 8 forwards). Supports descriptive prose and English/Chinese text. Denoises references without separate reference conditioning; omit `negative_prompt` at CFG 1. | Z, R1, E |
| `flux2-klein-4b` | 4 steps, CFG 1, multiple 16. Accepts one `reference_image` (conditioning + denoising); state the edit in `prompt`. Omit `negative_prompt` at CFG 1. | K, R1, E |
| `qwen-image-21-turbo` | 8 steps, CFG 1, multiple 32. Omit `steps` and `scheduler` to keep its fixed 8-step sigma schedule (changing `steps` alone is refused). Supports one `reference_image` and prompt-directed RGBA; omit `negative_prompt` at CFG 1. | QT, E |
| `qwen-image-21` | 40 steps, CFG 6, multiple 32. Negative prompts apply. Publisher RGBA phrasing: “This is an RGBA image with transparency. <description>. The image has alpha channel and the background is transparent.” | Q, E |
| `sdxl-base-1.0` | 20 steps, CFG 5, 1024x1024, multiple 64 (base only, no refiner). Supports `negative_prompt`, denoising references and SDXL adapters. | S, E |
| `pixel-party-xl` | 25 steps, CFG 5, 1024x1024, multiple 64. Automatically appends “. in pixel art style” and applies 8x nearest-neighbour `downsize` to 128x128 while keeping the full render; publisher negative example: “mixels. amateur. multiple”. | P, E |

**CODE inspected 2026-11-13:** `pixel-party-xl` carries publisher notice “please do not host this model” in `src/extensions/bundled/mercury-media/server/catalog.json` (do not copy weights to a remote host without checking publisher terms); Qwen rows use Qwen Research License (non-commercial). Check memory before raising dimensions above 1024, and read each custom SD checkpoint's own card rather than copying another row's defaults. [P, Q, QT, E]

## ControlNet, LoRAs, embeddings and upscalers

- **`control`:** SD 1.5 and SDXL (including `pixel-party-xl`) only; match `controlnet-sd1-*` or `controlnet-sdxl-*` at the target render size. `canny` extracts edges from a PNG; `depth` and `pose` require precomputed maps. Mercury defaults `control.strength` to 0.9 (Diffusers canny/depth cards suggest 0.5; Xinsir pose uses 1.0). [C, E]
- **`loras` (`{path, weight}`):** local paths or supported Hugging Face/Civitai URLs; family mismatches refuse (SD 1.x, SD 2.x, SDXL/Pixel Party, SD 3, Z-Image, Klein->FLUX.2, Qwen 2.1). Match the publisher's exact base model, trigger words and weight (do not assume larger FLUX.2 LoRAs fit Klein 4B). [E]
- **`embeddings` (`{path, token?}`):** textual inversions for SD 1.x, SD 2.x and SDXL (checked by tensor width; defaults `token` to filename stem and appends to `prompt` if absent from both prompts; negative embeddings require CFG > 1). Changing embeddings reloads the engine; omit `embeddings` to clear them. `clip_skip` applies to SD 1.x and SDXL only. [E]
- **Sampling & `upscale`:** omit `sampler` and `scheduler` unless the model card or experiment requires them. `upscale` (integer factor) + optional `upscaler` (`realesrgan-x4plus` general, `realesrgan-x4plus-anime-6b` anime/illustration, both native 4x) run after `palette` and bilinearly resize non-native factors; use integer nearest-neighbour scaling instead for crisp pixel grids. [U, E]
