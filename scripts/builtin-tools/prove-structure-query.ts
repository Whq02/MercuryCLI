#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/prove-structure-query.ts — bounded structural source
//  queries. Proves against a REAL fixture project:
//    · deterministic queries (identical ids across runs);
//    · JS, TS, JSX and TSX fixtures all match;
//    · name/callee/module/within/value filters;
//    · bounded results with flagged truncation;
//    · no-match honesty (empty ≠ error);
//    · parse-failure honesty (a broken file is REPORTED, never silently
//      skipped);
//    · stable match ids are content-derived (a changed file changes ids).
// ============================================================================

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { runStructureQuery } = await import('../../src/services/structure/query.ts')

const root = mkdtempSync(join(tmpdir(), 'builtin-tools-structure-'))
mkdirSync(join(root, 'src'), { recursive: true })

writeFileSync(
  join(root, 'src', 'alpha.ts'),
  `import { readFile } from 'node:fs/promises'
import legacy from './legacy/util'

export interface Job { id: string }

export class Runner {
  run(job: Job): void {
    console.log('running', job.id)
    legacy.track(job)
  }
}

export function planJob(name: string): Job {
  console.log('planning', name)
  return { id: name }
}
`,
)
writeFileSync(
  join(root, 'src', 'beta.js'),
  `const config = { retries: 3, verbose: false }

function retry(fn) {
  console.log('retrying')
  return fn()
}

module.exports = { config, retry }
`,
)
writeFileSync(
  join(root, 'src', 'gamma.jsx'),
  `export function Panel({ title }) {
  return (
    <section>
      <Header title={title} />
      <p>hello</p>
    </section>
  )
}
`,
)
writeFileSync(
  join(root, 'src', 'delta.tsx'),
  `type Props = { label: string }
export const Badge = ({ label }: Props) => <span className="badge">{label}</span>
`,
)
writeFileSync(join(root, 'src', 'broken.ts'), 'export function oops( {\n')

try {
  console.log('── determinism + language matrix ──')
  const calls1 = runStructureQuery(root, { select: 'call', callee: 'console.log' })
  const calls2 = runStructureQuery(root, { select: 'call', callee: 'console.log' })
  if ('state' in calls1 || 'state' in calls2) {
    check('parser facility available', false, 'state' in calls1 ? calls1.note : '')
  } else {
    check('console.log calls found across ts + js', calls1.matches.length === 3, `${calls1.matches.length}`)
    check(
      'deterministic ids across runs',
      JSON.stringify(calls1.matches.map(m => m.id)) === JSON.stringify(calls2.matches.map(m => m.id)),
    )
    check(
      'matches ordered by (file, position)',
      JSON.stringify(calls1.matches.map(m => m.file)) ===
        JSON.stringify([...calls1.matches.map(m => m.file)].sort()),
    )
  }

  const broken = runStructureQuery(root, { select: 'function', name: 'oops*' })
  check(
    'parse failure REPORTED (never silently skipped)',
    !('state' in broken) && broken.parseFailures.some(f => f.file.endsWith('broken.ts')),
    'state' in broken ? broken.note : JSON.stringify(broken.parseFailures),
  )

  const jsx = runStructureQuery(root, { select: 'jsx-element', name: 'Header' })
  check('JSX fixture matches', !('state' in jsx) && jsx.matches.length === 1 && jsx.matches[0]!.file.endsWith('gamma.jsx'))

  const tsx = runStructureQuery(root, { select: 'jsx-element', name: 'span' })
  check('TSX fixture matches', !('state' in tsx) && tsx.matches.length === 1 && tsx.matches[0]!.file.endsWith('delta.tsx'))

  const iface = runStructureQuery(root, { select: 'interface', name: 'Job' })
  check('TS interface matches', !('state' in iface) && iface.matches.length === 1)

  const jsFn = runStructureQuery(root, { select: 'function', name: 'retry' })
  check('JS function matches', !('state' in jsFn) && jsFn.matches.length === 1 && jsFn.matches[0]!.file.endsWith('beta.js'))

  console.log('── filters ──')
  const within = runStructureQuery(root, { select: 'call', callee: 'console.log', within: 'class:Runner' })
  check('within class:Runner narrows to 1', !('state' in within) && within.matches.length === 1)

  const imports = runStructureQuery(root, { select: 'import', module: './legacy/*' })
  check('import module glob matches', !('state' in imports) && imports.matches.length === 1)

  const prop = runStructureQuery(root, { select: 'property', name: 'retries' })
  check('object property matches', !('state' in prop) && prop.matches.length === 1)

  const str = runStructureQuery(root, { select: 'string', value: 'running' })
  check('string literal value filter', !('state' in str) && str.matches.length === 1)

  console.log('── bounds + honesty ──')
  const bounded = runStructureQuery(root, { select: 'call', limit: 1 })
  check('limit truncation FLAGGED', !('state' in bounded) && bounded.matches.length === 1 && bounded.truncated)

  const none = runStructureQuery(root, { select: 'enum' })
  check('no-match honesty: empty result, not an error', !('state' in none) && none.matches.length === 0 && !none.truncated)

  const scoped = runStructureQuery(root, { select: 'call', files: ['src/beta.js'] })
  check('files glob scopes the walk', !('state' in scoped) && scoped.matches.every(m => m.file === 'src/beta.js'))

  console.log('── content-derived id stability ──')
  const before = runStructureQuery(root, { select: 'function', name: 'planJob' })
  writeFileSync(
    join(root, 'src', 'alpha.ts'),
    `${'// shifted\n'}${require('node:fs').readFileSync(join(root, 'src', 'alpha.ts'), 'utf8')}`,
  )
  const after = runStructureQuery(root, { select: 'function', name: 'planJob' })
  check(
    'a changed file changes the match id (staleness is mechanical)',
    !('state' in before) && !('state' in after) && before.matches[0]!.id !== after.matches[0]!.id,
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'STRUCTURE QUERY: ALL GREEN' : `STRUCTURE QUERY: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
