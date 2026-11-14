import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { gitFixture } from './gitFixture.ts'

if (!process.argv.includes('--child')) {
  const wrapper = gitFixture('git-definition-home-')
  try {
    const child = spawnSync(process.execPath, [import.meta.filename, '--child'], { env: { ...wrapper.env, GIT_PROOF_HOME: wrapper.home }, stdio: 'inherit' })
    process.exitCode = child.status ?? 1
  } finally { wrapper.dispose() }
} else {
  if (homedir() !== process.env.GIT_PROOF_HOME) throw new Error('wrong proof home before product imports')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { GitTool } = await import('../../src/tools/GitTool/GitTool.ts')
  const { zodToJsonSchema } = await import('../../src/utils/zodToJsonSchema.ts')
  const prompt = await GitTool.prompt()
  const schema = zodToJsonSchema(GitTool.inputSchema) as { properties: { op: { enum: string[] } } }
  let checks = 0
  let failures = 0
  const check = (label: string, ok: boolean) => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`) }
  check(`all new typed capabilities fit the original definition budget: ${prompt.length} + ${JSON.stringify(schema).length} <= 237 + 4167`, prompt.length + JSON.stringify(schema).length <= 4404)
  const examples = [
    { op: 'status' },
    { op: 'diff', scope: 'worktree', paths: ['src/a.ts'] },
    { op: 'show', sha: 'HEAD' },
    { op: 'worktree' },
    { op: 'conflicts' },
    { op: 'mergebase', refA: 'main', refB: 'topic' },
    { op: 'plan', groups: [{ files: ['src/a.ts'], message: 'foundation' }, { files: ['src/b.ts'], message: 'consumer', dependsOn: [0], checks: ['recorded only'] }] },
    { op: 'apply', planId: 'gp-example' },
    { op: 'stage', files: ['src/a.ts'], hunks: { 'src/a.ts': ['gh-example'] } },
    { op: 'restore', files: ['src/a.ts'] },
    { op: 'resolve', resolutions: [{ region: 'gr-example', take: 'base' }, { region: 'gr-other', content: '' }] },
    { op: 'verify', planId: 'gp-example' },
    { op: 'reviewContext', pr: 1 },
    { op: 'reviewRecord', findings: [], inspected: ['src/a.ts'], reviewNote: 'read the diff' },
    { op: 'fileAtRef', ref: 'HEAD', path: 'src/a.ts' },
    { op: 'tree', ref: 'HEAD', path: 'src' },
    { op: 'compare', refA: 'main', refB: 'topic' },
    { op: 'hostSearch', searchKind: 'code', query: 'repo:example/project parser', limit: 10 },
    { op: 'prDiff', pr: 1, file: 'src/a.ts', page: 0 },
    { op: 'runs', limit: 10 },
    { op: 'runWatch', run: '123', cancel: true },
  ]
  check('examples cover exactly every offered operation', JSON.stringify(examples.map(e => e.op)) === JSON.stringify(schema.properties.op.enum))
  for (const example of examples) {
    const parsed = GitTool.inputSchema.safeParse(example)
    const valid = parsed.success ? await GitTool.validateInput(parsed.data) : { result: false }
    check(`model-facing ${example.op} example parses and validates`, valid.result)
  }
  check('whole-file resolution and explicit empty content still validate', GitTool.inputSchema.safeParse({ op: 'resolve', path: 'file', content: '' }).success)
  check('fractional dependencies are never rounded', !GitTool.inputSchema.safeParse({ op: 'plan', groups: [{ files: ['file'], message: 'message', dependsOn: [0.5] }] }).success)
  console.log(`Git definition budget: ${checks - failures}/${checks}`)
  process.exitCode = failures ? 1 : 0
}
