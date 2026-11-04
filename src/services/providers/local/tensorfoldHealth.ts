import { gibWords } from '../../localServer/localServerMemory.js'
import { appServingWords } from './tensorfoldApp.js'
import { helperChoiceWords, helperFailureWords, helperJobsWords, helperModelChoices, readHelperModelSetting } from './tensorfoldHelper.js'
import { readTensorFoldState, tensorFoldPresent, TENSORFOLD_WINDOW_FLOOR, type TensorFoldServerState, type TensorFoldState, type TensorFoldStateReads } from './tensorfoldState.js'
import { readTensorFoldSupportLine, tensorFoldBackendWords } from './tensorfoldSupport.js'

export type TensorFoldHealthStatus = 'ok' | 'warn' | 'fail' | 'info'

export interface TensorFoldHealthRow {
  status: TensorFoldHealthStatus
  evidence: string
  detail?: string
  fix?: string
}

export const TENSORFOLD_HEALTH_LABEL = 'TensorFold'
export const TENSORFOLD_SUPPORT_LABEL = 'support'
export const HELPER_HEALTH_LABEL = 'Helper model'

export function windowWords(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : String(tokens)
}

function engineWords(server: TensorFoldServerState): string[] {
  const words: string[] = []
  if (server.version !== undefined) words.push(`TensorFold ${server.version}`)
  const backend = tensorFoldBackendWords(server.backend)
  if (backend !== undefined) words.push(backend)
  if (server.device !== undefined) words.push(server.device)
  return words
}

export function servedRow(server: TensorFoldServerState): TensorFoldHealthRow {
  const model = server.model ?? 'a model'
  if (server.keyed) {
    return {
      status: 'info',
      evidence: `${server.address} answers with a key · /health shows status only · model and window read from /v1/models: ${model}${server.window !== undefined ? ` · ${windowWords(server.window)}` : ''}${server.host !== undefined && server.host.origin !== 'app' ? ` · ${server.host.name}` : ''}`,
    }
  }
  if (server.window !== undefined && server.window < TENSORFOLD_WINDOW_FLOOR && server.started === undefined) {
    return {
      status: 'warn',
      evidence: `${model} on ${server.address} serves ${server.window >= 1024 && Math.round(server.window / 1024) === 8 ? 'an' : 'a'} ${windowWords(server.window)} window · under the ${windowWords(TENSORFOLD_WINDOW_FLOOR)} Mercury needs · started outside Mercury`,
      fix: `/tensorfold serves it again at ${windowWords(TENSORFOLD_WINDOW_FLOOR)} or more`,
    }
  }
  const parts = [`${model} on ${server.address}`]
  if (server.window !== undefined) parts.push(`${windowWords(server.window)} served`)
  if (server.inUseBytes !== undefined) parts.push(`${gibWords(server.inUseBytes)} in use`)
  if (server.streams !== undefined) parts.push(`${server.streams} stream${server.streams === 1 ? '' : 's'}`)
  parts.push(...engineWords(server))
  if (server.host !== undefined && server.host.origin !== 'app') parts.push(server.host.name)
  parts.push(server.started !== undefined ? 'started by Mercury (service tensorfold)' : 'started outside Mercury')
  return { status: 'ok', evidence: parts.join(' · ') }
}

export function optionalLibrariesWords(engine: TensorFoldState['engine']): string | undefined {
  const missing = (engine?.optionalLibraries ?? []).filter(library => !library.found)
  if (missing.length === 0) return undefined
  return `optional libraries: ${missing.map(library => `${library.name}${library.note !== undefined ? ` (${library.note})` : ''}`).join('; ')}`
}

export function tensorFoldHealthRow(state: TensorFoldState): TensorFoldHealthRow | undefined {
  if (state.exited !== undefined && state.servers.every(server => server.started === undefined)) {
    return { status: 'fail', evidence: `the ${state.exited.name} service exited${state.exited.lastLine !== undefined ? ` · ${state.exited.lastLine}` : ''}`, fix: '/tensorfold starts it again' }
  }
  const server = state.servers.find(row => row.started !== undefined) ?? state.servers.find(row => row.host === undefined) ?? state.servers[0]
  if (server !== undefined) {
    const row = servedRow(server)
    const detail = row.status === 'ok' ? optionalLibrariesWords(state.engine) : undefined
    return detail !== undefined ? { ...row, detail } : row
  }
  if (state.app.engine !== undefined) return { status: 'info', evidence: appServingWords(state.app)! }
  if (state.engine !== null && state.engine !== undefined) return { status: 'info', evidence: `TensorFold ${state.engine.version} installed · nothing served`, fix: '/tensorfold' }
  return undefined
}

export function helperHealthRow(state: TensorFoldState): TensorFoldHealthRow | undefined {
  const setting = readHelperModelSetting()
  if (setting.size === 'off') return undefined
  const choice = helperModelChoices().find(row => row.size === setting.size)
  if (choice === undefined) return undefined
  if (!choice.available) return { status: 'warn', evidence: `${helperChoiceWords(choice)} · not running`, fix: '/config → Helper model' }
  const failure = helperFailureWords()
  if (failure !== undefined) return { status: 'warn', evidence: `${choice.label} · ${failure}`, fix: '/config → Helper model' }
  const port = state.helper.port
  const serving = port !== undefined ? state.servers.find(server => server.address === `127.0.0.1:${port}`) : undefined
  return {
    status: state.helper.enabled && (port !== undefined || setting.size === 'session') ? 'ok' : 'info',
    evidence: `${choice.label}${serving?.model !== undefined ? ` · ${serving.model} on ${serving.address}` : port !== undefined ? ` · on 127.0.0.1:${port}` : ' · starting when first needed'} · ${helperJobsWords(setting.compaction)}`,
  }
}

export interface TensorFoldHealthChecks {
  tensorfold?: TensorFoldHealthRow
  support?: string
  helper?: TensorFoldHealthRow
}

export async function readTensorFoldHealth(reads?: TensorFoldStateReads): Promise<TensorFoldHealthChecks> {
  const state = await readTensorFoldState(reads)
  if (!tensorFoldPresent(state)) {
    const helper = helperHealthRow(state)
    return helper !== undefined ? { helper } : {}
  }
  const row = tensorFoldHealthRow(state)
  const support = await readTensorFoldSupportLine(undefined, reads, state)
  const helper = helperHealthRow(state)
  return { ...(row !== undefined ? { tensorfold: row } : {}), ...(support !== undefined ? { support } : {}), ...(helper !== undefined ? { helper } : {}) }
}
