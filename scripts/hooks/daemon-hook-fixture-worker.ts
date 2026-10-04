#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { runHookEvent } = await import('../../src/utils/hooks/engine.ts')
const { updateHooksConfigSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.ts')
updateHooksConfigSnapshot()
const { registerHookEventHandler } = await import('../../src/utils/hooks/hookEvents.ts')
registerHookEventHandler(() => {})
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
  try {
    for await (const result of runHookEvent({
      ...request,
      forceSyncExecution: true,
      marks: {
        started: mark => reply({ kind: 'started', sessionId: request.sessionId, ...mark }),
        progress: mark => reply({ kind: 'progress', sessionId: request.sessionId, ...mark }),
        response: mark => reply({ kind: 'response', sessionId: request.sessionId, ...mark }),
      },
    })) {
      if (result.blockingError) reply({ kind: 'blocked', error: result.blockingError })
    }
    reply({ kind: 'settled', sessionId: request.sessionId, event: request.event })
  } catch (error) {
    reply({ kind: 'failed', error: String(error) })
  }
}
writeFileSync(process.argv[2]!, 'ended')
