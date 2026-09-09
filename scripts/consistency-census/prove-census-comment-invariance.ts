#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { codeOnlyText, syntaxShape } from '../lib/codeText.ts'

const ROOT = join(import.meta.dir, '..', '..')
let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

type Row = { file: string; excerpt: string } & Record<string, unknown>
type Census = { sites: Row[] }
const CODE = 'PLANTED-CODE'
const COMMENT = 'PLANTED-COMMENT'

const PLANTED_LOCKUP = [
  `// ${COMMENT} <Crab /> leading`,
  `/* ${COMMENT} <Wordmark /> block */`,
  '/**',
  ` * ${COMMENT} <SessionMark /> docblock`,
  ` * ${COMMENT} <Text color={TERRA}>Mercury</Text>`,
  ' */',
  "import { Box, Text } from 'ink'",
  `export const planted1 = <Crab key="${CODE}" /> // ${COMMENT} <Crab /> trailing`,
  `export const planted2 = <Box>${CODE} // <Wordmark /> in jsx text</Box>`,
  `export const planted3 = '${CODE} // <SessionMark /> in a string'`,
  `export const planted4 = /${CODE} \\/\\/ <Crab\\b/`,
  `export const planted5 = \`${CODE} /* <Wordmark /> in a template */\``,
  'export const planted6 = 1',
  `  * '${CODE} <SessionMark />'.length`,
  `export const planted7 = <Box>{/* ${COMMENT} <Crab /> in a jsx container */}${CODE} <Crab /></Box>`,
  `export const planted8 = /* ${COMMENT}`,
  ` <Wordmark /> spanning lines`,
  ' */ 1',
  '',
]
const PLANTED_SHELL = [
  `// ${COMMENT} execSync(\`ls\`) leading`,
  `/* ${COMMENT} exec('ls') block */`,
  '/**',
  ` * ${COMMENT} spawnSync('bash', ['-c', 'ls']) docblock`,
  ' */',
  "import { exec, execSync, spawnSync } from 'node:child_process'",
  "import { mkdtempSync } from 'node:fs'",
  `export const planted1 = (): Buffer => execSync('${CODE}') // ${COMMENT} execSync(\`ls\`) trailing`,
  `export const planted2 = '${CODE} // execSync(ls) in a string'`,
  `export const planted3 = /${CODE} \\/\\/ execSync(ls)?/`,
  `export const planted4 = \`${CODE} /* exec('ls') in a template */\``,
  `export const planted5 = spawnSync('bash', ['-c', '${CODE}'])`,
  'export const planted6 = 1',
  `  * spawnSync('/usr/bin/python3', ['${CODE}']).status!`,
  `export const planted7 = mkdtempSync('/tmp/${CODE}')`,
  `export const planted8 = /* ${COMMENT}`,
  ` exec('ls') spanning lines`,
  ' */ 1',
  '',
]
const PLANTED_BASENAME = [
  `// ${COMMENT} '.claude' leading`,
  `/* ${COMMENT} ".mercury" block */`,
  '/**',
  ` * ${COMMENT} 'MERCURY.md' docblock`,
  ' */',
  "import { Box } from 'ink'",
  `export const planted1 = ['${CODE}', '.claude'] // ${COMMENT} '.claude' trailing`,
  `export const planted2 = "${CODE} // '.mercury' in a string"`,
  `export const planted3 = /${CODE} \\/\\/ 'MERCURY.md'/`,
  `export const planted4 = \`${CODE} /* ".claude" in a template */\``,
  'export const planted5 = 1',
  `  * '${CODE}'.length + ".mercury".length`,
  `export const planted6 = <Box>${CODE} // '.claude' in jsx text</Box>`,
  `export const planted7 = /* ${COMMENT}`,
  ` 'CLAUDE.md' spanning lines`,
  ' */ 1',
  '',
]

