type HostRecipeVerificationKind = 'measured' | 'documented' | 'community' | 'unverified'

interface HostRecipeVerified {
  by: HostRecipeVerificationKind
  on?: string
  note?: string
  source: string
}

export interface HostWeightManifest {
  model: string
  include: string
  revision: string
  files: { path: string; size: number; sha256?: string; git?: string }[]
}

export interface HostRecipe {
  id: string
  label: string
  model: string
  gpu: string
  count: number
  nodes?: number
  vramGb: number
  diskGb: number
  weightsGb: number
  image: string
  cuda: string
  flags: string[]
  source: string
  verification: string
  verified: HostRecipeVerified
  efforts?: { levels: string[]; verified: HostRecipeVerified }
  pythonInstall?: string
  context?: number
  contextPerSlot?: number
  kvBytesPerToken?: { bytes: number; conversationBytes?: number; maxContext: number; cacheType: string; verified: HostRecipeVerified }
  environment?: Record<string, string>
  files?: Record<string, string>
  engine?: 'llamacpp' | 'vllm'
  imageSource?: string
  install?: string
  weightFile?: string
  mmproj?: string
  include?: string
  weightManifest?: HostWeightManifest
}

const flashSource = 'https://docs.sglang.io/cookbook/autoregressive/GLM/GLM-5.3-Flash'
const glmSource = 'https://docs.sglang.io/cookbook/autoregressive/GLM/GLM-5.3'
const dsSource = 'https://docs.sglang.io/cookbook/autoregressive/DeepSeek/DeepSeek-V4_1'
const qwenSource = 'https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8-27B'
const kimiSource = 'https://docs.sglang.io/cookbook/autoregressive/Moonshotai/Kimi-K3'
const qwenMaxSource = 'https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8'
const dsProSource = 'https://docs.sglang.io/cookbook/autoregressive/DeepSeek/DeepSeek-V4'
const mimoSource = 'https://docs.sglang.io/cookbook/autoregressive/Xiaomi/MiMo-V2.6'
const mistralSource = 'https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512'
const mtp = ['--speculative-algorithm', 'EAGLE', '--speculative-num-steps', '5', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '6']
const pythonInstall = 'python3 -m venv /workspace/mercury-host/venv && /workspace/mercury-host/venv/bin/pip install --upgrade pip uv && /workspace/mercury-host/venv/bin/uv pip install --python /workspace/mercury-host/venv/bin/python --prerelease=allow sglang'
export const LLAMACPP_ENGINE_SHA = '184f6536024668e8908ab8c86033d56708e62b40'
export const LLAMACPP_ENGINE_IMAGE = 'ghcr.io/whq02/mercury-llamacpp@sha256:f187c39c119011346722a5a9ae6ad216f1e748637f04213912e0bfd044952251'
const llamaImageSource = 'https://github.com/users/Whq02/packages/container/mercury-llamacpp/1432523828?tag=cuda13-' + LLAMACPP_ENGINE_SHA.slice(0, 7)
const llamaInstall = 'export PATH=/usr/local/cuda/bin:$PATH CUDACXX=/usr/local/cuda/bin/nvcc && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y pciutils build-essential cmake curl libcurl4-openssl-dev git python3-venv && python3 -m venv /workspace/mercury-host/hf && /workspace/mercury-host/hf/bin/pip install -U huggingface_hub && if ! test -d /workspace/mercury-host/llama.cpp; then git clone https://github.com/ggml-org/llama.cpp /workspace/mercury-host/llama.cpp; fi && git -C /workspace/mercury-host/llama.cpp checkout ' + LLAMACPP_ENGINE_SHA + ' && cmake /workspace/mercury-host/llama.cpp -B /workspace/mercury-host/llama.cpp/build -DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=ON -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc -DCMAKE_CUDA_ARCHITECTURES="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -n 1 | tr -d .)" && cmake --build /workspace/mercury-host/llama.cpp/build --config Release -j --target llama-server'

function withPrefixCaching(recipes: readonly HostRecipe[]): HostRecipe[] {
  return recipes.map(recipe => {
    const flags = recipe.engine === 'llamacpp' ? ['--cache-prompt']
      : recipe.engine === 'vllm' ? ['--enable-prefix-caching'] : ['--enable-cache-report']
    return { ...recipe, flags: [...recipe.flags, ...flags.filter(flag => !recipe.flags.includes(flag))] }
  })
}

