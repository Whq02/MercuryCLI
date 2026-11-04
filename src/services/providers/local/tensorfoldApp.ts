import { execFile } from 'node:child_process'

interface TensorFoldProcessRow {
  pid: number
  ppid: number
  command: string
  args: string
}

export interface TensorFoldAppState {
  running: boolean
  engine?: { pid: number; model?: string; port?: number }
}

const TENSORFOLD_APP_BUNDLE = 'TensorFold.app'
const ENGINE_BINARY = /(^|\/)tensorfold-native$/
const APP_PATTERN = /TensorFold\.app\/Contents\/MacOS\/TensorFold(\s|$)/

export function parseProcessRows(text: string): TensorFoldProcessRow[] {
  const rows: TensorFoldProcessRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!, args: match[4] ?? '' })
  }
  return rows
}

function argValue(args: string, flag: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${flag}(?:=|\\s+)("([^"]*)"|'([^']*)'|(\\S+))`).exec(args)
  return match ? (match[2] ?? match[3] ?? match[4]) : undefined
}

export function engineServedName(args: string): string | undefined {
  const named = argValue(args, '--name')
  if (named !== undefined) return named
  const served = /\bserve\s+("([^"]*)"|'([^']*)'|(\S+))/.exec(args)
  const repo = served ? (served[2] ?? served[3] ?? served[4]) : undefined
  return repo === undefined ? undefined : repo.split('/').pop()
}

export function tensorFoldAppStateOf(rows: readonly TensorFoldProcessRow[]): TensorFoldAppState {
  const app = rows.filter(row => APP_PATTERN.test(row.args) || APP_PATTERN.test(row.command))
  const appPids = new Set(app.map(row => row.pid))
  const byPid = new Map(rows.map(row => [row.pid, row] as const))
  const underApp = (row: TensorFoldProcessRow): boolean => {
    let parent = byPid.get(row.ppid)
    for (let depth = 0; parent !== undefined && depth < 6; depth++) {
      if (appPids.has(parent.pid) || parent.args.includes(`${TENSORFOLD_APP_BUNDLE}/`) || parent.command.includes(`${TENSORFOLD_APP_BUNDLE}/`)) return true
      parent = byPid.get(parent.ppid)
    }
    return false
  }
  const engine = rows.find(row => ENGINE_BINARY.test(row.command) && /\bserve\b/.test(row.args) && (row.args.includes(`${TENSORFOLD_APP_BUNDLE}/`) || row.command.includes(`${TENSORFOLD_APP_BUNDLE}/`) || underApp(row)))
  if (engine === undefined) return { running: app.length > 0 }
  const port = Number(argValue(engine.args, '--port'))
  const model = engineServedName(engine.args)
  return {
    running: true,
    engine: { pid: engine.pid, ...(model !== undefined ? { model } : {}), ...(Number.isInteger(port) && port > 0 ? { port } : {}) },
  }
}

export function listProcesses(): Promise<TensorFoldProcessRow[]> {
  if (process.platform === 'win32') return Promise.resolve([])
  return new Promise(resolve => {
    execFile('ps', ['-axo', 'pid=,ppid=,comm=,args='], { timeout: 4000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error ? [] : parseProcessRows(String(stdout)))
    })
  })
}

let cachedApp: { at: number; state: TensorFoldAppState } | undefined
const APP_TTL_MS = 5_000

export async function detectTensorFoldApp(reads?: { processes?: () => Promise<readonly TensorFoldProcessRow[]>; now?: () => number }): Promise<TensorFoldAppState> {
  const now = reads?.now?.() ?? Date.now()
  if (reads === undefined && cachedApp !== undefined && now - cachedApp.at < APP_TTL_MS) return cachedApp.state
  const state = tensorFoldAppStateOf(await (reads?.processes ?? listProcesses)())
  if (reads === undefined) cachedApp = { at: now, state }
  return state
}

export function appServingWords(state: TensorFoldAppState): string | undefined {
  if (state.engine === undefined) return undefined
  return `the app is serving ${state.engine.model ?? 'a model'} · paste from its API tab · s serve with Mercury instead (quit the app first — two copies won't fit)`
}

export const TENSORFOLD_SECOND_COPY_REFUSAL = 'the TensorFold app is already serving on this Mac · quit the app first — two copies won\'t fit'

export function refuseSecondCopy(state: TensorFoldAppState): string | undefined {
  return state.engine !== undefined ? TENSORFOLD_SECOND_COPY_REFUSAL : undefined
}
