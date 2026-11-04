import type { HostRecipe } from './recipes.js'

export const TENSORFOLD_HOST_VERSION = '1.2.2'
export const TENSORFOLD_HOST_IMAGE = 'nvidia/cuda:13.0.3-base-ubuntu24.04@sha256:7c7413a56200486f71f181cad9310f6fd31b6bb21816ade15fc9c1e1e927a5c1'
export const TENSORFOLD_HOST_IMAGE_SOURCE = 'https://hub.docker.com/layers/nvidia/cuda/13.0.3-base-ubuntu24.04/images/sha256-7c7413a56200486f71f181cad9310f6fd31b6bb21816ade15fc9c1e1e927a5c1'
export const TENSORFOLD_RELEASE_BASE = 'https://github.com/ashhart/TensorFold/releases/download/v' + TENSORFOLD_HOST_VERSION + '/'
export const TENSORFOLD_RELEASE_PUBLIC_KEY = 'MCowBQYDK2VwAyEA80FFo6a9/NXHNX9zBV3/2tM9AbC//mShbseG74mkkGw='
export const TENSORFOLD_RELEASE_SIGNED_PREFIX = 'tensorfold-native-checksum-v1\n'
export const TENSORFOLD_RELEASE_ARCHIVES = {
  x86_64: { platform: 'linux-x86_64', sha256: '976c39d01ce0e165d67b7b3ede6e6ff5dad037823b35d1539752707c9a238be5', bytes: 46281309 },
  aarch64: { platform: 'linux-aarch64', sha256: '17632c30f761e7f9051255744a17fc36f0b9c0d46343d47617bb34e7ec4e4128', bytes: 45836984 },
} as const
export const TENSORFOLD_HOST_PORT = 8080
export const TENSORFOLD_HOST_VOLUME = '/workspace'
export const TENSORFOLD_HOST_KEY_LABEL = 'mercury[inference]'
export const TENSORFOLD_HOST_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const TENSORFOLD_HOST_CAPABILITIES: readonly string[] = ['8.0', '8.6', '8.9', '12.0', '12.1']
export const TENSORFOLD_HOST_DRIVER_FLOOR = 580
export const TENSORFOLD_HOST_WINDOWS: readonly number[] = [32768, 65536, 131072, 262144]

export type TensorFoldCardClass = 'supported' | 'unqualified' | 'refused'
export interface TensorFoldCard { gpu: string; vramGb: number; capability: string; class: TensorFoldCardClass; evidence: string }
export const TENSORFOLD_CARDS: readonly TensorFoldCard[] = [
  { gpu: 'RTX 5090', vramGb: 32, capability: '12.0', class: 'supported', evidence: '16 RTX 5090 receipts on the public TensorFold board' },
  { gpu: 'RTX PRO 6000', vramGb: 96, capability: '12.0', class: 'supported', evidence: 'checked by TensorFold on RTX PRO 6000 Blackwell' },
  { gpu: 'GB10', vramGb: 128, capability: '12.1', class: 'supported', evidence: 'Nemotron Lightning qualified by TensorFold on GB10' },
  { gpu: 'A100', vramGb: 80, capability: '8.0', class: 'supported', evidence: 'sm_80 kernels ship; kernel checks only, no served-model receipt yet' },
  { gpu: 'RTX A6000', vramGb: 48, capability: '8.6', class: 'supported', evidence: 'Nemotron Lightning qualified by TensorFold on compute capability 8.6' },
  { gpu: 'RTX 3090', vramGb: 24, capability: '8.6', class: 'supported', evidence: 'Nemotron Lightning qualified by TensorFold on compute capability 8.6' },
  { gpu: 'RTX 4090', vramGb: 24, capability: '8.9', class: 'unqualified', evidence: 'sm_89 kernels ship; unqualified by TensorFold' },
  { gpu: 'L40S', vramGb: 48, capability: '8.9', class: 'unqualified', evidence: 'sm_89 kernels ship; unqualified by TensorFold' },
  { gpu: 'L4', vramGb: 24, capability: '8.9', class: 'unqualified', evidence: 'sm_89 kernels ship; unqualified by TensorFold' },
  { gpu: 'H100', vramGb: 80, capability: '9.0', class: 'refused', evidence: 'the 1.2.2 archive holds no sm_90 machine code and no PTX' },
  { gpu: 'H200', vramGb: 141, capability: '9.0', class: 'refused', evidence: 'the 1.2.2 archive holds no sm_90 machine code and no PTX' },
  { gpu: 'B200', vramGb: 180, capability: '10.0', class: 'refused', evidence: 'the 1.2.2 archive holds no sm_100 machine code and no PTX' },
  { gpu: 'B300', vramGb: 288, capability: '10.3', class: 'refused', evidence: 'the 1.2.2 archive holds no sm_103 machine code and no PTX' },
  { gpu: 'GB300', vramGb: 288, capability: '10.3', class: 'refused', evidence: 'the 1.2.2 archive holds no sm_103 machine code and no PTX' },
]

