#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  [PASS] ${label}`)
  } else {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('============================================================')
console.log(' endProcessTree never ends its own caller')
console.log('============================================================')

const root = mkdtempSync(join(tmpdir(), 'tree-self-guard-'))
const child = join(root, 'child.ts')
const processGroup = pathToFileURL(resolve(import.meta.dir, '../../src/utils/processGroup.ts')).href
writeFileSync(
  child,
  [
    "import { spawn } from 'node:child_process'",
    `const { endProcessTree } = await import(${JSON.stringify(processGroup)})`,
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    'try {',
    '  const receipt = await endProcessTree(process.pid)',
    "  console.log('RECEIPT ' + JSON.stringify(receipt))",
    '  let alive = true',
    '  try { process.kill(child.pid!, 0) } catch { alive = false }',
    "  console.log('CHILD ' + alive)",
    '} finally {',
    '  if (child.exitCode === null && child.signalCode === null) {',
    "    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))",
    "    child.kill('SIGKILL')",
    '    await closed',
    '  }',
    '}',
  ].join('\n'),
)

for (const detached of [false, true]) {
  const run = spawnSync(process.execPath, [child], { detached, encoding: 'utf8', timeout: 60_000, windowsHide: true })
  const receipt = run.stdout.split(/\r?\n/).find(line => line.startsWith('RECEIPT '))
  const prefix = detached ? 'a detached launch: ' : ''
  check(`${prefix}a process that asks to end its own tree is still alive to answer`, run.status === 0, `exit ${run.status}; signal ${run.signal}`)
  check(`${prefix}its receipt names nothing ended`, receipt === 'RECEIPT {"ended":0,"survivors":[]}', receipt ?? (run.stderr || '').trim().split('\n').slice(-1)[0])
  check(`${prefix}its child is still alive`, run.stdout.split(/\r?\n/).includes('CHILD true'), run.stdout.trim())
}

try {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
} catch {
}
console.log(failures === 0 ? '\nALL TREE SELF-GUARD CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
