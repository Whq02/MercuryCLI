#!/usr/bin/env bun
import { spawn } from 'node:child_process'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { registerPendingAsyncHook, checkForAsyncHookResponses } = await import('../../src/utils/hooks/AsyncHookRegistry.ts')
const { registerHookEventHandler } = await import('../../src/utils/hooks/hookEvents.ts')
const events: Array<import('../../src/utils/hooks/hookEvents.ts').HookExecutionEvent> = []
registerHookEventHandler(event => events.push(event))
const child = spawn(process.execPath, ['-e', "let n=0;process.stdin.on('data',()=>{process.stdout.write(['chunk one\\n','chunk two\\n','{\\\"systemMessage\\\":\\\"async done\\\"}\\n'][n++]);if(n===3)process.stdin.end()})"], { stdio: ['pipe', 'pipe', 'pipe'] })
let stdout = ''
let status = 'running'
const chunks = new Set<(snapshot: { stdout: string; stderr: string; output: string }) => void>()
let resolveResult!: (value: { code: number; stdout: string; stderr: string }) => void
const result = new Promise<{ code: number; stdout: string; stderr: string }>(resolve => { resolveResult = resolve })
child.on('close', code => { status = 'completed'; resolveResult({ code: code ?? 1, stdout, stderr: '' }) })
const command = {
  get status() { return status },
  taskOutput: { getStdout: async () => stdout, getStderr: () => '', getStdoutForDecision: async () => stdout },
  result,
  cleanup: () => {},
  kill: () => child.kill('SIGTERM'),
}
let chunksSeen = 0
let synchronous = true
child.stdout.on('data', data => {
  stdout += String(data)
  const before = events.filter(event => event.type === 'progress').length
  for (const observer of chunks) observer({ stdout, stderr: '', output: stdout })
  synchronous &&= events.filter(event => event.type === 'progress').length === before + 1
  if (++chunksSeen < 3) child.stdin.write('next\n')
  else child.stdin.end()
})
let timers = 0
const priorInterval = globalThis.setInterval
const priorTimeout = globalThis.setTimeout
const replacements = {
  interval: ((...args: Parameters<typeof setInterval>) => { timers++; return priorInterval(...args) }) as typeof setInterval,
  timeout: ((...args: Parameters<typeof setTimeout>) => { timers++; return priorTimeout(...args) }) as typeof setTimeout,
}
globalThis.setInterval = replacements.interval
globalThis.setTimeout = replacements.timeout
registerPendingAsyncHook({ processId: 'fixture-async-progress', hookId: 'async-mark', asyncResponse: { async: true }, hookEvent: 'SessionStart', hookName: 'SessionStart', command: 'fixture', shellCommand: command as never, subscribeProgress: observer => { chunks.add(observer); return () => { chunks.delete(observer) } } })
child.stdin.write('next\n')
const guard = priorTimeout(() => { child.kill('SIGTERM'); console.error('FAIL async progress fixture exceeded its liveness deadline'); process.exit(1) }, 15_000)
await result
await new Promise<void>(resolve => setImmediate(resolve))
globalThis.setInterval = priorInterval
globalThis.setTimeout = priorTimeout
clearTimeout(guard)
let failures = 0
const check = (label: string, good: boolean): void => { if (!good) failures++; console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}`) }
check('the async registry arms zero timers while output chunks arrive', timers === 0)
check('all acknowledged async output chunks emit their mark synchronously', synchronous && chunksSeen === 3 && events.filter(event => event.type === 'progress').length === 3)
check('async completion emits one response without waiting for a polling read', events.filter(event => event.type === 'response').length === 1 && events.some(event => event.type === 'response' && event.output.includes('async done')))
const responses = await checkForAsyncHookResponses()
check('the later response reader delivers the verdict without emitting it twice', responses.length === 1 && responses[0]?.response.systemMessage === 'async done' && events.filter(event => event.type === 'response').length === 1)
registerHookEventHandler(null)
console.log(failures === 0 ? 'ASYNC HOOK PROGRESS MARKS GREEN' : `${failures} ASYNC HOOK PROGRESS MARK FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