export interface TensorFoldStartingPoint { title: string; repo: string; name: string; revision?: string; drafter?: string; promptCacheGib?: number; downloadGb: number; weightsGib: number; drafterGib?: number; cacheKibPerToken: number; runtimeGib: number; maxWindow: number; source: string; variant: string }
export const TENSORFOLD_STARTING_POINTS: readonly TensorFoldStartingPoint[] = [
  { title: 'Qwen3.8 27B', variant: 'MLX 4-bit + DFlash2', repo: 'TensorFold/Qwen3.8-27B-MLX-4bit', name: 'qwen3.8-27b', drafter: 'z-lab/Qwen3.8-27B-DFlash2', downloadGb: 19.930634001, weightsGib: 14.98, drafterGib: 3.58, cacheKibPerToken: 64, runtimeGib: 2, maxWindow: 262144, source: 'https://github.com/ashhart/TensorFold/blob/main/docs/recipes/qwen3.8-27b.md' },
  { title: 'Nemotron Lightning', variant: 'MLX 4-bit', repo: 'TensorFold/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit', name: 'nemotron-lightning', downloadGb: 18.544234457, weightsGib: 17.27, cacheKibPerToken: 6, runtimeGib: 2, maxWindow: 262144, source: 'https://github.com/ashhart/TensorFold/blob/main/docs/recipes/nemotron-3.5.md' },
  { title: 'Qwen3.5 2B', variant: 'MLX 4-bit', repo: 'mlx-community/Qwen3.5-2B-MLX-4bit', name: 'qwen3.5-2b', revision: '93760be4f1f69842a46bc13dbdc0f19e291392a3', promptCacheGib: 1, downloadGb: 1.749083534, weightsGib: 1.63, cacheKibPerToken: 12, runtimeGib: 2, maxWindow: 262144, source: 'https://github.com/ashhart/TensorFold/blob/main/docs/recipes/qwen3.5-2b-native.md' },
]

export const tensorFoldMemoryGib = (point: TensorFoldStartingPoint, window: number): number => point.weightsGib + (point.drafterGib ?? 0) + window * point.cacheKibPerToken / 1048576 + (point.promptCacheGib ?? 0) + point.runtimeGib
export const tensorFoldCardReserveGib = (card: Pick<TensorFoldCard, 'vramGb'>): number => Math.max(1, card.vramGb / 32)
export function tensorFoldWindowFor(point: TensorFoldStartingPoint, card: Pick<TensorFoldCard, 'vramGb'>): number | undefined {
  const usable = card.vramGb - tensorFoldCardReserveGib(card)
  return [...TENSORFOLD_HOST_WINDOWS].reverse().find(window => window <= point.maxWindow && tensorFoldMemoryGib(point, window) <= usable)
}
export const tensorFoldWindowWords = (window: number): string => window >= 1048576 ? window / 1048576 + 'M' : Math.round(window / 1024) + 'k'
export const tensorFoldTitle = (point: Pick<TensorFoldStartingPoint, 'title'>): string => point.title + ' on TensorFold'
export const tensorFoldRecipeId = (point: TensorFoldStartingPoint, card: TensorFoldCard): string => 'tensorfold-' + point.name.replaceAll('.', '') + '-' + card.gpu.toLowerCase().replaceAll(' ', '-')
export const tensorFoldServeFlags = (point: TensorFoldStartingPoint, window: number): string[] => ['--name', point.name, '--context', String(window), ...(point.drafter ? ['--drafter', point.drafter] : []), ...(point.promptCacheGib ? ['--prompt-cache-gib', String(point.promptCacheGib)] : [])]
export const tensorFoldClassWords = (card: TensorFoldCard): string => card.class === 'supported' ? 'supported' : card.class === 'unqualified' ? 'ships · unqualified by TensorFold' : 'not offered'