export const HOST_RECIPES: readonly HostRecipe[] = withPrefixCaching([
  {
    id: 'glm53-flash-gguf-b300', label: 'GLM-5.3-Flash · UD-Q4_K_XL', model: 'unsloth/GLM-5.3-Flash-GGUF', weightsGb: 200.844798752, gpu: 'B300', count: 1, vramGb: 288, diskGb: 300,
    engine: 'llamacpp', image: LLAMACPP_ENGINE_IMAGE, cuda: '13.0', imageSource: llamaImageSource, source: 'https://unsloth.ai/docs/models/glm-5.3-flash', verification: 'llama.cpp (GGUF) · verified on 1× B300 (67 tok/s)',
    verified: { by: 'measured', on: '2026-10-20', note: '1× B300 · upstream llama.cpp 3bb63cbcbfb62056c84fe9e521b0f3d756d29c32 · 67 tok/s single-stream, ~23 tok/s per stream with two busy · 193 GB VRAM · 524,288 ctx across 4 slots (131,072 per slot)', source: 'https://unsloth.ai/docs/models/glm-5.3-flash' },
    efforts: { levels: ['low','high','max'], verified: { by: 'documented' as const, on: '2026-10-20', source: 'https://huggingface.co/zai-org/GLM-5.3-Flash/blob/main/chat_template.jinja', note: 'low and high are explicit; all other inputs use max' } },
    context: 131072, contextPerSlot: 131072,
    kvBytesPerToken: { bytes: 11 * (512 + 0 + 3 * 128) * 34 / 32, conversationBytes: 34 * (3 * (4 - 1) * 64 * 128 + 128 * 128 * 64) * 4, maxContext: 1048576, cacheType: 'q8_0', verified: { by: 'documented', on: '2026-10-20', source: 'https://huggingface.co/zai-org/GLM-5.3-Flash/raw/main/config.json', note: 'Computed from config.json for llama.cpp 3bb63cbcbfb62056c84fe9e521b0f3d756d29c32 (glm5-next): per token, each of the 11 deepseek_sparse_attention layers caches a K-only latent (kv_lora_rank 512 + qk_rope_head_dim 0) and a k-pool indexer row (3 × index_head_dim 128) at q8_0, 34/32 bytes: 11 × 896 × 34/32 = 10,472 bytes. Per conversation, whatever its length, each of the 34 linear_attention layers keeps one f32 state (short_conv_kernel_size 4, 64 heads × head_dim 128): 34 × (3 × 3 × 64 × 128 + 128 × 128 × 64) × 4 = 152,633,344 bytes. At 4 × 131,072 that is 5,818 MiB beside 185,437 MiB of weights on the GPU (the GGUF less its skipped MTP block and its CPU-side token embedding).' } },
    install: llamaInstall,
    include: '*UD-Q4_K_XL*', mmproj: 'mmproj-F16.gguf', weightFile: 'UD-Q4_K_XL/GLM-5.3-Flash-UD-Q4_K_XL-00001-of-00006.gguf',
    flags: ['--n-gpu-layers', 'all', '--jinja', '--ctx-size', '524288', '--parallel', '4', '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--cache-reuse', '256', '--temp', '1.0', '--top-p', '0.95', '--chat-template-kwargs', '{"reasoning_effort":"max"}'],
  },
  {
    id: 'nemotron35-super-gguf-rtx-pro-6000', label: 'Nemotron 3.5 Super VL 120B · UD-Q3_K_XL', model: 'unsloth/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-GGUF', weightsGb: 67.495236872, gpu: 'RTX PRO 6000', count: 1, vramGb: 96, diskGb: 120,
    engine: 'llamacpp', image: LLAMACPP_ENGINE_IMAGE, cuda: '13.0', imageSource: llamaImageSource, source: 'https://unsloth.ai/docs/models/nemotron-3.5-super-vl', verification: 'llama.cpp (GGUF) · the engine the model card names for RTX PRO 6000 · 67.5 GB on disk with its vision projector, documented minimum 96 GB · GPU run not measured',
    verified: { by: 'documented', note: "NVIDIA's model card names llama.cpp for RTX PRO 6000; Unsloth's 96 GB minimum", source: 'https://unsloth.ai/docs/models/nemotron-3.5-super-vl' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-20', source: 'https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16/blob/main/chat_template.jinja', note: 'enable_thinking and medium_effort are boolean controls, not named reasoning_effort levels' } },
    context: 131072, contextPerSlot: 131072,
    install: llamaInstall,
    include: '*UD-Q3_K_XL*', mmproj: 'mmproj-BF16.gguf', weightFile: 'UD-Q3_K_XL/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-UD-Q3_K_XL-00001-of-00003.gguf',
    flags: ['--n-gpu-layers', 'all', '--jinja', '--ctx-size', '524288', '--parallel', '4', '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--cache-reuse', '256', '--temp', '1.0', '--top-p', '0.95', '--top-k', '0', '--min-p', '0.0', '--reasoning-format', 'deepseek'],
  },
  {
    id: 'glm53-flash-b200-community', label: 'GLM-5.3-Flash · NVFP4', model: 'RadixArk/GLM-5.3-Flash-NVFP4', weightsGb: 202.951815003, gpu: 'B200', count: 4, vramGb: 180, diskGb: 300,
    image: 'lmsysorg/sglang:glm-5.3-flash', cuda: '13.0', source: 'https://github.com/caiovicentino/glm-5.3-flash-sglang-4x-b200', verification: 'community recipe · SGLang prefill in thousands of tok/s vs 1-GPU llama.cpp (not measured)',
    verified: { by: 'community', note: 'community 4× B200 SGLang NVFP4 recipe · SGLang prefill in thousands of tok/s vs 1-GPU llama.cpp (not measured)', source: 'https://github.com/caiovicentino/glm-5.3-flash-sglang-4x-b200' },
    efforts: { levels: ['low','high','max'], verified: { by: 'documented' as const, on: '2026-10-20', source: 'https://huggingface.co/RadixArk/GLM-5.3-Flash-NVFP4/blob/main/chat_template.jinja', note: 'low and high are explicit; all other inputs use max' } },
    context: 524288,
    environment: { PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True' },
    files: { 'adaptive.json': JSON.stringify({ '1': { candidate_steps: [3], up_hysteresis: 0, down_hysteresis: 0, ceiling_coeff: 0 }, '40': { candidate_steps: [2], up_hysteresis: 0, down_hysteresis: 0, ceiling_coeff: 0 } }) },
    flags: ['--quantization', 'modelopt_fp4', '--tp-size', '4', '--ep-size', '4', '--context-length', '524288', '--dsa-prefill-backend', 'trtllm', '--dsa-decode-backend', 'trtllm', '--kv-cache-dtype', 'fp8_e4m3', '--moe-runner-backend', 'flashinfer_cutlass', '--speculative-algorithm', 'EAGLE', '--speculative-num-steps', '3', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '4', '--speculative-adaptive', '--speculative-adaptive-config', '/workspace/mercury-host/glm53-flash-b200-community/adaptive.json', '--reasoning-parser', 'glm45', '--tool-call-parser', 'glm47', '--mem-fraction-static', '0.75', '--max-mamba-cache-size', '700', '--cuda-graph-max-bs-decode', '96', '--max-running-requests', '96', '--chunked-prefill-size', '4096', '--max-prefill-tokens', '4096', '--prefill-decode-interval', '2', '--image-processor-backend', 'pil', '--schedule-policy', 'lpm', '--enable-cache-report', '--enable-multimodal', '--enable-metrics', '--media-url-max-file-size-mb', '1024'],
  },
  ...[{ gpu: 'RTX PRO 6000', vramGb: 96, chunk: '2048' }, { gpu: 'H200', vramGb: 141, chunk: '32768' }].map(hw => ({
    id: 'qwen38-27b-' + hw.gpu.toLowerCase().replaceAll(' ', '-'), label: 'Qwen3.8-27B · FP8', model: 'Qwen/Qwen3.8-27B-FP8', weightsGb: 30.890049597, gpu: hw.gpu, count: 1, vramGb: hw.vramGb, diskGb: 80,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: qwenSource, verification: 'verified',
    verified: { by: 'documented' as const, note: 'verified', source: qwenSource },
    efforts: { levels: ['low','medium','xhigh'], verified: { by: 'documented' as const, on: '2026-10-20', source: 'https://huggingface.co/Qwen/Qwen3.8-27B-FP8/blob/main/chat_template.jinja', note: 'only low, medium and xhigh are accepted' } },
    pythonInstall,
    flags: ['--trust-remote-code', '--kv-cache-dtype', 'fp8_e4m3', '--mem-fraction-static', '0.85', '--attention-backend', 'flashinfer', '--chunked-prefill-size', hw.chunk, ...(hw.gpu === 'H200' ? ['--max-prefill-tokens', '32768'] : []), '--reasoning-parser', 'qwen3', '--tool-call-parser', 'qwen3_coder'],
  })),
  ...[{ gpu: 'B300', count: 8, vramGb: 288, verification: 'in-progress' }, { gpu: 'GB300', count: 4, vramGb: 288, verification: 'verified' }].map(hw => ({
    id: 'glm53-flash-' + hw.gpu.toLowerCase(), label: 'GLM-5.3-Flash · FP8', model: 'zai-org/GLM-5.3-Flash', weightsGb: 328.366173639, ...hw, diskGb: 450, image: 'lmsysorg/sglang:latest', cuda: '13.0', source: flashSource,
    verified: { by: 'documented' as const, note: hw.verification, source: flashSource },
    efforts: { levels: ['low','high','max'], verified: { by: 'documented' as const, on: '2026-10-20', source: 'https://huggingface.co/zai-org/GLM-5.3-Flash/blob/main/chat_template.jinja', note: 'low and high are explicit; all other inputs use max' } },
    pythonInstall,
    flags: ['--tp-size', String(hw.count), '--dsa-prefill-backend', 'trtllm', '--dsa-decode-backend', 'trtllm', '--kv-cache-dtype', 'fp8_e4m3', '--moe-runner-backend', 'flashinfer_trtllm', ...mtp, '--reasoning-parser', 'glm45', '--tool-call-parser', 'glm47'],
  })),
  ...[
    { gpu: 'B200', vramGb: 180, fraction: '0.78', chunk: '2048', verification: 'verified · 1M context · prefill chunk 2048 and a 78% static share, set from the engine’s own memory plan read on 4× B200 on 2026-10-23: the stock 16384-token chunk scores the whole context densely and outgrew the 24.7 GB headroom near 150k tokens of context' },
    { gpu: 'B300', vramGb: 288, fraction: '0.8', chunk: '4096', verification: 'verified · 1M context · prefill chunk 4096, computed from the 4× B200 reading of 2026-10-23 (the stock 16384-token chunk scores the whole context densely and outgrows the engine’s headroom past ~700k tokens); not measured on this card' },
    { gpu: 'GB300', vramGb: 288, fraction: '0.8', chunk: '4096', verification: 'verified · 1M context · prefill chunk 4096, computed from the 4× B200 reading of 2026-10-23 (the stock 16384-token chunk scores the whole context densely and outgrows the engine’s headroom past ~700k tokens); not measured on this card' },
  ].map(({ fraction, chunk, verification, ...hw }) => ({
    id: 'deepseek41-' + hw.gpu.toLowerCase(), label: 'DeepSeek-V4.1-Flash-1017', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', weightsGb: 510.311045295, ...hw, count: 4, diskGb: 650,
    image: 'lmsysorg/sglang:dev-dsv41', cuda: '13.0', source: dsSource, context: 1048576, contextPerSlot: 1048576, verification,
    verified: { by: 'documented' as const, on: '2026-10-23', note: 'verified', source: dsSource },
    efforts: { levels: ['low','high','max'], verified: { by: 'documented' as const, on: '2026-10-20', source: 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/blob/main/encoding/README.md', note: 'encoder maps low, high and max to 50, 75 and 100' } },
    kvBytesPerToken: { bytes: 11624, maxContext: 1048576, cacheType: 'fp8_e4m3', verified: { by: 'measured' as const, on: '2026-10-23', source: dsSource, note: 'per card, from the engine’s own plan on 4× B200: max_total_num_tokens=1754112 out of the 18.99 GiB left of the 80% static share after 121.97 GiB of weights, i.e. 11,624 bytes per token, kept on every card (tensor parallel). The model keeps a 512-wide latent + 64 rope at fp8 for its 4 kv-source layers (3 of them 2:1 compressed), a 128-wide fp4 index key per index layer, a 128-position sliding window per layer, and the DSpark draft’s share.' } },
    flags: ['--trust-remote-code', '--tp', '4', '--ep-size', '4', '--mem-fraction-static', fraction, '--chunked-prefill-size', chunk, '--speculative-algorithm', 'DSPARK', '--speculative-dspark-block-size', '5', '--cuda-graph-max-bs-decode', '64', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto'],
  })),
  ...[{ gpu: 'H200', count: 8, vramGb: 141 }, { gpu: 'B200', count: 8, vramGb: 180 }, { gpu: 'B300', count: 8, vramGb: 288 }, { gpu: 'GB300', count: 4, vramGb: 288 }].map(hw => ({
    id: 'glm53-' + hw.gpu.toLowerCase(), label: 'GLM-5.3 · FP8', model: 'zai-org/GLM-5.3', ...hw, weightsGb: 755.663689302, context: 1048576, contextPerSlot: 1048576, diskGb: 950,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: glmSource, verification: 'verified · GLM-5.3 License · MaaS operators above $10B aggregate revenue in 12 months require Z.AI security review',
    verified: { by: 'documented' as const, note: 'verified', source: glmSource },
    efforts: { levels: ['low','high','max'], verified: { by: 'documented' as const, on: '2026-10-20', source: 'https://huggingface.co/zai-org/GLM-5.3/blob/main/chat_template.jinja', note: 'low and high are explicit; all other inputs use max' } },
    pythonInstall,
    flags: ['--tp', String(hw.count), ...mtp, '--mem-fraction-static', hw.count === 4 ? '0.85' : '0.8', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto'],
  })),
  ...[{ gpu: 'B300', count: 8, nodes: 1, vramGb: 288, badge: 'verified' }, { gpu: 'B200', count: 8, nodes: 2, vramGb: 180, badge: 'in-progress' }, { gpu: 'H200', count: 8, nodes: 2, vramGb: 141, badge: 'in-progress' }, { gpu: 'GB300', count: 4, nodes: 2, vramGb: 288, badge: 'in-progress' }].map(({ badge, ...hw }) => ({
    id: 'kimi-k3-' + hw.gpu.toLowerCase(), label: 'Kimi K3 · MXFP4', model: 'moonshotai/Kimi-K3', ...hw, weightsGb: 1560.998988078, diskGb: 2000,
    image: 'lmsysorg/sglang:kimi-k3', cuda: '13.0', source: kimiSource, context: 1048576, contextPerSlot: 1048576,
    efforts: { levels: ['low','high','max'], verified: { by: 'documented' as const, on: '2026-10-20', source: 'https://huggingface.co/moonshotai/Kimi-K3/blob/main/README.md', note: 'thinking is always on; the top-level reasoning_effort field takes low, high and max' } },
    verification: badge + ' · Kimi K3 License · MaaS operators above $20M aggregate revenue in 12 months need a separate agreement; internal use exempt · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-20', note: badge, source: kimiSource },
    ...(hw.gpu === 'H200' ? { environment: { NCCL_MNNVL_ENABLE: '1', NCCL_CUMEM_ENABLE: '1', SGLANG_ENABLE_TP_MEMORY_INBALANCE_CHECK: '0' } } : hw.gpu === 'GB300' ? { environment: { SGLANG_ENABLE_TP_MEMORY_INBALANCE_CHECK: '0' } } : {}),
    flags: ['--trust-remote-code', '--tp-size', hw.gpu === 'H200' ? '16' : '8', ...(hw.gpu === 'B200' ? ['--pp-size', '2', '--disable-flashinfer-autotune', '--watchdog-timeout', '3600', '--model-loader-extra-config', '{"enable_multithread_load":true}'] : []), ...(hw.gpu === 'H200' ? ['--ep-size', '16', '--moe-runner-backend', 'marlin', '--decode-attention-backend', 'flashmla', '--enable-symm-mem'] : []), '--mem-fraction-static', '0.85', '--reasoning-parser', 'kimi_k3', '--tool-call-parser', 'kimi_k3'],
  })),
  ...[{ gpu: 'H200', nodes: 4, vramGb: 141 }, { gpu: 'B200', nodes: 2, vramGb: 180 }, { gpu: 'B300', nodes: 2, vramGb: 288 }].map(hw => ({
    id: 'qwen38-24t-fp8-' + hw.gpu.toLowerCase(), label: 'Qwen3.8-2.4T-A95B · FP8', model: 'Qwen/Qwen3.8-2.4T-A95B-FP8', ...hw, count: 8, weightsGb: 2496.154395007, diskGb: 3000,
    image: 'lmsysorg/sglang:qwen38', cuda: '13.0', source: qwenMaxSource, context: 262144, contextPerSlot: 262144,
    efforts: { levels: ['low','medium','xhigh'], verified: { by: 'documented' as const, on: '2026-10-20', source: 'https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B-FP8/blob/main/chat_template.jinja', note: 'only low, medium and xhigh are accepted; xhigh is the default' } },
    verification: 'verified · Qwen3.8-Max License · MaaS or AI Work Assistant businesses above $50M aggregate revenue in 12 months need a separate licence; internal use exempt',
    verified: { by: 'documented' as const, on: '2026-10-20', note: 'verified', source: qwenMaxSource },
    flags: ['--trust-remote-code', '--tp-size', '8', '--pp-size', String(hw.nodes), '--dist-timeout', '1800', '--mamba-full-memory-ratio', '0.95', '--mamba-ssm-dtype', 'bfloat16', ...(hw.gpu === 'H200' ? ['--linear-attn-prefill-backend', 'flashinfer', '--linear-attn-decode-backend', 'flashinfer', '--max-prefill-tokens', '8192', '--page-size', '64'] : hw.gpu === 'B300' ? ['--context-length', '262144', '--attention-backend', 'trtllm_mha', '--linear-attn-prefill-backend', 'flashinfer', '--linear-attn-decode-backend', 'flashinfer', '--moe-runner-backend', 'flashinfer_trtllm', '--moe-a2a-backend', 'none', '--mamba-radix-cache-strategy', 'extra_buffer', '--mem-fraction-static', '0.95', '--max-running-requests', '512', '--chunked-prefill-size', '8192', '--max-prefill-tokens', '8192', '--page-size', '64', '--cuda-graph-backend-decode', 'full', '--cuda-graph-max-bs-decode', '128', '--cuda-graph-bs-decode', '1', '2', '4', '8', '16', '32', '64', '128'] : ['--chunked-prefill-size', '8192']), '--reasoning-parser', 'qwen3', '--tool-call-parser', 'qwen3_coder'],
  })),
  {
    id: 'qwen38-24t-nvfp4-b300', label: 'Qwen3.8-2.4T-A95B · NVFP4', model: 'RadixArk/Qwen3.8-2.4T-A95B-NVFP4', gpu: 'B300', count: 8, weightsGb: 1484.459595887, vramGb: 288, diskGb: 1900,
    image: 'lmsysorg/sglang:qwen38', cuda: '13.0', source: qwenMaxSource, context: 262144, contextPerSlot: 262144,
    efforts: { levels: ['low','medium','xhigh'], verified: { by: 'documented' as const, on: '2026-10-20', source: 'https://huggingface.co/RadixArk/Qwen3.8-2.4T-A95B-NVFP4/blob/main/chat_template.jinja', note: 'only low, medium and xhigh are accepted; xhigh is the default' } },
    verification: 'verified · Qwen3.8-Max License · MaaS or AI Work Assistant businesses above $50M aggregate revenue in 12 months need a separate licence; internal use exempt',
    verified: { by: 'documented', on: '2026-10-20', note: 'verified', source: qwenMaxSource },
    environment: { SGLANG_FLASHINFER_MNNVL_CUTEDSL_AR_FUSION: '1' },
    flags: ['--trust-remote-code', '--tp-size', '8', '--moe-runner-backend', 'flashinfer_trtllm', '--mamba-radix-cache-strategy', 'extra_buffer', '--mamba-ssm-dtype', 'bfloat16', '--speculative-algorithm', 'NEXTN', '--speculative-num-steps', '3', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '4', '--enable-linear-replayssm-spec', '--mem-fraction-static', '0.90', '--chunked-prefill-size', '8192', '--max-prefill-tokens', '8192', '--reasoning-parser', 'qwen3', '--tool-call-parser', 'qwen3_coder'],
  },
  ...[{ gpu: 'B200', count: 8, vramGb: 180, badge: 'in-progress' }, { gpu: 'B300', count: 8, vramGb: 288, badge: 'in-progress' }, { gpu: 'GB300', count: 4, vramGb: 288, badge: 'verified' }].map(({ badge, ...hw }) => ({
    id: 'deepseek-v4-pro-0813-' + hw.gpu.toLowerCase(), label: 'DeepSeek-V4-Pro-0813 · MXFP4', model: 'deepseek-ai/DeepSeek-V4-Pro-0813', ...hw, weightsGb: 892.762497859, diskGb: 1100,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: dsProSource, context: 1048576, contextPerSlot: 1048576, verification: badge + ' · MIT · configured 1M context, capacity not measured',
    efforts: { levels: ['low','high','max'], verified: { by: 'documented' as const, on: '2026-10-20', source: 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813/blob/main/encoding/README.md', note: 'in thinking mode the encoder realises low, high and max as a prompt prefix; chat mode ignores it' } },
    verified: { by: 'documented' as const, on: '2026-10-20', note: badge, source: dsProSource },
    ...(hw.gpu === 'B200' ? { environment: { SGLANG_OPT_USE_JIT_NORM: '1', SGLANG_OPT_USE_TOPK_V2: '1' } } : {}),
    flags: ['--trust-remote-code', '--tp', String(hw.count), '--moe-runner-backend', 'flashinfer_mxfp4', '--speculative-algorithm', 'DSPARK', '--chunked-prefill-size', '8192', '--disable-flashinfer-autotune', '--swa-full-tokens-ratio', '0.1', '--mem-fraction-static', '0.90', '--reasoning-parser', 'deepseek-v4', '--tool-call-parser', 'deepseekv4'],
  })),
  ...[{ gpu: 'B300', vramGb: 288, badge: 'verified' }, { gpu: 'H200', vramGb: 141, badge: 'in-progress' }].map(({ badge, ...hw }) => ({
    id: 'mimo26-pro-' + hw.gpu.toLowerCase(), label: 'MiMo-V2.6-Pro-RL · MXFP4', model: 'XiaomiMiMo/MiMo-V2.6-Pro-RL', ...hw, count: 8, weightsGb: 573.492067396, diskGb: 800,
    image: 'lmsysorg/sglang:dev', cuda: '13.0', source: mimoSource, context: 1048576, contextPerSlot: 1048576, verification: badge + ' · MIT · configured 1M context, capacity not measured',
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-20', source: 'https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL/blob/main/chat_template.jinja', note: 'the template knows enable_thinking only; no effort levels' } },
    verified: { by: 'documented' as const, on: '2026-10-20', note: badge, source: mimoSource },
    flags: ['--tp', '8', '--trust-remote-code', '--reasoning-parser', 'mimo', '--tool-call-parser', 'mimo', ...(hw.gpu === 'H200' ? ['--moe-runner-backend', 'marlin'] : ['--ep', '8', '--dp', '1', '--pp-size', '1', '--moe-runner-backend', 'deep_gemm', '--moe-a2a-backend', 'deepep', '--deepep-mode', 'auto', '--moe-dense-tp-size', '1', '--enable-dp-lm-head', '--log-level-http', 'warning', '--enable-cache-report', '--page-size', '1', '--cuda-graph-max-bs-decode', '64', '--max-running-requests', '64', '--mem-fraction-static', '0.7', '--swa-full-tokens-ratio', '0.08', '--chunked-prefill-size', '49152', '--max-prefill-tokens', '65536', '--attention-backend', 'fa4', '--speculative-algorithm', 'DFLASH', '--speculative-draft-model-path', '/workspace/mercury-host/mimo26-pro-b300/weights/dflash', '--speculative-num-draft-tokens', '8', '--context-length', '1048576', '--cuda-graph-backend-prefill=disabled', '--mm-enable-dp-encoder', '--mm-attention-backend', 'fa4'])],
  })),
  ...[{ gpu: 'H200', vramGb: 141 }, { gpu: 'B200', vramGb: 180 }].map(hw => ({
    id: 'mistral-large3-' + hw.gpu.toLowerCase(), label: 'Mistral Large 3 675B · FP8', model: 'mistralai/Mistral-Large-3-675B-Instruct-2512', ...hw, count: 8, weightsGb: 681.542908857, diskGb: 900, engine: 'vllm' as const,
    image: 'vllm/vllm-openai:v0.32.0', cuda: '13.0', source: mistralSource, context: 262144, contextPerSlot: 262144, verification: 'Apache-2.0 · vendor FP8 serving recipe',
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-20', source: 'https://huggingface.co/mistralai/Mistral-Large-3-675B-Instruct-2512/blob/main/chat_template.jinja', note: 'the template renders thinking blocks and takes no effort field' } },
    verified: { by: 'documented' as const, on: '2026-10-20', note: 'Vendor model-card vLLM recipe; GPU serving not measured by Mercury', source: mistralSource },
    flags: ['--max-model-len', '262144', '--tensor-parallel-size', '8', '--tokenizer_mode', 'mistral', '--config_format', 'mistral', '--load_format', 'mistral', '--enable-auto-tool-choice', '--tool-call-parser', 'mistral'],
  })),
  ...[{ gpu: 'H200', count: 8, nodes: 2, vramGb: 141, badge: 'in-progress' }, { gpu: 'B200', count: 8, nodes: 2, vramGb: 180, badge: 'in-progress' }, { gpu: 'B300', count: 8, nodes: 1, vramGb: 288, badge: 'verified' }, { gpu: 'GB300', count: 4, nodes: 2, vramGb: 288, badge: 'in-progress' }].map(({ badge, ...hw }) => ({
    id: 'glm53-bf16-' + hw.gpu.toLowerCase(), label: 'GLM-5.3 · BF16', model: 'zai-org/GLM-5.3-BF16', ...hw, weightsGb: 1506.69304823, diskGb: 1900,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: glmSource, context: 1048576, contextPerSlot: 1048576,
    efforts: { levels: ['low','high','max'], verified: { by: 'documented' as const, on: '2026-10-20', source: 'https://huggingface.co/zai-org/GLM-5.3-BF16/blob/main/chat_template.jinja', note: 'low and high are explicit; all other inputs use max' } },
    verification: badge + ' · GLM-5.3 License · MaaS operators above $10B aggregate revenue in 12 months require Z.AI security review',
    verified: { by: 'documented' as const, on: '2026-10-20', note: badge, source: glmSource },
    flags: ['--tp', String(hw.count * hw.nodes), ...mtp, '--mem-fraction-static', hw.gpu === 'B300' ? '0.9' : '0.85', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto'],
  })),
  {
    id: 'beam1-fp8-b300', label: 'Beam 1.0 501B-A23B · FP8', model: 'reflection/Beam-1.0-501B-A23B-FP8', weightsGb: 503.299122421, gpu: 'B300', count: 4, vramGb: 288, diskGb: 650,
    image: 'lmsysorg/sglang:beam', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Reflection/Beam-1_0', context: 1048576, contextPerSlot: 1048576, verification: 'verified · Apache-2.0 · configured 1M context, capacity not measured · the engine fetches the DFlash2 draft reflection/Beam-1.0-501B-A23B-DFlash2 at start',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/Reflection/Beam-1_0' },
    efforts: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/reflection/Beam-1.0-501B-A23B-FP8/blob/main/chat_template.jinja', note: 'low, medium, high, xhigh and max map to 32, 64, 128, 256 and 512; max is the default; minimal (8) and plain integers are also accepted' } },
    flags: ['--tp', '4', '--attention-backend', 'trtllm_mha', '--page-size', '64', '--context-length', '1048576', '--mem-fraction-static', '0.85', '--enable-unified-memory', '--speculative-algorithm', 'DFLASH', '--speculative-draft-model-path', 'reflection/Beam-1.0-501B-A23B-DFlash2', '--speculative-dflash-block-size', '8', '--tool-call-parser', 'beam', '--reasoning-parser', 'beam'],
  },
  {
    id: 'beam1-fp8-gb300', label: 'Beam 1.0 501B-A23B · FP8', model: 'reflection/Beam-1.0-501B-A23B-FP8', weightsGb: 503.299122421, gpu: 'GB300', count: 4, vramGb: 288, diskGb: 650,
    image: 'lmsysorg/sglang:beam', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Reflection/Beam-1_0', context: 1048576, contextPerSlot: 1048576, verification: 'verified · Apache-2.0 · configured 1M context, capacity not measured · the engine fetches the DFlash2 draft reflection/Beam-1.0-501B-A23B-DFlash2 at start',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/Reflection/Beam-1_0' },
    efforts: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/reflection/Beam-1.0-501B-A23B-FP8/blob/main/chat_template.jinja', note: 'low, medium, high, xhigh and max map to 32, 64, 128, 256 and 512; max is the default; minimal (8) and plain integers are also accepted' } },
    environment: { NCCL_MNNVL_ENABLE: '1', NCCL_CUMEM_ENABLE: '1', NCCL_NVLS_ENABLE: '1' },
    flags: ['--tp', '4', '--attention-backend', 'trtllm_mha', '--page-size', '64', '--context-length', '1048576', '--mem-fraction-static', '0.85', '--enable-unified-memory', '--speculative-algorithm', 'DFLASH', '--speculative-draft-model-path', 'reflection/Beam-1.0-501B-A23B-DFlash2', '--speculative-dflash-block-size', '8', '--tool-call-parser', 'beam', '--reasoning-parser', 'beam'],
  },
  {
    id: 'beam1-fp8-h200', label: 'Beam 1.0 501B-A23B · FP8', model: 'reflection/Beam-1.0-501B-A23B-FP8', weightsGb: 503.299122421, gpu: 'H200', count: 8, vramGb: 141, diskGb: 650,
    image: 'lmsysorg/sglang:beam', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Reflection/Beam-1_0', context: 1048576, contextPerSlot: 1048576, verification: 'verified · Apache-2.0 · configured 1M context, capacity not measured · the engine fetches the DFlash2 draft reflection/Beam-1.0-501B-A23B-DFlash2 at start',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/Reflection/Beam-1_0' },
    efforts: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/reflection/Beam-1.0-501B-A23B-FP8/blob/main/chat_template.jinja', note: 'low, medium, high, xhigh and max map to 32, 64, 128, 256 and 512; max is the default; minimal (8) and plain integers are also accepted' } },
    flags: ['--tp', '8', '--attention-backend', 'fa3', '--page-size', '64', '--context-length', '1048576', '--mem-fraction-static', '0.85', '--enable-unified-memory', '--speculative-algorithm', 'DFLASH', '--speculative-draft-model-path', 'reflection/Beam-1.0-501B-A23B-DFlash2', '--speculative-dflash-block-size', '8', '--tool-call-parser', 'beam', '--reasoning-parser', 'beam'],
  },
  {
    id: 'beam1-nvfp4-b300', label: 'Beam 1.0 501B-A23B · NVFP4', model: 'reflection/Beam-1.0-501B-A23B-NVFP4', weightsGb: 293.654927078, gpu: 'B300', count: 4, vramGb: 288, diskGb: 400,
    image: 'lmsysorg/sglang:beam', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Reflection/Beam-1_0', context: 1048576, contextPerSlot: 1048576, verification: 'verified · Apache-2.0 · configured 1M context, capacity not measured · the engine fetches the DFlash2 draft reflection/Beam-1.0-501B-A23B-DFlash2 at start',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/Reflection/Beam-1_0' },
    efforts: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/reflection/Beam-1.0-501B-A23B-FP8/blob/main/chat_template.jinja', note: 'low, medium, high, xhigh and max map to 32, 64, 128, 256 and 512; max is the default; minimal (8) and plain integers are also accepted' } },
    flags: ['--tp', '4', '--attention-backend', 'trtllm_mha', '--page-size', '64', '--context-length', '1048576', '--mem-fraction-static', '0.85', '--enable-unified-memory', '--speculative-algorithm', 'DFLASH', '--speculative-draft-model-path', 'reflection/Beam-1.0-501B-A23B-DFlash2', '--speculative-dflash-block-size', '8', '--tool-call-parser', 'beam', '--reasoning-parser', 'beam'],
  },
  {
    id: 'beam1-nvfp4-gb300', label: 'Beam 1.0 501B-A23B · NVFP4', model: 'reflection/Beam-1.0-501B-A23B-NVFP4', weightsGb: 293.654927078, gpu: 'GB300', count: 4, vramGb: 288, diskGb: 400,
    image: 'lmsysorg/sglang:beam', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Reflection/Beam-1_0', context: 1048576, contextPerSlot: 1048576, verification: 'verified · Apache-2.0 · configured 1M context, capacity not measured · the engine fetches the DFlash2 draft reflection/Beam-1.0-501B-A23B-DFlash2 at start',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/Reflection/Beam-1_0' },
    efforts: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/reflection/Beam-1.0-501B-A23B-FP8/blob/main/chat_template.jinja', note: 'low, medium, high, xhigh and max map to 32, 64, 128, 256 and 512; max is the default; minimal (8) and plain integers are also accepted' } },
    environment: { NCCL_MNNVL_ENABLE: '1', NCCL_CUMEM_ENABLE: '1', NCCL_NVLS_ENABLE: '1' },
    flags: ['--tp', '4', '--attention-backend', 'trtllm_mha', '--page-size', '64', '--context-length', '1048576', '--mem-fraction-static', '0.85', '--enable-unified-memory', '--speculative-algorithm', 'DFLASH', '--speculative-draft-model-path', 'reflection/Beam-1.0-501B-A23B-DFlash2', '--speculative-dflash-block-size', '8', '--tool-call-parser', 'beam', '--reasoning-parser', 'beam'],
  },
  {
    id: 'hy4-preview-mxfp8-b300', label: 'Hy4-preview 770B · MXFP8', model: 'tencent/Hy4-preview-FP8', weightsGb: 813.800659217, gpu: 'B300', count: 4, vramGb: 288, diskGb: 1000,
    image: 'lmsysorg/sglang:hy4-preview', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Tencent/Hy4-Preview', context: 262144, contextPerSlot: 262144, verification: 'Apache-2.0',
    verified: { by: 'documented' as const, on: '2026-10-25', note: '262,144-token serving context from the hardware sizing table; the model supports 1M positions', source: 'https://docs.sglang.io/cookbook/autoregressive/Tencent/Hy4-Preview' },
    efforts: { levels: ['high'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/tencent/Hy4-preview-FP8/blob/main/chat_template.jinja', note: 'reasoning_effort takes high or no_think only; high is the default' } },
    flags: ['--context-length', '262144', '--tp', '4', '--moe-runner-backend', 'deep_gemm', '--fp8-gemm-backend', 'deep_gemm', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto', '--speculative-algorithm', 'NEXTN', '--speculative-num-steps', '3', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '4'],
  },
  {
    id: 'hy4-preview-mxfp8-gb300', label: 'Hy4-preview 770B · MXFP8', model: 'tencent/Hy4-preview-FP8', weightsGb: 813.800659217, gpu: 'GB300', count: 4, vramGb: 288, diskGb: 1000,
    image: 'lmsysorg/sglang:hy4-preview', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Tencent/Hy4-Preview', context: 262144, contextPerSlot: 262144, verification: 'Apache-2.0',
    verified: { by: 'documented' as const, on: '2026-10-25', note: '262,144-token serving context from the hardware sizing table; the model supports 1M positions', source: 'https://docs.sglang.io/cookbook/autoregressive/Tencent/Hy4-Preview' },
    efforts: { levels: ['high'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/tencent/Hy4-preview-FP8/blob/main/chat_template.jinja', note: 'reasoning_effort takes high or no_think only; high is the default' } },
    flags: ['--context-length', '262144', '--tp', '4', '--moe-runner-backend', 'deep_gemm', '--fp8-gemm-backend', 'deep_gemm', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto', '--speculative-algorithm', 'NEXTN', '--speculative-num-steps', '3', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '4'],
  },
  {
    id: 'hy4-preview-mxfp8-b200', label: 'Hy4-preview 770B · MXFP8', model: 'tencent/Hy4-preview-FP8', weightsGb: 813.800659217, gpu: 'B200', count: 8, vramGb: 180, diskGb: 1000,
    image: 'lmsysorg/sglang:hy4-preview', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Tencent/Hy4-Preview', context: 262144, contextPerSlot: 262144, verification: 'Apache-2.0',
    verified: { by: 'documented' as const, on: '2026-10-25', note: '262,144-token serving context from the hardware sizing table; the model supports 1M positions', source: 'https://docs.sglang.io/cookbook/autoregressive/Tencent/Hy4-Preview' },
    efforts: { levels: ['high'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/tencent/Hy4-preview-FP8/blob/main/chat_template.jinja', note: 'reasoning_effort takes high or no_think only; high is the default' } },
    flags: ['--context-length', '262144', '--tp', '8', '--moe-runner-backend', 'deep_gemm', '--fp8-gemm-backend', 'deep_gemm', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto', '--speculative-algorithm', 'NEXTN', '--speculative-num-steps', '3', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '4'],
  },
  {
    id: 'hy4-preview-bf16-b300', label: 'Hy4-preview 770B · BF16', model: 'tencent/Hy4-preview', weightsGb: 1560.01822126, gpu: 'B300', count: 8, vramGb: 288, diskGb: 2000,
    image: 'lmsysorg/sglang:hy4-preview', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Tencent/Hy4-Preview', context: 262144, contextPerSlot: 262144, verification: 'Apache-2.0',
    verified: { by: 'documented' as const, on: '2026-10-25', note: '262,144-token serving context from the hardware sizing table; the model supports 1M positions', source: 'https://docs.sglang.io/cookbook/autoregressive/Tencent/Hy4-Preview' },
    efforts: { levels: ['high'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/tencent/Hy4-preview/blob/main/chat_template.jinja', note: 'reasoning_effort takes high or no_think only; high is the default' } },
    flags: ['--context-length', '262144', '--tp', '8', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto', '--speculative-algorithm', 'NEXTN', '--speculative-num-steps', '3', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '4'],
  },
  {
    id: 'step5-preview-b300', label: 'Step 5 Preview 604B-A27B · FP8', model: 'stepfun-ai/Step-5-Preview', weightsGb: 650.320093993, gpu: 'B300', count: 4, vramGb: 288, diskGb: 850,
    image: 'lmsysorg/sglang:step-5-preview', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/StepFun/Step-5-Preview', context: 1048576, contextPerSlot: 1048576, verification: 'verified · StepFun Model License 1.0 · MaaS operators above $20M revenue in 12 months and device makers need a commercial licence; internal use exempt · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/StepFun/Step-5-Preview' },
    efforts: { levels: ['low', 'medium', 'high'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://docs.sglang.io/cookbook/autoregressive/StepFun/Step-5-Preview', note: 'the template renders reasoning_effort; the vendor documents low, medium and high; high is the default' } },
    flags: ['--trust-remote-code', '--tp', '4', '--moe-runner-backend', 'flashinfer_trtllm', '--attention-backend', 'fa4', '--page-size', '64', '--kv-cache-dtype', 'bfloat16', '--mem-fraction-static', '0.9', '--swa-full-tokens-ratio', '0.03', '--chunked-prefill-size', '16384', '--max-running-requests', '64', '--flashinfer-allreduce-fusion-backend', 'trtllm', '--speculative-algorithm', 'EAGLE', '--speculative-num-steps', '3', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '4', '--enable-multi-layer-eagle', '--reasoning-parser', 'step5', '--tool-call-parser', 'step5'],
  },
  {
    id: 'step5-preview-h200', label: 'Step 5 Preview 604B-A27B · FP8', model: 'stepfun-ai/Step-5-Preview', weightsGb: 650.320093993, gpu: 'H200', count: 8, vramGb: 141, diskGb: 850,
    image: 'lmsysorg/sglang:step-5-preview', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/StepFun/Step-5-Preview', context: 1048576, contextPerSlot: 1048576, verification: 'verified · StepFun Model License 1.0 · MaaS operators above $20M revenue in 12 months and device makers need a commercial licence; internal use exempt · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/StepFun/Step-5-Preview' },
    efforts: { levels: ['low', 'medium', 'high'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://docs.sglang.io/cookbook/autoregressive/StepFun/Step-5-Preview', note: 'the template renders reasoning_effort; the vendor documents low, medium and high; high is the default' } },
    flags: ['--trust-remote-code', '--tp', '8', '--ep-size', '8', '--moe-runner-backend', 'triton', '--attention-backend', 'fa3', '--page-size', '64', '--kv-cache-dtype', 'bfloat16', '--mem-fraction-static', '0.9', '--swa-full-tokens-ratio', '0.03', '--chunked-prefill-size', '16384', '--max-running-requests', '64', '--flashinfer-allreduce-fusion-backend', 'trtllm', '--speculative-algorithm', 'EAGLE', '--speculative-num-steps', '3', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '4', '--enable-multi-layer-eagle', '--reasoning-parser', 'step5', '--tool-call-parser', 'step5'],
  },
  {
    id: 'minimax-m3-mxfp8-b300', label: 'MiniMax-M3 427B-A23B · MXFP8', model: 'MiniMaxAI/MiniMax-M3-MXFP8', weightsGb: 443.776005285, gpu: 'B300', count: 4, vramGb: 288, diskGb: 600,
    image: 'lmsysorg/sglang:dev-cu13-minimax-m3', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/MiniMax/MiniMax-M3', context: 1048576, contextPerSlot: 1048576, verification: 'verified · MiniMax Community License · commercial use needs a "Built with MiniMax M3" notice and a one-time notice to MiniMax; above $20M yearly revenue a written authorisation · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/MiniMax/MiniMax-M3' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/MiniMaxAI/MiniMax-M3-MXFP8/blob/main/chat_template.jinja', note: 'thinking_mode is enabled, disabled or adaptive; no effort levels' } },
    flags: ['--trust-remote-code', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto', '--tp', '4', '--attention-backend', 'fa4', '--moe-runner-backend', 'deep_gemm', '--chunked-prefill-size', '8192', '--mem-fraction-static', '0.75'],
  },
  {
    id: 'minimax-m3-mxfp8-gb300', label: 'MiniMax-M3 427B-A23B · MXFP8', model: 'MiniMaxAI/MiniMax-M3-MXFP8', weightsGb: 443.776005285, gpu: 'GB300', count: 4, vramGb: 288, diskGb: 600,
    image: 'lmsysorg/sglang:dev-cu13-minimax-m3', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/MiniMax/MiniMax-M3', context: 1048576, contextPerSlot: 1048576, verification: 'verified · MiniMax Community License · commercial use needs a "Built with MiniMax M3" notice and a one-time notice to MiniMax; above $20M yearly revenue a written authorisation · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/MiniMax/MiniMax-M3' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/MiniMaxAI/MiniMax-M3-MXFP8/blob/main/chat_template.jinja', note: 'thinking_mode is enabled, disabled or adaptive; no effort levels' } },
    flags: ['--trust-remote-code', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto', '--tp', '4', '--attention-backend', 'fa4', '--moe-runner-backend', 'deep_gemm', '--chunked-prefill-size', '8192', '--mem-fraction-static', '0.75'],
  },
  {
    id: 'minimax-m3-mxfp8-b200', label: 'MiniMax-M3 427B-A23B · MXFP8', model: 'MiniMaxAI/MiniMax-M3-MXFP8', weightsGb: 443.776005285, gpu: 'B200', count: 8, vramGb: 180, diskGb: 600,
    image: 'lmsysorg/sglang:dev-minimax-m3', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/MiniMax/MiniMax-M3', context: 1048576, contextPerSlot: 1048576, verification: 'verified · MiniMax Community License · commercial use needs a "Built with MiniMax M3" notice and a one-time notice to MiniMax; above $20M yearly revenue a written authorisation · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/MiniMax/MiniMax-M3' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/MiniMaxAI/MiniMax-M3-MXFP8/blob/main/chat_template.jinja', note: 'thinking_mode is enabled, disabled or adaptive; no effort levels' } },
    flags: ['--trust-remote-code', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto', '--tp', '8', '--attention-backend', 'fa4', '--moe-runner-backend', 'deep_gemm', '--chunked-prefill-size', '8192', '--mem-fraction-static', '0.65'],
  },
  {
    id: 'minimax-m3-bf16-h200', label: 'MiniMax-M3 427B-A23B · BF16', model: 'MiniMaxAI/MiniMax-M3', weightsGb: 854.200504173, gpu: 'H200', count: 8, vramGb: 141, diskGb: 1100,
    image: 'lmsysorg/sglang:dev-cu12-minimax-m3', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/MiniMax/MiniMax-M3', context: 1048576, contextPerSlot: 1048576, verification: 'verified · MiniMax Community License · commercial use needs a "Built with MiniMax M3" notice and a one-time notice to MiniMax; above $20M yearly revenue a written authorisation · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/MiniMax/MiniMax-M3' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/MiniMaxAI/MiniMax-M3/blob/main/chat_template.jinja', note: 'thinking_mode is enabled, disabled or adaptive; no effort levels' } },
    flags: ['--trust-remote-code', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto', '--tp', '8', '--mem-fraction-static', '0.75'],
  },
  {
    id: 'inkling-nvfp4-b200', label: 'Inkling 975B · NVFP4', model: 'thinkingmachines/Inkling-NVFP4', weightsGb: 592.037337118, gpu: 'B200', count: 8, vramGb: 180, diskGb: 800,
    image: 'lmsysorg/sglang:dev-inkling-dspark', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling', context: 1048576, contextPerSlot: 1048576, verification: 'verified · Apache-2.0 · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-25', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling' },
    efforts: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], verified: { by: 'documented' as const, on: '2026-10-25', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling', note: 'none, minimal, low, medium, high, xhigh and max map to 0, 0.1, 0.2, 0.7, 0.9, 0.99 and 0.99; high is the default' } },
    flags: ['--trust-remote-code', '--tp', '8', '--quantization', 'modelopt_fp4', '--attention-backend', 'fa4', '--page-size', '128', '--fp4-gemm-backend', 'flashinfer_trtllm', '--moe-runner-backend', 'flashinfer_trtllm_routed', '--enable-torch-symm-mem', '--mamba-radix-cache-strategy', 'extra_buffer', '--mem-fraction-static', '0.85', '--swa-full-tokens-ratio', '0.1', '--mamba-full-memory-ratio', '0.1', '--enable-multimodal', '--reasoning-parser', 'inkling', '--tool-call-parser', 'inkling'],
  },
  {
    id: 'inkling-nvfp4-b300', label: 'Inkling 975B · NVFP4', model: 'thinkingmachines/Inkling-NVFP4', weightsGb: 592.037337118, gpu: 'B300', count: 8, vramGb: 288, diskGb: 800,
    image: 'lmsysorg/sglang:dev-inkling-dspark', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling', context: 1048576, contextPerSlot: 1048576, verification: 'verified · Apache-2.0 · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-25', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling' },
    efforts: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], verified: { by: 'documented' as const, on: '2026-10-25', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling', note: 'none, minimal, low, medium, high, xhigh and max map to 0, 0.1, 0.2, 0.7, 0.9, 0.99 and 0.99; high is the default' } },
    flags: ['--trust-remote-code', '--tp', '8', '--quantization', 'modelopt_fp4', '--attention-backend', 'fa4', '--page-size', '128', '--fp4-gemm-backend', 'flashinfer_trtllm', '--moe-runner-backend', 'flashinfer_trtllm_routed', '--enable-torch-symm-mem', '--mamba-radix-cache-strategy', 'extra_buffer', '--mem-fraction-static', '0.85', '--swa-full-tokens-ratio', '0.1', '--mamba-full-memory-ratio', '0.1', '--enable-multimodal', '--reasoning-parser', 'inkling', '--tool-call-parser', 'inkling'],
  },
  {
    id: 'inkling-nvfp4-gb300', label: 'Inkling 975B · NVFP4', model: 'thinkingmachines/Inkling-NVFP4', weightsGb: 592.037337118, gpu: 'GB300', count: 4, vramGb: 288, diskGb: 800,
    image: 'lmsysorg/sglang:dev-inkling-dspark', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling', context: 1048576, contextPerSlot: 1048576, verification: 'verified · Apache-2.0 · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-25', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling' },
    efforts: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], verified: { by: 'documented' as const, on: '2026-10-25', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling', note: 'none, minimal, low, medium, high, xhigh and max map to 0, 0.1, 0.2, 0.7, 0.9, 0.99 and 0.99; high is the default' } },
    flags: ['--trust-remote-code', '--tp', '4', '--quantization', 'modelopt_fp4', '--attention-backend', 'fa4', '--page-size', '128', '--fp4-gemm-backend', 'flashinfer_trtllm', '--moe-runner-backend', 'flashinfer_trtllm_routed', '--enable-torch-symm-mem', '--mamba-radix-cache-strategy', 'extra_buffer', '--mem-fraction-static', '0.85', '--swa-full-tokens-ratio', '0.1', '--mamba-full-memory-ratio', '0.1', '--enable-multimodal', '--reasoning-parser', 'inkling', '--tool-call-parser', 'inkling'],
  },
  {
    id: 'inkling-nvfp4-h200', label: 'Inkling 975B · NVFP4', model: 'thinkingmachines/Inkling-NVFP4', weightsGb: 592.037337118, gpu: 'H200', count: 8, vramGb: 141, diskGb: 800,
    image: 'lmsysorg/sglang:dev-inkling-dspark', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling', context: 1048576, contextPerSlot: 1048576, verification: 'verified · Apache-2.0 · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-25', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling' },
    efforts: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], verified: { by: 'documented' as const, on: '2026-10-25', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling', note: 'none, minimal, low, medium, high, xhigh and max map to 0, 0.1, 0.2, 0.7, 0.9, 0.99 and 0.99; high is the default' } },
    flags: ['--trust-remote-code', '--tp', '8', '--quantization', 'modelopt_fp4', '--attention-backend', 'fa4', '--page-size', '128', '--fp4-gemm-backend', 'marlin', '--moe-runner-backend', 'marlin', '--enable-torch-symm-mem', '--mamba-radix-cache-strategy', 'extra_buffer', '--mem-fraction-static', '0.85', '--swa-full-tokens-ratio', '0.1', '--mamba-full-memory-ratio', '0.1', '--enable-multimodal', '--reasoning-parser', 'inkling', '--tool-call-parser', 'inkling'],
  },
  {
    id: 'inkling-small-nvfp4-b200', label: 'Inkling-Small 266B · NVFP4', model: 'thinkingmachines/Inkling-Small-NVFP4', weightsGb: 170.764923366, gpu: 'B200', count: 8, vramGb: 180, diskGb: 250,
    image: 'lmsysorg/sglang:dev-inkling-dspark', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling-Small', context: 1048576, contextPerSlot: 1048576, verification: 'verified · Apache-2.0 · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling-Small' },
    efforts: { levels: ['low', 'medium', 'high', 'max'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/thinkingmachines/Inkling-Small-NVFP4/blob/main/chat_template.jinja', note: 'low, medium, high and max map to 0.2, 0.7, 0.9 and 0.99; high is the default; none, minimal and numbers in [0, 0.99] are also accepted' } },
    flags: ['--trust-remote-code', '--tp', '8', '--quantization', 'modelopt_fp4', '--attention-backend', 'fa4', '--page-size', '128', '--fp4-gemm-backend', 'flashinfer_trtllm', '--moe-runner-backend', 'flashinfer_trtllm_routed', '--enable-torch-symm-mem', '--mamba-radix-cache-strategy', 'extra_buffer', '--mem-fraction-static', '0.85', '--swa-full-tokens-ratio', '0.1', '--mamba-full-memory-ratio', '0.1', '--enable-multimodal', '--reasoning-parser', 'inkling', '--tool-call-parser', 'inkling'],
  },
  {
    id: 'inkling-small-nvfp4-b300', label: 'Inkling-Small 266B · NVFP4', model: 'thinkingmachines/Inkling-Small-NVFP4', weightsGb: 170.764923366, gpu: 'B300', count: 8, vramGb: 288, diskGb: 250,
    image: 'lmsysorg/sglang:dev-inkling-dspark', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling-Small', context: 1048576, contextPerSlot: 1048576, verification: 'verified · Apache-2.0 · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling-Small' },
    efforts: { levels: ['low', 'medium', 'high', 'max'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/thinkingmachines/Inkling-Small-NVFP4/blob/main/chat_template.jinja', note: 'low, medium, high and max map to 0.2, 0.7, 0.9 and 0.99; high is the default; none, minimal and numbers in [0, 0.99] are also accepted' } },
    flags: ['--trust-remote-code', '--tp', '8', '--quantization', 'modelopt_fp4', '--attention-backend', 'fa4', '--page-size', '128', '--fp4-gemm-backend', 'flashinfer_trtllm', '--moe-runner-backend', 'flashinfer_trtllm_routed', '--enable-torch-symm-mem', '--mamba-radix-cache-strategy', 'extra_buffer', '--mem-fraction-static', '0.85', '--swa-full-tokens-ratio', '0.1', '--mamba-full-memory-ratio', '0.1', '--enable-multimodal', '--reasoning-parser', 'inkling', '--tool-call-parser', 'inkling'],
  },
  {
    id: 'inkling-small-nvfp4-gb300', label: 'Inkling-Small 266B · NVFP4', model: 'thinkingmachines/Inkling-Small-NVFP4', weightsGb: 170.764923366, gpu: 'GB300', count: 4, vramGb: 288, diskGb: 250,
    image: 'lmsysorg/sglang:dev-inkling-dspark', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling-Small', context: 1048576, contextPerSlot: 1048576, verification: 'verified · Apache-2.0 · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling-Small' },
    efforts: { levels: ['low', 'medium', 'high', 'max'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/thinkingmachines/Inkling-Small-NVFP4/blob/main/chat_template.jinja', note: 'low, medium, high and max map to 0.2, 0.7, 0.9 and 0.99; high is the default; none, minimal and numbers in [0, 0.99] are also accepted' } },
    flags: ['--trust-remote-code', '--tp', '4', '--quantization', 'modelopt_fp4', '--attention-backend', 'fa4', '--page-size', '128', '--fp4-gemm-backend', 'flashinfer_trtllm', '--moe-runner-backend', 'flashinfer_trtllm_routed', '--enable-torch-symm-mem', '--mamba-radix-cache-strategy', 'extra_buffer', '--mem-fraction-static', '0.85', '--swa-full-tokens-ratio', '0.1', '--mamba-full-memory-ratio', '0.1', '--enable-multimodal', '--reasoning-parser', 'inkling', '--tool-call-parser', 'inkling'],
  },
  {
    id: 'inkling-small-nvfp4-h200', label: 'Inkling-Small 266B · NVFP4', model: 'thinkingmachines/Inkling-Small-NVFP4', weightsGb: 170.764923366, gpu: 'H200', count: 8, vramGb: 141, diskGb: 250,
    image: 'lmsysorg/sglang:dev-inkling-dspark', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling-Small', context: 1048576, contextPerSlot: 1048576, verification: 'verified · Apache-2.0 · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/ThinkingMachines/Inkling-Small' },
    efforts: { levels: ['low', 'medium', 'high', 'max'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/thinkingmachines/Inkling-Small-NVFP4/blob/main/chat_template.jinja', note: 'low, medium, high and max map to 0.2, 0.7, 0.9 and 0.99; high is the default; none, minimal and numbers in [0, 0.99] are also accepted' } },
    flags: ['--trust-remote-code', '--tp', '8', '--quantization', 'modelopt_fp4', '--attention-backend', 'fa4', '--page-size', '128', '--fp4-gemm-backend', 'marlin', '--moe-runner-backend', 'marlin', '--enable-torch-symm-mem', '--mamba-radix-cache-strategy', 'extra_buffer', '--mem-fraction-static', '0.85', '--swa-full-tokens-ratio', '0.1', '--mamba-full-memory-ratio', '0.1', '--enable-multimodal', '--reasoning-parser', 'inkling', '--tool-call-parser', 'inkling'],
  },
  {
    id: 'nemotron3-ultra-nvfp4-b200', label: 'Nemotron 3 Ultra 550B-A55B · NVFP4', model: 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4', weightsGb: 352.381245755, gpu: 'B200', count: 4, vramGb: 180, diskGb: 500,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/NVIDIA/Nemotron3-Ultra', context: 262144, contextPerSlot: 262144, verification: 'documented · NVIDIA OpenMDW-1.1 licence · the cookbook names 1M context; config.json caps positions at 262,144',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'documented', source: 'https://docs.sglang.io/cookbook/autoregressive/NVIDIA/Nemotron3-Ultra' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4/blob/main/chat_template.jinja', note: 'enable_thinking and medium_effort are boolean controls, not named reasoning_effort levels' } },
    flags: ['--trust-remote-code', '--tp', '4', '--mamba-radix-cache-strategy', 'extra_buffer', '--attention-backend', 'trtllm_mha', '--reasoning-parser', 'nemotron_3', '--tool-call-parser', 'qwen3_coder'],
  },
  {
    id: 'nemotron3-ultra-nvfp4-b300', label: 'Nemotron 3 Ultra 550B-A55B · NVFP4', model: 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4', weightsGb: 352.381245755, gpu: 'B300', count: 4, vramGb: 288, diskGb: 500,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/NVIDIA/Nemotron3-Ultra', context: 262144, contextPerSlot: 262144, verification: 'documented · NVIDIA OpenMDW-1.1 licence · the cookbook names 1M context; config.json caps positions at 262,144',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'documented', source: 'https://docs.sglang.io/cookbook/autoregressive/NVIDIA/Nemotron3-Ultra' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4/blob/main/chat_template.jinja', note: 'enable_thinking and medium_effort are boolean controls, not named reasoning_effort levels' } },
    flags: ['--trust-remote-code', '--tp', '4', '--mamba-radix-cache-strategy', 'extra_buffer', '--attention-backend', 'trtllm_mha', '--reasoning-parser', 'nemotron_3', '--tool-call-parser', 'qwen3_coder'],
  },
  {
    id: 'nemotron3-ultra-nvfp4-gb300', label: 'Nemotron 3 Ultra 550B-A55B · NVFP4', model: 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4', weightsGb: 352.381245755, gpu: 'GB300', count: 4, vramGb: 288, diskGb: 500,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/NVIDIA/Nemotron3-Ultra', context: 262144, contextPerSlot: 262144, verification: 'documented · NVIDIA OpenMDW-1.1 licence · the cookbook names 1M context; config.json caps positions at 262,144',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'documented', source: 'https://docs.sglang.io/cookbook/autoregressive/NVIDIA/Nemotron3-Ultra' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4/blob/main/chat_template.jinja', note: 'enable_thinking and medium_effort are boolean controls, not named reasoning_effort levels' } },
    flags: ['--trust-remote-code', '--tp', '4', '--mamba-radix-cache-strategy', 'extra_buffer', '--attention-backend', 'trtllm_mha', '--reasoning-parser', 'nemotron_3', '--tool-call-parser', 'qwen3_coder'],
  },
  {
    id: 'nemotron3-ultra-bf16-b200', label: 'Nemotron 3 Ultra 550B-A55B · BF16', model: 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16', weightsGb: 1121.078448762, gpu: 'B200', count: 8, vramGb: 180, diskGb: 1400,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/NVIDIA/Nemotron3-Ultra', context: 262144, contextPerSlot: 262144, verification: 'documented · NVIDIA OpenMDW-1.1 licence · the cookbook names 1M context; config.json caps positions at 262,144',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'documented', source: 'https://docs.sglang.io/cookbook/autoregressive/NVIDIA/Nemotron3-Ultra' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16/blob/main/chat_template.jinja', note: 'enable_thinking and medium_effort are boolean controls, not named reasoning_effort levels' } },
    flags: ['--trust-remote-code', '--tp', '8', '--mamba-radix-cache-strategy', 'extra_buffer', '--attention-backend', 'trtllm_mha', '--tool-call-parser', 'qwen3_coder', '--reasoning-parser', 'nemotron_3'],
  },
  {
    id: 'nemotron3-ultra-bf16-b300', label: 'Nemotron 3 Ultra 550B-A55B · BF16', model: 'nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16', weightsGb: 1121.078448762, gpu: 'B300', count: 8, vramGb: 288, diskGb: 1400,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/NVIDIA/Nemotron3-Ultra', context: 262144, contextPerSlot: 262144, verification: 'documented · NVIDIA OpenMDW-1.1 licence · the cookbook names 1M context; config.json caps positions at 262,144',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'documented', source: 'https://docs.sglang.io/cookbook/autoregressive/NVIDIA/Nemotron3-Ultra' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16/blob/main/chat_template.jinja', note: 'enable_thinking and medium_effort are boolean controls, not named reasoning_effort levels' } },
    flags: ['--trust-remote-code', '--tp', '8', '--mamba-radix-cache-strategy', 'extra_buffer', '--attention-backend', 'trtllm_mha', '--tool-call-parser', 'qwen3_coder', '--reasoning-parser', 'nemotron_3'],
  },
  {
    id: 'longcat2-fp8-b300', label: 'LongCat-2.0 1.8T · FP8', model: 'meituan-longcat/LongCat-2.0-FP8', weightsGb: 2051.220418466, gpu: 'B300', count: 8, vramGb: 288, diskGb: 2500,
    image: 'lmsysorg/sglang:dev-cu13', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Meituan/LongCat-2.0', context: 262144, contextPerSlot: 262144, verification: 'verified · MIT · configured 256K context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/Meituan/LongCat-2.0' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/meituan-longcat/LongCat-2.0-FP8/blob/main/tokenizer_config.json', note: 'the template knows enable_thinking and thinking_budget; no effort levels' } },
    flags: ['--trust-remote-code', '--tp', '8', '--ep', '8', '--max-running-requests', '64', '--mem-fraction-static', '0.92', '--chunked-prefill-size', '2048', '--dsa-prefill-backend', 'fa3', '--kv-cache-dtype', 'bfloat16', '--model-loader-extra-config', '{"enable_multithread_load":true,"num_threads":12}'],
  },
  {
    id: 'longcat2-fp8-b200', label: 'LongCat-2.0 1.8T · FP8', model: 'meituan-longcat/LongCat-2.0-FP8', weightsGb: 2051.220418466, gpu: 'B200', count: 8, nodes: 2, vramGb: 180, diskGb: 2500,
    image: 'lmsysorg/sglang:dev', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Meituan/LongCat-2.0', context: 262144, contextPerSlot: 262144, verification: 'in-progress · MIT · configured 256K context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'in-progress', source: 'https://docs.sglang.io/cookbook/autoregressive/Meituan/LongCat-2.0' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/meituan-longcat/LongCat-2.0-FP8/blob/main/tokenizer_config.json', note: 'the template knows enable_thinking and thinking_budget; no effort levels' } },
    flags: ['--trust-remote-code', '--tp', '16', '--ep', '16', '--max-running-requests', '64', '--mem-fraction-static', '0.92', '--chunked-prefill-size', '2048', '--dsa-prefill-backend', 'fa3', '--kv-cache-dtype', 'bfloat16', '--model-loader-extra-config', '{"enable_multithread_load":true,"num_threads":12}'],
  },
  {
    id: 'longcat2-fp8-h200', label: 'LongCat-2.0 1.8T · FP8', model: 'meituan-longcat/LongCat-2.0-FP8', weightsGb: 2051.220418466, gpu: 'H200', count: 8, nodes: 2, vramGb: 141, diskGb: 2500,
    image: 'lmsysorg/sglang:dev', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Meituan/LongCat-2.0', context: 262144, contextPerSlot: 262144, verification: 'in-progress · MIT · configured 256K context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'in-progress', source: 'https://docs.sglang.io/cookbook/autoregressive/Meituan/LongCat-2.0' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/meituan-longcat/LongCat-2.0-FP8/blob/main/tokenizer_config.json', note: 'the template knows enable_thinking and thinking_budget; no effort levels' } },
    flags: ['--trust-remote-code', '--tp', '16', '--ep', '16', '--max-running-requests', '64', '--mem-fraction-static', '0.92', '--chunked-prefill-size', '2048', '--dsa-prefill-backend', 'fa3', '--kv-cache-dtype', 'bfloat16', '--model-loader-extra-config', '{"enable_multithread_load":true,"num_threads":12}'],
  },
  {
    id: 'ling31-flash-h200', label: 'Ling-3.1-flash 572B · FP8', model: 'inclusionAI/Ling-3.1-flash', weightsGb: 573.813967733, gpu: 'H200', count: 8, vramGb: 141, diskGb: 750,
    image: 'lmsysorg/sglang:dev-ling-3.1-flash', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/InclusionAI/Ling-3.1-flash', context: 262144, contextPerSlot: 262144, verification: 'verified · MIT · configured 256K context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/InclusionAI/Ling-3.1-flash' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/inclusionAI/Ling-3.1-flash/blob/main/chat_template.jinja', note: 'the template knows enable_thinking only; no effort levels' } },
    environment: { SGLANG_ENABLE_FP8_BLOCK_GEMV: '1', SGLANG_ENABLE_FUSED_KDA_OUTPUT_QUANT: '1' },
    flags: ['--tp', '8', '--speculative-algorithm', 'NEXTN'],
  },
  {
    id: 'ling31-flash-gb300', label: 'Ling-3.1-flash 572B · FP8', model: 'inclusionAI/Ling-3.1-flash', weightsGb: 573.813967733, gpu: 'GB300', count: 4, vramGb: 288, diskGb: 750,
    image: 'lmsysorg/sglang:dev-ling-3.1-flash', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/InclusionAI/Ling-3.1-flash', context: 262144, contextPerSlot: 262144, verification: 'verified · MIT · configured 256K context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/InclusionAI/Ling-3.1-flash' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/inclusionAI/Ling-3.1-flash/blob/main/chat_template.jinja', note: 'the template knows enable_thinking only; no effort levels' } },
    flags: ['--tp', '4', '--speculative-algorithm', 'NEXTN'],
  },
  {
    id: 'ling31-flash-b200', label: 'Ling-3.1-flash 572B · FP8', model: 'inclusionAI/Ling-3.1-flash', weightsGb: 573.813967733, gpu: 'B200', count: 8, vramGb: 180, diskGb: 750,
    image: 'lmsysorg/sglang:dev-ling-3.1-flash', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/InclusionAI/Ling-3.1-flash', context: 262144, contextPerSlot: 262144, verification: 'in-progress · MIT · configured 256K context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'in-progress', source: 'https://docs.sglang.io/cookbook/autoregressive/InclusionAI/Ling-3.1-flash' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/inclusionAI/Ling-3.1-flash/blob/main/chat_template.jinja', note: 'the template knows enable_thinking only; no effort levels' } },
    flags: ['--tp', '8', '--speculative-algorithm', 'NEXTN'],
  },
  {
    id: 'qwen38-flash-next-fp8-h200', label: 'Qwen3.8-Flash-Next 180B-A6B · FP8', model: 'Qwen/Qwen3.8-Flash-Next-FP8', weightsGb: 185.563783577, gpu: 'H200', count: 4, vramGb: 141, diskGb: 250,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8-Flash-Next', context: 262144, contextPerSlot: 262144, verification: 'verified · Qwen Community License 1.0 · MaaS or AI Work Assistant businesses need a separate licence; internal use exempt',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8-Flash-Next' },
    efforts: { levels: ['low', 'medium', 'xhigh'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/Qwen/Qwen3.8-Flash-Next-FP8/blob/main/chat_template.jinja', note: 'only low, medium and xhigh are accepted; xhigh is the default' } },
    flags: ['--tp', '4', '--ep', '4', '--mem-fraction-static', '0.85', '--chunked-prefill-size', '8192', '--linear-attn-prefill-backend', 'flashinfer', '--linear-attn-decode-backend', 'flashinfer', '--linear-attn-verify-backend', 'triton', '--mamba-ssm-dtype', 'bfloat16', '--kv-cache-dtype', 'fp8_e4m3', '--qsa-indexer-dtype', 'fp8_e4m3', '--speculative-algorithm', 'NEXTN', '--speculative-num-steps', '3', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '4', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto'],
  },
  {
    id: 'qwen38-flash-next-fp8-b200', label: 'Qwen3.8-Flash-Next 180B-A6B · FP8', model: 'Qwen/Qwen3.8-Flash-Next-FP8', weightsGb: 185.563783577, gpu: 'B200', count: 4, vramGb: 180, diskGb: 250,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8-Flash-Next', context: 262144, contextPerSlot: 262144, verification: 'verified · Qwen Community License 1.0 · MaaS or AI Work Assistant businesses need a separate licence; internal use exempt',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8-Flash-Next' },
    efforts: { levels: ['low', 'medium', 'xhigh'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/Qwen/Qwen3.8-Flash-Next-FP8/blob/main/chat_template.jinja', note: 'only low, medium and xhigh are accepted; xhigh is the default' } },
    flags: ['--tp', '4', '--ep', '4', '--mem-fraction-static', '0.85', '--chunked-prefill-size', '8192', '--linear-attn-prefill-backend', 'flashinfer', '--linear-attn-decode-backend', 'flashinfer', '--mamba-ssm-dtype', 'bfloat16', '--kv-cache-dtype', 'fp8_e4m3', '--qsa-indexer-dtype', 'fp8_e4m3', '--speculative-algorithm', 'NEXTN', '--speculative-num-steps', '3', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '4', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto'],
  },
  {
    id: 'qwen38-flash-next-fp8-b300', label: 'Qwen3.8-Flash-Next 180B-A6B · FP8', model: 'Qwen/Qwen3.8-Flash-Next-FP8', weightsGb: 185.563783577, gpu: 'B300', count: 4, vramGb: 288, diskGb: 250,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8-Flash-Next', context: 262144, contextPerSlot: 262144, verification: 'verified · Qwen Community License 1.0 · MaaS or AI Work Assistant businesses need a separate licence; internal use exempt',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8-Flash-Next' },
    efforts: { levels: ['low', 'medium', 'xhigh'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/Qwen/Qwen3.8-Flash-Next-FP8/blob/main/chat_template.jinja', note: 'only low, medium and xhigh are accepted; xhigh is the default' } },
    flags: ['--tp', '4', '--ep', '4', '--mem-fraction-static', '0.85', '--chunked-prefill-size', '8192', '--linear-attn-prefill-backend', 'flashinfer', '--linear-attn-decode-backend', 'flashinfer', '--mamba-ssm-dtype', 'bfloat16', '--kv-cache-dtype', 'fp8_e4m3', '--qsa-indexer-dtype', 'fp8_e4m3', '--speculative-algorithm', 'NEXTN', '--speculative-num-steps', '3', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '4', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto'],
  },
  {
    id: 'qwen38-flash-next-fp8-gb300', label: 'Qwen3.8-Flash-Next 180B-A6B · FP8', model: 'Qwen/Qwen3.8-Flash-Next-FP8', weightsGb: 185.563783577, gpu: 'GB300', count: 4, vramGb: 288, diskGb: 250,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8-Flash-Next', context: 262144, contextPerSlot: 262144, verification: 'verified · Qwen Community License 1.0 · MaaS or AI Work Assistant businesses need a separate licence; internal use exempt',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/Qwen/Qwen3.8-Flash-Next' },
    efforts: { levels: ['low', 'medium', 'xhigh'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/Qwen/Qwen3.8-Flash-Next-FP8/blob/main/chat_template.jinja', note: 'only low, medium and xhigh are accepted; xhigh is the default' } },
    flags: ['--tp', '4', '--ep', '4', '--mem-fraction-static', '0.85', '--chunked-prefill-size', '8192', '--linear-attn-prefill-backend', 'flashinfer', '--linear-attn-decode-backend', 'flashinfer', '--mamba-ssm-dtype', 'bfloat16', '--kv-cache-dtype', 'fp8_e4m3', '--qsa-indexer-dtype', 'fp8_e4m3', '--speculative-algorithm', 'NEXTN', '--speculative-num-steps', '3', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '4', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto'],
  },
  {
    id: 'mimo26-flash-b300', label: 'MiMo-V2.6-Flash-RL 309B-A15B · MXFP4', model: 'XiaomiMiMo/MiMo-V2.6-Flash-RL', weightsGb: 177.767644198, gpu: 'B300', count: 4, vramGb: 288, diskGb: 250,
    image: 'lmsysorg/sglang:dev', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Xiaomi/MiMo-V2.6', context: 1048576, contextPerSlot: 1048576, verification: 'verified · MIT · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/Xiaomi/MiMo-V2.6' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Flash-RL/blob/main/chat_template.jinja', note: 'the template knows enable_thinking only; no effort levels' } },
    flags: ['--tp', '4', '--ep', '4', '--dp', '1', '--pp-size', '1', '--moe-runner-backend', 'deep_gemm', '--moe-a2a-backend', 'deepep', '--deepep-mode', 'auto', '--moe-dense-tp-size', '1', '--enable-dp-lm-head', '--log-level-http', 'warning', '--enable-cache-report', '--page-size', '1', '--cuda-graph-max-bs-decode', '64', '--max-running-requests', '64', '--trust-remote-code', '--mem-fraction-static', '0.6', '--swa-full-tokens-ratio', '0.03', '--chunked-prefill-size', '49152', '--max-prefill-tokens', '65536', '--reasoning-parser', 'mimo', '--tool-call-parser', 'mimo', '--attention-backend', 'fa4', '--speculative-algorithm', 'DFLASH', '--speculative-draft-model-path', '/workspace/mercury-host/mimo26-flash-b300/weights/dflash', '--speculative-num-draft-tokens', '8', '--context-length', '1048576', '--cuda-graph-backend-prefill=disabled', '--mm-enable-dp-encoder', '--mm-attention-backend', 'fa4'],
  },
  {
    id: 'mimo26-flash-h200', label: 'MiMo-V2.6-Flash-RL 309B-A15B · MXFP4', model: 'XiaomiMiMo/MiMo-V2.6-Flash-RL', weightsGb: 177.767644198, gpu: 'H200', count: 4, vramGb: 141, diskGb: 250,
    image: 'lmsysorg/sglang:dev', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Xiaomi/MiMo-V2.6', context: 1048576, contextPerSlot: 1048576, verification: 'in-progress · MIT · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'in-progress', source: 'https://docs.sglang.io/cookbook/autoregressive/Xiaomi/MiMo-V2.6' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Flash-RL/blob/main/chat_template.jinja', note: 'the template knows enable_thinking only; no effort levels' } },
    flags: ['--tp', '4', '--moe-runner-backend', 'marlin', '--trust-remote-code', '--reasoning-parser', 'mimo', '--tool-call-parser', 'mimo'],
  },
  {
    id: 'nemotron35-super-nvfp4-rtx-pro-6000', label: 'Nemotron 3.5 Super VL 120B · NVFP4', model: 'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4', weightsGb: 75.063321726, gpu: 'RTX PRO 6000', count: 1, vramGb: 96, diskGb: 120,
    image: 'lmsysorg/sglang:nemotron3-5-super', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/NVIDIA/Nemotron3.5-Super', context: 262144, contextPerSlot: 262144, verification: 'verified · NVIDIA OpenMDW-1.1 licence · the cell sets 262,144 context',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'verified', source: 'https://docs.sglang.io/cookbook/autoregressive/NVIDIA/Nemotron3.5-Super' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4/blob/main/chat_template.jinja', note: 'enable_thinking and medium_effort are boolean controls, not named reasoning_effort levels' } },
    flags: ['--trust-remote-code', '--tp-size', '1', '--context-length', '262144', '--attention-backend', 'flashinfer', '--kv-cache-dtype', 'fp8_e4m3', '--mamba-ssm-dtype', 'bfloat16', '--max-running-requests', '2', '--mem-fraction-static', '0.90', '--max-total-tokens', '1016382', '--cuda-graph-max-bs-decode', '2', '--cuda-graph-bs-decode', '1', '2', '--max-mamba-cache-size', '25', '--chunked-prefill-size', '1024', '--max-prefill-tokens', '16384', '--speculative-algorithm', 'EAGLE', '--speculative-eagle-topk', '1', '--speculative-num-steps', '3', '--speculative-num-draft-tokens', '4', '--reasoning-parser', 'nemotron_3', '--tool-call-parser', 'qwen3_coder'],
  },
  {
    id: 'gpt-oss-120b-h100', label: 'gpt-oss-120b · MXFP4', model: 'openai/gpt-oss-120b', weightsGb: 195.764040609, gpu: 'H100', count: 1, vramGb: 80, diskGb: 260, engine: 'vllm' as const,
    image: 'vllm/vllm-openai:v0.32.0', cuda: '13.0', source: 'https://recipes.vllm.ai/openai/gpt-oss-120b', context: 131072, contextPerSlot: 131072, verification: 'Apache-2.0 · vendor MXFP4 vLLM serving recipe for one 80 GB GPU · the repository holds three 65 GB copies of the weights (safetensors, original, metal) and the download takes all three',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'Vendor model-card vLLM recipe; GPU serving not measured by Mercury', source: 'https://recipes.vllm.ai/openai/gpt-oss-120b' },
    efforts: { levels: ['low', 'medium', 'high'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/openai/gpt-oss-120b/blob/main/chat_template.jinja', note: 'reasoning_effort defaults to medium; the model card names low, medium and high' } },
    flags: ['--tool-call-parser', 'openai', '--enable-auto-tool-choice'],
  },
  {
    id: 'gpt-oss-120b-h200', label: 'gpt-oss-120b · MXFP4', model: 'openai/gpt-oss-120b', weightsGb: 195.764040609, gpu: 'H200', count: 1, vramGb: 141, diskGb: 260, engine: 'vllm' as const,
    image: 'vllm/vllm-openai:v0.32.0', cuda: '13.0', source: 'https://recipes.vllm.ai/openai/gpt-oss-120b', context: 131072, contextPerSlot: 131072, verification: 'Apache-2.0 · vendor MXFP4 vLLM serving recipe for one 80 GB GPU · the repository holds three 65 GB copies of the weights (safetensors, original, metal) and the download takes all three',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'Vendor model-card vLLM recipe; GPU serving not measured by Mercury', source: 'https://recipes.vllm.ai/openai/gpt-oss-120b' },
    efforts: { levels: ['low', 'medium', 'high'], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/openai/gpt-oss-120b/blob/main/chat_template.jinja', note: 'reasoning_effort defaults to medium; the model card names low, medium and high' } },
    flags: ['--tool-call-parser', 'openai', '--enable-auto-tool-choice'],
  },
  {
    id: 'gemma4-31b-h200', label: 'Gemma 4 31B · BF16', model: 'google/gemma-4-31B-it', weightsGb: 62.578686256, gpu: 'H200', count: 2, vramGb: 141, diskGb: 100,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Google/Gemma4', context: 262144, contextPerSlot: 262144, verification: 'documented · Apache-2.0 · the engine fetches the gemma-4-31B-it-assistant MTP draft at start',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'documented', source: 'https://docs.sglang.io/cookbook/autoregressive/Google/Gemma4' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/google/gemma-4-31B-it/blob/main/chat_template.jinja', note: 'the template knows enable_thinking only; no effort levels' } },
    flags: ['--tp-size', '2', '--speculative-algorithm', 'NEXTN', '--speculative-draft-model-path', 'google/gemma-4-31B-it-assistant', '--speculative-num-steps', '5', '--speculative-num-draft-tokens', '6', '--speculative-eagle-topk', '1', '--mem-fraction-static', '0.85', '--reasoning-parser', 'gemma4', '--tool-call-parser', 'gemma4'],
  },
  {
    id: 'gemma4-31b-b200', label: 'Gemma 4 31B · BF16', model: 'google/gemma-4-31B-it', weightsGb: 62.578686256, gpu: 'B200', count: 1, vramGb: 180, diskGb: 100,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: 'https://docs.sglang.io/cookbook/autoregressive/Google/Gemma4', context: 262144, contextPerSlot: 262144, verification: 'documented · Apache-2.0',
    verified: { by: 'documented' as const, on: '2026-10-22', note: 'documented', source: 'https://docs.sglang.io/cookbook/autoregressive/Google/Gemma4' },
    efforts: { levels: [], verified: { by: 'documented' as const, on: '2026-10-22', source: 'https://huggingface.co/google/gemma-4-31B-it/blob/main/chat_template.jinja', note: 'the template knows enable_thinking only; no effort levels' } },
    flags: ['--reasoning-parser', 'gemma4', '--tool-call-parser', 'gemma4'],
  },
])

export function hostRecipeVerificationWord(recipe: HostRecipe): HostRecipeVerificationKind {
  return recipe.verified.by
}

export function formatHostOfferLabel(recipe: HostRecipe, detail: string): string {
  return `${recipe.label} · ${detail}`
}

export function recipeFits(recipe: HostRecipe, name: string, memoryGb: number, count: number, nodes = 1): boolean {
  const hardware = name.toUpperCase().replaceAll('NVIDIA', '').trim()
  const matches = recipe.gpu === 'RTX PRO 6000' ? hardware.includes('RTX PRO 6000') && hardware.includes('BLACKWELL') : new RegExp('(^|[^A-Z0-9])' + recipe.gpu + '([^A-Z0-9]|$)').test(hardware)
  return matches && memoryGb >= recipe.vramGb && count >= recipe.count && nodes >= (recipe.nodes ?? 1) && count * nodes >= recipe.count * (recipe.nodes ?? 1)
}