const CENSUSES = [
  {
    name: 'shellstring',
    generator: 'scripts/consistency-census/gen-shellstring-census.ts',
    asset: 'scripts/consistency-census/shellstring-census.json',
    planted: 'src/planted/plantedShell.ts',
    text: PLANTED_SHELL.join('\n'),
    codeRows: 7,
  },
  {
    name: 'lockup',
    generator: 'scripts/consistency-census/gen-lockup-census.ts',
    asset: 'scripts/consistency-census/lockup-census.json',
    planted: 'src/planted/PlantedLockup.tsx',
    text: PLANTED_LOCKUP.join('\n'),
    codeRows: 7,
  },
  {
    name: 'basename',
    generator: 'scripts/consistency-census/gen-basename-census.ts',
    asset: 'scripts/consistency-census/basename-census.json',
    planted: 'src/planted/PlantedBasename.tsx',
    text: PLANTED_BASENAME.join('\n'),
    codeRows: 6,
  },
]

function stripComments(path: string, text: string): string {
  const original = text.split('\n')
  const code = codeOnlyText(path, text).split('\n')
  const out: string[] = []
  for (let i = 0; i < original.length; i++) {
    const was = original[i]!
    const now = code[i]!
    if (was === now) out.push(was)
    else if (now.trim() !== '' || was.trim() === '') out.push(now.replace(/[ \t]+$/, ''))
  }
  return out.join('\n')
}

function generate(generator: string, root: string): string {
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  const out = join(root, 'census.json')
  const run = spawnSync(process.execPath, [join(ROOT, generator), '--root', root, '--out', out], { cwd: ROOT, encoding: 'utf8' })
  if (run.error || !existsSync(out)) throw new Error(`${generator} wrote nothing under ${root}: ${run.error?.message ?? run.stderr}`)
  return readFileSync(out, 'utf8')
}

