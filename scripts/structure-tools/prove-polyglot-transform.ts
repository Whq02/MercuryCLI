import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, REPO } from '../ast-tools/lib/harness.ts'

const env = armEnvironment()
const { AstEditTool } = await import('../../src/tools/AstEditTool/AstEditTool.ts')
const { AstSearchTool } = await import('../../src/tools/AstSearchTool/AstSearchTool.ts')
const { resolveAstScope, isAstRefusal, searchAstPattern } = await import('../../src/utils/astPatterns.ts')
const { loadGrammarEngine, parsePolyglot, languageByName } = await import('../../src/services/structure/grammarFacility.ts')
const root = mkdtempSync(join(tmpdir(), 'ast-transform-'))
try {
  await enterRoot(root)
  const prover = await makeContext([AstSearchTool, AstEditTool])
  const appPy = join(root, 'app.py')
  const utilGo = join(root, 'util.go')
  const source = 'def greet(name):\n    print(name)\n    print("hi")\n'
  writeFileSync(appPy, source)
  writeFileSync(utilGo, 'package util\n\nimport "fmt"\n\nfunc Greet() {\n\tfmt.Println("a")\n\tfmt.Println("b")\n}\n')
  const input = { pattern: 'print($X)', rewrite: 'logging.info($X)', path: '.', lang: 'python' }
  const dry = await drive(AstEditTool, input, prover)
  check('dry run substitutes captures exactly', !dry.isError && dry.data?.state === 'dry-run' && dry.text.includes('logging.info(name)') && dry.text.includes('logging.info("hi")'), dry.text)
  check('dry run writes nothing', readFileSync(appPy, 'utf8') === source)
  writeFileSync(appPy, source + '# drift\n')
  const stale = await drive(AstEditTool, { ...input, apply: true, plan: dry.data?.plan }, prover)
  check('drift refuses the stale plan and provides the fresh plan', stale.isError && stale.text.includes('does not match the current dry run') && stale.text.includes('Nothing was written.'), stale.text)
  check('drift refusal leaves the entire file alone', readFileSync(appPy, 'utf8') === source + '# drift\n')
  const secondPy = join(root, 'second.py')
  writeFileSync(secondPy, 'def other():\n    print("second")\n')
  const clean = await drive(AstEditTool, input, prover)
  check('one dry run spans both files', !clean.isError && clean.data?.fileCount === 2)
  const applied = await drive(AstEditTool, { ...input, apply: true, plan: clean.data?.plan }, prover)
  check('clean apply re-reads and reports both changed files', !applied.isError && applied.data?.state === 'applied' && (applied.data?.changedPaths as string[])?.length === 2 && applied.text.includes('re-read verified'), applied.text)
  check('first file contains only its exact rewrites', readFileSync(appPy, 'utf8') === (source + '# drift\n').replaceAll('print(', 'logging.info('))
  check('second file contains its exact rewrite', readFileSync(secondPy, 'utf8') === 'def other():\n    logging.info("second")\n')
  const engine = await loadGrammarEngine()
  if (engine.state !== 'ok') throw new Error(engine.note)
  for (const file of [appPy, secondPy]) {
    const parsed = await parsePolyglot(engine, languageByName('python')!, readFileSync(file, 'utf8'))
    check('applied file parses cleanly', !('state' in parsed) && parsed.parseErrors.length === 0)
    if (!('state' in parsed)) parsed.tree.delete()
  }
  const double = await drive(AstEditTool, { ...input, apply: true, plan: clean.data?.plan }, prover)
  check('second apply never writes twice', double.data?.state !== 'applied' && readFileSync(appPy, 'utf8') === (source + '# drift\n').replaceAll('print(', 'logging.info('))
  const beforeGo = readFileSync(utilGo, 'utf8')
  const broken = await drive(AstEditTool, { pattern: 'fmt.Println($X)', rewrite: 'if broken((( $X', path: 'util.go' }, prover)
  check('a syntactically broken rewrite refuses during planning', broken.isError && /pars/i.test(broken.text), broken.text)
  check('parse guard keeps all bytes', readFileSync(utilGo, 'utf8') === beforeGo)
  writeFileSync(join(root, 'nested.py'), 'print(print(1))\n')
  const scope = resolveAstScope({ cwd: root, path: 'nested.py' })
  if (isAstRefusal(scope)) throw new Error(scope.refused)
  const nestedSearch = await searchAstPattern(scope, { pattern: 'print($X)' })
  check('both nested matches remain searchable', !isAstRefusal(nestedSearch) && nestedSearch.matches.length === 2)
  const nested = await drive(AstEditTool, { pattern: 'print($X)', rewrite: 'log($X)', path: 'nested.py' }, prover)
  check('overlapping matches refuse during planning', nested.isError && nested.text.includes('Ambiguous rewrite') && readFileSync(join(root, 'nested.py'), 'utf8') === 'print(print(1))\n', nested.text)
  const unbound = await drive(AstEditTool, { pattern: 'fmt.Println($X)', rewrite: 'fmt.Println($NOPE)', path: 'util.go' }, prover)
  check('uncaptured rewrite name refuses', unbound.isError && unbound.text.includes('$NOPE') && readFileSync(utilGo, 'utf8') === beforeGo, unbound.text)
  const deletionInput = { pattern: 'fmt.Println("a")', rewrite: '', path: 'util.go' }
  const deletion = await drive(AstEditTool, deletionInput, prover)
  check('a literal pattern selects exactly one of the two calls', !deletion.isError && deletion.data?.matchCount === 1)
  const deleted = await drive(AstEditTool, { ...deletionInput, apply: true, plan: deletion.data?.plan }, prover)
  check('deletion removes exactly the selected node and its line', !deleted.isError && readFileSync(utilGo, 'utf8') === beforeGo.replace('\tfmt.Println("a")\n', ''), deleted.text)
  for (const [file, text, pattern, rewrite, expected] of [
    ['inj.py', 'f("has $LAST inside", tail)\n', 'f($$$INIT, $LAST)', 'g($$$INIT, $LAST)', 'g("has $LAST inside", tail)\n'],
    ['dollar.py', 'f("price $Y total", n)\n', 'f($$$ARGS)', 'g($$$ARGS)', 'g("price $Y total", n)\n'],
  ]) {
    writeFileSync(join(root, file!), text!)
    const args = { pattern, rewrite, path: file }
    const plan = await drive(AstEditTool, args, prover)
    const result = await drive(AstEditTool, { ...args, apply: true, plan: plan.data?.plan }, prover)
    check('capture text with dollar names survives substitution verbatim', !plan.isError && !result.isError && readFileSync(join(root, file!), 'utf8') === expected, result.text)
  }
  writeFileSync(join(root, 'race.py'), 'race_target(1)\n')
  const raceInput = { pattern: 'race_target($X)', rewrite: 'raced($X)', path: 'race.py' }
  const race = await drive(AstEditTool, raceInput, prover)
  const raceResults = await Promise.all([1, 2].map(() => drive(AstEditTool, { ...raceInput, apply: true, plan: race.data?.plan }, prover)))
  check('concurrent applies land exactly once', raceResults.filter(r => r.data?.state === 'applied').length === 1 && readFileSync(join(root, 'race.py'), 'utf8') === 'raced(1)\n', raceResults.map(r => r.text).join('\n'))
  check('the second concurrent apply is a refusal or verified replay', raceResults.filter(r => r.isError || r.data?.state === 'no-change').length === 1)
} finally {
  process.chdir(REPO)
  for (const dir of [root, env.home, env.engineDir]) rmSync(dir, { recursive: true, force: true })
}
finish('POLYGLOT TRANSFORM LAWS')
