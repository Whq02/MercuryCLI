import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const original = process.cwd()
const world = realpathSync(mkdtempSync(join(tmpdir(), 'own-tools-hostless-')))
const project = join(world, 'project')
mkdirSync(join(project, 'tests'), { recursive: true })
writeFileSync(join(project, 'package.json'), '{"name":"fixture","scripts":{"test":"node --test tests/*.test.mjs"}}\n')
writeFileSync(join(project, 'tests', 'limiter.test.mjs'), "import test from 'node:test'\ntest('x', () => {})\n")
process.env.MERCURY_CONFIG_DIR = join(world, 'home')
process.chdir(project)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { TestTool } = await import('../../src/tools/TestTool/TestTool.ts')
const { EvalTool } = await import('../../src/tools/EvalTool/EvalTool.ts')
const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.ts')
const { JourneyTool } = await import('../../src/tools/JourneyTool/JourneyTool.ts')
const { StructureTool } = await import('../../src/tools/StructureTool/StructureTool.ts')
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ' — ' + detail}`)
  if (!ok) failures++
}
const assistant = { message: { id: 'own-tools-hostless' } } as never
function context(mode: string, host: boolean, rules: { deny?: string[]; allow?: string[] } = {}) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, alwaysDenyRules: { localSettings: rules.deny ?? [] }, alwaysAllowRules: { localSettings: rules.allow ?? [] } } }
  return { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, options: { isNonInteractiveSession: true, hostHoldsAsks: host }, messages: [] } as never
}
type Call = { tool: unknown; name: string; input: Record<string, unknown>; words: string }
const calls: Call[] = [
  { tool: TestTool, name: 'Test', input: { op: 'run', framework: 'node-test', path: 'tests/limiter.test.mjs' }, words: 'Test run: tests/limiter.test.mjs' },
  { tool: TestTool, name: 'Test', input: { op: 'discover', path: project }, words: 'Test discover' },
  { tool: EvalTool, name: 'Eval', input: { language: 'js', title: 'Randomized limiter invariant stress test', code: "const { RateLimiter } = await import('./src/limiter.ts')\n1" }, words: 'Run a js cell — Randomized limiter invariant stress test' },
  { tool: EvalTool, name: 'Eval', input: { language: 'js', code: "const { buildNav } = await import('./core/nav.mjs')\nbuildNav([])" }, words: 'Run a js cell' },
  { tool: DebugTool, name: 'Debug', input: { op: 'launch', program: join(project, 'main.py') }, words: 'Debug launch:' },
  { tool: JourneyTool, name: 'Journey', input: { op: 'run', objective: 'boot and probe', steps: [{ kind: 'http.request', url: 'http://127.0.0.1:3000/' }] }, words: 'Journey run: boot and probe' },
  { tool: StructureTool, name: 'Structure', input: { op: 'apply', previewId: 'sp-1' }, words: 'Structure apply sp-1' },
]
async function decide(call: Call, mode: string, host: boolean, rules: { deny?: string[]; allow?: string[] } = {}) {
  const outcome = await decideToolPermissionWithModes(call.tool as never, call.input, context(mode, host, rules), assistant, `${call.name}-${mode}`)
  return outcome.decision as { behavior: string; message?: string }
}
try {
  for (const call of calls) {
    const hostless = await decide(call, 'flow', false)
    check(`hostless Flow runs ${call.name} ${JSON.stringify(call.input.op ?? call.input.language)} as it runs Bash's residual`, hostless.behavior === 'allow', JSON.stringify(hostless))
    const hosted = await decide(call, 'flow', true)
    check(`hosted Flow still puts ${call.name} to the host, in the tool's own words`, hosted.behavior === 'ask' && (hosted.message ?? '').includes(call.words), JSON.stringify(hosted))
    const plain = await decide(call, 'default', false)
    check(`default mode still asks for ${call.name}, in the tool's own words`, plain.behavior === 'ask' && (plain.message ?? '').includes(call.words), JSON.stringify(plain))
    const denied = await decide(call, 'flow', false, { deny: [call.name] })
    check(`a deny rule on ${call.name} still denies it hostless`, denied.behavior === 'deny', JSON.stringify(denied))
    const sovereign = await decide(call, 'sovereign', false)
    check(`sovereign allows ${call.name}`, sovereign.behavior === 'allow', JSON.stringify(sovereign))
  }
  const report = await decide({ tool: TestTool, name: 'Test', input: { op: 'report' }, words: '' }, 'default', false)
  check('Test report stays allowed everywhere', report.behavior === 'allow', JSON.stringify(report))
  const floor = await decide({ tool: EvalTool, name: 'Eval', input: { language: 'py', code: "open('/Users/someone/.mercury/.provider-secrets.json').read()" }, words: '' }, 'flow', false)
  check("Eval's own floor on Mercury's stored credentials still refuses hostless", floor.behavior === 'deny', JSON.stringify(floor))
} finally {
  process.chdir(original)
  rmSync(world, { recursive: true, force: true })
}
console.log(failures ? `own tools hostless: ${failures} FAILED` : 'own tools hostless: ALL PASS')
process.exit(failures ? 1 : 0)
