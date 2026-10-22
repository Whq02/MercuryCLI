#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { visit } from './sourceCensus.ts'

const ROOT = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'capture-directory-law-'))
try {
  const roots: string[] = []
  for (const file of ['scripts/prompts-panel/prove-panel-captures.ts', 'scripts/prompts-panel/prove-hop-follows-focus.ts']) {
    const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true)
    let initializer: ts.Expression | undefined
    visit(source, node => { if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'CAPTURE_DIR') initializer = node.initializer })
    assert.ok(initializer, `${file} declares its capture directory`)
    const select = new Function('process', 'join', 'tmpdir', 'mkdtempSync', `return (${initializer.getText(source)})`) as (process: { env: Record<string, string> }, join: typeof import('node:path').join, tmpdir: () => string, mkdtempSync: typeof import('node:fs').mkdtempSync) => string
    const first = select({ env: {} }, join, () => scratch, mkdtempSync)
    const second = select({ env: {} }, join, () => scratch, mkdtempSync)
    assert.notEqual(first, second, `${file}: concurrent copies must not share the capture configuration or result path`)
    for (const dir of [first, second]) {
      assert.ok(dir.startsWith(scratch + '/'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'same-tag.grid.json'), JSON.stringify({ dir }))
      roots.push(dir)
    }
    assert.equal(readFileSync(join(first, 'same-tag.grid.json'), 'utf8'), JSON.stringify({ dir: first }))
    const pinned = join(scratch, 'requested-output')
    assert.equal(select({ env: { PROMPTS_PANEL_CAPTURE_DIR: pinned } }, join, () => scratch, mkdtempSync), pinned, 'an explicit output-directory request still wins')
  }
  assert.equal(new Set(roots).size, roots.length, 'different panel proofs also have distinct capture roots')
  console.log('PASS each concurrent panel proof owns its default capture root; result names cannot overwrite another capture; explicit output pins remain exact')
} finally { rmSync(scratch, { recursive: true, force: true }) }
