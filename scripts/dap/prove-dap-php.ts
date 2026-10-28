import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'dap-php-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_DAP_ADAPTERS
process.env.MERCURY_DAP_ADAPTERS_FILE = join(scratch, 'absent.json')
process.env.MERCURY_JS_DEBUG_DAP = join(scratch, 'absent.js')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const savedPath = process.env.PATH
let failures = 0
function check(label: string, passed: boolean): void {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}`)
  if (!passed) failures++
}
try {
  const bin = join(scratch, 'bin')
  mkdirSync(bin)
  process.env.PATH = bin
  const { resolveAdapter, dormantBuiltinAdapterHints } = await import('../../src/services/dap/dapClient.js')
  const { optionalAdapterPlan } = await import('../../src/services/dap/optionalAdapters.js')
  const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')
  const hint = dormantBuiltinAdapterHints().find(row => row.key === 'php')?.hint ?? ''
  check('PHP hint names separate adapter and Xdebug prerequisites', hint.includes('php -m | grep -i xdebug') && hint.includes('pie install xdebug/xdebug') && hint.includes('PHP Debug'))
  const permission = await DebugTool.checkPermissions({ op: 'launch', program: join(scratch, 'main.php') } as never, {} as never)
  check('missing PHP adapter still infers PHP', 'message' in permission && permission.message?.includes('adapter php') === true)
  const plan = optionalAdapterPlan('php')!
  check('PHP pins the runnable upstream VSIX', plan.archive === 'php-debug-1.40.2.vsix' && plan.bytes === 1797181 && plan.sha256 === '17631993fe800083a2fc89a6782c8bf58a79603ad201ddff60d9b59ba2345d5f')
  for (const file of [plan.entry, ...plan.licenseFiles]) {
    mkdirSync(dirname(join(plan.destination, file)), { recursive: true })
    writeFileSync(join(plan.destination, file), '')
  }
  writeFileSync(join(plan.destination, '.vendor-manifest.json'), JSON.stringify({ sha256: plan.sha256, version: plan.version }))
  const absent = resolveAdapter('php')
  check('no PHP runtime refuses before adapter launch', absent?.preflightError?.includes('php') === true)
  const php = join(bin, process.platform === 'win32' ? 'php.exe' : 'php')
  writeFileSync(php, '#!/bin/sh\nprintf "[PHP Modules]\\nCore\\n"\n')
  chmodSync(php, 0o755)
  check('PHP without Xdebug refuses with module check', resolveAdapter('php')?.preflightError?.includes('php -m | grep -i xdebug') === true)
  const other = join(scratch, 'with-xdebug')
  mkdirSync(other)
  const enabled = join(other, process.platform === 'win32' ? 'php.exe' : 'php')
  writeFileSync(enabled, '#!/bin/sh\nprintf "[PHP Modules]\\nCore\\nxdebug\\n[Zend Modules]\\nXdebug\\n"\n')
  chmodSync(enabled, 0o755)
  process.env.PATH = other
  const ready = resolveAdapter('php')
  check('PHP adapter runs its script under the bundled runtime', ready?.command === process.execPath && ready?.args[0] === join(plan.destination, plan.entry))
  check('Xdebug-enabled PHP passes preflight', ready !== null && ready.preflightError === undefined)
  check('PHP binds loopback on an allocated port', ready?.launchDefaults?.hostname === '127.0.0.1' && ready?.launchDefaults?.port === 0)
  check('PHP CLI defaults enable and connect Xdebug', JSON.stringify(ready?.launchDefaults ?? {}).includes('xdebug.start_with_request=yes') && JSON.stringify(ready?.launchDefaults ?? {}).includes('client_port=${port}'))
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ php: { command: 'operator-php-debug', args: [] } })
  check('PHP environment row overrides built-in preflight', resolveAdapter('php')?.command === 'operator-php-debug')
} finally {
  process.env.PATH = savedPath
  rmSync(scratch, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0
