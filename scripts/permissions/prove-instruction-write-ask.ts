import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(process.argv[2] ?? join(import.meta.dir, '../..'))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'instruction-ask-')))
const previous = process.cwd()
const project = join(scratch, 'project')
const outside = join(scratch, 'outside')
for (const path of [project, outside, join(project, '.mercury/agents'), join(project, '.mercury/skills'), join(project, '.mercury/apollo')]) mkdirSync(path, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
process.env.BROWSER = '/usr/bin/true'
process.chdir(project)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const load = (file: string) => import(pathToFileURL(join(root, file)).href)
const { getEmptyToolPermissionContext } = await load('src/Tool.ts')
const { decideToolPermission } = await load('src/utils/permissions/decision/engine.ts')
const { FileWriteTool } = await load('src/tools/FileWriteTool/FileWriteTool.ts')
const { FileEditTool } = await load('src/tools/FileEditTool/FileEditTool.ts')
const { NotebookEditTool } = await load('src/tools/NotebookEditTool/NotebookEditTool.ts')
const { ChangeSetTool } = await load('src/tools/ChangeSetTool/ChangeSetTool.ts')
const { AstEditTool } = await load('src/tools/AstEditTool/AstEditTool.ts')
const { AstSearchTool } = await load('src/tools/AstSearchTool/AstSearchTool.ts')
const { FileReadTool } = await load('src/tools/FileReadTool/FileReadTool.ts')
const { RecordConventionTool } = await load('src/tools/RecordConventionTool/RecordConventionTool.ts')
const { runWithCwdOverride } = await load('src/utils/cwd.ts')
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function context(mode: string, rules: { allow?: string[]; deny?: string[]; ask?: string[] } = {}) {
  const state = { toolPermissionContext: {
    ...getEmptyToolPermissionContext(), mode,
    alwaysAllowRules: { userSettings: rules.allow ?? [] },
    alwaysDenyRules: { userSettings: rules.deny ?? [] },
    alwaysAskRules: { userSettings: rules.ask ?? [] },
  }, tasks: {}, sessionHooks: new Map() }
  return { getAppState: () => state, setAppState: () => {}, abortController: new AbortController(), readFileState: new Map(), messages: [], options: { tools: [] } }
}
async function decide(tool: any, input: Record<string, unknown>, mode: string, rules = {}) {
  return (await decideToolPermission(tool, input, context(mode, rules))).decision
}
const modes = ['default', 'implement', 'sovereign']
const bodies = (path: string): Array<[any, Record<string, unknown>]> => [
  [FileWriteTool, { file_path: path, content: 'replacement' }],
  [FileEditTool, { file_path: path, append: 'replacement' }],
  [NotebookEditTool, { notebook_path: path, new_source: 'replacement' }],
  [ChangeSetTool, { op: 'apply', changes: [{ file_path: path, expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '1', replace: 'replacement' }] }] }],
]
writeFileSync(join(outside, 'AGENTS.md'), 'fixture-original\n')
symlinkSync(join(outside, 'AGENTS.md'), join(project, 'innocent.txt'))
symlinkSync(join(project, '.mercury'), join(project, 'linked-config'), process.platform === 'win32' ? 'junction' : 'dir')
symlinkSync(join(outside, 'MERCURY.local.md'), join(project, 'missing-link'))
symlinkSync(join(outside, 'AGENTS.md'), join(project, '.mercury/apollo/linked-instruction.md'))
symlinkSync(join(project, '.mercury/settings.json'), join(project, '.mercury/apollo/linked-settings.md'))
symlinkSync(join(outside, 'notes.md'), join(project, '.mercury/apollo/linked-outside.md'))
symlinkSync(join(project, '.mercury/apollo/spec.md'), join(project, '.mercury/apollo/linked-plan.md'))
try {
  console.log('refusals')
  const paths = [
    'MERCURY.md', 'MERCURY.local.md', 'AGENTS.md', 'agents.MD', 'nested/MeRcUrY.Md',
    '../outside/AGENTS.md', join(outside, 'MERCURY.md'), 'nested/../AGENTS.md',
    'semi;colon/AGENTS.md', 'quote"name/MERCURY.local.md',
    String.raw`C:\Users\Fixture\workspace\MERCURY.md`, '/mnt/c/Users/Fixture/workspace/AGENTS.md', '/c/Users/Fixture/workspace/MERCURY.local.md',
    join(project, 'innocent.txt'), join(project, 'missing-link'),
    '.mercury/settings.json', '.mercury/settings.local.json', '.mercury/agents/helper.md', '.mercury/skills/helper/SKILL.md',
    '.mercury/launch.json', '.mercury/wards.json', '.mercury/custom/file', 'linked-config/new-file',
    '.mercury/apollo/AGENTS.md', '.mercury/apollo/MeRcUrY.local.md', '.mercury/apollo/MERCURY.md', '.mercury/apollo/SKILL.md',
    '.mercury/apollo/settings.json', '.mercury/apollo/launch.json', '.mercury/apollo/agents/helper.md', '.mercury/apollo/skills/helper/SKILL.md',
    '.mercury/apollo/.mercury/settings.json', '.mercury/apollo/linked-instruction.md', '.mercury/apollo/linked-settings.md', '.mercury/apollo/linked-outside.md', '.mercury/apollo-notes/spec.md',
    'nested/.mercury/settings.json', 'nested/.mercury/agents/helper.md', join(process.env.MERCURY_CONFIG_DIR!, 'agents/helper.md'), join(process.env.MERCURY_CONFIG_DIR!, 'skills/helper/SKILL.md'),
  ]
  for (const mode of modes) for (const path of paths) for (const [tool, input] of bodies(path)) {
    const verdict = await decide(tool, input, mode, { allow: [tool.name] })
    check(`${mode} ${tool.name} instruction write`, verdict.behavior === (mode === 'sovereign' ? 'allow' : 'ask') && (mode === 'sovereign' || verdict.message?.includes('this file steers every later session')), `${path}: ${verdict.behavior}: ${verdict.message ?? ''}`)
  }
  for (const mode of modes) {
    const rule = 'Edit(/' + join(project, 'AGENTS.md') + ')'
    for (const [tool, input] of bodies(join(project, 'AGENTS.md'))) {
      const allowed = await decide(tool, input, mode, { allow: [rule] })
      check(`${mode} ${tool.name} named path grant honoured`, allowed.behavior === 'allow', allowed.message)
      const wildcard = await decide(tool, input, mode, { allow: ['Edit(//**)', 'Edit(**)'] })
      check(`${mode} ${tool.name} wildcard grant does not bypass instruction ask`, wildcard.behavior === (mode === 'sovereign' ? 'allow' : 'ask') && (mode === 'sovereign' || wildcard.message?.includes('steers every later session')), wildcard.message)
      const projCtx = { ...context(mode), getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, alwaysAllowRules: { projectSettings: [rule] } }, tasks: {}, sessionHooks: new Map() }) }
      const projGrant = (await decideToolPermission(tool, input, projCtx)).decision
      check(`${mode} ${tool.name} projectSettings grant does not bypass instruction ask`, projGrant.behavior === (mode === 'sovereign' ? 'allow' : 'ask') && (mode === 'sovereign' || projGrant.message?.includes('steers every later session')), projGrant.message)
      const denied = await decide(tool, input, mode, { allow: [rule], deny: [rule] })
      check(`${mode} ${tool.name} deny outranks grant`, denied.behavior === 'deny', denied.message)
      const asked = await decide(tool, input, mode, { allow: [rule], ask: [rule] })
      check(`${mode} ${tool.name} explicit ask still wins unless sovereign`, asked.behavior === (mode === 'sovereign' ? 'allow' : 'ask'), asked.message)
    }
    for (const file of ['settings.json', 'launch.json', 'agents/helper.md', 'custom/file', 'apollo/spec.md']) {
      const verdict = await decide(FileWriteTool, { file_path: '.mercury/' + file, content: 'x' }, mode, { allow: ['Edit(/' + join(project, '.mercury', file) + ')'] })
      check(mode + ' project config path grant honoured', verdict.behavior === 'allow', verdict.message)
    }
    const relative = await runWithCwdOverride(outside, () => decide(FileWriteTool, { file_path: 'MERCURY.md', content: 'x' }, mode))
    check(mode + ' cwd-relative instruction stays gated', relative.behavior === (mode === 'sovereign' ? 'allow' : 'ask') && (mode === 'sovereign' || relative.message?.includes('steers every later session')), relative.message)
    const hostRule = 'Edit(/' + join(outside, 'AGENTS.md') + ')'
    const denied = await decide(FileWriteTool, { file_path: 'innocent.txt', content: 'x' }, mode, { deny: [hostRule] })
    check(mode + ' real host deny survives linked filename', denied.behavior === 'deny', denied.message)
  }
  for (const mode of [...modes, 'apollo']) for (const path of ['.mercury/apollo/spec.md', '.mercury/apollo/design/architecture.md', '.mercury/apollo/linked-plan.md']) {
    const verdict = await decide(FileWriteTool, { file_path: path, content: 'x' }, mode)
    check(mode + ' designated planning document keeps prior consent', verdict.behavior === (mode === 'default' ? 'ask' : 'allow') && !verdict.message?.includes('steers every later session'), verdict.message)
    const denied = await decide(FileWriteTool, { file_path: path, content: 'x' }, mode, { deny: ['Edit(/' + join(project, path) + ')'] })
    check(mode + ' planning consent never beats an explicit deny', denied.behavior === 'deny', denied.message)
  }
  for (const path of ['.mercury/apollo/MERCURY.md', '.mercury/apollo/AGENTS.md', '.mercury/apollo/settings.json', '.mercury/apollo/SKILL.md', '.mercury/apollo/wards.json', '.mercury/apollo/.mercury/agents/x.md', '.mercury/apollo/linked-instruction.md']) {
    const verdict = await decide(FileWriteTool, { file_path: path, content: 'x' }, 'apollo')
    check('Apollo refuses instruction and control files inside planning tree: ' + path, verdict.behavior === 'deny', `${verdict.behavior}: ${verdict.message ?? ''}`)
  }
  writeFileSync(join(project, '.mercury/agents/helper.ts'), 'const x = 1\n')
  const dryEdit = await AstEditTool.call({ path: join(project, '.mercury/agents/helper.ts'), pattern: 'const $X = 1', rewrite: 'const $X = 2' }, context('default'))
  const planToken = /plan:\s*(ae-[a-z0-9]+)/i.exec(String(AstEditTool.mapToolResultToToolResultBlockParam(dryEdit.data, 't').content))?.[1] ?? ''
  for (const mode of modes) {
    const astVerdict = await decide(AstEditTool, { path: join(project, '.mercury/agents/helper.ts'), pattern: 'const $X = 1', rewrite: 'const $X = 2', apply: true, plan: planToken }, mode, { allow: ['AstEdit'] })
    check(mode + ' AstEdit preserves steering safety ask on .mercury/agents/helper.ts', astVerdict.behavior === (mode === 'sovereign' ? 'allow' : 'ask') && (mode === 'sovereign' || astVerdict.message?.includes('steers every later session')), `${astVerdict.behavior}: ${astVerdict.message ?? ''}`)
  }
  mkdirSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true })
  writeFileSync(join(process.env.MERCURY_CONFIG_DIR!, '.credentials.json'), 'const secret = "do-not-parse-secret-fixture"\n')
  symlinkSync(join(process.env.MERCURY_CONFIG_DIR!, '.credentials.json'), join(process.env.MERCURY_CONFIG_DIR!, 'secret-link.js'))
  writeFileSync(join(process.env.MERCURY_CONFIG_DIR!, 'public.js'), 'const pub = "visible-json"\n')
  const astSearch = await AstSearchTool.call({ path: process.env.MERCURY_CONFIG_DIR!, pattern: 'const $NAME = $VAL' }, context('sovereign', { allow: ['AstSearch'] }))
  const astOut = JSON.stringify(astSearch.data)
  check('AstSearch directory walk excludes Mercury secret files', !astOut.includes('do-not-parse-secret-fixture') && astOut.includes('visible-json'), astOut)
  const apolloOutside = await decide(FileWriteTool, { file_path: join(outside, 'spec.md'), content: 'x' }, 'apollo')
  check('Apollo keeps the spec-only boundary', apolloOutside.behavior === 'deny', apolloOutside.message)
  const changingLink = join(project, 'changed-link')
  symlinkSync(join(outside, 'note.txt'), changingLink)
  const beforeLink = await decide(FileWriteTool, { file_path: changingLink, content: 'x' }, 'implement', { allow: ['Write'] })
  check('ordinary alias starts outside instruction gate', beforeLink.behavior === 'allow', beforeLink.message)
  unlinkSync(changingLink)
  symlinkSync(join(outside, 'AGENTS.md'), changingLink)
  const afterLink = await decide(FileWriteTool, { file_path: changingLink, content: 'x' }, 'implement')
  check('retargeted link is resolved afresh', afterLink.behavior === 'ask' && afterLink.message?.includes('steers every later session'), afterLink.message)
  check('unapproved instruction bytes were never changed', readFileSync(join(outside, 'AGENTS.md'), 'utf8') === 'fixture-original\n')
  console.log('controls')
  for (const mode of modes) {
    for (const path of ['MERCURY.md.bak', 'AGENTS.markdown', 'notes.md', '.mercury-notes/config.json']) {
      const verdict = await decide(FileWriteTool, { file_path: path, content: 'x' }, mode, { allow: ['Write'] })
      check(mode + ' near-miss ordinary write unchanged', verdict.behavior === 'allow', verdict.message)
    }
    const read = await decide(FileReadTool, { file_path: join(outside, 'AGENTS.md') }, mode, { allow: ['Read'] })
    check(mode + ' instruction reading unchanged', read.behavior === 'allow', read.message)
    const capture = await decide(RecordConventionTool, { rule: 'Run the fixture checks before committing.' }, mode)
    check(mode + ' RecordConvention permission road unchanged', capture.behavior === (mode === 'default' ? 'ask' : 'allow') && !capture.message?.includes('steers every later session'), capture.message)
    const captureGrant = await decide(RecordConventionTool, { rule: 'Run the fixture checks before committing.' }, mode, { allow: ['RecordConvention'] })
    check(mode + ' RecordConvention explicit grant unchanged', captureGrant.behavior === 'allow', captureGrant.message)
  }
  const captured = await RecordConventionTool.call({ rule: 'Run the fixture checks before committing.' }, context('implement'))
  check('RecordConvention writes through the designed writer', captured.data.action === 'recorded' && readFileSync(join(project, 'MERCURY.md'), 'utf8').includes('Run the fixture checks before committing.'), captured.data.detail)
  for (const path of ['src/tools/RecordConventionTool/RecordConventionTool.ts', 'src/services/instructions/projectInstructionWriter.ts', 'src/cli/update.ts', 'src/tools/JourneyTool/JourneyTool.ts', 'src/tools/ServiceTool/ServiceTool.ts']) {
    const before = spawnSync('git', ['-C', root, 'show', '56946be6d5:' + path], { encoding: 'utf8' })
    check(path + ' byte-identical to base', before.status === 0 && before.stdout === readFileSync(join(root, path), 'utf8'), before.stderr)
  }
} finally {
  process.chdir(previous)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`instruction write ask: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
