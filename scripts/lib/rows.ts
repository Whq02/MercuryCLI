import type { InputRow, NoteRow, PromptRow, ShellRow } from '../../src/rows/vocabulary.ts'
import type { ParamsOf, ResultOf } from '../../src/runner/wire/methods.ts'
import { hostRunner, type HostedRunner } from './runnerHost.ts'

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

export const outcomeCount = (stdout: string): number => frameLines(stdout).filter(isOutcome).length
export const hasOutcome = (stdout: string): boolean => frameLines(stdout).some(isOutcome)
export const outcomeLines = (lines: readonly string[]): string[] => lines.filter(line => isOutcome(parseFrame(line)))
export const lastOutcome = (frames: readonly Frame[]): Frame | undefined => frames.filter(isOutcome).at(-1)
export const completedAnswer = (stdout: string): string | undefined => {
  const outcome = lastOutcome(frameLines(stdout))
  return isCompleted(outcome) ? answerOf(outcome) : undefined
}
export const answeredWith = (stdout: string, marker: string): boolean => (completedAnswer(stdout) ?? '').includes(marker)

type InputStamp = Pick<PromptRow, 'id' | 'priority' | 'sent_at' | 'origin'>
export const promptRow = (content: PromptRow['content'], stamp: InputStamp = {}): PromptRow => ({ type: 'prompt', content, ...stamp })
export const shellRow = (command: string, stamp: InputStamp = {}): ShellRow => ({ type: 'shell', command, ...stamp })
export const noteRow = (to: string, content: string, id?: string): NoteRow => ({ type: 'note', to, content, ...(id !== undefined ? { id } : {}) })
export const inputLine = (row: InputRow): string => `${JSON.stringify(row)}\n`

export type TurnRequest<M extends Parameters<HostedRunner['request']>[0] = Parameters<HostedRunner['request']>[0]> = { method: M; params: ParamsOf<M> }
export type Turn = { prompt: string; before?: () => void; requests?: TurnRequest[] }
export type TurnsRun = { exit: number | null; stdout: string; stderr: string; frames: Frame[]; answers: Array<{ method: string; result?: unknown; error?: string }> }

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
    const answers: TurnsRun['answers'] = []
    let stdout = ''
    let sent = 0
    let resultsSeen = 0
    const host = hostRunner({
      node: opts.node,
      dist: opts.dist,
      argv: opts.args,
      cwd: opts.cwd,
      env: opts.env as Record<string, string | undefined>,
      home: opts.env.MERCURY_CONFIG_DIR ?? opts.cwd,
      raw: text => {
        stdout += text
      },
      onRow: frame => {
        frames.push(frame)
        const results = frames.filter(isOutcome).length
        while (resultsSeen < results) {
          resultsSeen++
          if (opts.settleMs !== undefined) setTimeout(sendNext, opts.settleMs)
          else sendNext()
        }
      },
    })
    const sendNext = (): void => {
      if (sent >= opts.turns.length) {
        host.end()
        return
      }
      const raw = opts.turns[sent]!
      const turn: Turn = typeof raw === 'string' ? { prompt: raw } : raw
      sent++
      turn.before?.()
      for (const request of turn.requests ?? []) {
        void host.request(request.method, request.params as never).then(
          result => answers.push({ method: request.method, result }),
          (error: unknown) => answers.push({ method: request.method, error: error instanceof Error ? error.message : String(error) }),
        )
      }
      void host.prompt(turn.prompt).catch(() => undefined)
    }
    const killer = setTimeout(() => host.child.kill('SIGKILL'), opts.timeoutMs ?? 90_000)
    void host.exited.then(exit => {
      clearTimeout(killer)
      host.peer.close('the turns ended')
      resolvePromise({ exit, stdout, stderr: host.stderr(), frames, answers })
    })
    void host.initialize({ partial_rows: opts.args.includes('--partial') }).then(() => sendNext(), () => sendNext())
  })
}

export type { ResultOf }
