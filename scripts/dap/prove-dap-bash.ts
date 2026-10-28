import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'dap-bash-'))
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
  const bin = join(scratch, 'prefix', 'bin')
  mkdirSync(bin, { recursive: true })
  process.env.PATH = bin
  const { resolveAdapter, dormantBuiltinAdapterHints } = await import('../../src/services/dap/dapClient.js')
  const { optionalAdapterPlan } = await import('../../src/services/dap/optionalAdapters.js')
  const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')
  const hint = dormantBuiltinAdapterHints().find(row => row.key === 'bash')?.hint ?? ''
  check('Bash hint distinguishes maintained bashdb from stale adapter', hint.includes('bashdb is maintained') && hint.includes('2021') && hint.includes('3.2') && hint.includes('no automatic download'))
  check('Bash has no fetch plan', optionalAdapterPlan('bash') === null)
  for (const ext of ['.sh', '.bash']) {
    const permission = await DebugTool.checkPermissions({ op: 'launch', program: join(scratch, `main${ext}`) } as never, {} as never)
    check(`${ext} infers Bash even when missing`, 'message' in permission && permission.message?.includes('adapter bash') === true)
  }
  check('no dependencies means no Bash row', resolveAdapter('bash') === null)
  const entry = join(process.env.MERCURY_CONFIG_DIR, 'adapters', 'bash', 'extension', 'out', 'bashDebug.js')
  mkdirSync(join(process.env.MERCURY_CONFIG_DIR, 'adapters', 'bash', 'extension', 'out'), { recursive: true })
  writeFileSync(entry, '')
  check('adapter alone does not arm Bash', resolveAdapter('bash') === null)
  for (const name of ['bash', 'bashdb', 'cat', 'mkfifo', 'pkill']) {
    const file = join(bin, name)
    writeFileSync(file, '#!/bin/sh\nprintf "GNU bash, version 3.2.57(1)-release\\n"\n')
    chmodSync(file, 0o755)
  }
  const library = join(scratch, 'prefix', 'share', 'bashdb')
  mkdirSync(library, { recursive: true })
  writeFileSync(join(library, 'dbg-main.sh'), '')
  check('macOS-era Bash 3.2 refuses before spawn', resolveAdapter('bash')?.preflightError?.includes('Bash 4') === true)
  const compatible = join(scratch, 'compatible')
  mkdirSync(compatible)
  writeFileSync(join(compatible, 'bash'), '#!/bin/sh\nprintf "GNU bash, version 5.2.37(1)-release\\n"\n')
  chmodSync(join(compatible, 'bash'), 0o755)
  process.env.PATH = `${compatible}:${bin}`
  const row = resolveAdapter('bash')
  check('compatible Bash and bashdb arm installed adapter', row !== null && row.preflightError === undefined && row.command === process.execPath && row.args[0] === entry)
  check('Bash defaults carry its library and non-terminal transport', row?.launchDefaults?.pathBashdbLib === library && row?.launchDefaults?.terminalKind === 'debugConsole')
  check('Bash defaults carry required environment and argsString', row?.launchDefaults?.argsString === '' && JSON.stringify(row?.launchDefaults?.env) === '{}')
  rmSync(join(library, 'dbg-main.sh'))
  check('missing bashdb library has a precise refusal', resolveAdapter('bash')?.preflightError?.includes('bashdb library') === true)
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ bash: { command: 'operator-bash-debug', args: [] } })
  check('environment row overrides Bash preflight', resolveAdapter('bash')?.command === 'operator-bash-debug')
} finally {
  process.env.PATH = savedPath
  rmSync(scratch, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0
