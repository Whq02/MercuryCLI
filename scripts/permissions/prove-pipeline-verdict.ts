import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const original = process.cwd()
const world = realpathSync(mkdtempSync(join(tmpdir(), 'pipeline-verdict-')))
const project = join(world, 'project')
mkdirSync(join(project, 'tests'), { recursive: true })
mkdirSync(join(project, 'sub'), { recursive: true })
writeFileSync(join(project, 'package.json'), '{"name":"fixture","scripts":{"test":"node --test tests/*.test.mjs"}}\n')
writeFileSync(join(project, 'todo.json'), '[]\n')
process.env.MERCURY_CONFIG_DIR = join(world, 'home')
process.chdir(project)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ' — ' + detail}`)
  if (!ok) failures++
}
const tool = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: any, context: any) => bashToolHasPermission(input, context.getAppState().toolPermissionContext) } as never
const assistant = { message: { id: 'pipeline-verdict' } } as never
function context(mode = 'flow', rules: { deny?: string[]; allow?: string[] } = {}) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, alwaysDenyRules: { localSettings: rules.deny ?? [] }, alwaysAllowRules: { localSettings: rules.allow ?? [] } } }
  return { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, options: { isNonInteractiveSession: true, hostHoldsAsks: false }, messages: [] } as never
}
async function decide(command: string, mode = 'flow', rules: { deny?: string[]; allow?: string[] } = {}) {
  const outcome = await decideToolPermissionWithModes(tool, { command }, context(mode, rules), assistant, command)
  return outcome.decision as { behavior: string; message?: string }
}
try {
  const evidence = [
    'npm test 2>&1 | tail -60',
    'npm test 2>&1 | tail -80',
    'npm test 2>&1 | tail -20 && npm run typecheck 2>&1 | tail -5',
    "node --test 'tests/*.test.ts' 2>&1 | tail -15",
    'make test 2>&1 | tail -60',
    "python3 -m unittest discover -s checks -p 'check_*.py' -t . -v 2>&1 | tail -60",
    'curl -s https://registry.npmjs.org/ms | node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d).on(\'end\',()=>{console.log(s.length)})"',
    'npm view typescript version --json && npm view typescript dependencies --json | node -e "console.log(1)"',
    'pwd; ls -la sub | head -20; node -e "console.log(require(\'fs\').realpathSync(\'.\'))"',
  ]
  for (const command of evidence) {
    const bare = await decide(command.split(/\s*(?:\||&&|;)\s*/)[0] as string)
    const piped = await decide(command)
    check(`hostless Flow decides the pipeline as it decides its bare command (${bare.behavior}): ${command}`, piped.behavior === bare.behavior && piped.behavior === 'allow', JSON.stringify(piped))
  }
  const insideProject = ['npm test > out.log', 'npm test > sub/out.log 2>&1', 'npm test 2>&1 | tee out.log', 'npm test | tee sub/out.log']
  for (const command of insideProject) {
    const result = await decide(command)
    check(`a redirection or tee inside the project keeps the command's own verdict: ${command}`, result.behavior === 'allow', JSON.stringify(result))
  }
  for (const command of ['npm test > /tmp/out.log', 'npm test | tee /tmp/out.log', 'npm test 2>&1 | tee ../outside.log']) {
    const result = await decide(command)
    check(`a written path outside the project keeps its own ask: ${command}`, result.behavior === 'ask', JSON.stringify(result))
  }
  for (const command of ['rm -rf src | tail -1', 'git status && rm -rf generated | cat']) {
    const result = await decide(command)
    check(`a destructive segment keeps the floor through a pipe: ${command}`, result.behavior !== 'allow', JSON.stringify(result))
  }
  const denied = await decide('npm test 2>&1 | tail -60', 'flow', { deny: ['Bash(npm test *)'] })
  check('a deny rule on a segment denies the pipeline', denied.behavior === 'deny', JSON.stringify(denied))
  for (const mode of ['default', 'implement']) {
    const bare = await decide('npm test', mode)
    const piped = await decide('npm test 2>&1 | tail -60', mode)
    check(`${mode} mode asks for the pipeline exactly as for the bare command`, bare.behavior === 'ask' && piped.behavior === 'ask', JSON.stringify({ bare, piped }))
    check(`${mode} mode names the part that needs approval`, (piped.message ?? '').includes('npm test'), piped.message ?? '')
  }
  const readOnly = await decide('ls | head -3', 'default')
  check('a read-only pipeline is allowed in default mode', readOnly.behavior === 'allow', JSON.stringify(readOnly))
  mkdirSync(join(world, 'elsewhere'), { recursive: true })
  writeFileSync(join(world, 'elsewhere', 'notes.txt'), 'x\n')
  for (const command of [`pwd; ls -la ${join(world, 'elsewhere')} | head -20; node -e "console.log(1)"`, `cat ${join(world, 'elsewhere', 'notes.txt')} && npm test`, 'cat tests/*.mjs; npm test', 'ls /etc | head -3; npm test']) {
    const result = await decide(command)
    check(`a read Flow lets roam keeps roaming beside a command that requires approval: ${command.slice(0, 60)}`, result.behavior === 'allow', JSON.stringify(result))
  }
  for (const command of [`cp ${join(world, 'elsewhere', 'notes.txt')} here.txt; npm test`, `printf x > ${join(world, 'elsewhere', 'notes.txt')}; npm test`]) {
    const result = await decide(command)
    check(`a write outside the project still asks beside it: ${command.slice(0, 60)}`, result.behavior === 'ask', JSON.stringify(result))
  }
} finally {
  process.chdir(original)
  rmSync(world, { recursive: true, force: true })
}
console.log(failures ? `pipeline verdict: ${failures} FAILED` : 'pipeline verdict: ALL PASS')
process.exit(failures ? 1 : 0)
