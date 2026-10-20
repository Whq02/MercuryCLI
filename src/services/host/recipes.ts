type HostRecipeVerificationKind = 'measured' | 'documented' | 'community' | 'unverified'

interface HostRecipeVerified {
  by: HostRecipeVerificationKind
  on?: string
  note?: string
  source: string
}

export interface HostRecipe {
  id: string
  label: string
  model: string
  gpu: string
  count: number
  vramGb: number
  diskGb: number
  image: string
  cuda: string
  flags: string[]
  source: string
  verification: string
  verified: HostRecipeVerified
  pythonInstall?: string
  context?: number
  contextPerSlot?: number
  environment?: Record<string, string>
  files?: Record<string, string>
  engine?: 'llamacpp'
  imageSource?: string
  install?: string
  weightFile?: string
  include?: string
}

const flashSource = 'https://docs.sglang.io/cookbook/autoregressive/GLM/GLM-5.3-Flash'
const glmSource = 'https://docs.sglang.io/cookbook/autoregressive/GLM/GLM-5.3'
const dsSource = 'https://docs.sglang.io/cookbook/autoregressive/DeepSeek/DeepSeek-V4_1'
const qwenSource = 'https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8-27B'
const mtp = ['--speculative-algorithm', 'EAGLE', '--speculative-num-steps', '5', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '6']
const pythonInstall = 'python3 -m venv /workspace/mercury-host/venv && /workspace/mercury-host/venv/bin/pip install --upgrade pip uv && /workspace/mercury-host/venv/bin/uv pip install --python /workspace/mercury-host/venv/bin/python --prerelease=allow sglang'
const llamaInstall = 'export PATH=/usr/local/cuda/bin:$PATH CUDACXX=/usr/local/cuda/bin/nvcc && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y pciutils build-essential cmake curl libcurl4-openssl-dev git python3-venv && python3 -m venv /workspace/mercury-host/hf && /workspace/mercury-host/hf/bin/pip install -U huggingface_hub && if ! test -d /workspace/mercury-host/llama.cpp; then git clone https://github.com/ggml-org/llama.cpp /workspace/mercury-host/llama.cpp; fi && git -C /workspace/mercury-host/llama.cpp checkout 3bb63cbcbfb62056c84fe9e521b0f3d756d29c32 && cmake /workspace/mercury-host/llama.cpp -B /workspace/mercury-host/llama.cpp/build -DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=ON -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc -DCMAKE_CUDA_ARCHITECTURES="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -n 1 | tr -d .)" && cmake --build /workspace/mercury-host/llama.cpp/build --config Release -j --target llama-server'

