import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { engineDeathAfterReady, waitHostEngine, type HostRunner, type SshTarget } from '../../src/services/host/ssh.ts'
import { currentHostRecipes } from '../../src/services/host/recipesFile.ts'

let checks = 0
const check = (name: string, truth: unknown, detail = ''): void => { assert.ok(truth, name + (detail ? '\n' + detail : '')); checks++; console.log('PASS ' + name) }
const target: SshTarget = { host: '127.0.0.1', port: 22, user: 'root' }
const recipe = currentHostRecipes().find(row => row.engine === 'llamacpp') ?? currentHostRecipes()[0]!
const signal = new AbortController().signal
const fakeRunner = (answer: (remote: string, call: number) => string | Error): HostRunner & { calls: number } => {
  const runner = {
    calls: 0,
    async run(_command: string, args: string[]): Promise<string> {
      runner.calls++
      const reply = answer(args[args.length - 1] ?? '', runner.calls)
      if (reply instanceof Error) throw reply
      return reply
    },
    tunnel(): { stop(): void; failed(): string | undefined } { return { stop() {}, failed: () => undefined } },
  }
  return runner
}

const poll = (remote: string): boolean => remote.includes('MERCURY_ENGINE_EXITED')
const health = (remote: string): boolean => remote.includes('/health')

console.log('§1 an engine that died after READY is read as a death with its own reason, never as a dropped tunnel')
const oomRunner = fakeRunner(remote => poll(remote) ? 'launch.log:\n[TP2] Freezing GC in Scheduler process\nMERCURY_ENGINE_EXITED\nMERCURY_ENGINE_CAUSE torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 3.00 GiB. GPU 1 has a total capacity of 178.37 GiB of which 364.00 MiB is free\n' : '')
const death = await engineDeathAfterReady(target, recipe, oomRunner, signal)
check('a dead engine answers with its cause', death instanceof Error && death.message.startsWith('the engine died after setup: ') && /out of memory/i.test(death.message), death?.message)
check('the reason is the engine’s own line, not a frame', death instanceof Error && !/\+0x[0-9a-f]+\)\[0x/.test(death.message), death?.message)
const liveRunner = fakeRunner(remote => poll(remote) ? '[TP0] Decode batch. #running-req: 1\n' : '')
check('a live engine answers nothing, so the tunnel road goes on', await engineDeathAfterReady(target, recipe, liveRunner, signal) === undefined)
const exitedQuietly = fakeRunner(remote => poll(remote) ? 'MERCURY_ENGINE_EXITED\n' : '')
const quiet = await engineDeathAfterReady(target, recipe, exitedQuietly, signal)
check('an engine that exited without a captured line still reads as a death', quiet instanceof Error && quiet.message === 'the engine died after setup: the engine process exited', quiet?.message)

console.log('§2 the engine clock keeps running while the engine log keeps moving, and stops when it stops')
let line = 0
const progressing = fakeRunner(remote => {
  if (poll(remote)) { line++; return Array.from({ length: Math.min(8, line) }, (_, i) => 'prewarm bucket ' + (line - Math.min(8, line) + i + 1)).join('\n') + '\n' }
  if (health(remote)) return line >= 12 ? '{"status":"ok"}' : new Error('curl: (7) connection refused')
  return ''
})
const t0 = Date.now()
await waitHostEngine(target, recipe, progressing, signal, 20, 60, () => {}, 400)
check('an engine still printing progress is given time past the budget and reaches READY', line >= 12 && Date.now() - t0 >= 60, 'polls ' + line + ' · ' + (Date.now() - t0) + ' ms')
const silent = fakeRunner(remote => poll(remote) ? 'loading weights\n' : health(remote) ? new Error('curl: (7) connection refused') : '')
const t1 = Date.now()
const stalled = await waitHostEngine(target, recipe, silent, signal, 20, 60, () => {}, 150).then(() => undefined, (error: unknown) => error)
check('an engine that prints nothing new stops at the budget plus the grace', stalled instanceof Error && /Engine not ready/.test(stalled.message) && Date.now() - t1 < 2000, String(stalled))

console.log('§3 the keep-alive road asks the engine before it reconnects, and the notice names the choice')
const worker = readFileSync(new URL('../../src/services/host/worker.ts', import.meta.url), 'utf8')
const reconnectBody = worker.slice(worker.indexOf('const reconnect = async (why: string)'), worker.indexOf('for (let attempt = 1; ; attempt++)'))
check('the reconnect road reads the engine first', reconnectBody.includes('engineDeathAfterReady(target, recipe, runner, signal, text =>') && reconnectBody.includes('if (death) throw death'))
check('a death after setup pauses the record with the machine up and is told with the rate still billing and the two actions', worker.includes("if (error instanceof HostEngineDeath && failedSetup && failedSetup.generation === generation && failedSetup.jobState !== 'stopped') {") && worker.includes("machine + ' stays up and bills $' + initial.price.toFixed(2) + '/hr while paused · Resume restarts the engine from the weights already on the machine, Terminate stops the bill · /llmhost → Machines I’m paying for'") && worker.includes("patchHostRecord(id, { jobState: 'paused', step, error: words, engineDeath: error.facts, linkLost: undefined, advancedAt: at,") && worker.includes("hostNotice(paused, 'paused', initial.name + ' · ' + words)"))
check('an out-of-memory death after setup never carries the loading-time shape verdict', death instanceof Error && !death.message.includes('too small') && death.message.includes('the engine ran out of GPU memory after setup · Resume restarts it; a shorter conversation or the Tune screen’s smaller context fits'), death?.message)
const ssh = readFileSync(new URL('../../src/services/host/ssh.ts', import.meta.url), 'utf8')
check('the engine clock and the death reader live in ssh.ts', ssh.includes('export async function engineDeathAfterReady(') && ssh.includes('Date.now() - progressedAt < progressGraceMs'))
console.log('ENGINE AFTER READY GREEN — ' + checks + ' checks; fake runners, no machine, no network')
