#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const NAMES = ['jsx', 'jsxs', 'jsxDEV', 'Fragment'] as const
const NAME_RE = NAMES.join('|')

let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? `\n         ${detail}` : ''}`)
}

const files = execSync(`git -C '${REPO}' ls-files 'src/**/*.tsx'`, { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean)
  .filter(rel => existsSync(join(REPO, rel)))

const BINDING_PATTERNS: Array<{ why: string; re: RegExp }> = [
  { why: 'declaration', re: new RegExp(`\\b(?:let|const|var)\\s+(?:${NAME_RE})\\b`) },
  { why: 'arrow param', re: new RegExp(`(?<![\\w.])(?:${NAME_RE})(?:_\\d+)?\\s*=>`) },
  { why: 'function param', re: new RegExp(`\\bfunction\\s*\\w*\\s*\\(\\s*(?:${NAME_RE})\\b`) },
  { why: 'catch param', re: new RegExp(`\\bcatch\\s*\\(\\s*(?:${NAME_RE})\\b`) },
  { why: 'import alias', re: new RegExp(`\\bas\\s+(?:${NAME_RE})\\b`) },
]

const DESTRUCTURE_RE = new RegExp(
  `\\b(?:let|const|var)\\s*\\{[^}]*(?<![\\w.:])(?:${NAME_RE})\\s*[,}]`,
)

const offenders: string[] = []
for (const rel of files) {
  const text = readFileSync(join(REPO, rel), 'utf8')
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  for (const { why, re } of BINDING_PATTERNS) {
    const m = stripped.match(re)
    if (m) offenders.push(`${rel}: ${why} → ${JSON.stringify(m[0])}`)
  }
  const d = stripped.match(DESTRUCTURE_RE)
  if (d) offenders.push(`${rel}: destructure shorthand → ${JSON.stringify(d[0])}`)
}

console.log('============================================================')
console.log(' prove-jsx-shadow — no JSX-runtime identifier is ever shadowed')
console.log('============================================================')
console.log(`  scanned ${files.length} .tsx files for bindings of: ${NAMES.join(', ')}`)

check('no jsx/jsxs/jsxDEV/Fragment binding in any .tsx file', offenders.length === 0, offenders.join('\n         '))

const pbc = readFileSync(join(REPO, 'src/utils/processUserInput/processBashCommand.tsx'), 'utf8')
check('processBashCommand carries the renamed progressJsx slot', /progressJsx/.test(pbc) && !/let jsx\b/.test(pbc))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
