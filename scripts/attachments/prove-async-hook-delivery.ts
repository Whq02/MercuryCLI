import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const sourceArg = process.argv.indexOf('--source-root')
const root = sourceArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[sourceArg + 1]!)
const scratch = mkdtempSync(join(tmpdir(), 'async-hook-delivery-'))
mkdirSync(join(scratch, 'home'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
try {
  const background = await import(`${root}/src/integrations/event-hooks/background.ts`)
  const { getBackgroundHookAttachments } = await import(`${root}/src/engine/attachment-shapes/taskStatus.ts`)
  const finished = (stdout: string, code: number, stderr = '') => ({
    pid: 1,
    result: Promise.resolve({ kind: 'exited' as const, code, stdout, stderr, durationMs: 5 }),
    kill: () => {},
  })
  const H = 'Check hookRowsOf in src/integrations/event-hooks/rows.ts and takeBackgroundHookOutcomes in src/integrations/event-hooks/background.ts, which getBackgroundHookAttachments in src/engine/attachment-shapes/taskStatus.ts calls.'
  background.resetBackgroundHooksForTesting()
  check('an empty background delivers nothing', (await getBackgroundHookAttachments()).length === 0, `after resetBackgroundHooksForTesting in src/integrations/event-hooks/background.ts, getBackgroundHookAttachments in src/engine/attachment-shapes/taskStatus.ts should return no rows; check takeBackgroundHookOutcomes`)
  const scope = { sessionId: 'delivery-session' }
  background.startBackgroundHook({ id: 'hook-one', name: 'after-edit', event: 'tool.after', process: finished('{"notice":"edit noted"}\n', 0), wake: false, scope })
  background.startBackgroundHook({ id: 'hook-two', name: 'warm-up', event: 'session.start', process: finished('ready\n', 0), wake: false, scope })
  background.startBackgroundHook({ id: 'hook-three', name: 'broken', event: 'tool.after', process: finished('', 1, 'it broke'), wake: false, scope })
  await new Promise(resolve => setTimeout(resolve, 50))
  const delivered = (await getBackgroundHookAttachments()) as Array<Record<string, unknown>>
  const byName = new Map(delivered.map(a => [a.name, a]))
  const one = byName.get('after-edit')
  const two = byName.get('warm-up')
  const three = byName.get('broken')
  check('every finished background hook with something to say becomes one hook row, marked background', delivered.length === 3 && delivered.every(a => a.type === 'hook' && a.background === true), `${JSON.stringify(delivered)}. ${H}`)
  check('a notice answer rides as a notice row naming the hook and the event', one?.outcome === 'notice' && one.event === 'tool.after' && one.words === 'edit noted', `${JSON.stringify(one)}. ${H}`)
  check('plain words on session.start ride as a context row', two?.outcome === 'context' && two.event === 'session.start' && two.words === 'ready', `${JSON.stringify(two)}. ${H}`)
  check('a failed background hook rides as a failed row with the one sentence', three?.outcome === 'failed' && String(three.words).includes('broken') && String(three.words).includes('it broke'), `${JSON.stringify(three)}. ${H}`)
  check('a delivered outcome is delivered once', (await getBackgroundHookAttachments()).length === 0, 'takeBackgroundHookOutcomes in src/integrations/event-hooks/background.ts should empty the banked outcomes when it returns them')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} background hook delivery: ${failures} failures`)
process.exit(failures ? 1 : 0)
