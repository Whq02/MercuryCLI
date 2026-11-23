import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { fakeCommand } from './fakeCommand.ts'

const scratch = mkdtempSync(join(tmpdir(), 'dap-php-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_DAP_ADAPTERS
process.env.MERCURY_DAP_ADAPTERS_FILE = join(scratch, 'absent.json')
process.env.MERCURY_JS_DEBUG_DAP = join(scratch, 'absent.js')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const savedPath = process.env.PATH
let failures = 0
function check(label: string, passed: boolean, detail = ''): void {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}${!passed && detail ? ' — ' + detail : ''}`)
  if (!passed) failures++
}
try {
  const bin = join(scratch, 'bin')
  mkdirSync(bin)
  process.env.PATH = bin
  const { resolveAdapter, dormantBuiltinAdapterHints } = await import('../../src/integrations/debugger/dapClient.js')
  const { optionalAdapterPlan } = await import('../../src/integrations/debugger/optionalAdapters.js')
  const { DebugTool } = await import('../../src/tools/debug/DebugTool.js')
  const hint = dormantBuiltinAdapterHints().find(row => row.key === 'php')?.hint ?? ''
  check('PHP hint names separate adapter and Xdebug prerequisites', hint.includes('check that php -m lists xdebug') && !hint.includes('grep') && hint.includes('pie install xdebug/xdebug') && hint.includes('PHP Debug'), `hint=${JSON.stringify(hint)}; edit PHP_DEBUG_HINT in src/integrations/debugger/client/builtins.ts (the php row of dormantBuiltinAdapterHints in client/adapters.ts)`)
  const permission = await DebugTool.checkPermissions({ op: 'launch', program: join(scratch, 'main.php') } as never, {} as never)
  check('missing PHP adapter still infers PHP', 'message' in permission && permission.message?.includes('adapter php') === true, `permission=${JSON.stringify(permission)}; DebugTool.checkPermissions in src/tools/debug/DebugTool.ts must infer adapter php from a .php program`)
  const plan = optionalAdapterPlan('php')!
  check('PHP pins the runnable upstream VSIX', plan.archive === 'php-debug-1.40.2.vsix' && plan.bytes === 1797181 && plan.sha256 === '17631993fe800083a2fc89a6782c8bf58a79603ad201ddff60d9b59ba2345d5f', `plan=${JSON.stringify({ archive: plan.archive, bytes: plan.bytes, sha256: plan.sha256 })}; the php entry read by optionalAdapterPlan in src/integrations/debugger/optionalAdapters.ts must pin this VSIX (or update this check with the new pin)`)
  for (const file of [plan.entry, ...plan.licenseFiles]) {
    mkdirSync(dirname(join(plan.destination, file)), { recursive: true })
    writeFileSync(join(plan.destination, file), '')
  }
  writeFileSync(join(plan.destination, '.vendor-manifest.json'), JSON.stringify({ sha256: plan.sha256, version: plan.version }))
  const absent = resolveAdapter('php')
  check('no PHP runtime refuses before adapter launch', absent?.preflightError?.includes('php') === true, `preflightError=${String(absent?.preflightError)}; phpDebugPreflight in src/integrations/debugger/client/builtins.ts must return an error naming php when none is on PATH`)
  fakeCommand(bin, 'php', '[PHP Modules]\nCore\n', scratch)
  check('PHP without Xdebug refuses with module check', resolveAdapter('php')?.preflightError?.includes('check that php -m lists xdebug') === true, `preflightError=${String(resolveAdapter('php')?.preflightError)}; phpDebugPreflight in src/integrations/debugger/client/builtins.ts must refuse when php -m lacks xdebug`)
  const other = join(scratch, 'with-xdebug')
  fakeCommand(other, 'php', '[PHP Modules]\nCore\nxdebug\n[Zend Modules]\nXdebug\n', scratch)
  process.env.PATH = other
  const ready = resolveAdapter('php')
  check('PHP adapter runs its script under the bundled runtime', ready?.command === process.execPath && ready?.args[0] === join(plan.destination, plan.entry), `command=${String(ready?.command)} args=${JSON.stringify(ready?.args)}; the php row in builtinAdapters (src/integrations/debugger/client/builtins.ts) must run process.execPath on the installed adapter entry`)
  check('Xdebug-enabled PHP passes preflight', ready !== null && ready.preflightError === undefined, `preflightError=${String(ready?.preflightError)}; phpDebugPreflight in src/integrations/debugger/client/builtins.ts must accept a php whose php -m lists xdebug`)
  check('PHP binds loopback on an allocated port', ready?.launchDefaults?.hostname === '127.0.0.1' && ready?.launchDefaults?.port === 0, `launchDefaults=${JSON.stringify(ready?.launchDefaults)}; fix the php row's launchDefaults in src/integrations/debugger/client/builtins.ts`)
  check('PHP CLI defaults enable and connect Xdebug', JSON.stringify(ready?.launchDefaults ?? {}).includes('xdebug.start_with_request=yes') && JSON.stringify(ready?.launchDefaults ?? {}).includes('client_port=${port}'), `launchDefaults=${JSON.stringify(ready?.launchDefaults)}; fix runtimeArgs and env in the php row's launchDefaults in src/integrations/debugger/client/builtins.ts`)
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ php: { command: 'operator-php-debug', args: [] } })
  check('PHP environment row overrides built-in preflight', resolveAdapter('php')?.command === 'operator-php-debug', `command=${String(resolveAdapter('php')?.command)}; resolveAdapter in src/integrations/debugger/client/adapters.ts must prefer a MERCURY_DAP_ADAPTERS row over the builtin php row`)
} finally {
  process.env.PATH = savedPath
  removeScratch(scratch)
}
process.exitCode = failures ? 1 : 0
