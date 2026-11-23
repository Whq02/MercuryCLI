import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { fakeCommand } from './fakeCommand.ts'

const scratch = mkdtempSync(join(tmpdir(), 'dap-bash-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_DAP_ADAPTERS
process.env.MERCURY_DAP_ADAPTERS_FILE = join(scratch, 'absent.json')
process.env.MERCURY_JS_DEBUG_DAP = join(scratch, 'absent.js')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const savedPath = process.env.PATH
let failures = 0
function check(label: string, passed: boolean, detail?: string): void {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}`)
  if (!passed) {
    failures++
    if (detail) console.log(`  ${detail}`)
  }
}
try {
  const bin = join(scratch, 'prefix', 'bin')
  mkdirSync(bin, { recursive: true })
  process.env.PATH = bin
  const { resolveAdapter, dormantBuiltinAdapterHints } = await import('../../src/integrations/debugger/dapClient.js')
  const { optionalAdapterPlan } = await import('../../src/integrations/debugger/optionalAdapters.js')
  const { DebugTool } = await import('../../src/tools/debug/DebugTool.js')
  const hint = dormantBuiltinAdapterHints().find(row => row.key === 'bash')?.hint ?? ''
  check('Bash hint distinguishes maintained bashdb from stale adapter', hint.includes('bashdb is maintained') && hint.includes('2021') && hint.includes('3.2') && hint.includes('no automatic download'), 'hint read: ' + hint + ' | change BASH_DEBUG_HINT in src/integrations/debugger/client/builtins.ts so it names maintained bashdb, 2021, Bash 3.2 and no automatic download')
  check('Bash has no fetch plan', optionalAdapterPlan('bash') === null, 'optionalAdapterPlan in src/integrations/debugger/optionalAdapters.ts must return null for bash (no fetch plan)')
  for (const ext of ['.sh', '.bash']) {
    const permission = await DebugTool.checkPermissions({ op: 'launch', program: join(scratch, `main${ext}`) } as never, {} as never)
    check(`${ext} infers Bash even when missing`, 'message' in permission && permission.message?.includes('adapter bash') === true, 'inferAdapter and checkPermissions in src/tools/debug/DebugTool.ts must map ' + ext + ' programs to the bash adapter')
  }
  check('no dependencies means no Bash row', resolveAdapter('bash') === null, 'with no bash, bashdb, cat, mkfifo or pkill on PATH, bashDebugSpec in src/integrations/debugger/client/builtins.ts must not arm a bash row')
  const entry = join(process.env.MERCURY_CONFIG_DIR, 'adapters', 'bash', 'extension', 'out', 'bashDebug.js')
  mkdirSync(join(process.env.MERCURY_CONFIG_DIR, 'adapters', 'bash', 'extension', 'out'), { recursive: true })
  writeFileSync(entry, '')
  check('adapter alone does not arm Bash', resolveAdapter('bash') === null, 'the bash row in src/integrations/debugger/client/builtins.ts must also require bash and bashdb on PATH, not only the adapter entry file')
  for (const name of ['bash', 'bashdb', 'cat', 'mkfifo', 'pkill']) fakeCommand(bin, name, 'GNU bash, version 3.2.57(1)-release\n', scratch)
  const library = join(scratch, 'prefix', 'share', 'bashdb')
  mkdirSync(library, { recursive: true })
  writeFileSync(join(library, 'dbg-main.sh'), '')
  check('macOS-era Bash 3.2 refuses before spawn', resolveAdapter('bash')?.preflightError?.includes('Bash 4') === true, 'bashDebugSpec in src/integrations/debugger/client/builtins.ts must set a preflightError naming Bash 4 when bash reports 3.2')
  const compatible = join(scratch, 'compatible')
  fakeCommand(compatible, 'bash', 'GNU bash, version 5.2.37(1)-release\n', scratch)
  process.env.PATH = [compatible, bin].join(delimiter)
  const row = resolveAdapter('bash')
  check('compatible Bash and bashdb arm installed adapter', row !== null && row.preflightError === undefined && row.command === process.execPath && row.args[0] === entry, 'row: ' + JSON.stringify(row) + ' | bashDebugSpec in src/integrations/debugger/client/builtins.ts must arm with command process.execPath and the adapter entry as first arg when Bash 5 and bashdb are on PATH')
  check('Bash defaults carry its library and non-terminal transport', row?.launchDefaults?.pathBashdbLib === library && row?.launchDefaults?.terminalKind === 'debugConsole', 'launchDefaults: ' + JSON.stringify(row?.launchDefaults) + ' | set pathBashdbLib and terminalKind debugConsole in bashDebugSpec, src/integrations/debugger/client/builtins.ts')
  check('Bash defaults carry required environment and argsString', row?.launchDefaults?.argsString === '' && JSON.stringify(row?.launchDefaults?.env) === '{}', 'launchDefaults: ' + JSON.stringify(row?.launchDefaults) + ' | set argsString to an empty string and env to {} in bashDebugSpec, src/integrations/debugger/client/builtins.ts')
  rmSync(join(library, 'dbg-main.sh'))
  check('missing bashdb library has a precise refusal', resolveAdapter('bash')?.preflightError?.includes('bashdb library') === true, 'bashDebugSpec in src/integrations/debugger/client/builtins.ts must set a preflightError naming the bashdb library when dbg-main.sh is missing')
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ bash: { command: 'operator-bash-debug', args: [] } })
  check('environment row overrides Bash preflight', resolveAdapter('bash')?.command === 'operator-bash-debug', 'resolveAdapter in src/integrations/debugger/client/adapters.ts must let a MERCURY_DAP_ADAPTERS row win over the builtin bash preflight')
} finally {
  process.env.PATH = savedPath
  removeScratch(scratch)
}
process.exitCode = failures ? 1 : 0
