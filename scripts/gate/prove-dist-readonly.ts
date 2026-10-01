#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { calleeName, callSites, declarationOf, namedFunctionDecl, stringText, unwrap, visit } from './sourceCensus.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const LAUNCHERS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'])

function scratchOutput(expression: ts.Expression, depth = 0): boolean {
  if (depth > 8) return false
  const value = unwrap(expression)
  if (ts.isCallExpression(value)) return calleeName(value) === 'mkdtempSync'
  if (!ts.isIdentifier(value)) return false
  const declaration = declarationOf(value)
  if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return scratchOutput(declaration.initializer, depth + 1)
  if (declaration && ts.isParameter(declaration) && ts.isFunctionLike(declaration.parent)) {
    const owner = namedFunctionDecl(declaration.parent)
    if (!owner) return false
    const index = declaration.parent.parameters.indexOf(declaration)
    const calls = callSites(value.getSourceFile(), owner)
    return calls.length > 0 && calls.every(call => call.arguments[index] !== undefined && scratchOutput(call.arguments[index]!, depth + 1))
  }
  return false
}

function buildCalls(text: string, file = 'proof.ts'): { calls: number; offenders: number[] } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const offenders: number[] = []
  let calls = 0
  visit(source, node => {
    if (!ts.isCallExpression(node) || !LAUNCHERS.has(calleeName(node) ?? '')) return
    if (node.arguments[0] && stringText(node.arguments[0]) === 'git') return
    let builder = false
    for (const arg of node.arguments.slice(0, 2)) visit(arg, part => {
      const value = stringText(part)
      if (value !== undefined && /(?:^|[\s/])build\.ts(?:$|[\s;&])/.test(value)) builder = true
    })
    if (!builder) return
    calls++
    const options = node.arguments[2] && unwrap(node.arguments[2])
    const env = options && ts.isObjectLiteralExpression(options) ? options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'env') : undefined
    const object = env && ts.isPropertyAssignment(env) ? unwrap(env.initializer) : undefined
    const output = object && ts.isObjectLiteralExpression(object) ? object.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'MERCURY_BUILD_OUTDIR') : undefined
    if (!output || !ts.isPropertyAssignment(output) || !scratchOutput(output.initializer)) offenders.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)
  })
  return { calls, offenders }
}

function shellBuilds(text: string): number[] {
  return text.split('\n').flatMap((line, index) => {
    const code = line.trim().replace(/^if\s+!?\s*/, '')
    return /^(?:"?\$\{?[Bb][Uu][Nn]\}?"?|(?:\S*\/)?bun)\s+run\s+[^\n]*build\.ts\b/.test(code) ? [index + 1] : []
  })
}

assert.equal(buildCalls("spawnSync(bun, ['run', 'build.ts'], { cwd: ROOT })").offenders.length, 1)
assert.equal(buildCalls("if (!existsSync(dist)) execFileSync(bun, ['run', 'build.ts'], { cwd: ROOT })").offenders.length, 1)
assert.equal(buildCalls("spawnSync(bun, ['run', join(ROOT, 'build.ts')], { env: { MERCURY_BUILD_OUTDIR: 'dist' } })").offenders.length, 1)
assert.equal(buildCalls("const scratch = mkdtempSync(join(tmpdir(), 'build-')); spawnSync(bun, ['run', 'build.ts'], { env: { ...process.env, MERCURY_BUILD_OUTDIR: scratch } })").offenders.length, 0)
assert.equal(buildCalls("const run = (outdir: string) => spawnSync(bun, ['run', 'build.ts'], { env: { MERCURY_BUILD_OUTDIR: outdir } }); const out = mkdtempSync(join(tmpdir(), 'build-')); run(out)").offenders.length, 0)
assert.equal(buildCalls("console.log('bun run build.ts before this proof')").calls, 0)
assert.equal(shellBuilds('if ! "$BUN" run build.ts >/dev/null; then').length, 1)
assert.equal(shellBuilds('echo "run bun run build.ts first"').length, 0)
console.log('[PASS] the census refuses an unconditional or missing-dist rebuild, accepts scratch builds, and ignores remedies')

const result = (() => {
  try {
    return execFileSync('git', ['grep', '-l', '-e', 'build.ts', '--', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
  } catch (error) {
    if ((error as { status?: number }).status === 1) return ''
    throw error
  }
})()
const candidates = result.trim().split('\n').filter(file => /(?:^|\/)prove-[^/]+\.(?:tsx?|[cm]?js)$/.test(file) || /\/run-all\.sh$/.test(file) || /^scripts\/lib\/.*\.(?:tsx?|[cm]?js)$/.test(file))
const offenders: string[] = []
let builders = 0
for (const file of candidates) {
  const text = readFileSync(resolve(ROOT, file), 'utf8')
  const found = file.endsWith('.sh') ? { calls: 0, offenders: shellBuilds(text) } : buildCalls(text, file)
  builders += found.calls
  for (const line of found.offenders) offenders.push(`${file}:${line}`)
}
assert.ok(candidates.length > 50, `the git grep census must read the proof estate, saw ${candidates.length}`)
assert.ok(builders >= 5, `the census must still see the build proofs' scratch builds, saw ${builders}`)
assert.deepEqual(offenders, [], `proofs and suite runners must not rebuild the shared dist:\n${offenders.join('\n')}`)
console.log(`[PASS] git grep census read ${candidates.length} proof/runner/helper files; ${builders} builder calls all declare scratch outputs; no shared-dist build`)
