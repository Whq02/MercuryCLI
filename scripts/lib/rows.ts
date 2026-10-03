import { spawn, type ChildProcess } from 'node:child_process'
import { RunnerConnection } from '../../src/daemon/runnerConnection.ts'
import { runnerDoorArgv, type RunnerDoorCapabilities } from '../../src/daemon/headlessRun.ts'

export type Frame = Record<string, unknown>

export type RunnerDoor = { send: (frame: Frame) => Promise<boolean>; connection: RunnerConnection; argv: string[] }

export function attachRunnerDoor(child: ChildProcess, onLine: (line: string) => void, capabilities: RunnerDoorCapabilities, argv: string[] = []): RunnerDoor {
  const connection = new RunnerConnection(child, capabilities, { onLine, onRow: () => {}, onAsk: () => {}, log: () => {} })
  return {
    connection,
    argv,
    send: frame => (frame.type === 'user' ? connection.deliver(frame) : Promise.resolve(connection.control(frame))),
  }
}

export function spawnRunnerDoor(opts: {
  node: string
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  onLine: (line: string) => void
  capabilities?: Partial<RunnerDoorCapabilities>
}): RunnerDoor & { child: ChildProcess } {
  const translated = runnerDoorArgv(opts.argv)
  const child = spawn(opts.node, translated.argv, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin!.on('error', () => {})
  const door = attachRunnerDoor(child, opts.onLine, { ...translated.capabilities, ...(opts.capabilities ?? {}) }, translated.argv)
  return { ...door, child }
}

export function parseFrame(line: string): Frame | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const frame = value as Frame
  if (frame.jsonrpc === '2.0' && frame.method === 'row') {
    const params = frame.params
    if (params !== null && typeof params === 'object' && !Array.isArray(params)) return params as Frame
    return null
  }
  return frame
}

export function frameLines(text: string): Frame[] {
  const frames: Frame[] = []
  for (const line of text.split('\n')) {
    const frame = parseFrame(line)
    if (frame !== null) frames.push(frame)
  }
  return frames
}

export class LineReader {
  private buffer = ''
  feed(chunk: string | Buffer): Frame[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const frames: Frame[] = []
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      const frame = parseFrame(line)
      if (frame !== null) frames.push(frame)
    }
    return frames
  }
  flush(): Frame[] {
    const frame = parseFrame(this.buffer)
    this.buffer = ''
    return frame === null ? [] : [frame]
  }
}

export const isOutcome = (f: Frame | null | undefined): boolean => f?.type === 'outcome'
export const isSession = (f: Frame | null | undefined): boolean => f?.type === 'session'
export const isTurnOpen = (f: Frame | null | undefined): boolean => f?.type === 'turn' && f.state === 'started'
export const isTurnWaiting = (f: Frame | null | undefined): boolean => f?.type === 'turn' && f.state === 'waiting'
export const isText = (f: Frame | null | undefined): boolean => f?.type === 'text'
export const isToolCall = (f: Frame | null | undefined): boolean => f?.type === 'tool_call'
export const isToolResult = (f: Frame | null | undefined): boolean => f?.type === 'tool_result'
export const isStep = (f: Frame | null | undefined): boolean => f?.type === 'step'
export const isMainThread = (f: Frame | null | undefined): boolean => f !== null && f !== undefined && f.parent_call_id === undefined
export const isCompleted = (f: Frame | null | undefined): boolean => isOutcome(f) && f?.status === 'completed'
export const outcomeError = (f: Frame | null | undefined): string | undefined => (isOutcome(f) ? ((f?.error as { message?: string } | undefined)?.message ?? undefined) : undefined)
export const answerOf = (f: Frame | null | undefined): string => (isOutcome(f) && typeof f?.answer === 'string' ? f.answer : '')
export const textOf = (frames: readonly Frame[]): string => frames.filter(f => isText(f) && isMainThread(f)).map(f => String(f.text ?? '')).join('')
export const isControlRequest = (f: Frame | null | undefined): boolean => f?.type === 'control_request'
export const isControlResponse = (f: Frame | null | undefined, requestId?: string): boolean =>
  f?.type === 'control_response' && (requestId === undefined || (f.response as { request_id?: unknown } | undefined)?.request_id === requestId)
