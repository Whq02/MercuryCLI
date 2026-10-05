#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { runHookEvent } = await import('../../src/utils/hooks/engine.ts')
const { updateHooksConfigSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.ts')
updateHooksConfigSnapshot()
const { registerHookEventHandler } = await import('../../src/utils/hooks/hookEvents.ts')
registerHookEventHandler(() => {})
const assert = (claim: boolean, detail: () => string): void => {
  if (!claim) {
    process.stdout.write(`${JSON.stringify({ kind: 'assertion', error: detail() })}\n`)
    process.exit(3)
  }
}
const reply = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`) }
const requests = createInterface({ input: process.stdin })
for await (const line of requests) {
  const request = JSON.parse(line) as {
    event: Parameters<typeof runHookEvent>[0]['event']
    fields: Parameters<typeof runHookEvent>[0]['fields']
    sessionId: string
    cwd: string
    transcriptPath: string
    trustAccepted: boolean
  }
  const marks: Array<Record<string, unknown>> = []
  const forward = (kind: string) => (mark: Record<string, unknown>): void => {
    marks.push({ kind, sessionId: request.sessionId, ...mark })
    reply({ kind, sessionId: request.sessionId, ...mark })
  }
  try {
    for await (const result of runHookEvent({
      ...request,
      forceSyncExecution: true,
      marks: {
        started: forward('started'),
        progress: forward('progress'),
        response: forward('response'),
      },
    })) {
      if (result.blockingError) reply({ kind: 'blocked', error: result.blockingError })
    }
    const forRun = marks.filter(mark => mark.sessionId === request.sessionId)
    const response = forRun.filter(mark => mark.type === 'response')
    const trusted = request.trustAccepted !== false
    if (trusted) {
      assert(forRun.length > 0, () => `no lifecycle marks for ${request.sessionId} ${request.event}`)
      assert(response.length === 1, () => `${request.event} produced ${response.length} response marks for one matched hook, wanted exactly 1`)
      const started = forRun.filter(mark => mark.type === 'started')
      assert(started.length === 1, () => `${request.event} produced ${started.length} started marks, wanted exactly 1`)
      assert(response[0]!.hookId === started[0]!.hookId, () => `${request.event} response hookId ${String(response[0]!.hookId)} does not close the started hookId ${String(started[0]!.hookId)}`)
      const order = forRun.map(mark => String(mark.type)).join(',')
      assert(order === 'started,progress,response' || order === 'started,response', () => `${request.event} mark order was ${order}, wanted started,progress,response`)
    } else {
      assert(forRun.length === 0, () => `untrusted ${request.sessionId} ${request.event} emitted ${forRun.length} marks`)
    }
    reply({ kind: 'settled', sessionId: request.sessionId, event: request.event })
  } catch (error) {
    reply({ kind: 'failed', error: String(error) })
  }
}
writeFileSync(process.argv[2]!, 'ended')
