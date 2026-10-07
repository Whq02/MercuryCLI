import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, finish, REPO } from './lib/harness.ts'

const env = armEnvironment()
const { compileFor } = await import(join(REPO, 'src/services/structure/polyglotQuery.ts'))
const { encodePattern } = await import(join(REPO, 'src/services/structure/pattern.ts'))
const { loadGrammarEngine, languageByName } = await import(join(REPO, 'src/services/structure/grammarFacility.ts'))
const { resolveAstScope, searchAstPattern, isAstRefusal } = await import(join(REPO, 'src/utils/astPatterns.ts'))
const root = mkdtempSync(join(tmpdir(), 'ast-examples-'))
try {
  writeFileSync(join(root, 'orders.py'), 'def process_order(order):\n    return order\n\ndef process_order_v2(o) -> int:\n    return o\n')
  writeFileSync(join(root, 'orders.ts'), 'function process_order(a: number): string { return String(a) }\n')
  const engine = await loadGrammarEngine()
  if (engine.state !== 'ok') throw new Error(engine.note)
  for (const [langName, patterns] of [
    ['typescript', ['$FN($$$ARGS)', 'if ($COND) { $$$BODY }', "import { $$$NAMES } from '$MODULE'", 'class $_ { $$$BODY }', 'function process_order($$$ARGS) { $$$BODY }', 'function process_order($$$ARGS): $_ { $$$BODY }', 'oldName($$$ARGS)', 'newName($$$ARGS)']],
    ['python', ['def process_order($$$ARGS): $$$BODY', 'def process_order_v2($$$ARGS) -> $_: $$$BODY', 'print($$$ARGS)', 'print($X)', 'logging.info($X)']],
  ] as Array<[string, string[]]>) {
    for (const text of patterns) {
      const compiled = await compileFor(engine, languageByName(langName)!, encodePattern(text), new Map())
      check(`${langName} description example compiles: ${text}`, !('state' in compiled), 'state' in compiled ? compiled.note : '')
      if (!('state' in compiled)) compiled.hold.delete()
    }
  }
  for (const [file, pattern, count] of [
    ['orders.py', 'def process_order($$$ARGS): $$$BODY', 1],
    ['orders.py', 'def process_order_v2($$$ARGS) -> $_: $$$BODY', 1],
    ['orders.ts', 'function process_order($$$ARGS): $_ { $$$BODY }', 1],
    ['orders.ts', 'function process_order($$$ARGS) { $$$BODY }', 0],
  ] as Array<[string, string, number]>) {
    const scope = resolveAstScope({ cwd: root, path: file })
    if (isAstRefusal(scope)) throw new Error(scope.refused)
    const result = await searchAstPattern(scope, { pattern })
    check(`declaration form ${pattern}: exactly ${count}`, !isAstRefusal(result) && result.matches.length === count, isAstRefusal(result) ? result.refused : String(result.matches.length))
  }
} finally {
  for (const dir of [root, env.home, env.engineDir]) rmSync(dir, { recursive: true, force: true })
}
finish('AST DESCRIPTION EXAMPLES')
