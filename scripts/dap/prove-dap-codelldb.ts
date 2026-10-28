import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../src/Tool.js'
import type { CanUseToolFn } from '../../src/hooks/useCanUseTool.js'
import type { AssistantMessage } from '../../src/types/message.js'

const scratch = mkdtempSync(join(tmpdir(), 'dap-codelldb-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_DAP_ADAPTERS
process.env.MERCURY_DAP_ADAPTERS_FILE = join(scratch, 'absent.json')
process.env.MERCURY_JS_DEBUG_DAP = join(scratch, 'absent.js')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const savedPath = process.env.PATH
const savedFetch = globalThis.fetch
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
  const { optionalAdapterPlan, installOptionalAdapter, installedOptionalAdapter } = await import('../../src/services/dap/optionalAdapters.js')
  const { provisionDebugAdapter } = await import('../../src/services/dap/adapterInstallConsent.js')
  const { installPermission } = await import('../../src/extensions/installConsent.js')
  const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')
  const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
  const inferred = async (program: string) => {
    const result = await DebugTool.checkPermissions({ op: 'launch', program } as never, {} as never)
    return 'message' in result ? result.message : ''
  }
  const cargo = join(scratch, 'cargo')
  mkdirSync(join(cargo, 'target', 'debug'), { recursive: true })
  writeFileSync(join(cargo, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\n')
  const program = join(cargo, 'target', 'debug', 'fixture')
  check('absent CodeLLDB has its install hint', dormantBuiltinAdapterHints().some(row => row.key === 'codelldb' && row.hint.includes('CodeLLDB')))
  check('absent CodeLLDB does not displace native default', !((await inferred(program)) ?? '').includes('adapter codelldb'))
  const executable = join(bin, process.platform === 'win32' ? 'codelldb.exe' : 'codelldb')
  writeFileSync(executable, '#!/bin/sh\nexit 0\n')
  chmodSync(executable, 0o755)
  check('PATH CodeLLDB uses its stdio transport', resolveAdapter('codelldb')?.command === executable && resolveAdapter('codelldb')?.args.length === 0 && resolveAdapter('codelldb')?.connect !== 'tcp')
  check('Cargo binaries prefer available CodeLLDB', (await inferred(program))?.includes('adapter codelldb') === true)
  check('relative Cargo binaries use the logical working directory', (await runWithCwdOverride(cargo, () => inferred('target/debug/fixture')))?.includes('adapter codelldb') === true)
  check('non-Cargo native binaries retain native default', !((await inferred(join(scratch, 'native'))) ?? '').includes('adapter codelldb'))
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ codelldb: { command: 'operator-codelldb', args: [] } })
  check('operator row overrides CodeLLDB', resolveAdapter('codelldb')?.command === 'operator-codelldb')
  delete process.env.MERCURY_DAP_ADAPTERS
  rmSync(executable)
  for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm', 'linux-x64', 'win32-x64']) {
    const plan = optionalAdapterPlan('codelldb', join(scratch, 'home'), platform)
    check(`official pinned asset for ${platform}`, !!plan && /^[a-f0-9]{64}$/.test(plan.sha256) && plan.url.startsWith('https://github.com/vadimcn/codelldb/releases/download/v1.12.3/') && plan.bytes > 0)
  }
  check('unsupported platform does not invent an asset', optionalAdapterPlan('codelldb', scratch, 'win32-arm64') === null)
  const plan = optionalAdapterPlan('codelldb', join(scratch, 'home'), 'darwin-arm64')!
  const permission = installPermission(plan)
  check('download asks with the existing install card', permission.behavior === 'ask' && permission.message === `Install CodeLLDB 1.12.3 (45,390,048 bytes) to ${plan.destination}?` && permission.decisionReason?.type === 'safetyCheck' && permission.decisionReason.operatorOnly === true)
  let asks = 0
  let fetches = 0
  globalThis.fetch = (async () => { fetches++; return new Response('bad') }) as typeof fetch
  const context = { options: { isNonInteractiveSession: true }, abortController: new AbortController() } as ToolUseContext
  const deny: CanUseToolFn = async () => { asks++; return { behavior: 'deny', message: 'no', decisionReason: { type: 'other', reason: 'refused' } } }
  await provisionDebugAdapter('codelldb', DebugTool, { op: 'launch', adapter: 'codelldb', program }, context, deny, {} as AssistantMessage)
  check('headless cannot fetch or ask', asks === 0 && fetches === 0)
  context.options.isNonInteractiveSession = false
  await provisionDebugAdapter('codelldb', DebugTool, { op: 'launch', adapter: 'codelldb', program }, context, deny, {} as AssistantMessage)
  check('refused consent never fetches', asks === 1 && fetches === 0 && !existsSync(plan.destination))
  await assert.rejects(() => installOptionalAdapter(plan, { authorize: async () => true }), /Size or SHA-256 mismatch/)
  check('corrupt download never publishes a directory', !existsSync(plan.destination) && installedOptionalAdapter('codelldb') === null)
} finally {
  process.env.PATH = savedPath
  globalThis.fetch = savedFetch
  rmSync(scratch, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0