export const isControlCancel = (f: Frame | null | undefined): boolean => f?.type === 'control_cancel_request'

export const outcomeCount = (stdout: string): number => frameLines(stdout).filter(isOutcome).length
export const hasOutcome = (stdout: string): boolean => frameLines(stdout).some(isOutcome)
export const outcomeLines = (lines: readonly string[]): string[] => lines.filter(line => isOutcome(parseFrame(line)))
export const lastOutcome = (frames: readonly Frame[]): Frame | undefined => frames.filter(isOutcome).at(-1)

export const userRow = (content: unknown, extra: Frame = {}): Frame => ({ type: 'user', message: { role: 'user', content }, ...extra })
export const controlRequestFrame = (requestId: string, request: Frame): Frame => ({ type: 'control_request', request_id: requestId, request })
export const controlResponseFrame = (requestId: string, response: Frame, subtype: 'success' | 'error' = 'success'): Frame =>
  subtype === 'success'
    ? { type: 'control_response', response: { subtype, request_id: requestId, response } }
    : { type: 'control_response', response: { subtype, request_id: requestId, error: String(response.error ?? '') } }

export interface RunnerPort {
  send: (frame: Frame) => void
  waitFor: (label: string, test: (f: Frame) => boolean, timeoutMs: number) => Promise<Frame | null>
}

let controlIds = 0
export async function controlRequest(runner: RunnerPort, request: Frame, timeoutMs: number, requestId = `ctl-${++controlIds}`): Promise<Frame | null> {
  runner.send(controlRequestFrame(requestId, request))
  return runner.waitFor(`control ${String(request.subtype ?? '?')} ${requestId}`, f => isControlResponse(f, requestId), timeoutMs)
}
export function answerControl(runner: RunnerPort, requestId: string, response: Frame): void {
  runner.send(controlResponseFrame(requestId, response))
}

export type Turn = { prompt: string; before?: () => void; controls?: Array<{ request: Frame; requestId?: string }> }
export type TurnsRun = { exit: number | null; stdout: string; stderr: string; frames: Frame[] }

export function runTurns(opts: {
  node: string
  dist: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  turns: Array<string | Turn>
  timeoutMs?: number
  settleMs?: number
}): Promise<TurnsRun> {
  return new Promise(resolvePromise => {
    const frames: Frame[] = []
    let stdout = ''
    let stderr = ''
    let sent = 0
    let resultsSeen = 0
    const door = spawnRunnerDoor({
      node: opts.node,
      argv: [opts.dist, ...opts.args],
      cwd: opts.cwd,
      env: opts.env,
      onLine: line => {
        stdout += `${line}\n`
        const frame = parseFrame(line)
        if (frame !== null) frames.push(frame)
        const results = frames.filter(isOutcome).length
        while (resultsSeen < results) {
          resultsSeen++
          if (opts.settleMs !== undefined) setTimeout(sendNext, opts.settleMs)
          else sendNext()
        }
      },
    })
    const child = door.child
    const sendNext = (): void => {
      if (sent >= opts.turns.length) {
        child.stdin!.end()
        return
      }
      const raw = opts.turns[sent]!
      const turn: Turn = typeof raw === 'string' ? { prompt: raw } : raw
      sent++
      turn.before?.()
      for (const [index, control] of (turn.controls ?? []).entries()) {
        void door.send(controlRequestFrame(control.requestId ?? `ctl-${sent}-${index}`, control.request))
      }
      void door.send(userRow(turn.prompt))
    }
    child.stderr!.on('data', d => (stderr += String(d)))
    const killer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 90_000)
    child.on('close', exit => {
      clearTimeout(killer)
      door.connection.close('the turns ended')
      resolvePromise({ exit, stdout, stderr, frames })
    })
    child.on('spawn', () => sendNext())
  })
}
