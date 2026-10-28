import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? join(import.meta.dir, '../..'))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-notes-write-')))
const previous = process.cwd()
const project = join(scratch, 'project')
for (const dir of ['.mercury', '.mercury/hooks', '.mercury/agents', '.mercury/skills/helper', '.mercury/extensions/pack', '.mercury/notes', '.mercury/apollo', '.mercury/worktrees/lane', 'nested/.mercury', '.git', '.vscode']) mkdirSync(join(project, dir), { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
process.chdir(project)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const load = (file: string) => import(pathToFileURL(join(root, file)).href)
const { getEmptyToolPermissionContext } = await load('src/Tool.ts')
const { decideToolPermission } = await load('src/utils/permissions/decision/engine.ts')
const { checkPathSafetyForAutoEdit, isMercuryConfigSegment } = await load('src/utils/permissions/filesystem.ts')
const { FileWriteTool } = await load('src/tools/FileWriteTool/FileWriteTool.ts')
const { FileEditTool } = await load('src/tools/FileEditTool/FileEditTool.ts')
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function context(mode: string) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, alwaysAllowRules: { userSettings: ['Write', 'Edit'] }, alwaysDenyRules: {}, alwaysAskRules: {} }, tasks: {}, sessionHooks: new Map() }
  return { getAppState: () => state, setAppState: () => {}, abortController: new AbortController(), readFileState: new Map(), messages: [], options: { tools: [] } }
}
async function decide(tool: any, input: Record<string, unknown>, mode: string) {
  return (await decideToolPermission(tool, input, context(mode))).decision
}
const SENSITIVE = 'which is a sensitive file.'
const safety = (path: string): { safe: boolean; message?: string } => checkPathSafetyForAutoEdit(join(project, path))

try {
  console.log('notes and plans under .mercury/ pass the path-safety check (red on the base: every one was "a sensitive file")')
  for (const path of ['.mercury/SESSION_STATE.md', '.mercury/ROADMAP_AND_LANES.md', '.mercury/HANDOFF.md', '.mercury/notes/checkpoint-3.md', '.mercury/apollo/spec.md', '.mercury/worktrees/lane/notes.md', 'nested/.mercury/plan.md']) {
    const verdict = safety(path)
    check(`safe: ${path}`, verdict.safe, verdict.message ?? '')
  }

  console.log('the product\'s own files under .mercury/ stay sensitive')
  for (const path of ['.mercury/settings.json', '.mercury/settings.local.json', '.mercury/settings.ci.json', 'nested/.mercury/settings.local.json', '.mercury/mcp.json', '.mercury/hooks/guard.mjs', '.mercury/hooks/pre-commit.sh', '.mercury/guard.mjs', '.mercury/guardrails.json', '.mercury/MERCURY.local.md', '.mercury/notes/plan.local.md', '.mercury/wards.json', '.mercury/gates.json', '.mercury/keybindings.json', '.mercury/engine-suites.json', '.mercury/worktree-setup.json', '.mercury/agent-overrides.json', '.mercury/agents/helper.md', '.mercury/skills/helper/SKILL.md', '.mercury/extensions/pack/index.js', 'nested/.mercury/hooks/x.sh']) {
    const verdict = safety(path)
    check(`sensitive: ${path}`, !verdict.safe, verdict.message ?? 'safe')
  }
  for (const path of ['.git/config', '.vscode/settings.json', '.mcp.json', 'nested/.mercury.json']) {
    const verdict = safety(path)
    check(`still sensitive outside .mercury/: ${path}`, !verdict.safe, verdict.message ?? 'safe')
  }
  for (const path of [join(homedir(), '.mercury', 'runtime-notes', 'file'), join(homedir(), '.mercury', 'projects', 'slug', 'notes.md'), join(homedir(), '.mercury', 'SESSION_STATE.md')]) {
    const verdict = checkPathSafetyForAutoEdit(path)
    check(`the config home stays whole: ${path.slice(homedir().length)}`, !verdict.safe, verdict.message ?? 'safe')
  }

  console.log('the segment rule, read directly')
  for (const segment of ['settings.json', 'settings.local.json', 'SETTINGS.CI.JSON', 'mcp.json', 'hooks', 'guard.mjs', 'guard', 'x.local.md', 'agents', 'skills', 'extensions', 'wards.json', 'launch.json']) check(`config segment: ${segment}`, isMercuryConfigSegment(segment))
  for (const segment of ['SESSION_STATE.md', 'notes', 'plan.md', 'apollo', 'worktrees', 'health', 'settings.md', 'guardian-notes.md'.replace('guardian', 'keeper'), 'local.md', 'mcp.md']) check(`plain segment: ${segment}`, !isMercuryConfigSegment(segment))

  console.log('the write ladder under the bypass posture: a note records no would-be ask, a config file still does')
  for (const [tool, input] of [[FileWriteTool, { file_path: '.mercury/SESSION_STATE.md', content: 'x' }], [FileEditTool, { file_path: '.mercury/SESSION_STATE.md', append: 'x' }]] as const) {
    const verdict = await decide(tool, input as never, 'sovereign')
    check(`sovereign ${tool.name} .mercury/SESSION_STATE.md: allowed with no bypassed ask`, verdict.behavior === 'allow' && verdict.decisionReason?.type !== 'bypassedAsk', JSON.stringify(verdict.decisionReason))
  }
  for (const path of ['.mercury/hooks/guard.mjs', '.mercury/mcp.json', '.mercury/MERCURY.local.md']) {
    const verdict = await decide(FileWriteTool, { file_path: path, content: 'x' }, 'sovereign')
    check(`sovereign Write ${path}: allowed, the would-be ask recorded as the path-safety road`, verdict.behavior === 'allow' && verdict.decisionReason?.type === 'bypassedAsk' && verdict.decisionReason.road === 'safetyCheckAsk' && String(verdict.decisionReason.reason?.reason ?? '').endsWith(SENSITIVE), JSON.stringify(verdict.decisionReason))
  }
  const settings = await decide(FileWriteTool, { file_path: '.mercury/settings.local.json', content: '{}' }, 'sovereign')
  check('sovereign Write .mercury/settings.local.json: allowed, the would-be ask recorded', settings.behavior === 'allow' && settings.decisionReason?.type === 'bypassedAsk', JSON.stringify(settings.decisionReason))

  console.log('the modes that ask still ask for the config files; a note still asks there through the instruction-estate rung')
  for (const mode of ['default', 'implement']) {
    for (const path of ['.mercury/hooks/guard.mjs', '.mercury/settings.local.json', '.mercury/mcp.json']) {
      const verdict = await decide(FileWriteTool, { file_path: path, content: 'x' }, mode)
      check(`${mode} Write ${path}: asks`, verdict.behavior === 'ask', `${verdict.behavior}: ${verdict.message ?? ''}`)
    }
    const note = await decide(FileWriteTool, { file_path: '.mercury/SESSION_STATE.md', content: 'x' }, mode)
    check(`${mode} Write .mercury/SESSION_STATE.md: asks as a file that steers later sessions, not as a sensitive file`, note.behavior === 'ask' && String(note.message ?? '').includes('steers every later session') && !String(note.message ?? '').includes(SENSITIVE), `${note.behavior}: ${note.message ?? ''}`)
  }
  writeFileSync(join(project, 'plain.md'), 'x\n')
  const plain = await decide(FileWriteTool, { file_path: 'plain.md', content: 'y' }, 'default')
  check('default Write plain.md: allowed by the Write rule (control)', plain.behavior === 'allow', `${plain.behavior}: ${plain.message ?? ''}`)
} finally {
  process.chdir(previous)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`mercury notes write: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
