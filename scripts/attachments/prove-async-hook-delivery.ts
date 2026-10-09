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
  const registry = await import(`${root}/src/utils/hooks/AsyncHookRegistry.ts`)
  const { getAsyncHookResponseAttachments } = await import(`${root}/src/utils/attachments/taskStatus.ts`)
  const finished = (stdout: string, code: number) => ({
    status: 'completed',
    taskOutput: { getStdout: async () => stdout, getStderr: () => 'warned', getStdoutForDecision: async () => stdout },
    result: Promise.resolve({ code, stdout, stderr: 'warned' }),
    cleanup: () => {},
    kill: () => {},
  })
  check('an empty registry delivers nothing', (await getAsyncHookResponseAttachments()).length === 0)
  registry.registerPendingAsyncHook({ processId: 'proc-one', hookId: 'hook-one', asyncResponse: { async: true }, hookEvent: 'PostToolUse', hookName: 'after-edit', toolName: 'Edit', command: 'fixture', shellCommand: finished('{"systemMessage":"edit noted"}\n', 0), extensionId: 'ext-x' })
  registry.registerPendingAsyncHook({ processId: 'proc-two', hookId: 'hook-two', asyncResponse: { async: true }, hookEvent: 'SessionStart', hookName: 'warm-up', command: 'fixture', shellCommand: finished('{"additionalContext":"ready"}\n', 0) })
  const delivered = await getAsyncHookResponseAttachments()
  const byProcess = new Map(delivered.map((a: { processId: string }) => [a.processId, a]))
  const one = byProcess.get('proc-one') as Record<string, unknown> | undefined
  const two = byProcess.get('proc-two') as Record<string, unknown> | undefined
  check('every finished hook becomes one async_hook_response attachment', delivered.length === 2 && one?.type === 'async_hook_response' && two?.type === 'async_hook_response', JSON.stringify(delivered))
  check('the attachment carries the hook name, event, tool, response, output and exit code', one?.hookName === 'after-edit' && one?.hookEvent === 'PostToolUse' && one?.toolName === 'Edit' && JSON.stringify(one?.response) === '{"systemMessage":"edit noted"}' && one?.stderr === 'warned' && one?.exitCode === 0 && two?.toolName === undefined, JSON.stringify(one))
  check('the extension id does not ride the attachment', one !== undefined && !('extensionId' in one))
  check('a delivered response is delivered once', (await getAsyncHookResponseAttachments()).length === 0)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${failures ? 'FAIL' : 'PASS'} async hook delivery: ${failures} failures`)
process.exit(failures ? 1 : 0)
