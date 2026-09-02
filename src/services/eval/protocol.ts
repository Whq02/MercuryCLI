// ============================================================================
//  services/eval/protocol — the kernel wire (Mercury's own shape).
//
//  Runner→host: newline-delimited JSON on FD 3 (a dedicated pipe — user code
//  owns fd 1/2, so native prints can never split a protocol frame). Every
//  frame carries the kernel token handed over in the host's `hello`; a line
//  that fails to parse or carries the wrong token is dropped with a debug
//  note. The token is integrity hygiene, not the security boundary: a forged
//  bridge request still meets the SAME permission chain host-side as a
//  legitimate one.
//
//  Host→runner: newline-delimited JSON on stdin. User code never reads
//  stdin (interactive stdin is a typed refusal in the runner).
// ============================================================================

import { z } from 'zod/v4'
import { logForDebugging } from '../../utils/debug.js'

// ── Runner → host ──────────────────────────────────────────────────────────

const readyFrame = z.object({ t: z.literal('ready'), token: z.string() })
const startedFrame = z.object({ t: z.literal('started'), token: z.string(), id: z.string() })
const displayFrame = z.object({
  t: z.literal('display'),
  token: z.string(),
  id: z.string(),
  mime: z.string(),
  data: z.string(),
  b64: z.boolean().optional(),
})
const resultFrame = z.object({
  t: z.literal('result'),
  token: z.string(),
  id: z.string(),
  repr: z.string(),
})
const errorFrame = z.object({
  t: z.literal('error'),
  token: z.string(),
  id: z.string(),
  name: z.string(),
  value: z.string(),
  traceback: z.string(),
})
const doneFrame = z.object({
  t: z.literal('done'),
  token: z.string(),
  id: z.string(),
  status: z.enum(['ok', 'error', 'cancelled']),
  cancelled: z.boolean().optional(),
})
const bridgeFrame = z.object({
  t: z.literal('bridge'),
  token: z.string(),
  bridgeId: z.string(),
  id: z.string(),
  kind: z.enum(['tool', 'agent', 'completion', 'width']),
  payload: z.unknown(),
})

export const runnerFrameSchema = z.discriminatedUnion('t', [
  readyFrame,
  startedFrame,
  displayFrame,
  resultFrame,
  errorFrame,
  doneFrame,
  bridgeFrame,
])

export type RunnerFrame = z.infer<typeof runnerFrameSchema>
export type BridgeRequestFrame = z.infer<typeof bridgeFrame>
export type BridgeKind = BridgeRequestFrame['kind']

// ── Host → runner ──────────────────────────────────────────────────────────

export type HostFrame =
  | { t: 'hello'; token: string; cwd: string }
  | { t: 'exec'; id: string; code: string; seq: number }
  | { t: 'bridge_result'; bridgeId: string; ok: boolean; value?: unknown; error?: string }
  | { t: 'bye' }

export function encodeHostFrame(frame: HostFrame): string {
  return `${JSON.stringify(frame)}\n`
}

/**
 * Incremental NDJSON decoder for the runner channel. Feeds arbitrary chunk
 * boundaries; emits only frames that parse AND carry the expected token.
 */
export class RunnerFrameDecoder {
  private buffer = ''
  constructor(private readonly token: string) {}

  push(chunk: string): RunnerFrame[] {
    this.buffer += chunk
    const frames: RunnerFrame[] = []
    for (;;) {
      const nl = this.buffer.indexOf('\n')
      if (nl < 0) break
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (!line.trim()) continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        logForDebugging(`eval protocol: dropped non-JSON line (${line.length} chars)`)
        continue
      }
      const parsed = runnerFrameSchema.safeParse(raw)
      if (!parsed.success) {
        logForDebugging('eval protocol: dropped malformed frame')
        continue
      }
      if (parsed.data.token !== this.token) {
        logForDebugging('eval protocol: dropped frame with wrong token')
        continue
      }
      frames.push(parsed.data)
    }
    return frames
  }
}
