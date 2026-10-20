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
  nodes?: number
  weightsGb?: number
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
  engine?: 'llamacpp' | 'vllm'
  imageSource?: string
  install?: string
  weightFile?: string
  include?: string
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
const llamaInstall = 'export PATH=/usr/local/cuda/bin:$PATH CUDACXX=/usr/local/cuda/bin/nvcc && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y pciutils build-essential cmake curl libcurl4-openssl-dev git python3-venv && python3 -m venv /workspace/mercury-host/hf && /workspace/mercury-host/hf/bin/pip install -U huggingface_hub && if ! test -d /workspace/mercury-host/llama.cpp; then git clone https://github.com/ggml-org/llama.cpp /workspace/mercury-host/llama.cpp; fi && git -C /workspace/mercury-host/llama.cpp checkout 3bb63cbcbfb62056c84fe9e521b0f3d756d29c32 && cmake /workspace/mercury-host/llama.cpp -B /workspace/mercury-host/llama.cpp/build -DBUILD_SHARED_LIBS=OFF -DGGML_CUDA=ON -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc -DCMAKE_CUDA_ARCHITECTURES="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -n 1 | tr -d .)" && cmake --build /workspace/mercury-host/llama.cpp/build --config Release -j --target llama-server'

export const HOST_RECIPES: readonly HostRecipe[] = [
  {
    id: 'glm53-flash-gguf-b300', label: 'GLM-5.3-Flash · UD-Q4_K_XL', model: 'unsloth/GLM-5.3-Flash-GGUF', gpu: 'B300', count: 1, vramGb: 288, diskGb: 300,
    engine: 'llamacpp', image: 'nvidia/cuda:13.0.2-devel-ubuntu24.04', cuda: '13.0', imageSource: 'https://hub.docker.com/layers/nvidia/cuda/13.0.2-devel-ubuntu24.04/images/sha256-5dc1bca23d05bd37b011be68ec470c03b403a5da07ec3a86e41af9470e9d0cc6', source: 'https://unsloth.ai/docs/models/glm-5.3-flash', verification: 'llama.cpp (GGUF) · verified on 1× B300 (67 tok/s)',
    verified: { by: 'measured', on: '2026-10-20', note: '1× B300 · upstream llama.cpp 3bb63cbcbfb62056c84fe9e521b0f3d756d29c32 · 67 tok/s single-stream, ~23 tok/s per stream with two busy · 193 GB VRAM · 524,288 ctx across 4 slots (131,072 per slot)', source: 'https://unsloth.ai/docs/models/glm-5.3-flash' },
    context: 131072, contextPerSlot: 131072,
    install: llamaInstall,
    include: '*UD-Q4_K_XL*', weightFile: 'UD-Q4_K_XL/GLM-5.3-Flash-UD-Q4_K_XL-00001-of-00006.gguf',
    flags: ['--n-gpu-layers', 'all', '--jinja', '--ctx-size', '524288', '--parallel', '4', '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--cache-reuse', '256', '--temp', '1.0', '--top-p', '0.95', '--chat-template-kwargs', '{"reasoning_effort":"max"}'],
  },
  {
    id: 'nemotron35-super-gguf-rtx-pro-6000', label: 'Nemotron 3.5 Super VL 120B · UD-Q3_K_XL', model: 'unsloth/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-GGUF', gpu: 'RTX PRO 6000', count: 1, vramGb: 96, diskGb: 120,
    engine: 'llamacpp', image: 'nvidia/cuda:13.0.2-devel-ubuntu24.04', cuda: '13.0', imageSource: 'https://hub.docker.com/layers/nvidia/cuda/13.0.2-devel-ubuntu24.04/images/sha256-5dc1bca23d05bd37b011be68ec470c03b403a5da07ec3a86e41af9470e9d0cc6', source: 'https://unsloth.ai/docs/models/nemotron-3.5-super-vl', verification: 'llama.cpp (GGUF) · the road the model card names for RTX PRO 6000 · 65.8 GB, documented minimum 96 GB · GPU run not measured',
    verified: { by: 'documented', note: "NVIDIA's model card names llama.cpp for RTX PRO 6000; Unsloth's 96 GB minimum", source: 'https://unsloth.ai/docs/models/nemotron-3.5-super-vl' },
    context: 131072, contextPerSlot: 131072,
    install: llamaInstall,
    include: '*UD-Q3_K_XL*', weightFile: 'UD-Q3_K_XL/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-UD-Q3_K_XL-00001-of-00003.gguf',
    flags: ['--n-gpu-layers', 'all', '--jinja', '--ctx-size', '524288', '--parallel', '4', '--flash-attn', 'on', '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--cache-reuse', '256', '--temp', '1.0', '--top-p', '0.95', '--top-k', '0', '--min-p', '0.0', '--reasoning-format', 'deepseek'],
  },
  {
    id: 'glm53-flash-b200-community', label: 'GLM-5.3-Flash · NVFP4', model: 'RadixArk/GLM-5.3-Flash-NVFP4', gpu: 'B200', count: 4, vramGb: 180, diskGb: 300,
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
  ...[{ gpu: 'B200', vramGb: 180 }, { gpu: 'B300', vramGb: 288 }, { gpu: 'GB300', vramGb: 288 }].map(hw => ({
    id: 'deepseek41-' + hw.gpu.toLowerCase(), label: 'DeepSeek-V4.1-Flash-1017', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', ...hw, count: 4, diskGb: 650,
    image: 'lmsysorg/sglang:dev-dsv41', cuda: '13.0', source: dsSource, verification: 'verified',
    verified: { by: 'documented' as const, note: 'verified', source: dsSource },
    flags: ['--trust-remote-code', '--tp', '4', '--ep-size', '4', '--mem-fraction-static', '0.8', '--speculative-algorithm', 'DSPARK', '--speculative-dspark-block-size', '5', '--cuda-graph-max-bs-decode', '64', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto'],
  })),
  ...[{ gpu: 'H200', count: 8, vramGb: 141 }, { gpu: 'B200', count: 8, vramGb: 180 }, { gpu: 'B300', count: 8, vramGb: 288 }, { gpu: 'GB300', count: 4, vramGb: 288 }].map(hw => ({
    id: 'glm53-' + hw.gpu.toLowerCase(), label: 'GLM-5.3 · FP8', model: 'zai-org/GLM-5.3', ...hw, weightsGb: 756, context: 1048576, contextPerSlot: 1048576, diskGb: 950,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: glmSource, verification: 'verified · GLM-5.3 License · MaaS operators above $10B aggregate revenue in 12 months require Z.AI security review',
    verified: { by: 'documented' as const, note: 'verified', source: glmSource },
    pythonInstall,
    flags: ['--tp', String(hw.count), ...mtp, '--mem-fraction-static', hw.count === 4 ? '0.85' : '0.8', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto'],
  })),
  ...[{ gpu: 'B300', count: 8, nodes: 1, vramGb: 288, badge: 'verified' }, { gpu: 'B200', count: 8, nodes: 2, vramGb: 180, badge: 'in-progress' }, { gpu: 'H200', count: 8, nodes: 2, vramGb: 141, badge: 'in-progress' }, { gpu: 'GB300', count: 4, nodes: 2, vramGb: 288, badge: 'in-progress' }].map(({ badge, ...hw }) => ({
    id: 'kimi-k3-' + hw.gpu.toLowerCase(), label: 'Kimi K3 · MXFP4', model: 'moonshotai/Kimi-K3', ...hw, weightsGb: 1561, diskGb: 2000,
    image: 'lmsysorg/sglang:kimi-k3', cuda: '13.0', source: kimiSource, context: 1048576, contextPerSlot: 1048576,
    verification: badge + ' · Kimi K3 License · MaaS operators above $20M aggregate revenue in 12 months need a separate agreement; internal use exempt · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-20', note: badge, source: kimiSource },
    ...(hw.gpu === 'H200' ? { environment: { NCCL_MNNVL_ENABLE: '1', NCCL_CUMEM_ENABLE: '1', SGLANG_ENABLE_TP_MEMORY_INBALANCE_CHECK: '0' } } : hw.gpu === 'GB300' ? { environment: { SGLANG_ENABLE_TP_MEMORY_INBALANCE_CHECK: '0' } } : {}),
    flags: ['--trust-remote-code', '--tp-size', hw.gpu === 'H200' ? '16' : '8', ...(hw.gpu === 'B200' ? ['--pp-size', '2', '--disable-flashinfer-autotune', '--watchdog-timeout', '3600', '--model-loader-extra-config', '{"enable_multithread_load":true}'] : []), ...(hw.gpu === 'H200' ? ['--ep-size', '16', '--moe-runner-backend', 'marlin', '--decode-attention-backend', 'flashmla', '--enable-symm-mem'] : []), '--mem-fraction-static', '0.85', '--reasoning-parser', 'kimi_k3', '--tool-call-parser', 'kimi_k3'],
  })),
  ...[{ gpu: 'H200', nodes: 4, vramGb: 141 }, { gpu: 'B200', nodes: 2, vramGb: 180 }, { gpu: 'B300', nodes: 2, vramGb: 288 }].map(hw => ({
    id: 'qwen38-24t-fp8-' + hw.gpu.toLowerCase(), label: 'Qwen3.8-2.4T-A95B · FP8', model: 'Qwen/Qwen3.8-2.4T-A95B-FP8', ...hw, count: 8, weightsGb: 2497, diskGb: 3000,
    image: 'lmsysorg/sglang:qwen38', cuda: '13.0', source: qwenMaxSource, context: 262144, contextPerSlot: 262144,
    verification: 'verified · Qwen3.8-Max License · MaaS or AI Work Assistant businesses above $50M aggregate revenue in 12 months need a separate licence; internal use exempt',
    verified: { by: 'documented' as const, on: '2026-10-20', note: 'verified', source: qwenMaxSource },
    flags: ['--trust-remote-code', '--tp-size', '8', '--pp-size', String(hw.nodes), '--dist-timeout', '1800', '--mamba-full-memory-ratio', '0.95', '--mamba-ssm-dtype', 'bfloat16', ...(hw.gpu === 'H200' ? ['--linear-attn-prefill-backend', 'flashinfer', '--linear-attn-decode-backend', 'flashinfer', '--max-prefill-tokens', '8192', '--page-size', '64'] : hw.gpu === 'B300' ? ['--context-length', '262144', '--attention-backend', 'trtllm_mha', '--linear-attn-prefill-backend', 'flashinfer', '--linear-attn-decode-backend', 'flashinfer', '--moe-runner-backend', 'flashinfer_trtllm', '--moe-a2a-backend', 'none', '--mamba-radix-cache-strategy', 'extra_buffer', '--mem-fraction-static', '0.95', '--max-running-requests', '512', '--chunked-prefill-size', '8192', '--max-prefill-tokens', '8192', '--page-size', '64', '--cuda-graph-backend-decode', 'full', '--cuda-graph-max-bs-decode', '128', '--cuda-graph-bs-decode', '1', '2', '4', '8', '16', '32', '64', '128'] : ['--chunked-prefill-size', '8192']), '--reasoning-parser', 'qwen3', '--tool-call-parser', 'qwen3_coder'],
  })),
  {
    id: 'qwen38-24t-nvfp4-b300', label: 'Qwen3.8-2.4T-A95B · NVFP4', model: 'RadixArk/Qwen3.8-2.4T-A95B-NVFP4', gpu: 'B300', count: 8, weightsGb: 1485, vramGb: 288, diskGb: 1900,
    image: 'lmsysorg/sglang:qwen38', cuda: '13.0', source: qwenMaxSource, context: 262144, contextPerSlot: 262144,
    verification: 'verified · Qwen3.8-Max License · MaaS or AI Work Assistant businesses above $50M aggregate revenue in 12 months need a separate licence; internal use exempt',
    verified: { by: 'documented', on: '2026-10-20', note: 'verified', source: qwenMaxSource },
    environment: { SGLANG_FLASHINFER_MNNVL_CUTEDSL_AR_FUSION: '1' },
    flags: ['--trust-remote-code', '--tp-size', '8', '--moe-runner-backend', 'flashinfer_trtllm', '--mamba-radix-cache-strategy', 'extra_buffer', '--mamba-ssm-dtype', 'bfloat16', '--speculative-algorithm', 'NEXTN', '--speculative-num-steps', '3', '--speculative-eagle-topk', '1', '--speculative-num-draft-tokens', '4', '--enable-linear-replayssm-spec', '--mem-fraction-static', '0.90', '--chunked-prefill-size', '8192', '--max-prefill-tokens', '8192', '--reasoning-parser', 'qwen3', '--tool-call-parser', 'qwen3_coder'],
  },
  ...[{ gpu: 'B200', count: 8, vramGb: 180, badge: 'in-progress' }, { gpu: 'B300', count: 8, vramGb: 288, badge: 'in-progress' }, { gpu: 'GB300', count: 4, vramGb: 288, badge: 'verified' }].map(({ badge, ...hw }) => ({
    id: 'deepseek-v4-pro-0813-' + hw.gpu.toLowerCase(), label: 'DeepSeek-V4-Pro-0813 · MXFP4', model: 'deepseek-ai/DeepSeek-V4-Pro-0813', ...hw, weightsGb: 893, diskGb: 1100,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: dsProSource, context: 1048576, contextPerSlot: 1048576, verification: badge + ' · MIT · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-20', note: badge, source: dsProSource },
    ...(hw.gpu === 'B200' ? { environment: { SGLANG_OPT_USE_JIT_NORM: '1', SGLANG_OPT_USE_TOPK_V2: '1' } } : {}),
    flags: ['--trust-remote-code', '--tp', String(hw.count), '--moe-runner-backend', 'flashinfer_mxfp4', '--speculative-algorithm', 'DSPARK', '--chunked-prefill-size', '8192', '--disable-flashinfer-autotune', '--swa-full-tokens-ratio', '0.1', '--mem-fraction-static', '0.90', '--reasoning-parser', 'deepseek-v4', '--tool-call-parser', 'deepseekv4'],
  })),
  ...[{ gpu: 'B300', vramGb: 288, badge: 'verified' }, { gpu: 'H200', vramGb: 141, badge: 'in-progress' }].map(({ badge, ...hw }) => ({
    id: 'mimo26-pro-' + hw.gpu.toLowerCase(), label: 'MiMo-V2.6-Pro-RL · MXFP4', model: 'XiaomiMiMo/MiMo-V2.6-Pro-RL', ...hw, count: 8, weightsGb: 574, diskGb: 800,
    image: 'lmsysorg/sglang:dev', cuda: '13.0', source: mimoSource, context: 1048576, contextPerSlot: 1048576, verification: badge + ' · MIT · configured 1M context, capacity not measured',
    verified: { by: 'documented' as const, on: '2026-10-20', note: badge, source: mimoSource },
    flags: ['--tp', '8', '--trust-remote-code', '--reasoning-parser', 'mimo', '--tool-call-parser', 'mimo', ...(hw.gpu === 'H200' ? ['--moe-runner-backend', 'marlin'] : ['--ep', '8', '--dp', '1', '--pp-size', '1', '--moe-runner-backend', 'deep_gemm', '--moe-a2a-backend', 'deepep', '--deepep-mode', 'auto', '--moe-dense-tp-size', '1', '--enable-dp-lm-head', '--log-level-http', 'warning', '--enable-cache-report', '--page-size', '1', '--cuda-graph-max-bs-decode', '64', '--max-running-requests', '64', '--mem-fraction-static', '0.7', '--swa-full-tokens-ratio', '0.08', '--chunked-prefill-size', '49152', '--max-prefill-tokens', '65536', '--attention-backend', 'fa4', '--speculative-algorithm', 'DFLASH', '--speculative-draft-model-path', '/workspace/mercury-host/mimo26-pro-b300/weights/dflash', '--speculative-num-draft-tokens', '8', '--context-length', '1048576', '--cuda-graph-backend-prefill=disabled', '--mm-enable-dp-encoder', '--mm-attention-backend', 'fa4'])],
  })),
  ...[{ gpu: 'H200', vramGb: 141 }, { gpu: 'B200', vramGb: 180 }].map(hw => ({
    id: 'mistral-large3-' + hw.gpu.toLowerCase(), label: 'Mistral Large 3 675B · FP8', model: 'mistralai/Mistral-Large-3-675B-Instruct-2512', ...hw, count: 8, weightsGb: 682, diskGb: 900, engine: 'vllm' as const,
    image: 'vllm/vllm-openai:latest', cuda: '13.0', source: mistralSource, context: 262144, contextPerSlot: 262144, verification: 'Apache-2.0 · vendor FP8 serving recipe',
    verified: { by: 'documented' as const, on: '2026-10-20', note: 'Vendor model-card vLLM recipe; GPU serving not measured by Mercury', source: mistralSource },
    flags: ['--max-model-len', '262144', '--tensor-parallel-size', '8', '--tokenizer_mode', 'mistral', '--config_format', 'mistral', '--load_format', 'mistral', '--enable-auto-tool-choice', '--tool-call-parser', 'mistral'],
  })),
  ...[{ gpu: 'H200', count: 8, nodes: 2, vramGb: 141, badge: 'in-progress' }, { gpu: 'B200', count: 8, nodes: 2, vramGb: 180, badge: 'in-progress' }, { gpu: 'B300', count: 8, nodes: 1, vramGb: 288, badge: 'verified' }, { gpu: 'GB300', count: 4, nodes: 2, vramGb: 288, badge: 'in-progress' }].map(({ badge, ...hw }) => ({
    id: 'glm53-bf16-' + hw.gpu.toLowerCase(), label: 'GLM-5.3 · BF16', model: 'zai-org/GLM-5.3-BF16', ...hw, weightsGb: 1507, diskGb: 1900,
    image: 'lmsysorg/sglang:latest', cuda: '13.0', source: glmSource, context: 1048576, contextPerSlot: 1048576,
    verification: badge + ' · GLM-5.3 License · MaaS operators above $10B aggregate revenue in 12 months require Z.AI security review',
    verified: { by: 'documented' as const, on: '2026-10-20', note: badge, source: glmSource },
    flags: ['--tp', String(hw.count * hw.nodes), ...mtp, '--mem-fraction-static', hw.gpu === 'B300' ? '0.9' : '0.85', '--reasoning-parser', 'auto', '--tool-call-parser', 'auto'],
  })),
]

export function hostRecipeVerificationWord(recipe: HostRecipe): HostRecipeVerificationKind {
  return recipe.verified.by
}

export function formatHostOfferLabel(recipe: HostRecipe, detail: string): string {
  return `${recipe.label} · ${detail} · ${recipe.verified.by}`
}

export function recipeFits(recipe: HostRecipe, name: string, memoryGb: number, count: number, nodes = 1): boolean {
  const hardware = name.toUpperCase().replaceAll('NVIDIA', '').trim()
  const matches = recipe.gpu === 'RTX PRO 6000' ? hardware.includes('RTX PRO 6000') && hardware.includes('BLACKWELL') : new RegExp('(^|[^A-Z0-9])' + recipe.gpu + '([^A-Z0-9]|$)').test(hardware)
  return matches && memoryGb >= recipe.vramGb && count >= recipe.count && nodes >= (recipe.nodes ?? 1) && count * nodes >= recipe.count * (recipe.nodes ?? 1)
}