function representativeFiles(census: Census): string[] {
  const counts = new Map<string, number>()
  for (const s of census.sites) counts.set(s.file, (counts.get(s.file) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([file]) => file)
}

function writeTree(to: string, files: Map<string, string>): void {
  for (const [rel, text] of files) {
    const target = join(to, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
}

{
  const separating: Array<[string, string]> = [
    ['a keyword and a name', 'const/*note*/x = 1\n'],
    ['two operators', 'const y = a +/*note*/+ b\n'],
    ['a name and a keyword operator', 'const w = x/*n*/instanceof/*n*/y\n'],
    ['a comment inside a string stays', "const s = 'a/*n*/b'\n"],
    ['a comment between a name and a bracket', 'call/*n*/(1)\n'],
    ['a multi-line comment keeps its line count', 'const z = 1 +/* one\n two */+ 2\n'],
    ['two consecutive comments between a keyword and a name', 'const/*a*//*b*/x = 1\n'],
    ['a numeric literal and a member access', 'const x = 1/*note*/.toString()\n'],
    ['three comments with spaces between them', 'x = a/*c*/ /*d*/ /*e*/b\n'],
  ]
  for (const [label, src] of separating) {
    const out = codeOnlyText('planted.ts', src)
    check(`token-separating comment, ${label}: the tokens keep their shape`, syntaxShape('planted.ts', src) === syntaxShape('planted.ts', out), JSON.stringify(out))
    check(`token-separating comment, ${label}: the line count is unchanged`, out.split('\n').length === src.split('\n').length)
  }
  check('a comment beside a bracket adds no separator', codeOnlyText('planted.ts', 'call/*n*/(1)\n') === 'call(1)\n')
  check('a comment at a line end adds no separator', codeOnlyText('planted.ts', 'const a = 1 // note\n') === 'const a = 1 \n')
}

const scratch = mkdtempSync(join(tmpdir(), 'census-comment-invariance-'))
try {
  for (const c of CENSUSES) {
    const committed = JSON.parse(readFileSync(join(ROOT, c.asset), 'utf8')) as Census
    const files = representativeFiles(committed)
    check(`${c.name}: three representative sources carry committed rows`, files.length === 3, files.join(', '))

    const original = new Map<string, string>()
    for (const rel of files) original.set(rel, readFileSync(join(ROOT, rel), 'utf8'))
    original.set(c.planted, c.text)
    const stripped = new Map<string, string>()
    for (const [rel, text] of original) stripped.set(rel, stripComments(rel, text))

    let commentBytes = 0
    let sameShape = true
    let anyDiagnostics = false
    for (const [rel, text] of original) {
      const after = stripped.get(rel)!
      commentBytes += text.length - after.length
      const shapeBefore = syntaxShape(rel, text)
      const shapeAfter = syntaxShape(rel, after)
      if (shapeBefore !== shapeAfter) sameShape = false
      if (!shapeBefore.startsWith('0\n')) anyDiagnostics = true
    }
    check(`${c.name}: the stripped copies lost comment bytes (the perturbation is real)`, commentBytes > 0, String(commentBytes))
    check(`${c.name}: every copied source parses without diagnostics`, !anyDiagnostics)
    check(`${c.name}: stripping changed no token of any copied source (comments only)`, sameShape)
    check(`${c.name}: the stripped planted source keeps no comment marker`, !stripped.get(c.planted)!.includes(COMMENT))

    const originalRoot = join(scratch, c.name, 'original')
    const strippedRoot = join(scratch, c.name, 'stripped')
    writeTree(originalRoot, original)
    writeTree(strippedRoot, stripped)
    const a = generate(c.generator, originalRoot)
    const b = generate(c.generator, strippedRoot)
    const rowsA = (JSON.parse(a) as Census).sites
    const rowsB = (JSON.parse(b) as Census).sites
    check(`${c.name}: comment-free copies regenerate byte-identical output`, a === b, `${rowsA.length} vs ${rowsB.length} rows`)
    check(`${c.name}: no row carries a line field`, rowsA.every(r => !('line' in r)))

    const fromSources = rowsA.filter(r => r.file !== c.planted)
    check(`${c.name}: the representative sources yield rows (${fromSources.length})`, fromSources.length > 0)
    check(
      `${c.name}: every row of the representative sources is a committed row`,
      fromSources.every(r => committed.sites.some(s => JSON.stringify(s) === JSON.stringify(r))),
      fromSources.filter(r => !committed.sites.some(s => JSON.stringify(s) === JSON.stringify(r))).map(r => r.excerpt).join(' | ').slice(0, 300),
    )
    const committedFromSources = committed.sites.filter(s => files.includes(s.file))
    check(`${c.name}: the representative sources reproduce every committed row of theirs`, committedFromSources.length === fromSources.length, `${committedFromSources.length} committed, ${fromSources.length} regenerated`)

    const plantedRows = rowsA.filter(r => r.file === c.planted)
    check(
      `${c.name}: every planted code site is counted once (strings, a regex, a template, jsx text, a continuation line)`,
      plantedRows.length === c.codeRows && plantedRows.every(r => r.excerpt.includes(CODE)),
      plantedRows.map(r => r.excerpt).join(' | ').slice(0, 400),
    )
    check(`${c.name}: no planted comment adds a row or reaches an excerpt`, plantedRows.every(r => !r.excerpt.includes(COMMENT)))
    const order = rowsA.map(r => r.file)
    const firstSeen = order.filter((file, at) => order.indexOf(file) === at)
    check(`${c.name}: the rows of one file stay together in the generator's walk order`, order.join('\n') === firstSeen.flatMap(file => order.filter(f => f === file)).join('\n'))
    check(`${c.name}: the rows of one file follow the source's order (the planted continuation line last but one)`, plantedRows[plantedRows.length - 2]?.excerpt.startsWith('*') === true)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failed === 0 ? '\n ✅ THE CENSUSES ARE INVARIANT UNDER COMMENT REMOVAL' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
