#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'rule-anchors-home-'))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { processConditionedRules } = await import('../../src/services/instructions/discovery.ts')
const { mercuryNativeConvention } = await import('../../src/services/instructions/nativeSource.ts')
const { setOriginalCwd } = await import('../../src/bootstrap/state.ts')

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'rule-anchors-')))
const project = join(scratch, 'project')
const rulesDir = join(project, '.mercury', 'rules')
mkdirSync(rulesDir, { recursive: true })
const rule = (name: string, paths: string | undefined, body: string): void => {
  const head = paths === undefined ? '' : `---\npaths: ${paths}\n---\n`
  writeFileSync(join(rulesDir, `${name}.md`), `${head}${body}\n`)
}
rule('ts', '"src/**/*.ts"', 'TS-RULE')
rule('docs', '["docs/**", "notes/*.md"]', 'DOCS-RULE')
rule('plain', undefined, 'PLAIN-RULE')
rule('everywhere', '"**"', 'EVERYWHERE-RULE')

const names = (entries: Array<{ content: string }>): string[] => entries.map(e => e.content.trim())
const governing = (target: string, type: 'Project' | 'User' = 'Project', dir = rulesDir): Promise<string[]> =>
  processConditionedRules(mercuryNativeConvention, target, dir, type, new Set<string>(), false).then(names)

console.log('the project anchor: the folder above the config home')
check('a source file under src is governed by the src rule alone', JSON.stringify(await governing(join(project, 'src', 'app', 'main.ts'))) === JSON.stringify(['TS-RULE']), JSON.stringify(await governing(join(project, 'src', 'app', 'main.ts'))))
check('a docs file is governed by the docs rule alone', JSON.stringify(await governing(join(project, 'docs', 'guide.md'))) === JSON.stringify(['DOCS-RULE']))
check('a second glob in the same rule governs its own files and no deeper', JSON.stringify(await governing(join(project, 'notes', 'a.md'))) === JSON.stringify(['DOCS-RULE']) && (await governing(join(project, 'notes', 'sub', 'a.md'))).length === 0)
check('a file no glob names is governed by nothing', (await governing(join(project, 'README.md'))).length === 0)
check('a rule without paths and a rule whose paths are only ** are not conditional rules', !(await governing(join(project, 'src', 'a.ts'))).some(n => n === 'PLAIN-RULE' || n === 'EVERYWHERE-RULE'))
check('a relative target is judged as spelled', JSON.stringify(await governing(join('src', 'x.ts'))) === JSON.stringify(['TS-RULE']))

console.log('spellings the matcher never judges')
check('a target outside the anchor matches nothing and throws nothing', (await governing(join(scratch, 'elsewhere', 'main.ts'))).length === 0)
check('the anchor itself matches nothing and throws nothing', (await governing(project)).length === 0)
check('a target under a sibling whose name starts with the anchor matches nothing', (await governing(join(`${project}-two`, 'src', 'a.ts'))).length === 0)

console.log('the user anchor: the original cwd')
const userHome = join(scratch, 'user-home')
const userRules = join(userHome, 'rules')
mkdirSync(userRules, { recursive: true })
writeFileSync(join(userRules, 'py.md'), '---\npaths: "**/*.py"\n---\nPY-RULE\n')
const cwd = join(scratch, 'cwd')
mkdirSync(cwd, { recursive: true })
setOriginalCwd(cwd)
check('a user rule matches a target under the original cwd', JSON.stringify(await governing(join(cwd, 'tool', 'run.py'), 'User', userRules)) === JSON.stringify(['PY-RULE']))
check('a user rule does not match a target outside the original cwd', (await governing(join(project, 'run.py'), 'User', userRules)).length === 0)

console.log(failures ? `FAIL conditional rule anchors: ${failures} failures` : 'PASS conditional rule anchors')
process.exit(failures ? 1 : 0)
