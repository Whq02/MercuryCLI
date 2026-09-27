import { localProbeTargets, refreshLocalDiscovery, type LocalServerKind, type LocalServerRecord } from '../providers/local/localDiscovery.js'
import { LOCAL_SERVER_NAMES } from '../providers/local/localCatalogue.js'
import { resolveSetupIo } from './setupIo.js'
import type { DetectedServer, SetupIo } from './setupTypes.js'

export function ollamaRootOf(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const targets = localProbeTargets(env)
  return targets.find(t => t.kind === 'ollama')?.root ?? targets.find(t => t.kind === 'openai-compatible')?.root
}

function probeUrl(target: { kind: LocalServerKind; root: string }): string {
  switch (target.kind) {
    case 'ollama':
      return `GET ${target.root}/api/tags`
    case 'lmstudio':
      return `GET ${target.root}/api/v1/models`
    case 'vllm':
      return `GET ${target.root}/v1/models`
    case 'llamacpp':
      return `GET ${target.root}/props`
    case 'openai-compatible':
      return `GET ${target.root}/api/tags`
  }
}

export function probeWords(env: NodeJS.ProcessEnv = process.env): string {
  const targets = localProbeTargets(env)
  if (targets.length === 0) return 'nothing: probing is off (MERCURY_LOCAL_PROBE_TARGETS=none)'
  return targets.map(probeUrl).join(' · ')
}

function modelsOf(server: LocalServerRecord): string[] {
  const loaded = server.models.filter(m => m.loaded === true).map(m => m.id)
  const rest = server.models.filter(m => m.loaded !== true).map(m => m.id)
  return [...loaded, ...rest]
}

const LISTED_IN_WORDS = 4

export function listedWords(models: string[]): string {
  const count = `${models.length} model${models.length === 1 ? '' : 's'}`
  if (models.length === 0) return 'no model'
  const shown = models.slice(0, LISTED_IN_WORDS).join(', ')
  return models.length > LISTED_IN_WORDS ? `${count}: ${shown}, …` : `${count}: ${shown}`
}

export async function detectLocalServers(seam: SetupIo = {}): Promise<DetectedServer> {
  const io = resolveSetupIo(seam)
  const probed = localProbeTargets(io.env)
  if (probed.length === 0) {
    return { kind: 'none', models: [], root: '', label: 'none', probed, words: 'no server probed: MERCURY_LOCAL_PROBE_TARGETS=none turns probing off' }
  }
  const snapshot = await refreshLocalDiscovery({ force: true, env: io.env, fetchImpl: io.fetchImpl, timeoutMs: io.timeoutMs, now: io.now, ...(io.signal !== undefined ? { signal: io.signal } : {}) })
  const servers = snapshot.servers
  const ollama = servers.find(s => s.kind === 'ollama')
  const others = servers.filter(s => s.kind !== 'ollama' && s.models.length > 0)
  const pick = ollama && ollama.models.length > 0 ? ollama : (others[0] ?? ollama ?? servers[0])
  if (!pick) {
    const roots = probed.map(t => `${LOCAL_SERVER_NAMES[t.kind]} ${t.root}`).join(', ')
    return { kind: 'none', models: [], root: '', label: 'none', probed, words: `no local server answered (${roots})` }
  }
  const models = modelsOf(pick)
  const words =
    pick.kind === 'ollama'
      ? `${pick.label} at ${pick.root} answers with ${listedWords(models)}`
      : `${pick.label} at ${pick.root} answers with ${listedWords(models)} — it keeps working; nothing is installed or started`
  return { kind: pick.kind, models, root: pick.root, label: pick.label, probed, words }
}
