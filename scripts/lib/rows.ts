import { spawn } from 'node:child_process'

export type Frame = Record<string, unknown>

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

export const isResult = (f: Frame | null | undefined): boolean => f?.type === 'result'
export const isInit = (f: Frame | null | undefined): boolean => f?.type === 'system' && f.subtype === 'init'
export const isSystem = (f: Frame | null | undefined, subtype?: string): boolean => f?.type === 'system' && (subtype === undefined || f.subtype === subtype)
export const isAssistant = (f: Frame | null | undefined): boolean => f?.type === 'assistant'
export const isControlRequest = (f: Frame | null | undefined): boolean => f?.type === 'control_request'
export const isControlResponse = (f: Frame | null | undefined, requestId?: string): boolean =>
  f?.type === 'control_response' && (requestId === undefined || (f.response as { request_id?: unknown } | undefined)?.request_id === requestId)
export const isControlCancel = (f: Frame | null | undefined): boolean => f?.type === 'control_cancel_request'

export const resultCount = (stdout: string): number => frameLines(stdout).filter(isResult).length
export const hasResult = (stdout: string): boolean => frameLines(stdout).some(isResult)
export const resultLines = (lines: readonly string[]): string[] => lines.filter(line => isResult(parseFrame(line)))

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
    const child = spawn(opts.node, [opts.dist, ...opts.args], { cwd: opts.cwd, env: opts.env })
    const reader = new LineReader()
    const frames: Frame[] = []
    let stdout = ''
    let stderr = ''
    let sent = 0
    let resultsSeen = 0
    const sendNext = (): void => {
      if (sent >= opts.turns.length) {
        child.stdin.end()
        return
      }
      const raw = opts.turns[sent]!
      const turn: Turn = typeof raw === 'string' ? { prompt: raw } : raw
      sent++
      turn.before?.()
      for (const [index, control] of (turn.controls ?? []).entries()) {
        child.stdin.write(JSON.stringify(controlRequestFrame(control.requestId ?? `ctl-${sent}-${index}`, control.request)) + '\n')
      }
      child.stdin.write(JSON.stringify(userRow(turn.prompt)) + '\n')
    }
    child.stdout.on('data', d => {
      stdout += String(d)
      frames.push(...reader.feed(String(d)))
      const results = frames.filter(isResult).length
      while (resultsSeen < results) {
        resultsSeen++
        if (opts.settleMs !== undefined) setTimeout(sendNext, opts.settleMs)
        else sendNext()
      }
    })
    child.stderr.on('data', d => (stderr += String(d)))
    const killer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 90_000)
    child.on('close', exit => {
      clearTimeout(killer)
      frames.push(...reader.flush())
      resolvePromise({ exit, stdout, stderr, frames })
    })
    child.on('spawn', () => sendNext())
  })
}
