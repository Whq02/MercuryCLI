import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.6' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tensorfold-health-row-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const health = await import('../../src/services/providers/local/tensorfoldHealth.ts')
const support = await import('../../src/services/providers/local/tensorfoldSupport.ts')
const { renderPlainCertificate } = await import('../../src/cli/healthPresentation.ts')
type Reads = NonNullable<Parameters<typeof health.readTensorFoldHealth>[0]>
type Snapshot = Awaited<ReturnType<NonNullable<Reads['snapshot']>>>

console.log('RED on the base: no TensorFold row, no support line, no helper row in /health')
const ENGINE = { version: '1.2.2', binary: '/opt/homebrew/bin/tensorfold', chip: 'Apple M5 Pro', backends: ['metal'], families: [], optionalLibraries: [{ name: 'JPEG input unusable', found: false, note: 'libjpeg-turbo is not release 3.1.4.1; PNG images still serve' }] }
const OS = 'macOS 27.0'
const server = (root: string, model: string, window: number, opts: { keyed?: boolean; open?: boolean } = {}): Snapshot => ({
  probedAtMs: 1,
  targetCount: 1,
  servers: [{
    kind: 'tensorfold',
    root,
    baseUrl: `${root}/v1`,
    label: opts.keyed ? 'TensorFold' : 'TensorFold 1.2.2',
    ...(opts.keyed ? {} : { version: '1.2.2' }),
    models: [{ id: model, server: 'tensorfold', baseUrl: `${root}/v1`, contextWindow: { tokens: window, source: 'served' }, thinkingDeclared: true, efforts: [], loaded: true }],
    engine: opts.keyed ? { keyed: true } : { keyed: false, backend: 'metal', device: 'Apple M5 Pro', inUseBytes: 3006477107, streams: 8 },
  }],
})
const base: Reads = {
  engine: async () => ENGINE,
  served: () => [],
  snapshot: async () => null,
  hosts: () => [],
  app: async () => ({ running: false }),
  helper: () => ({ enabled: false }),
  exited: async () => undefined,
}
const osRead = support.readOsVersionWords
const osVersion = await osRead()

async function rows(reads: Partial<Reads>): Promise<ReturnType<typeof health.readTensorFoldHealth>> {
  return health.readTensorFoldHealth({ ...base, ...reads })
}

const ok = await rows({
  snapshot: async () => server('http://127.0.0.1:8080', 'qwen3.5-2b', 262144),
  served: () => [{ repo: 'mlx-community/Qwen3.5-2B-MLX-4bit', name: 'qwen3.5-2b', port: 8080, window: 262144, pid: 4242, startedAt: '2026-11-04T20:00:00.000Z', promptCacheGib: 1 }],
})
assert.equal(ok.tensorfold?.status, 'ok')
assert.equal(ok.tensorfold?.evidence, 'qwen3.5-2b on 127.0.0.1:8080 · 256k served · 2.8 GiB in use · 8 streams · TensorFold 1.2.2 · Metal · Apple M5 Pro · started by Mercury (service tensorfold)')
assert.equal(ok.tensorfold?.detail, 'optional libraries: JPEG input unusable (libjpeg-turbo is not release 3.1.4.1; PNG images still serve)')
assert.equal(ok.support, `TensorFold 1.2.2 · Metal · Apple M5 Pro · ${osVersion} · mlx-community/Qwen3.5-2B-MLX-4bit · --context 262144 --prompt-cache-gib 1 · Mercury 1.0.6`)
console.log('PASS ok: served by Mercury — the design words, the optional-libraries detail, the support line with --context and --prompt-cache-gib')

const warn = await rows({ snapshot: async () => server('http://127.0.0.1:8087', 'qwen3.5-2b', 8192) })
assert.equal(warn.tensorfold?.status, 'warn')
assert.equal(warn.tensorfold?.evidence, 'qwen3.5-2b on 127.0.0.1:8087 serves an 8k window · under the 32k Mercury needs · started outside Mercury')
assert.equal(warn.tensorfold?.fix, '/tensorfold serves it again at 32k or more')
assert.equal(warn.support, `TensorFold 1.2.2 · Metal · Apple M5 Pro · ${osVersion} · qwen3.5-2b · --context 8192 · Mercury 1.0.6`)
console.log('PASS warn: a window under 32k started outside Mercury')

const keyed = await rows({ snapshot: async () => server('http://127.0.0.1:8080', 'qwen3.8-27b', 131072, { keyed: true }) })
assert.equal(keyed.tensorfold?.status, 'info')
assert.equal(keyed.tensorfold?.evidence, '127.0.0.1:8080 answers with a key · /health shows status only · model and window read from /v1/models: qwen3.8-27b · 128k')
assert.equal(keyed.support, `TensorFold 1.2.2 · Metal · Apple M5 Pro · ${osVersion} · qwen3.8-27b · --context 131072 · Mercury 1.0.6`)
console.log('PASS info: a keyed server shows status only; the support line falls back to the installed engine for version, backend and chip')

