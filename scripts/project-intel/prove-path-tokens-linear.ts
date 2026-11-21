import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const worker = process.argv[2] === '--worker'
const modulePath = resolve(process.argv[worker ? 3 : 2] ?? join(import.meta.dir, '../../src/services/projectIntel/capsule.ts'))

if (worker) {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { pathTokens } = await import(pathToFileURL(modulePath).href) as {
    pathTokens: (task: string, workspace: string) => string[]
  }
  const workspace = process.argv[4]!
  const cases: Array<[string, string[]]> = [
    ['plain words ZZZ a. / .', []],
    ['"src/input.ts", ./README.md... `test/input.test.ts` missing.ts', ['README.md', 'src/input.ts', 'test/input.test.ts']],
    ['src/input.ts src/input.ts README.md', ['README.md', 'src/input.ts']],
    [`${workspace}/src/input.ts ${workspace}/README.md`, ['README.md', 'src/input.ts']],
    ['../README.md /outside/README.md src/../../README.md', []],
    ['src/./input.ts src/../README.md @scope/file.ts docs/LICENSE', ['@scope/file.ts', 'README.md', 'docs/LICENSE', 'src/input.ts']],
    ['src/input.ts!README.md?test/input.test.ts;docs/LICENSE', ['README.md', 'docs/LICENSE', 'src/input.ts', 'test/input.test.ts']],
  ]
  for (const [input, expected] of cases) assert.deepEqual(pathTokens(input, workspace), expected, input)
  console.log(JSON.stringify({ kind: 'semantics', checks: cases.length }))

  for (const size of [4_200_000, 1_050_000, 2_100_000, 8_400_000]) {
    const input = 'Z'.repeat(size)
    const budgetMs = 1000 + size / 1000
    console.log(JSON.stringify({ kind: 'start', size, shape: 'single-token', budgetMs }))
    const started = performance.now()
    const usage = process.cpuUsage()
    const tokens = pathTokens(input, workspace)
    const elapsedMs = performance.now() - started
    const cpu = process.cpuUsage(usage)
    assert.deepEqual(tokens, [])
    console.log(JSON.stringify({ kind: 'timing', size, shape: 'single-token', elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, budgetMs }))
    assert.ok(elapsedMs <= budgetMs, `${size} characters took ${elapsedMs.toFixed(1)}ms; budget ${budgetMs}ms`)
  }

  for (const [shape, prefix] of [
    ['trailing-dot', 'Z'.repeat(4_200_000) + '.'],
    ['leading-dot', '.' + 'Z'.repeat(4_200_000)],
    ['punctuation-run', '.'.repeat(4_200_000) + 'Z'],
    ['trailing-punctuation', 'src/input.ts' + '.'.repeat(4_200_000)],
  ]) {
    const input = `${prefix} README.md src/input.ts`
    const budgetMs = 1000 + input.length / 1000
    console.log(JSON.stringify({ kind: 'start', size: input.length, shape, budgetMs }))
    const started = performance.now()
    const tokens = pathTokens(input, workspace)
    const elapsedMs = performance.now() - started
    assert.deepEqual(tokens, ['README.md', 'src/input.ts'], `${shape}: the files after the entire long token survive`)
    console.log(JSON.stringify({ kind: 'timing', size: input.length, shape, elapsedMs, budgetMs }))
    assert.ok(elapsedMs <= budgetMs, `${shape} took ${elapsedMs.toFixed(1)}ms; budget ${budgetMs}ms`)
  }
  console.log('PASS: pathTokens preserves path semantics and scans multi-megabyte single lines within the measured linear budget')
  process.exit(0)
}

const workspace = mkdtempSync(join(tmpdir(), 'path-tokens-linear-'))
try {
  for (const dir of ['src', 'test', '@scope', 'docs']) mkdirSync(join(workspace, dir))
  for (const file of ['README.md', 'src/input.ts', 'test/input.test.ts', '@scope/file.ts', 'docs/LICENSE']) {
    writeFileSync(join(workspace, file), 'fixture\n')
  }
  const child = spawn(process.execPath, [import.meta.path, '--worker', modulePath, workspace], { stdio: ['ignore', 'pipe', 'pipe'] })
  let timer: ReturnType<typeof setTimeout>
  let active = 'module load'
  let started = performance.now()
  let timedOut = false
  const arm = () => {
    clearTimeout(timer)
    started = performance.now()
    timer = setTimeout(() => {
      timedOut = true
      console.error(`FAIL: ${active} has not returned after ${(performance.now() - started).toFixed(1)}ms (30s safety ceiling)`)
      child.kill('SIGKILL')
    }, 30_000)
  }
  arm()
  let pending = ''
  child.stdout.on('data', chunk => {
    process.stdout.write(chunk)
    pending += chunk.toString()
    let end: number
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      try {
        const row = JSON.parse(line)
        if (row.kind === 'start') { active = `${row.shape}, ${row.size} characters`; arm() }
      } catch {}
    }
  })
  child.stderr.on('data', chunk => process.stderr.write(chunk))
  const code = await new Promise<number | null>((done, reject) => { child.once('close', done); child.once('error', reject) })
  clearTimeout(timer!)
  assert.equal(timedOut, false, 'the isolated function must return before the safety ceiling')
  assert.equal(code, 0, 'the isolated function proof must pass')
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
