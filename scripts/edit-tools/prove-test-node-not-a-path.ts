#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'test-node-words-home-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
const { TestTool, isPathShapedNode } = await import(join(ROOT, 'src/tools/TestTool/TestTool.ts'))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const project = mkdtempSync(join(tmpdir(), 'test-node-words-project-'))
mkdirSync(join(project, 'test'))
writeFileSync(join(project, 'test', 'score.test.js'), 'test\n')

const refused = await TestTool.validateInput({ op: 'run', node: project } as never, {} as never)
check('a directory path passed as node is refused before any runner starts', refused.result === false, JSON.stringify(refused))
const message = refused.result === false ? refused.message : ''
check('the refusal says node is a test id from discover, not a path', /node is a test id from discover \(file::name, or a bare test name\), not a path/.test(message), message)
check('the refusal offers the two roads: drop node, or pass it as path', /drop node to run the whole profile, or pass it as path/.test(message), message)
check('the refusal never says counts were not parsed', !/counts not parsed/.test(message), message)

check('an absolute path is path-shaped', isPathShapedNode('/private/tmp/project'))
check('a relative file with a source extension is path-shaped', isPathShapedNode('test/score.test.js'))
check('a dotted relative folder is path-shaped', isPathShapedNode('./test'))
check('an existing relative folder is path-shaped', isPathShapedNode('test', project) === false && isPathShapedNode('test/', project))
check('a pytest id with :: is a node', !isPathShapedNode('tests/test_x.py::test_a'))
check('a node-test id with :: is a node', !isPathShapedNode('test/score.test.js::adds'))
check('a unittest dotted id is a node', !isPathShapedNode('pkg.module.Case.test_add'))
check('a go subtest name with a slash that is not on disk is a node', !isPathShapedNode('TestScore/adds', project))
check('a bare test name is a node', !isPathShapedNode('adds two numbers'))

const debug = await TestTool.validateInput({ op: 'debug' } as never, {} as never)
check('debug without node keeps its refusal', debug.result === false && debug.message === 'debug requires node (the test id)', JSON.stringify(debug))
const ok = await TestTool.validateInput({ op: 'run', node: 'test/score.test.js::adds' } as never, {} as never)
check('a real node id passes', ok.result === true, JSON.stringify(ok))

rmSync(project, { recursive: true, force: true })
console.log(failures === 0 ? 'PASS: a path-shaped node is refused in words' : `FAIL: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
