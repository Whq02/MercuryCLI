#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, REPO } from './lib/harness.ts'

armEnvironment()

const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))
const { planAstRewrite, resolveAstScope, searchAstPattern } = await import(join(REPO, 'src/utils/astPatterns.ts'))

const root = mkdtempSync(join(tmpdir(), 'ast-spans-'))
const nine = Array.from({ length: 9 }, (_, i) => `const broken${i} = ;`).join('\n') + '\nneedle(9);\n'
const many = Array.from({ length: 2000 }, (_, i) => `const broken${i} = ;`).join('\n') + '\nneedle(1);\n'
mkdirSync(join(root, 'one'))
mkdirSync(join(root, 'many'))
writeFileSync(join(root, 'one', 'nine.ts'), nine)
writeFileSync(join(root, 'one', 'clean.ts'), 'needle(0);\n')
for (let i = 0; i < 12; i++) writeFileSync(join(root, 'many', `g${String(i).padStart(2, '0')}.ts`), many)
await enterRoot(root)
type Recovered = { rel: string; source?: string; errors?: unknown[]; diagnostics: number; notes: string[] }
const searched = async (path: string, retainSource?: boolean): Promise<Recovered[]> => {
  const scope = resolveAstScope({ path: join(root, path), cwd: root })
  if ('refused' in scope) throw new Error(scope.refused)
  const result = await searchAstPattern(scope, { pattern: 'needle($X)', ...(retainSource ? { retainSource } : {}) })
  if ('refused' in result) throw new Error(result.refused)
  return (result.recovered ?? []) as Recovered[]
}

section('§1 — a search keeps the count of a file\'s error spans, not the spans')
{
  const [file, ...rest] = await searched('one')
  check('only the error-bearing file is named as recovered', rest.length === 0 && file?.rel === 'nine.ts', JSON.stringify([file?.rel, rest.length]))
  check('its nine diagnostics are counted and the first three are worded', file?.diagnostics === 9 && file.notes.join('; ') === '1:15 syntax error; 2:15 syntax error; 3:15 syntax error', JSON.stringify([file?.diagnostics, file?.notes]))
  check('neither the spans nor the source stay on the result', file !== undefined && file.errors === undefined && file.source === undefined, JSON.stringify(Object.keys(file ?? {})))
  const files = await searched('many')
  const kept = files.reduce((n, f) => n + (f.errors?.length ?? 0), 0)
  check('twelve files of 2,000 broken lines: 24,000 diagnostics counted, no span kept', files.length === 12 && files.every(f => f.diagnostics === 2000) && kept === 0, `${files.length} files, ${files.map(f => f.diagnostics).join(',')}, ${kept} kept`)
}

section('§2 — a caller that asks for the source is given the spans with it')
{
  const [file] = await searched('one', true)
  check('the source and every span are kept for that caller', file !== undefined && file.source === nine && file.errors?.length === 9 && file.diagnostics === 9, JSON.stringify([file?.errors?.length, file?.diagnostics]))
}

section('§3 — the answer is what it was')
{
  const prover = await makeContext([AstSearchTool])
  const r = await drive(AstSearchTool, { pattern: 'needle($X)', path: 'one' }, prover)
  check('the trailer still counts the diagnostics it does not show', r.text.includes('Searched recovered tree: nine.ts (typescript; 1:15 syntax error; 2:15 syntax error; 3:15 syntax error; +6 more diagnostics).'), r.text)
  check('both files matched and one parse problem is counted', Number(r.data?.matchCount) === 2 && Number(r.data?.parseFailures) === 1, JSON.stringify(r.data))
}

section('§4 — a plan of several rules keeps no spans on its recovered rows either')
{
  const scope = resolveAstScope({ path: join(root, 'many'), cwd: root })
  if ('refused' in scope) throw new Error(scope.refused)
  const plan = await planAstRewrite(scope, { rules: [{ pattern: 'needle($X)', rewrite: 'found($X)' }] })
  if ('refused' in plan) throw new Error(plan.refused)
  const rows = (plan.search.recovered ?? []) as Recovered[]
  check('twelve error-bearing files planned by rules: 24,000 diagnostics counted, no span kept', plan.files.length === 12 && rows.length === 12 && rows.every(f => f.diagnostics === 2000 && f.errors === undefined), `${plan.files.length} files, ${rows.length} rows, ${rows.reduce((n, f) => n + (f.errors?.length ?? 0), 0)} kept`)
}

finish('RECOVERED SPANS NOT KEPT')