const installed = await rows({})
assert.equal(installed.tensorfold?.status, 'info')
assert.equal(installed.tensorfold?.evidence, 'TensorFold 1.2.2 installed · nothing served')
assert.equal(installed.tensorfold?.fix, '/tensorfold')
assert.equal(installed.support, `TensorFold 1.2.2 · Metal · Apple M5 Pro · ${osVersion} · Mercury 1.0.6`)
console.log('PASS info: installed, nothing served')

const exited = await rows({ exited: async () => ({ name: 'tensorfold', lastLine: 'tensorfold: one stream\'s 262144-token window of KV pages (8.00 GiB) does not fit' }) })
assert.equal(exited.tensorfold?.status, 'fail')
assert.equal(exited.tensorfold?.evidence, 'the tensorfold service exited · tensorfold: one stream\'s 262144-token window of KV pages (8.00 GiB) does not fit')
assert.equal(exited.tensorfold?.fix, '/tensorfold starts it again')
console.log('PASS fail: the service exited with its last stderr line')

const lan = await rows({
  engine: async () => null,
  snapshot: async () => server('http://studio.local:8080', 'qwen3.8-27b', 131072, { keyed: true }),
  hosts: () => [{ name: 'studio', baseUrl: 'http://studio.local:8080', origin: 'typed', keyRef: 'stored', version: '1.2.2', chip: 'Apple M3 Ultra' }],
})
assert.equal(lan.tensorfold?.status, 'info')
assert.equal(lan.tensorfold?.evidence, 'studio.local:8080 answers with a key · /health shows status only · model and window read from /v1/models: qwen3.8-27b · 128k · studio')
assert.equal(lan.support, `TensorFold 1.2.2 · studio · ${osVersion} · qwen3.8-27b · --context 131072 · Mercury 1.0.6`)
console.log('PASS LAN host: the host\'s name stands where the chip would, the engine version from the pairing')

const app = await rows({ engine: async () => null, app: async () => ({ running: true, engine: { pid: 77, model: 'qwen3.8-27b', port: 53121 } }) })
assert.equal(app.tensorfold?.status, 'info')
assert.equal(app.tensorfold?.evidence, 'the app is serving qwen3.8-27b · paste from its API tab · s serve with Mercury instead (quit the app first — two copies won\'t fit)')
console.log('PASS the app\'s engine: the app-is-serving words, never a pairable row')

const absent = await rows({ engine: async () => null })
assert.deepEqual(absent, {})
const absentUndefined = await rows({ engine: async () => undefined })
assert.deepEqual(absentUndefined, {})
console.log('PASS absent: nothing installed, nothing answering — no row at all')

const focused = await support.readTensorFoldSupportLine({ repo: 'nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit', context: 262144 }, { ...base, snapshot: async () => server('http://127.0.0.1:8080', 'qwen3.5-2b', 32768) })
assert.equal(focused, `TensorFold 1.2.2 · Metal · Apple M5 Pro · ${osVersion} · nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit · --context 262144 · Mercury 1.0.6`)
const focusedHost = await support.readTensorFoldSupportLine({ host: 'studio' }, { ...base, engine: async () => null, snapshot: async () => server('http://studio.local:8080', 'qwen3.8-27b', 131072, { keyed: true }), hosts: () => [{ name: 'studio', baseUrl: 'http://studio.local:8080', origin: 'lan-paired', version: '1.2.2' }] })
assert.equal(focusedHost, `TensorFold 1.2.2 · studio · ${osVersion} · qwen3.8-27b · --context 131072 · Mercury 1.0.6`)
console.log('PASS the focus: the framed row\'s repo and window, or the host, stand in the one composed line')

const plain = renderPlainCertificate({ verdict: 'certified', durationMs: 0, sections: [{ id: 'auth', title: 'AUTH', checks: [{ id: 'tensorfold', label: 'TensorFold', status: 'ok', evidence: ok.tensorfold!.evidence, detail: ok.tensorfold!.detail }, { id: 'tensorfold-support', label: 'support', status: 'info', evidence: ok.support! }] }] } as never)
assert.ok(plain.includes('[OK] TensorFold — qwen3.5-2b on 127.0.0.1:8080'))
assert.ok(plain.includes('[INFO] support — TensorFold 1.2.2 · Metal'))
console.log('PASS the plain certificate carries the TensorFold row and the support row')
