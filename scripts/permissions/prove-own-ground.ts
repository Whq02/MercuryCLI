import { plugin } from 'bun'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slashed } from '../lib/platformPath.ts'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } }))
  },
})

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const original = process.cwd()
const world = realpathSync(mkdtempSync(join(tmpdir(), 'own-ground-')))
const project = join(world, 'project')
mkdirSync(join(project, 'generated'), { recursive: true })
mkdirSync(join(project, '.mercury', 'hooks'), { recursive: true })
mkdirSync(join(world, 'outside'), { recursive: true })
writeFileSync(join(project, 'package.json'), '{"name":"fixture"}\n')
writeFileSync(join(project, 'todo.json'), '[]\n')
writeFileSync(join(project, 'generated', 'keep.txt'), 'kept\n')
process.env.MERCURY_CONFIG_DIR = join(world, 'home')
process.env.MERCURY_TMPDIR = join(world, 'tmp')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
process.chdir(project)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { getScratchpadDir } = await import('../../src/utils/permissions/filesystem.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const ownGroundModule = await import('../../src/utils/permissions/ownGround.ts').catch(() => null)
const createdByThisRun = (path: string): boolean => ownGroundModule?.createdByThisRun(path) ?? false
const scratch = getScratchpadDir()
mkdirSync(scratch, { recursive: true })
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ' — ' + detail}`)
  if (!ok) failures++
}
const assistant = { message: { id: 'own-ground' } } as never
const MODES = ['flow', 'default', 'implement', 'dontAsk'] as const
function context(mode: string, host = false) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode } }
  return { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, options: { isNonInteractiveSession: true, hostHoldsAsks: host }, messages: [] } as never
}
async function decide(tool: unknown, input: Record<string, unknown>, mode: string, host = false) {
  const outcome = await decideToolPermissionWithModes(tool as never, input, context(mode, host), assistant, 'own-ground')
  return outcome.decision as { behavior: string; message?: string }
}
async function bash(command: string, mode = 'flow', host = false) {
  return decide(BashTool, { command }, mode, host)
}
let appState = getDefaultAppState()
const toolContext = {
  options: { engineModel: 'claude-sonnet-5', tools: [], commands: [], mcpClients: [], mcpResources: {} },
  readFileState: new Map(),
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => {
    appState = update(appState)
  },
  abortController: new AbortController(),
  toolUseId: 'own-ground',
} as never
type Caller = { call: (input: never, context: never, canUseTool?: never, parentMessage?: never) => Promise<{ data: unknown }> }
try {
  for (const mode of MODES) {
    const write = await decide(FileWriteTool, { file_path: join(scratch, 'run30.sh'), content: 'echo run\n' }, mode)
    check(`${mode}: a Write into the session's scratchpad never asks`, write.behavior === 'allow', JSON.stringify(write))
    const deep = await decide(FileWriteTool, { file_path: join(scratch, 'edge', 'site.json'), content: '{}\n' }, mode)
    check(`${mode}: a Write into a new folder of the scratchpad never asks`, deep.behavior === 'allow', JSON.stringify(deep))
    const mkdir = await bash(`mkdir -p ${slashed(join(scratch, 'demo'))}`, mode)
    check(`${mode}: mkdir in the scratchpad never asks`, mkdir.behavior === 'allow', JSON.stringify(mkdir))
    const removal = await bash(`rm -rf ${slashed(join(scratch, 'demo'))}`, mode)
    check(`${mode}: rm -rf of a scratchpad folder never asks`, removal.behavior === 'allow', JSON.stringify(removal))
    const working = await decide(FileWriteTool, { file_path: join(project, '.mercury', 'test-runs', 'r1.json'), content: '{}\n' }, mode)
    check(`${mode}: a Write into Mercury's own working files under .mercury never asks`, working.behavior === 'allow', JSON.stringify(working))
  }
  const hosted = await bash(`rm -rf ${slashed(join(scratch, 'demo'))}`, 'flow', true)
  check('hosted Flow: rm -rf of a scratchpad folder never asks either', hosted.behavior === 'allow', JSON.stringify(hosted))
  const chain = await bash(`mkdir -p ${slashed(join(scratch, 'demo'))}; rm -f ${slashed(join(scratch, 'demo', 'todo.json'))}`)
  check('a chain of own-ground mkdir and rm is allowed hostless', chain.behavior === 'allow', JSON.stringify(chain))
  const edit = await decide(FileEditTool, { file_path: join(scratch, 'run30.sh'), old_string: 'a', new_string: 'b' }, 'default')
  check('default: an Edit of a scratchpad file never asks', edit.behavior === 'allow', JSON.stringify(edit))

  for (const command of ['rm -rf /', 'rm -rf ~', 'rm -rf /Users', `rm -rf ${slashed(join(world, 'outside'))}`, 'rm -rf /tmp/handbook-out /tmp/blog-out', 'rm -rf generated', 'rm -r scratch-blog-check', 'rm -rf e2e']) {
    const result = await bash(command)
    check(`hostless Flow still refuses an rm of ground the run did not create: ${command}`, result.behavior !== 'allow', JSON.stringify(result))
  }
  for (const target of [join(project, '.mercury', 'settings.json'), join(project, '.mercury', 'hooks', 'x.sh'), join(project, '.mercury', 'skills', 's', 'SKILL.md'), join(project, '.mercury', 'wards.json')]) {
    const result = await decide(FileWriteTool, { file_path: target, content: '{}\n' }, 'default')
    check(`default: the config estate under .mercury still asks: ${target.slice(project.length)}`, result.behavior === 'ask', JSON.stringify(result))
  }

  const made = await (BashTool as unknown as Caller).call({ command: 'mkdir e2e && mkdir -p generated/sub' } as never, toolContext)
  check('the Bash tool ran the mkdir', existsSync(join(project, 'e2e')) && existsSync(join(project, 'generated', 'sub')), JSON.stringify(made.data).slice(0, 200))
  check('the folder the run created is in its ledger', createdByThisRun(join(project, 'e2e')), '')
  check('a pre-existing folder a mkdir -p passed through is not', !createdByThisRun(join(project, 'generated')), '')
  check('but the new folder under it is', createdByThisRun(join(project, 'generated', 'sub')), '')
  for (const mode of MODES) {
    const removal = await bash('rm -rf e2e', mode)
    check(`${mode}: rm -rf of the folder this run created never asks`, removal.behavior === 'allow', JSON.stringify(removal))
  }
  const inside = await bash(`rm ${slashed(join(project, 'e2e', 'todo.json'))} && rmdir generated/sub`)
  check('rm of a file inside the created folder and rmdir of the created sub-folder are allowed hostless', inside.behavior === 'allow', JSON.stringify(inside))
  const kept = await bash('rm -rf generated')
  check('rm -rf of the pre-existing folder still keeps its ask', kept.behavior !== 'allow', JSON.stringify(kept))
  const parent = { uuid: '00000000-0000-4000-8000-000000000001' }
  await (FileWriteTool as unknown as Caller).call({ file_path: join(project, 'scratch-blog-check', 'index.html'), content: '<p>x</p>\n' } as never, toolContext, undefined as never, parent as never)
  check('the Write tool created the folder', existsSync(join(project, 'scratch-blog-check', 'index.html')), '')
  check('the folder a Write created is in the ledger', createdByThisRun(join(project, 'scratch-blog-check')), '')
  const blog = await bash('rm -r scratch-blog-check && git status --short')
  check('rm -r of the folder a Write created never asks (the evidence command)', blog.behavior === 'allow', JSON.stringify(blog))
  check('a pre-existing file the run never created is not claimed', !createdByThisRun(join(project, 'todo.json')) && !createdByThisRun(project), '')
} finally {
  process.chdir(original)
  rmSync(world, { recursive: true, force: true })
}
console.log(failures ? `own ground: ${failures} FAILED` : 'own ground: ALL PASS')
process.exit(failures ? 1 : 0)
