#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'workflow-run-label-'))
const ROOT = resolve(import.meta.dir, '..', '..')
const { workflowRunLabel } = await import('../../src/tools/WorkflowTool/WorkflowTool.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

check('the run\'s name is its label', workflowRunLabel({ name: 'nightly-sweep', description: 'Sweeps the nightly queue' }) === 'nightly-sweep')
check('a title stands in for a missing name', workflowRunLabel({ title: 'Nightly sweep', description: 'Sweeps' }) === 'Nightly sweep')
check('the description is the last fallback', workflowRunLabel({ description: 'Sweeps the nightly queue' }) === 'Sweeps the nightly queue')
check('a blank name is no name', workflowRunLabel({ name: '   ', description: 'd' }) === 'd')
const src = readFileSync(join(ROOT, 'src/tools/WorkflowTool/WorkflowTool.tsx'), 'utf8')
check('no notice or task row reads the description as the run\'s summary any more', !src.includes('summary: meta.description'))
check('every summary reads the one owner', (src.match(/summary: workflowRunLabel\(meta\)/g) ?? []).length >= 6, String((src.match(/summary: workflowRunLabel\(meta\)/g) ?? []).length))

rmSync(process.env.MERCURY_CONFIG_DIR, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-workflow-run-label: all green' : `\nprove-workflow-run-label: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