export function tensorFoldHostRecipes(): HostRecipe[] {
  const rows: HostRecipe[] = []
  for (const card of TENSORFOLD_CARDS) {
    if (card.class === 'refused') continue
    for (const point of TENSORFOLD_STARTING_POINTS) {
      const window = tensorFoldWindowFor(point, card)
      if (!window) continue
      const memory = tensorFoldMemoryGib(point, window)
      const words = (card.class === 'supported' ? 'TensorFold ' + TENSORFOLD_HOST_VERSION + ' for CUDA' : tensorFoldClassWords(card)) + ' · ' + card.gpu + ' · ' + tensorFoldWindowWords(window) + ' window · ~' + memory.toFixed(1) + ' GiB of ' + card.vramGb + ' (an estimate) · ' + card.evidence
      rows.push({
        id: tensorFoldRecipeId(point, card), label: tensorFoldTitle(point) + ' · ' + point.variant, model: point.repo, weightsGb: point.downloadGb, gpu: card.gpu, count: 1, vramGb: card.vramGb, diskGb: 80,
        engine: 'tensorfold', image: TENSORFOLD_HOST_IMAGE, imageSource: TENSORFOLD_HOST_IMAGE_SOURCE, cuda: '13.0', source: point.source, verification: words,
        verified: { by: card.class === 'supported' ? 'documented' : 'unverified', on: '2026-11-04', note: words, source: point.source },
        efforts: { levels: [...TENSORFOLD_HOST_EFFORTS], verified: { by: 'documented', on: '2026-11-04', source: 'https://github.com/ashhart/TensorFold/blob/main/docs/api.md', note: 'reasoning_effort none through max; none turns thinking off; a level the template lacks maps to its nearest' } },
        context: window, contextPerSlot: window,
        flags: tensorFoldServeFlags(point, window),
      })
    }
  }
  return rows
}

export const tensorFoldStartingPoint = (recipe: Pick<HostRecipe, 'engine' | 'model'>): TensorFoldStartingPoint | undefined => recipe.engine === 'tensorfold' ? TENSORFOLD_STARTING_POINTS.find(point => point.repo === recipe.model) : undefined
export function tensorFoldServedName(recipe: Pick<HostRecipe, 'engine' | 'model' | 'flags'>): string | undefined {
  if (recipe.engine !== 'tensorfold') return
  const at = recipe.flags.indexOf('--name')
  return at >= 0 ? recipe.flags[at + 1] : tensorFoldStartingPoint(recipe)?.name
}
export const tensorFoldCardFor = (gpu: string): TensorFoldCard | undefined => {
  const hardware = gpu.toUpperCase().replaceAll('NVIDIA', '').trim()
  return TENSORFOLD_CARDS.find(card => card.gpu === 'RTX PRO 6000' ? hardware.includes('RTX PRO 6000') : new RegExp('(^|[^A-Z0-9])' + card.gpu + '([^A-Z0-9]|$)').test(hardware))
}

