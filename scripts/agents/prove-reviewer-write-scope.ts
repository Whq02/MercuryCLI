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
const tools = restrictReviewerTools([FileEditTool, BashTool] as Tool[], canonical)
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
  assert.throws(() => canonicalReviewerReceipt(other, frozen), /outside/)
  assert.throws(() => canonicalReviewerReceipt('relative.md', frozen), /absolute/)
  const source = join(scratch, 'source.ts')
  writeFileSync(source, 'export const n = 1\n')
  assert.throws(() => canonicalReviewerReceipt(source, frozen), /Markdown/)
  await edit.call({ file_path: report, section: '## Review', new_string: '## Review\n\n- Checked.\n' }, context())
  check('the real Edit tool updates the Review section', readFileSync(report, 'utf8').includes('- Checked.'))
  check('the report sections outside Review stay unchanged', readFileSync(report, 'utf8').startsWith('# Report\n\n## Scope\nuntouched\n\n') && readFileSync(report, 'utf8').endsWith('## Checks\nkept\n'))
  const before = readFileSync(report, 'utf8')
  for (const input of [
    { file_path: other, append: 'changed' },
    { file_path: report, old_string: 'untouched', new_string: 'changed' },
    { file_path: report, section: '## Scope', new_string: '## Scope\nchanged\n' },
    { file_path: report, section: '## Review', new_string: '## Review\nchecked\n## Scope\nchanged\n' },
    { file_path: report, section: '## Review', append: '  ## Scope\nchanged\n' },
    { file_path: report, append: '## Review\nsecond copy\n' },
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
  check('read-only commands remain subject to their normal permission checks', reviewerRefusal(BashTool as Tool, { command: 'pwd' }, canonical) === null)
  writeFileSync(report, '# Report\n\n## Scope\nuntouched\n')
  await edit.call({ file_path: report, append: '## Review\n\n- Initial review.\n' }, context())
  check('a missing Review section can be created once', readFileSync(report, 'utf8').endsWith('## Review\n\n- Initial review.\n'))
  const execution = readFileSync(join(import.meta.dir, '../../src/tools/AgentTool/runAgent.ts'), 'utf8')
  check('the run loop applies the guard before permission and at tool execution', execution.includes('reviewerRefusal(args[0], args[1], reviewReceipt)') && execution.includes('tools = restrictReviewerTools(tools, reviewReceipt)'))
  const dispatch = readFileSync(join(import.meta.dir, '../../src/tools/AgentTool/AgentTool.tsx'), 'utf8')
  check('alternate teammate dispatch is refused for the restricted reviewer', dispatch.includes("requestedType === 'mercury-reviewer'") && dispatch.includes('not a teammate'))
  const entry = readFileSync(join(import.meta.dir, '../../src/main.tsx'), 'utf8')
  check('the top-level agent option cannot bypass frozen reviewer dispatch', entry.includes("mainThreadAgentDefinition.agentType === 'mercury-reviewer'") && entry.includes('requires an isolated Agent dispatch'))
  console.log(`Reviewer write scope: ${checks} checks passed`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