export const HOST_RECIPES: readonly HostRecipe[] = [
  {
    id: 'glm53-flash-gguf-b300', label: 'GLM-5.3-Flash · UD-Q4_K_XL', model: 'unsloth/GLM-5.3-Flash-GGUF', gpu: 'B300', count: 1, vramGb: 288, diskGb: 300,
    engine: 'llamacpp', image: 'ghcr.io/whq02/mercury-llamacpp@sha256:80f998adbacedc15e9f3c704e3ed3dca5a718fa90de29eb311c2b678a727c9b8', cuda: '13.0', imageSource: 'https://github.com/users/Whq02/packages/container/mercury-llamacpp/1415353988?tag=cuda13-3bb63cb', source: 'https://unsloth.ai/docs/models/glm-5.3-flash', verification: 'llama.cpp (GGUF) · verified on 1× B300 (67 tok/s)',
    verified: { by: 'measured', on: '2026-10-20', note: '1× B300 · upstream llama.cpp 3bb63cbcbfb62056c84fe9e521b0f3d756d29c32 · 67 tok/s single-stream, ~23 tok/s per stream with two busy · 193 GB VRAM · 524,288 ctx across 4 slots (131,072 per slot)', source: 'https://unsloth.ai/docs/models/glm-5.3-flash' },
    context: 131072, contextPerSlot: 131072,
    install: llamaInstall,
    include: '*UD-Q4_K_XL*', weightFile: 'UD-Q4_K_XL/GLM-5.3-Flash-UD-Q4_K_XL-00001-of-00006.gguf',
    flags: ['--n-gpu-layers', 'all', '--jinja', '--ctx-size', '524288', '--parallel', '4', '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--cache-reuse', '256', '--temp', '1.0', '--top-p', '0.95', '--chat-template-kwargs', '{"reasoning_effort":"max"}'],
  },
  {
    id: 'nemotron35-super-gguf-rtx-pro-6000', label: 'Nemotron 3.5 Super VL 120B · UD-Q3_K_XL', model: 'unsloth/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-GGUF', gpu: 'RTX PRO 6000', count: 1, vramGb: 96, diskGb: 120,
    engine: 'llamacpp', image: 'ghcr.io/whq02/mercury-llamacpp@sha256:80f998adbacedc15e9f3c704e3ed3dca5a718fa90de29eb311c2b678a727c9b8', cuda: '13.0', imageSource: 'https://github.com/users/Whq02/packages/container/mercury-llamacpp/1415353988?tag=cuda13-3bb63cb', source: 'https://unsloth.ai/docs/models/nemotron-3.5-super-vl', verification: 'llama.cpp (GGUF) · the road the model card names for RTX PRO 6000 · 65.8 GB, documented minimum 96 GB · GPU run not measured',
    verified: { by: 'documented', note: "NVIDIA's model card names llama.cpp for RTX PRO 6000; Unsloth's 96 GB minimum", source: 'https://unsloth.ai/docs/models/nemotron-3.5-super-vl' },
    context: 131072, contextPerSlot: 131072,
    install: llamaInstall,
    include: '*UD-Q3_K_XL*', weightFile: 'UD-Q3_K_XL/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-UD-Q3_K_XL-00001-of-00003.gguf',
    flags: ['--n-gpu-layers', 'all', '--jinja', '--ctx-size', '524288', '--parallel', '4', '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--cache-reuse', '256', '--temp', '1.0', '--top-p', '0.95', '--top-k', '0', '--min-p', '0.0', '--reasoning-format', 'deepseek'],
  },
  {
    id: 'glm53-flash-b200-community', label: 'GLM-5.3-Flash · NVFP4', model: 'RadixArk/GLM-5.3-Flash-NVFP4', gpu: 'B200', count: 4, vramGb: 183, diskGb: 300,
    image: 'lmsysorg/sglang:glm-5.3-flash', cuda: '13.0', source: 'https://github.com/caiovicentino/glm-5.3-flash-sglang-4x-b200', verification: 'community recipe · SGLang prefill in thousands of tok/s vs 1-GPU llama.cpp (not measured)',
    verified: { by: 'community', note: 'community 4× B200 SGLang NVFP4 recipe · SGLang prefill in thousands of tok/s vs 1-GPU llama.cpp (not measured)', source: 'https://github.com/caiovicentino/glm-5.3-flash-sglang-4x-b200' },
    context: 524288,
    environment: { PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True' },
    files: { 'adaptive.json': JSON.stringify({ '1': { candidate_steps: [3], up_hysteresis: 0, down_hysteresis: 0, ceiling_coeff: 0 }, '40': { candidate_steps: [2], up_hysteresis: 0, down_hysteresis: 0, ceiling_coeff: 0 } }) },
    flags: ['--quantization', 'modelopt_fp4', '--tp-size', '4', '--ep-size', '4', '--context-length', '524288', '--dsa-prefill-backend', 'trtllm', '--dsa-decode-backend', 'trtllm', '--kv-cache-dtype', 'fp8_e4m3', '--moe-runner-backend', 'flashinfer_cutlass', '--speculative-algorithm', 'EAGLE', '--speculative-num-steps', '3', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '4', '--speculative-adaptive', '--speculative-adaptive-config', '/workspace/mercury-host/glm53-flash-b200-community/adaptive.json', '--reasoning-parser', 'glm45', '--tool-call-parser', 'glm47', '--mem-fraction-static', '0.75', '--max-mamba-cache-size', '700', '--cuda-graph-max-bs-decode', '96', '--max-running-requests', '96', '--chunked-prefill-size', '4096', '--max-prefill-tokens', '4096', '--prefill-decode-interval', '2', '--image-processor-backend', 'pil', '--schedule-policy', 'lpm', '--enable-cache-report', '--enable-multimodal', '--enable-metrics', '--media-url-max-file-size-mb', '1024'],
  },
  ...[{ gpu: 'RTX PRO 6000', vramGb: 96, chunk: '2048' }, { gpu: 'H200', vramGb: 141, chunk: '32768' }].map(hw => ({
    id: 'qwen38-27b-' + hw.gpu.toLowerCase().replaceAll(' ', '-'), label: 'Qwen3.8-27B · FP8', model: 'Qwen/Qwen3.8-27B-FP8', gpu: hw.gpu, count: 1, vramGb: hw.vramGb, diskGb: 80,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: qwenSource, verification: 'verified',
    verified: { by: 'documented' as const, note: 'verified', source: qwenSource },
    pythonInstall,
    flags: ['--trust-remote-code', '--kv-cache-dtype', 'fp8_e4m3', '--mem-fraction-static', '0.85', '--attention-backend', 'flashinfer', '--chunked-prefill-size', hw.chunk, ...(hw.gpu === 'H200' ? ['--max-prefill-tokens', '32768'] : []), '--reasoning-parser', 'qwen3', '--tool-call-parser', 'qwen3_coder'],
  })),
  ...[{ gpu: 'B300', count: 8, vramGb: 288, verification: 'in-progress' }, { gpu: 'GB300', count: 4, vramGb: 288, verification: 'verified' }].map(hw => ({
    id: 'glm53-flash-' + hw.gpu.toLowerCase(), label: 'GLM-5.3-Flash · FP8', model: 'zai-org/GLM-5.3-Flash', ...hw, diskGb: 450, image: 'lmsysorg/sglang:latest', cuda: '13.0', source: flashSource,
    verified: { by: 'documented' as const, note: hw.verification, source: flashSource },
    pythonInstall,
    flags: ['--tp-size', String(hw.count), '--dsa-prefill-backend', 'trtllm', '--dsa-decode-backend', 'trtllm', '--kv-cache-dtype', 'fp8_e4m3', '--moe-runner-backend', 'flashinfer_trtllm', ...mtp, '--reasoning-parser', 'glm45', '--tool-call-parser', 'glm47'],
  })),
  ...[{ gpu: 'B200', vramGb: 192 }, { gpu: 'B300', vramGb: 288 }, { gpu: 'GB300', vramGb: 288 }].map(hw => ({
    id: 'deepseek41-' + hw.gpu.toLowerCase(), label: 'DeepSeek-V4.1-Flash-1017', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', ...hw, count: 4, diskGb: 650,
    image: 'lmsysorg/sglang:dev-dsv41', cuda: '13.0', source: dsSource, verification: 'verified',
    verified: { by: 'documented' as const, note: 'verified', source: dsSource },
    flags: ['--trust-remote-code', '--tp', '4', '--ep-size', '4', '--mem-fraction-static', '0.8', '--speculative-algorithm', 'DSPARK', '--speculative-dspark-block-size', '5', '--cuda-graph-max-bs-decode', '64', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto'],
  })),
  ...[{ gpu: 'H200', count: 8, vramGb: 141 }, { gpu: 'B200', count: 8, vramGb: 192 }, { gpu: 'B300', count: 8, vramGb: 288 }, { gpu: 'GB300', count: 4, vramGb: 288 }].map(hw => ({
    id: 'glm53-' + hw.gpu.toLowerCase(), label: 'GLM-5.3 · FP8', model: 'zai-org/GLM-5.3', ...hw, diskGb: 950,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: glmSource, verification: 'verified',
    verified: { by: 'documented' as const, note: 'verified', source: glmSource },
    pythonInstall,
    flags: ['--tp', String(hw.count), ...mtp, '--mem-fraction-static', hw.count === 4 ? '0.85' : '0.8', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto'],
  })),
]

export function hostRecipeVerificationWord(recipe: HostRecipe): HostRecipeVerificationKind {
  return recipe.verified.by
}

export function formatHostOfferLabel(recipe: HostRecipe, detail: string): string {
  return `${recipe.label} · ${detail} · ${recipe.verified.by}`
}

export function recipeFits(recipe: HostRecipe, name: string, memoryGb: number, count: number): boolean {
  const hardware = name.toUpperCase().replaceAll('NVIDIA', '').trim()
  const matches = recipe.gpu === 'RTX PRO 6000' ? hardware.includes('RTX PRO 6000') && hardware.includes('BLACKWELL') : new RegExp('(^|[^A-Z0-9])' + recipe.gpu + '([^A-Z0-9]|$)').test(hardware)
  return matches && memoryGb >= recipe.vramGb && count >= recipe.count
}
