#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { calleeName, stringText, visit } from './sourceCensus.ts'

const ROOT = resolve(import.meta.dir, '../..')
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')
const tracked = execFileSync('git', ['ls-files', '-z', '--', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)

function unreachableProofs(text: string): number[] {
  let replaced = false
  const hits: number[] = []
  text.split('\n').forEach((line, i) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return
    if (replaced && /\bprove-[\w-]+\.(?:ts|tsx|py|sh)\b/.test(line)) hits.push(i + 1)
    if (/^exec\s+/.test(line)) replaced = true
  })
  return hits
}

function fixedFixturePorts(text: string): number[] {
  const source = ts.createSourceFile('proof.ts', text, ts.ScriptTarget.Latest, true)
  const hits: number[] = []
  visit(source, node => {
    if (ts.isVariableDeclaration(node) && /port$/i.test(node.name.getText(source)) && node.initializer && ts.isNumericLiteral(node.initializer) && Number(node.initializer.text) !== 0) hits.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    if (!ts.isCallExpression(node)) return
    const name = calleeName(node)
    const fallback = node.arguments[0]
    if (name === 'Number' && ts.isVariableDeclaration(node.parent) && /port/i.test(node.parent.name.getText(source)) && fallback && ts.isBinaryExpression(fallback) && fallback.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken && ts.isNumericLiteral(fallback.right) && Number(fallback.right.text) !== 0) hits.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    if (name === 'listen' && node.arguments[0] && ts.isNumericLiteral(node.arguments[0]) && Number(node.arguments[0].text) !== 0) hits.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    if (!['startWorkflowAgentFixture', 'startCrossfamilyFixture', 'startFoldFamiliesFixture'].includes(name ?? '') || !node.arguments[0] || !ts.isObjectLiteralExpression(node.arguments[0])) return
    for (const prop of node.arguments[0].properties) if (ts.isPropertyAssignment(prop) && prop.name.getText(source) === 'port' && ts.isNumericLiteral(prop.initializer) && Number(prop.initializer.text) !== 0) hits.push(source.getLineAndCharacterOfPosition(prop.getStart()).line + 1)
  })
  return hits
}

function historicalBuild(text: string): { builds: boolean; lent: number[]; locked: boolean } {
  const source = ts.createSourceFile('proof.ts', text, ts.ScriptTarget.Latest, true)
  let archive = false
  let build = false
  let locked = false
  const lent: number[] = []
  visit(source, node => {
    if (!ts.isCallExpression(node)) return
    const callee = calleeName(node)
    if (callee === 'symlinkSync') {
      let dependencies = false
      for (const arg of node.arguments) visit(arg, part => { if (stringText(part) === 'node_modules') dependencies = true })
      if (dependencies) lent.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1)
    }
    if (!['spawnSync', 'execFileSync', 'execSync', 'spawn'].includes(callee ?? '')) return
    const command = node.arguments.slice(0, 2).map(arg => arg.getText(source)).join(' ')
    if (/\barchive\b/.test(command)) archive = true
    if (/\bbuild\.ts\b/.test(command)) build = true
    if (/--frozen-lockfile/.test(command)) locked = true
  })
  return { builds: archive && build, lent, locked }
}

assert.deepEqual(unreachableProofs('exec bun prove-first.ts\nbun prove-lost.ts\n'), [2])
assert.deepEqual(unreachableProofs('bun prove-first.ts\nexec bun prove-last.ts\n# prove-note.ts\n'), [])
assert.deepEqual(unreachableProofs('echo "exec bun prove-note.ts"\nbun prove-last.ts\n'), [])
assert.deepEqual(fixedFixturePorts("server.listen(34906, '127.0.0.1'); startWorkflowAgentFixture({ port: 34907 })"), [1, 1])
assert.deepEqual(fixedFixturePorts("server.listen(0, '127.0.0.1'); startWorkflowAgentFixture({ port: 0 }); console.log('listen(34906)')"), [])
assert.deepEqual(fixedFixturePorts('const PORT = Number(process.env.PROOF_PORT ?? 34931)'), [1])
assert.deepEqual(fixedFixturePorts('const requestedPort = Number(process.env.PROOF_PORT ?? 0)'), [])
assert.deepEqual(fixedFixturePorts('const FIXTURE_PORT = 34123; const REPORT_WINDOW_MS = 3000'), [1])
const borrowed = historicalBuild("execFileSync('git', ['archive', sha]); symlinkSync(join(root, 'node_modules'), join(base, 'node_modules')); spawnSync(bun, ['run', 'build.ts'])")
assert.ok(borrowed.builds && borrowed.lent.length === 1 && !borrowed.locked)
const own = historicalBuild("execFileSync('git', ['archive', sha]); spawnSync(bun, ['install', '--frozen-lockfile']); spawnSync(bun, ['run', 'build.ts'])")
assert.ok(own.builds && own.locked && own.lent.length === 0)
assert.equal(historicalBuild("console.log('git archive and build.ts'); symlinkSync(join(root, 'node_modules'), target)").builds, false)
console.log('PASS planted runner and historical-build defects are detected; comments and remedies are not builds')

