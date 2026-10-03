#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const HOMES = [join(ROOT, 'src', 'rows'), join(ROOT, 'src', 'runner', 'wire')]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const rel = (path: string): string => path.slice(ROOT.length + 1)
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const resolves = (fromFile: string, spec: string): boolean => {
  const base = join(dirname(fromFile), spec.replace(/\.js$/, ''))
  return ['.ts', '.tsx', '.d.ts', '/index.ts'].some(ext => existsSync(base + ext))
}

console.log('the machine surface — the row vocabulary and the runner wire')

const modules: string[] = []
for (const home of HOMES) {
  const present = existsSync(home) && statSync(home).isDirectory()
  check(`${rel(home)} exists`, present)
  if (!present) continue
  const files = readdirSync(home).filter(name => name.endsWith('.ts')).sort()
  check(`${rel(home)} carries modules`, files.length > 0)
  modules.push(...files.map(name => join(home, name)))
}
for (const name of ['src/rows/vocabulary.ts', 'src/rows/read.ts', 'src/rows/project.ts', 'src/rows/turn.ts', 'src/runner/wire/methods.ts', 'src/runner/wire/peer.ts', 'src/runner/wire/errors.ts']) {
  check(`${name} is present`, existsSync(join(ROOT, name)))
}

for (const file of modules) {
  const src = readFileSync(file, 'utf8')
  const stripped = strip(src)
  const hasRealExport =
    /export\s+(type|interface|const|function|class|enum|declare|async)\s+\w/.test(stripped) ||
    /export\s+\{\s*\w/.test(stripped) ||
    /export\s+\*\s+from/.test(stripped)
  check(`${rel(file)}: exports real bindings`, hasRealExport, 'empty exported module')
  check(`${rel(file)}: no \`= any\` type alias`, !/export\s+type\s+\w+\s*=\s*any\b/.test(stripped), 'a misleading any-stub')
  const specs = [...stripped.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map(m => m[1]!)
  const unresolved = specs.filter(spec => !resolves(file, spec))
  check(`${rel(file)}: every relative import resolves`, unresolved.length === 0, unresolved.join(', '))
  check(`${rel(file)}: no 'not implemented' stub throws`, !/throw new Error\((?:'|")[^'"]*not implemented/i.test(stripped))
  check(`${rel(file)}: no provider package import`, !/from\s+['"]@anthropic-ai\//.test(stripped) && !/from\s+['"]openai['"]/.test(stripped), 'a provider package leaks through the machine surface')
}

{
  const vocabulary = readFileSync(join(ROOT, 'src', 'rows', 'vocabulary.ts'), 'utf8')
  const methods = readFileSync(join(ROOT, 'src', 'runner', 'wire', 'methods.ts'), 'utf8')
  check('ROWS_SCHEMA is declared as the literal 1', /export const ROWS_SCHEMA = 1\b/.test(vocabulary))
  check('the session row and the outcome row carry the schema literal', /schema: z\.literal\(ROWS_SCHEMA\)/.test(vocabulary))
  check('RUNNER_PROTOCOL is declared as the literal 1', /export const RUNNER_PROTOCOL = 1\b/.test(methods))
  check('the initialize handshake carries the one protocol literal both ways', (methods.match(/protocol: z\.literal\(RUNNER_PROTOCOL\)/g) ?? []).length === 2, String((methods.match(/protocol: z\.literal\(RUNNER_PROTOCOL\)/g) ?? []).length))
  const runnerMethods = readFileSync(join(ROOT, 'src', 'cli', 'headless', 'runnerMethods.ts'), 'utf8')
  check("the runner answers its protocol and refuses a host asking for another", runnerMethods.includes('protocol: RUNNER_PROTOCOL') && runnerMethods.includes('if (params.protocol !== RUNNER_PROTOCOL) {'))
}

{
  const project = strip(readFileSync(join(ROOT, 'src', 'rows', 'project.ts'), 'utf8'))
  for (const name of ['sessionRow', 'turnStartedRow', 'turnWaitingRow', 'itemRowsOf', 'toolResultRowsOf', 'toolUpdateRow', 'stepRow', 'outcomeRow', 'compactionRow', 'compactionClearedRow', 'partialRowsOf']) {
    check(`src/rows/project.ts exports the ${name} projector`, new RegExp(`export function ${name}\\b`).test(project))
  }
}

{
  const src = readFileSync(join(ROOT, 'src', 'services', 'api', 'emptyUsage.ts'), 'utf8')
  check(
    'NonNullableUsage is a structural Mercury declaration (no provider import, no any-stub)',
    !src.includes('@anthropic-ai/') &&
      !/NonNullableUsage\s*=\s*any/.test(src) &&
      src.includes('input_tokens: number') &&
      src.includes('cache_creation_input_tokens: number') &&
      src.includes('output_tokens_details'),
  )
}

if (failures > 0) {
  console.log(`\nthe machine surface: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nthe machine surface: green')
