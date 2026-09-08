#!/usr/bin/env bun
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalReviewerReceipt, restrictReviewerTools, reviewerRefusal } from '../../src/tools/AgentTool/reviewerPolicy.ts'
import type { Tool, ToolUseContext } from '../../src/Tool.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'review-write-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const frozen = join(scratch, 'frozen')
mkdirSync(frozen)
const report = join(scratch, 'report.md')
const other = join(frozen, 'source.md')
const original = '# Report\n\n## Scope\nuntouched\n\n## Review\npending\n\n## Checks\nkept\n'
writeFileSync(report, original)
writeFileSync(other, 'protected\n')
const canonical = canonicalReviewerReceipt(report, frozen)
const tools = restrictReviewerTools([FileEditTool, BashTool] as Tool[], canonical, frozen)
const edit = tools.find(tool => tool.name === 'Edit')!
const shell = tools.find(tool => tool.name === 'Bash')!
let checks = 0
const check = (label: string, ok: unknown): void => { assert(ok, label); checks++; console.log(`PASS ${label}`) }
const context = (): ToolUseContext => ({
  readFileState: new Map([[report, { content: readFileSync(report, 'utf8'), timestamp: Date.now() + 60000 }]]),
  userModified: false,
  updateFileHistoryState: () => {},
  dynamicSkillDirTriggers: new Set(), nestedMemoryAttachmentTriggers: new Set(),
  abortController: new AbortController(),
  getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
} as unknown as ToolUseContext)
try {
  check('the declared report is canonical', canonical === report)
  mkdirSync(join(frozen, 'scripts', 'checks'), { recursive: true })
  writeFileSync(join(frozen, 'scripts', 'checks', 'prove-read.ts'), 'console.log("review proof ran")\n')
  for (const command of ['bun scripts/checks/prove-read.ts', 'bun run typecheck']) {
    check('reviewer verification commands are admitted without declaring them read-only', reviewerRefusal(BashTool as Tool, { command }, canonical, frozen) === null)
  }
  assert.throws(() => canonicalReviewerReceipt(other, frozen), /outside/)
  assert.throws(() => canonicalReviewerReceipt('relative.md', frozen), /absolute/)
  const source = join(scratch, 'source.ts')
  writeFileSync(source, 'export const n = 1\n')
  assert.throws(() => canonicalReviewerReceipt(source, frozen), /Markdown/)
  await edit.call({ file_path: report, section: '## Review', new_string: '## Review\n\n- Checked.\n' }, context())
  check('the real Edit tool updates the Review section', readFileSync(report, 'utf8').includes('- Checked.'))
  check('the report sections outside Review stay unchanged', readFileSync(report, 'utf8').startsWith('# Report\n\n## Scope\nuntouched\n\n') && readFileSync(report, 'utf8').endsWith('## Checks\nkept\n'))
  for (const ending of ['  ## Checks\nKEEP-ME\n', '   ## Checks\nKEEP-ME\n', 'Checks\n------\nKEEP-ME\n', 'Long section\nheading\n------\nKEEP-ME\n']) {
    writeFileSync(report, '# Report\n\n## Review\npending\n```md\n## Example\n```\n\n' + ending)
    await edit.call({ file_path: report, section: '## Review', new_string: '## Review\nchecked\n' }, context())
    check('section replacement preserves indented and setext neighboring sections', readFileSync(report, 'utf8') === '# Report\n\n## Review\nchecked\n' + ending)
  }
  writeFileSync(report, original)
  await edit.call({ file_path: report, section: '## Review', append: '```md\n## Example\n```\n' }, context())
  check('a fenced heading example stays inside Review', readFileSync(report, 'utf8').endsWith('## Checks\nkept\n'))
  const before = readFileSync(report, 'utf8')
  for (const input of [
    { file_path: other, append: 'changed' },
    { file_path: report, old_string: 'untouched', new_string: 'changed' },
    { file_path: report, section: '## Scope', new_string: '## Scope\nchanged\n' },
    { file_path: report, section: '## Review', new_string: '## Review\nchecked\n## Scope\nchanged\n' },
    { file_path: report, section: '## Review', append: '  ## Scope\nchanged\n' },
    { file_path: report, append: '## Review\nsecond copy\n' },
    { file_path: report, section: '## Review', append: 'Unowned section\n===\n' },
    { file_path: report, section: '## Review', append: '```md\nunterminated example' },
    { file_path: report, section: '## Review', new_string: '## Review\n## Section boundary\n```md\nunterminated' },
  ]) {
    await assert.rejects(() => edit.call(input, context()), /review|Review/)
    assert.equal(readFileSync(report, 'utf8'), before)
    assert.equal(readFileSync(other, 'utf8'), 'protected\n')
  }
  check('all alternate write targets and section escapes are refused before mutation', true)
  const alias = join(scratch, 'alias.md')
  symlinkSync(other, alias)
  await assert.rejects(() => edit.call({ file_path: alias, section: '## Review', new_string: '## Review\nchanged\n' }, context()), /declared receipt/)
  check('a symlink cannot redirect the allowed write', readFileSync(other, 'utf8') === 'protected\n')
  for (const command of [`printf changed > '${other}'`, `git -C '${frozen}' add .`, 'bun run arbitrary.ts']) {
    await assert.rejects(() => shell.call({ command }, context()), /read-only/)
  }
  check('shell writes, git mutations and arbitrary programs cannot bypass the report boundary', readFileSync(other, 'utf8') === 'protected\n')
  check('read-only commands remain subject to their normal permission checks', reviewerRefusal(BashTool as Tool, { command: 'pwd' }, canonical, frozen) === null)
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  let appState = getDefaultAppState()
  const shellContext = {
    ...context(),
    options: { mainLoopModel: 'claude-sonnet-5', tools: [], commands: [], mcpClients: [], mcpResources: {} },
    getAppState: () => appState,
    setAppState: (update: (state: typeof appState) => typeof appState) => { appState = update(appState) },
    toolUseId: 'review-check',
  } as unknown as ToolUseContext
  writeFileSync(join(frozen, 'scripts', 'checks', 'run-all.sh'), '#!/usr/bin/env bash\nprintf "review suite ran\\n"\n')
  writeFileSync(join(frozen, 'package.json'), JSON.stringify({ scripts: { typecheck: 'bash scripts/checks/run-all.sh' } }))
  const locks = join(scratch, 'locks')
  mkdirSync(locks)
  const lock = join(scratch, 'with-box-lock.sh')
  writeFileSync(lock, `#!/usr/bin/env bash\nBASE=${locks}\nprintf locked > "$BASE/observed"\nshift\nexec "$@"\n`)
  const commands = ['bun scripts/checks/prove-read.ts', 'bash scripts/checks/run-all.sh', 'bun run typecheck', `cd "${frozen}" && bash "${lock}" check bun scripts/checks/prove-read.ts`]
  for (const command of commands) check('verification and its lock wrapper retain normal permission admission', reviewerRefusal(BashTool as Tool, { command }, canonical, frozen) === null && !BashTool.isReadOnly({ command }))
  if (process.platform === 'darwin' || process.platform === 'linux') {
    let available = true
    if (process.platform === 'linux') {
      const { whichSync } = await import('../../src/utils/which.ts')
      available = whichSync('bwrap') !== null
    }
    if (available) {
      for (const command of commands) {
        const result = await shell.call({ command }, shellContext)
        check('a real restricted Bash tool executes the verification', /review (proof|suite) ran/.test((result.data as { stdout: string }).stdout))
      }
      check('the lock wrapper writes only its temporary coordination state', readFileSync(join(locks, 'observed'), 'utf8') === 'locked')
      const outside = join(scratch, 'outside.txt')
      writeFileSync(outside, 'outside protected\n')
      writeFileSync(join(frozen, 'scripts', 'checks', 'prove-write.ts'), `import { writeFileSync, mkdtempSync, symlinkSync, linkSync } from 'node:fs'; import { execFileSync } from 'node:child_process'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; let blocked=0; const dir=mkdtempSync(join(tmpdir(),'probe-')); writeFileSync(join(dir,'result'),'temporary'); for(const path of ${JSON.stringify([other, report, outside])}) { try {writeFileSync(path,'changed')} catch {blocked++} } symlinkSync(${JSON.stringify(outside)},join(dir,'alias')); try {writeFileSync(join(dir,'alias'),'changed')} catch {blocked++} try {linkSync(${JSON.stringify(outside)},join(dir,'hard')); writeFileSync(join(dir,'hard'),'changed')} catch {blocked++} if(blocked!==5) throw Error('write escaped'); execFileSync('git',['init','-q',join(dir,'repo')]); console.log('all writes refused; scratch works')\n`)
      const protectedRun = await shell.call({ command: 'bun scripts/checks/prove-write.ts' }, shellContext)
      check('verification cannot write source, report, outside files or symlink targets', (protectedRun.data as { stdout: string }).stdout.includes('all writes refused; scratch works') && readFileSync(other, 'utf8') === 'protected\n' && readFileSync(report, 'utf8') === before && readFileSync(outside, 'utf8') === 'outside protected\n')
    } else {
      await assert.rejects(() => shell.call({ command: commands[0] }, shellContext), /confinement/)
      console.log('NOT RUN: runtime confinement cases; missing platform dependencies are refused')
    }
  } else {
    await assert.rejects(() => shell.call({ command: commands[0] }, shellContext), /confinement/)
    console.log('NOT RUN: runtime confinement cases on this platform; refusal verified')
  }
  symlinkSync(source, join(frozen, 'scripts', 'checks', 'prove-link.ts'))
  for (const command of ['bun -e "1"', 'bun install', `bun "${source}"`, 'bun scripts/checks/prove-link.ts', 'bash -c "true"', `cd "${scratch}" && bun scripts/checks/prove-read.ts`, 'bun scripts/checks/prove-read.ts > output.txt', `bash "${lock}" check bash -c "true"`, `bun scripts/checks/prove-read.ts && printf changed > '${other}'`]) {
    check('inline programs, installs, outside scripts, redirects and wrapper escapes refuse', reviewerRefusal(BashTool as Tool, { command }, canonical, frozen) !== null)
  }
  for (const input of [{ command: commands[0], dangerouslyDisableSandbox: true }, { command: 'pwd', _simulatedSedEdit: { filePath: other, newContent: 'changed' } }]) await assert.rejects(() => shell.call(input, shellContext), /write protection/)
  writeFileSync(report, '# Report\n\n## Scope\nuntouched\n')
  await edit.call({ file_path: report, append: '## Review\n\n- Initial review.\n' }, context())
  check('a missing Review section can be created once', readFileSync(report, 'utf8').endsWith('## Review\n\n- Initial review.\n'))
  const execution = readFileSync(join(import.meta.dir, '../../src/tools/AgentTool/runAgent.ts'), 'utf8')
  check('the run loop applies the guard before permission and at tool execution', execution.includes('reviewerRefusal(args[0], args[1], reviewReceipt, worktreePath!)') && execution.includes('tools = restrictReviewerTools(tools, reviewReceipt, worktreePath!)'))
  const dispatch = readFileSync(join(import.meta.dir, '../../src/tools/AgentTool/AgentTool.tsx'), 'utf8')
  check('alternate teammate dispatch is refused for the restricted reviewer', dispatch.includes("requestedType === 'mercury-reviewer'") && dispatch.includes('not a teammate'))
  const entry = readFileSync(join(import.meta.dir, '../../src/main.tsx'), 'utf8')
  check('the top-level agent option cannot bypass frozen reviewer dispatch', entry.includes("mainThreadAgentDefinition.agentType === 'mercury-reviewer'") && entry.includes('requires an isolated Agent dispatch'))
  console.log(`Reviewer write scope: ${checks} checks passed`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