const failures: string[] = []
const runners = tracked.filter(path => /^scripts\/[^/]+\/run-all\.sh$/.test(path))
for (const path of runners) for (const line of unreachableProofs(read(path))) failures.push(`${path}:${line}: a proof invocation after top-level exec is unreachable; keep the invocation before exec or remove the duplicate`)
let historical = 0
for (const path of tracked.filter(path => /\/prove-[^/]+\.tsx?$/.test(path) && !path.endsWith('/prove-proof-readings-census.ts'))) {
  const source = read(path)
  if (/^scripts\/(workflows|compact|agent-dispatch|provider-compat|search|extensions)\//.test(path)) for (const line of fixedFixturePorts(source)) failures.push(`${path}:${line}: fixtures must bind an ephemeral port by default and publish the bound endpoint`)
  const result = historicalBuild(source)
  if (!result.builds) continue
  historical++
  if (!result.locked) failures.push(`${path}: a historical build must install its own frozen lock`)
  for (const line of result.lent) failures.push(`${path}:${line}: a historical build must not borrow the current node_modules`)
}
assert.ok(runners.length > 100 && historical >= 3, `the census saw ${runners.length} runners and ${historical} historical builds`)
for (const [path, seconds] of [['scripts/edit-tools/prove-write-preserves-file-shape.ts', 120], ['scripts/core-runtime/prove-loop-guard-cycle.ts', 300]] as const) {
  const source = read(path)
  if (!new RegExp(`const budgetMs = vshotBudgetMs\\(${seconds}_000\\)`).test(source) || !/\}, budgetMs\)/.test(source)) failures.push(`${path}: the outer watchdog must honor the runner's pace, not a fixed ${seconds}-second wall`)
}
const fastLoad = readFileSync(resolve(ROOT, 'scripts/host/prove-fast-load-drive.ts'), 'utf8')
const fastLoadSource = ts.createSourceFile('fast-load.ts', fastLoad, ts.ScriptTarget.Latest, true)
let shortJobBudgets = 0
visit(fastLoadSource, node => {
  if (!ts.isCallExpression(node) || calleeName(node) !== 'runHostJob') return
  const options = node.arguments[2]
  if (!options || !ts.isObjectLiteralExpression(options)) return
  for (const prop of options.properties) {
    if (!ts.isPropertyAssignment(prop) || prop.name.getText(fastLoadSource) !== 'timeoutMs') continue
    if (ts.isNumericLiteral(prop.initializer) && Number(prop.initializer.text) === 60) failures.push('scripts/host/prove-fast-load-drive.ts: short inner failure-job budgets must honor the runner scale')
    if (ts.isCallExpression(prop.initializer) && calleeName(prop.initializer) === 'vshotBudgetMs' && prop.initializer.arguments[0]?.getText(fastLoadSource) === '60') shortJobBudgets++
  }
})
if (shortJobBudgets !== 2) failures.push('scripts/host/prove-fast-load-drive.ts: both short failure/cleanup job budgets must remain present and runner-scaled')
const splash = readFileSync(resolve(ROOT, 'scripts/splash/prove-splash.py'), 'utf8')
for (const name of ['run_pty', 'run_corpus']) {
  const body = splash.split(`def ${name}(`)[1]?.split('\ndef ')[0] ?? ''
  const clear = body.indexOf("for spelling in ('NO_COLOR', 'FORCE_COLOR', 'MERCURY_TRUECOLOR'):")
  const pins = body.indexOf('for k, v in (env_extra or {}).items():')
  if (!(clear >= 0 && pins > clear && body.slice(clear, pins).includes('os.environ.pop(spelling, None)'))) failures.push(`scripts/splash/prove-splash.py ${name}: clear ambient color overrides before applying each leg's explicit pins`)
}
const fold = readFileSync(resolve(ROOT, 'scripts/compact/prove-fold-loop-answers.ts'), 'utf8')
if (fold.includes('gaps.every') || !fold.includes("f.state === 'ended' && f.exit === 'landed'") || !fold.includes("f.type === 'tool_result' && f.status === 'ok'")) failures.push('scripts/compact/prove-fold-loop-answers.ts: read landed-fold and completed-tool marks, not a count of fixture request gaps')
const upgrade = readFileSync(resolve(ROOT, 'scripts/prompt/prove-upgrade-composition.ts'), 'utf8')
if (!upgrade.includes('lockOf(root, name) !== lockOf(base, name)')) failures.push('scripts/prompt/prove-upgrade-composition.ts: compare the historical and current vendor locks before lending a cache')
const boot = readFileSync(resolve(ROOT, 'scripts/updater/prove-proof-boot-reaches-nothing.py'), 'utf8')
if (!boot.includes('pyte.ByteStream(screen)') || !boot.includes('stream.feed(b)') || boot.includes('ESCAPES.sub')) failures.push('scripts/updater/prove-proof-boot-reaches-nothing.py: readiness is read from terminal cells; stripping cursor motion loses layout spaces')
const popup = readFileSync(resolve(ROOT, 'scripts/mcp/prove-mcp-popup-drive.ts'), 'utf8')
if (!popup.includes('signingInFrame = frame') || !popup.includes('...stepScreens, signingInFrame')) failures.push('scripts/mcp/prove-mcp-popup-drive.ts: retain the frame observed before the OAuth callback; later time samples can miss it')
const relaunch = readFileSync(resolve(ROOT, 'scripts/daemon/prove-dupline-relaunch-drive.ts'), 'utf8')
const pendingAt = relaunch.indexOf('carriersOf(projects, LINE).length === 0')
const killAt = relaunch.indexOf("process.kill(worker.pid, 'SIGKILL')")
if (pendingAt < 0 || killAt < pendingAt || !relaunch.includes('!releasedBeforeKill') || relaunch.includes('await sleep(1500)')) failures.push('scripts/daemon/prove-dupline-relaunch-drive.ts: prove the line is still pending under a held parent response before ending the runner')
assert.deepEqual(failures, [], `proof reading laws:\n${failures.join('\n')}`)
console.log(`PASS ${runners.length} runners and ${historical} historical builds; watchdog, color and fold-mark regressions are pinned`)
