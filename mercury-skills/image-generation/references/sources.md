# Sources

Access dates below are 2026-10-30. Publisher examples describe their own APIs; Mercury call shapes and defaults come from the shipped code. Re-read the relevant card when selecting a new model or adapter. A website refusal is not permission to bypass it; use another publisher source or leave the advice unspecified.

## Publisher cards

| Key | Source, read 2026-10-30 | What it supports here |
| --- | --- | --- |
| Z | [Tongyi-MAI: Z-Image Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo/blob/main/README.md) | 9 inference steps yielding 8 forwards, Diffusers guidance 0, descriptive prompt example and English/Chinese lettering. This is not a recommendation to set Mercury CFG to 0. |
| K | [Black Forest Labs: FLUX.2 Klein 4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/blob/main/README.md) | 4 steps, guidance 1, text generation and reference editing. The card's multi-reference interface is not exposed by Mercury's single reference field. |
| Q | [Qwen: Qwen-Image 2.1](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/README.md) | 40-step examples, editing and exact RGBA prompt wording. Its current examples omit guidance; they do not settle a runtime CFG comparison. |
| QT | [Qwen: Qwen-Image 2.1 Turbo](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/main/README.md) | Saved eight-step schedule, CFG 1, detailed prompt and editing examples. |
| S | [Stability AI: SDXL base 1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/README.md) | Standalone base generation, CLIP encoders; no requirement to add a refiner to Mercury's row. |
| P | [Pixel Party XL publisher](https://huggingface.co/pixelparty/pixel-party-xl/blob/main/README.md) | Prompt suffix, nearest-neighbour downsize 8, 25-step example, negative prompt example, init-image advice, no refiner. |
| C | [Diffusers SDXL Canny](https://huggingface.co/diffusers/controlnet-canny-sdxl-1.0/blob/main/README.md), [Diffusers SDXL depth](https://huggingface.co/diffusers/controlnet-depth-sdxl-1.0/blob/main/README.md), [Xinsir SDXL pose](https://huggingface.co/xinsir/controlnet-openpose-sdxl-1.0/blob/main/README.md) | Canny/depth conditioning 0.5 recommended for generalisation; pose example 1.0. These are per-weight examples, not a universal ControlNet range. |
| U | [Real-ESRGAN publisher model list](https://github.com/xinntao/Real-ESRGAN/blob/master/docs/model_zoo.md) | Native 4× general-image and anime/illustration models. No pixel-grid-preservation claim; the palette/grid trade-off comes from Mercury's postprocessing code. |
| V | [Wan 2.2 TI2V 5B](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B/blob/main/README.md), [MiniMax H3](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/README.md) | Text/image-to-video, 24 fps; MiniMax audio-video capabilities. Mercury's minimum sizes, frame arithmetic, deadlines and single-image interface come from its own code, not the larger publisher interfaces. |

## Runtime code at the shipped pin

All three entries were read 2026-10-30 at stable-diffusion.cpp revision e41fbcf455e0fbb45e08bd535b00d6cba865e921, the runtime pin in Mercury's media manifest. These are implementation facts for that pin, not advice from training memory.

- **R1:** [Z-Image recipe](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf455e0fbb45e08bd535b00d6cba865e921/examples/server/recipes/z-image-turbo.json) and [Klein recipe](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf455e0fbb45e08bd535b00d6cba865e921/examples/server/recipes/flux2-klein-4b.json): runtime CFG 1, Euler and 9/4 steps.
- **R2:** [Classifier-free guidance](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf455e0fbb45e08bd535b00d6cba865e921/src/runtime/guidance.cpp#L143-L176) and [image schedule](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf455e0fbb45e08bd535b00d6cba865e921/src/pipeline/image.cpp#L159-L214): the CFG-1 cancellation and truncated denoising schedule. Neither establishes a visually best strength for an edit.
- **R3:** [Attention parser](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf455e0fbb45e08bd535b00d6cba865e921/src/core/util.cpp#L875-L1003) and [conditioners](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf455e0fbb45e08bd535b00d6cba865e921/src/conditioning/conditioner.hpp): round/square bracket weights and parsing in text conditioning. This is syntax support, not a publisher claim that weighting improves all families or that literal brackets will render exactly.

## Shipped product and engine

Read 2026-10-30 from Mercury candidate 4ce9603d5d and media 0.2.6 source revision d983eac3cd7309015c3ec0c536d3920db6888182. File paths here name repository source, not files extracted with this skill.

- **E, calls and rows:** `src/extensions/bundled/mercury-media/server/server.js` registrations and Zod input schemas, plus `src/extensions/bundled/mercury-media/server/catalog.json` and `src/extensions/bundled/mercury-media/server/manifest.json`. Readable engine source: `src/server.ts` (common inputs 41-50, image schema 341-359, video schema 470-480, render/postprocessing 146-339); `src/pipeline-schema.ts` (steps 8-42, tool inputs 114-122); `src/sampling.ts`; `src/storage.ts`; `src/recipes.ts`. These own accepted fields, units, enums, default values, size rules and reference conditioning.
- **E, extras:** engine `src/upscale.ts` (6-43), `src/control.ts`, `src/png.ts`, `src/embeddings.ts`, `src/user-models.ts` (128-156). These own family checks, token insertion, pixel sampling, palette order, native upscale passes and RGB/alpha resizing. The grid/colour warning is a consequence of that processing order, not a measured pixel-art render.
- **E, editable work:** engine `src/pipeline.ts`, `src/pipeline-workflow.ts` (60-121) and `src/remote-pipeline.ts` (23-147); Mercury `src/services/media/pipeline.ts`, `src/services/media/generation.ts`, `src/services/media/host.ts`, `src/services/media/setup.ts` and `docs/MEDIA.md`. These own saved records, reuse, export limits, file transfers and the media details. The project directory is not sent wholesale.
- **A:** `src/tools/AsepriteTool/AsepriteTool.ts`, `src/tools/AsepriteTool/prompt.ts` and `docs/ASEPRITE-BRIDGE.md`: batch operations, native sprite editing, nearest-neighbour render-back, palette checks, sheet export and Lua import with permission.

Unestablished advice is not a recipe: no cross-size FLUX.2 LoRA compatibility promise, no universal LoRA weight or identity-preserving strength, no extra-step quality recommendation for distilled rows, and no measured claim that one sampler or upscaler looks best. Read the specific adapter card and inspect the result instead.