const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
const pem = (key: string): string => "printf '%s\\n' '-----BEGIN PUBLIC KEY-----' " + quote(key) + " '-----END PUBLIC KEY-----' > release-key.pem"
export const tensorFoldKeyFileLine = (key: string): string => TENSORFOLD_HOST_KEY_LABEL + ': ' + key + '\n'
export const tensorFoldKeyPath = (dir: string): string => dir + '/api-key'
export const tensorFoldReadyCommand = (dir: string): string => 'curl -fsS --max-time 10 http://127.0.0.1:' + TENSORFOLD_HOST_PORT + '/health >/dev/null && curl -fsS --max-time 10 -H "Authorization: Bearer $(cut -d \' \' -f 2 ' + quote(tensorFoldKeyPath(dir)) + ')" http://127.0.0.1:' + TENSORFOLD_HOST_PORT + '/v1/models'
export const tensorFoldKeyWriteCommand = (dir: string, key: string): string => 'umask 077; mkdir -p ' + quote(dir) + ' && printf %s ' + quote(tensorFoldKeyFileLine(key)) + ' > ' + quote(tensorFoldKeyPath(dir)) + ' && chmod 600 ' + quote(tensorFoldKeyPath(dir))

export function tensorFoldEngineScript(recipe: HostRecipe, dir: string, options: { volume?: string; publicKey?: string; releaseBase?: string; archives?: { x86_64: { sha256: string }; aarch64: { sha256: string } } } = {}): string {
  const point = tensorFoldStartingPoint(recipe)
  if (!point) throw new Error('This recipe is not a TensorFold starting point: ' + recipe.id)
  const volume = options.volume ?? TENSORFOLD_HOST_VOLUME
  const base = options.releaseBase ?? TENSORFOLD_RELEASE_BASE
  const archives = options.archives ?? TENSORFOLD_RELEASE_ARCHIVES
  const pulls = [point.repo + (point.revision ? '@' + point.revision : ''), ...(point.drafter ? [point.drafter] : [])]
  const serve = ['tensorfold-native', 'serve', point.repo, ...recipe.flags, '--host', '0.0.0.0', '--port', String(TENSORFOLD_HOST_PORT), '--api-key-file'].map(quote).join(' ') + ' "$dir/api-key"'
  return [
    'set -e',
    'dir=' + quote(dir),
    'volume=' + quote(volume),
    'export HF_HOME="$volume/huggingface"',
    'export HOME="$volume/mercury-host/home"',
    'mkdir -p "$HF_HOME" "$HOME" "$dir"',
    "echo 'MERCURY_STEP checking the NVIDIA driver'",
    'driver="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n 1 | tr -d \' \')"',
    'case "$driver" in [0-9]*) ;; *) echo \'no NVIDIA driver answered nvidia-smi; TensorFold ' + TENSORFOLD_HOST_VERSION + ' needs driver R' + TENSORFOLD_HOST_DRIVER_FLOOR + ' or newer (CUDA 13.0)\'; exit 1;; esac',
    'if [ "${driver%%.*}" -lt ' + TENSORFOLD_HOST_DRIVER_FLOOR + ' ]; then echo "NVIDIA driver $driver is older than R' + TENSORFOLD_HOST_DRIVER_FLOOR + ' (CUDA 13.0), which TensorFold ' + TENSORFOLD_HOST_VERSION + ' needs; choose a machine with a newer driver"; exit 1; fi',
    'capability="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -n 1 | tr -d \' \')"',
    'case "$capability" in ' + TENSORFOLD_HOST_CAPABILITIES.join('|') + ') ;; *) echo "TensorFold ' + TENSORFOLD_HOST_VERSION + ' ships no CUDA kernels for compute capability $capability (its archive holds sm_80, sm_86, sm_89, sm_120 and sm_121 machine code and no PTX); choose another GPU"; exit 1;; esac',
    'echo "MERCURY_STEP driver $driver · compute capability $capability"',
    'missing=""',
    'for tool in curl openssl sha256sum tar; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done',
    'if [ -n "$missing" ]; then if [ "$(id -u)" = 0 ] && command -v apt-get >/dev/null 2>&1; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl openssl ca-certificates tar coreutils; else echo "install$missing on this machine first"; exit 1; fi; fi',
    'case "$(uname -m)" in',
    '  x86_64) platform=' + TENSORFOLD_RELEASE_ARCHIVES.x86_64.platform + '; expected=' + archives.x86_64.sha256 + ';;',
    '  aarch64|arm64) platform=' + TENSORFOLD_RELEASE_ARCHIVES.aarch64.platform + '; expected=' + archives.aarch64.sha256 + ';;',
    '  *) echo "TensorFold ' + TENSORFOLD_HOST_VERSION + ' has no Linux release archive for $(uname -m)"; exit 1;;',
    'esac',
    'archive="tensorfold-' + TENSORFOLD_HOST_VERSION + '-$platform.tar.gz"',
    'runtime="$dir/tensorfold-' + TENSORFOLD_HOST_VERSION + '-$platform"',
    'if ! [ -x "$runtime/bin/tensorfold-native" ] || ! [ -r "$runtime/lib/libtfgrammar.so" ]; then',
    '  echo "MERCURY_STEP downloading TensorFold ' + TENSORFOLD_HOST_VERSION + ' for $platform"',
    '  rm -rf "$dir/release"; mkdir -p "$dir/release"',
    '  (',
    '    cd "$dir/release"',
    '    base=' + quote(base) + '"$archive"',
    "    curl --proto '=https' --proto-redir '=https' -fsSL --retry 3 \"$base\" -o \"$archive\"",
    "    curl --proto '=https' --proto-redir '=https' -fsSL --retry 3 --max-filesize 1024 \"$base.sha256\" -o \"$archive.sha256\"",
    "    curl --proto '=https' --proto-redir '=https' -fsSL --retry 3 --max-filesize 64 \"$base.sha256.sig\" -o \"$archive.sha256.sig\" || { echo 'This release has no checksum signature, so this installer stops.'; exit 1; }",
    '    ' + pem(options.publicKey ?? TENSORFOLD_RELEASE_PUBLIC_KEY),
    "    { printf 'tensorfold-native-checksum-v1\\n'; cat \"$archive.sha256\"; } > signed-checksum",
    '    openssl pkeyutl -verify -rawin -pubin -inkey release-key.pem -in signed-checksum -sigfile "$archive.sha256.sig" >/dev/null 2>&1 || { echo \'Release signature verification failed; a signed checksum and OpenSSL with Ed25519 support are required.\'; exit 1; }',
    '    [ "$(cat "$archive.sha256")" = "$expected  $archive" ] || { echo "the signed checksum names another archive or digest than the one Mercury measured for TensorFold ' + TENSORFOLD_HOST_VERSION + '"; exit 1; }',
    '    sha256sum -c "$archive.sha256"',
    '    tar -xzf "$archive"',
    '    [ -x "tensorfold-' + TENSORFOLD_HOST_VERSION + '-$platform/bin/tensorfold-native" ] && [ -r "tensorfold-' + TENSORFOLD_HOST_VERSION + '-$platform/lib/libtfgrammar.so" ] || { echo \'the release archive did not contain bin/tensorfold-native beside lib/libtfgrammar.so\'; exit 1; }',
    '    rm -rf "$runtime"',
    '    mv "tensorfold-' + TENSORFOLD_HOST_VERSION + '-$platform" "$runtime"',
    '  )',
    '  rm -rf "$dir/release"',
    'fi',
    'export PATH="$runtime/bin:$PATH"',
    'echo "MERCURY_STEP TensorFold $(tensorfold-native --version 2>/dev/null | head -n 1 | sed \'s/^tensorfold-native //\') installed"',
    '[ -f "$dir/api-key" ] || { echo \'the API key file is missing; resume the setup from /llmhost\'; exit 1; }',
    'chmod 600 "$dir/api-key"',
    ...pulls.flatMap(repo => ['echo ' + quote('MERCURY_STEP pulling ' + repo), 'tensorfold-native pull ' + quote(repo)]),
    "echo 'MERCURY_STEP starting engine'",
    serve,
    'wait',
    '',
  ].join('\n')
}
