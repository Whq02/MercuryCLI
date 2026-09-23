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
    `const { endProcessTree } = await import(${JSON.stringify(processGroup)})`,
    'const receipt = await endProcessTree(process.pid)',
    "console.log('RECEIPT ' + JSON.stringify(receipt))",
  ].join('\n'),
)

const run = spawnSync(process.execPath, [child], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
const receipt = run.stdout.split(/\r?\n/).find(line => line.startsWith('RECEIPT '))
check('a process that asks to end its own tree is still alive to answer', run.status === 0, `exit ${run.status}`)
check('its receipt names nothing ended', receipt === 'RECEIPT {"ended":0,"survivors":[]}', receipt ?? (run.stderr || '').trim().split('\n').slice(-1)[0])

try {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
} catch {
}
console.log(failures === 0 ? '\nALL TREE SELF-GUARD CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
