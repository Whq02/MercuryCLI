#!/usr/bin/env bun
// gate-watch: src/integrations/event-hooks/hookEvents.ts src/integrations/event-hooks/commandRunner.ts src/integrations/event-hooks/fire.ts src/platform/logs/debugLog.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'hook-debug-output-'))
const home = join(root, 'home')
const cwd = join(root, 'cwd')
const logPath = join(root, 'debug.log')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.NODE_ENV
delete process.env.MERCURY_HOME
process.argv.push(`--log-file=${logPath}`)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

try {
  const { setSessionTrustAccepted } = await import('../../src/boot/process-state/processState.ts')
  setSessionTrustAccepted(true)
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const { refreshHooksSnapshot } = await import('../../src/integrations/event-hooks/hooksConfigSnapshot.ts')
  const { fireHooks } = await import('../../src/integrations/event-hooks/fire.ts')
  const { subscribeHookExecutionEvents } = await import('../../src/integrations/event-hooks/hookEvents.ts')
  const { flushDebugLogs } = await import('../../src/platform/logs/debugLog.ts')
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks: { 'turn.start': [{ name: 'large', run: `node -e 'process.stdout.write("a".repeat(5000)+"MIDDLE-MARKER"+"a".repeat(12*1024*1024-5013))'` }] } } }))
  refreshHooksSnapshot()
  let delivered = ''
  const unsubscribe = subscribeHookExecutionEvents(event => {
    if (event.type === 'response' && event.hookName === 'large') delivered = event.stdout
  })
  const logStart = statSync(logPath, { throwIfNoEntry: false })?.size ?? 0
  const result = await fireHooks('turn.start', { turn_id: 'large-output', prompt: 'hello' }, { scope: { sessionId: 'large-output-session', cwd } })
  unsubscribe()
  await flushDebugLogs()
  const outcome = result.outcomes[0]
  const modelText = outcome?.state.kind === 'text' ? outcome.state.text : ''
  check('the 12 MB hook follows the existing 10 MB output road', modelText.length > 10 * 1024 * 1024 && modelText.endsWith('[hook output truncated at 10MB]'), String(modelText.length) + ' (the 10 MB cut and its note live in src/integrations/event-hooks/commandRunner.ts, TRUNCATION_NOTE)')
  check('the model result keeps that full existing view', result.answer.contexts[0] === modelText && delivered === modelText, JSON.stringify({ context: result.answer.contexts[0]?.length, delivered: delivered.length, model: modelText.length }) + ' (fireHooks in src/integrations/event-hooks/fire.ts and emitHookResponse in src/integrations/event-hooks/hookEvents.ts must hand the model and the event the same full text)')
  const log = readFileSync(logPath, 'utf8')
  const entryStart = log.indexOf('hook large (turn.start) success:', logStart)
  const entry = entryStart < 0 ? '' : log.slice(entryStart)
  const totalBytes = Buffer.byteLength(modelText, 'utf8')
  console.log(`hook debug entry: ${Buffer.byteLength(entry, 'utf8')} bytes; model view: ${totalBytes} bytes`)
  check('the debug entry exists', entryStart >= 0, 'no line starting with hook large (turn.start) success: reached the log file; look at emitHookResponse in src/integrations/event-hooks/hookEvents.ts and flushDebugLogs in src/platform/logs/debugLog.ts')
  check('the debug entry is under 8 KB', Buffer.byteLength(entry, 'utf8') < 8192, String(Buffer.byteLength(entry, 'utf8')) + ' (hookOutputForDebugLog in src/integrations/event-hooks/hookEvents.ts must bound the logged output)')
  check('the debug entry states the total byte count', entry.includes(`[${totalBytes} bytes total]`), 'hookOutputForDebugLog in src/integrations/event-hooks/hookEvents.ts must write the [N bytes total] line between the head and the tail')
  check('the debug entry keeps the first 4,000 and last 1,000 characters', entry.includes(modelText.slice(0, 4000)) && entry.includes(modelText.slice(-1000)), 'hookOutputForDebugLog in src/integrations/event-hooks/hookEvents.ts must keep output.slice(0, 4000) and output.slice(-1000)')
  check('the debug entry omits the middle', !entry.includes(modelText.slice(4500, 5500)), 'hookOutputForDebugLog in src/integrations/event-hooks/hookEvents.ts must drop the middle of long output')
  check('the model view carries no debug bound marker', !modelText.includes('bytes total]'), 'the bound marker leaked into the text the model sees; apply hookOutputForDebugLog (src/integrations/event-hooks/hookEvents.ts) to the debug log only')
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(failures === 0 ? 'HOOK DEBUG OUTPUT BOUND GREEN' : `${failures} HOOK DEBUG OUTPUT BOUND FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
