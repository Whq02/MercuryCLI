# Sources

Publisher card readings below date to 2026-10-30; Mercury schemas and defaults come from the shipped code. Re-read the publisher card when adopting a new model or adapter; respect robots/access refusals.

## Publisher cards (read 2026-10-30)

| Key | Source | Facts used |
| --- | --- | --- |
| Z | [Tongyi-MAI: Z-Image Turbo](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo/blob/main/README.md) | 9 steps (8 forwards), Diffusers guidance 0 (keep Mercury `cfg` 1), descriptive and English/Chinese text examples. |
| K | [Black Forest Labs: FLUX.2 Klein 4B](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/blob/main/README.md) | 4 steps, guidance 1, text-to-image and reference editing (Mercury exposes single `reference_image`). |
| Q | [Qwen: Qwen-Image 2.1](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/README.md) | 40-step generation/editing and RGBA transparency prompt wording. |
| QT | [Qwen: Qwen-Image 2.1 Turbo](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo/blob/main/README.md) | Fixed 8-step schedule, CFG 1, detailed prompt and editing examples. |
| S | [Stability AI: SDXL base 1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/README.md) | Standalone base generation with dual CLIP encoders (no refiner required). |
| P | [Pixel Party XL](https://huggingface.co/pixelparty/pixel-party-xl/blob/main/README.md) | “. in pixel art style” suffix, 8x nearest-neighbour downsize, 25 steps, negative prompt and init-image guidance, no-hosting request. |
| C | [Diffusers SDXL Canny](https://huggingface.co/diffusers/controlnet-canny-sdxl-1.0/blob/main/README.md), [Depth](https://huggingface.co/diffusers/controlnet-depth-sdxl-1.0/blob/main/README.md), [Xinsir Pose](https://huggingface.co/xinsir/controlnet-openpose-sdxl-1.0/blob/main/README.md) | Per-weight conditioning examples (0.5 canny/depth, 1.0 pose). |
| U | [Real-ESRGAN model zoo](https://github.com/xinntao/Real-ESRGAN/blob/master/docs/model_zoo.md) | Native 4x general (`realesrgan-x4plus`) and anime (`realesrgan-x4plus-anime-6b`) weights. |
| V | [Wan 2.2 TI2V 5B](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B/blob/main/README.md), [MiniMax H3](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/README.md) | Text/image-to-video at 24 fps; Mercury owns frame formulas, minimum sizes and single-image schema. |

## Pinned runtime (stable-diffusion.cpp e41fbcf455e0fbb45e08bd535b00d6cba865e921, read 2026-10-30)

- **R1:** [Z-Image](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf455e0fbb45e08bd535b00d6cba865e921/examples/server/recipes/z-image-turbo.json) and [Klein](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf455e0fbb45e08bd535b00d6cba865e921/examples/server/recipes/flux2-klein-4b.json) recipes (CFG 1, Euler, 9 and 4 steps).
- **R2:** [Guidance](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf455e0fbb45e08bd535b00d6cba865e921/src/runtime/guidance.cpp#L143-L176) and [image schedule](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf455e0fbb45e08bd535b00d6cba865e921/src/pipeline/image.cpp#L159-L214) (CFG-1 positive-only reduction and floor(steps * strength) + 1 schedule).
- **R3:** [Attention parser](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf455e0fbb45e08bd535b00d6cba865e921/src/core/util.cpp#L875-L1003) and [conditioners](https://github.com/leejet/stable-diffusion.cpp/blob/e41fbcf455e0fbb45e08bd535b00d6cba865e921/src/conditioning/conditioner.hpp) (round 1.1x and square 1/1.1x bracket weights).

## Shipped product and engine

**CODE inspected 2026-11-13:** `src/extensions/bundled/mercury-media/server/manifest.json` pins media 0.2.9 and runtime master-1015-e41fbcf.

- **E, schemas & rows:** `src/extensions/bundled/mercury-media/server/server.js`, `src/extensions/bundled/mercury-media/server/catalog.json`, `src/extensions/bundled/mercury-media/server/manifest.json` (engine source: `src/server.ts`, `src/pipeline-schema.ts`, `src/sampling.ts`, `src/storage.ts`, `src/recipes.ts`, `src/upscale.ts`, `src/control.ts`, `src/png.ts`, `src/embeddings.ts`, `src/user-models.ts`).
- **E, pipelines & remote:** engine `src/pipeline.ts`, `src/pipeline-workflow.ts`, `src/remote-pipeline.ts`; Mercury `src/services/media/pipeline.ts`, `src/services/media/generation.ts`, `src/services/media/host.ts`, `src/services/media/setup.ts`, `docs/MEDIA.md`.
- **A, sprite editing:** `src/tools/AsepriteTool/AsepriteTool.ts`, `src/tools/AsepriteTool/prompt.ts`, `docs/ASEPRITE-BRIDGE.md`.
