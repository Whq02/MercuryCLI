#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'readings-preflight-'))
try {
  const script = join(root, 'scripts/gate/check-bundle-ready.mjs')
  const run = (value: unknown, raw = false) => {
    const path = join(scratch, 'manifest.json')
    writeFileSync(path, raw ? String(value) : JSON.stringify(value))
    return spawnSync('node', [script, path], { encoding: 'utf8' })
  }
  const missing = spawnSync('node', [script, join(scratch, 'missing.json')], { encoding: 'utf8' })
  assert.equal(missing.status, 78, missing.stderr)
  assert.match(missing.stderr, /REFUSED readings: cannot read bundle manifest/)
  for (const value of ['{', null, {}, { degraded: null }, { degraded: [''] }, { degraded: [1] }]) {
    const r = run(value, value === '{')
    assert.equal(r.status, 78, r.stderr)
    assert.match(r.stderr, /REFUSED readings:/)
  }
  const absent = run({ degraded: ['python-debugger', 'structure-polyglot-extended'] })
  assert.equal(absent.status, 78, absent.stderr)
  assert.match(absent.stderr, /python-debugger, structure-polyglot-extended/)
  assert.match(absent.stderr, /rebuild/)
  assert.equal(absent.stdout, '')
  const complete = run({ degraded: [] })
  assert.equal(complete.status, 0, complete.stderr)
  assert.match(complete.stdout, /degraded: \[\]/)
  const linuxPool = run({ degraded: ['voice-input', 'on-device-transcriber', 'semantic-embedder', 'desktop-driver'], desktopDriver: { vendored: false }, semanticEmbedder: { vendored: false } })
  assert.equal(linuxPool.status, 0, linuxPool.stderr)
  assert.match(linuxPool.stdout, /degraded only by the built packs this runner cannot carry: voice-input, on-device-transcriber, semantic-embedder, desktop-driver/)
  const builtButMissing = run({ degraded: ['desktop-driver'], desktopDriver: { vendored: true } })
  assert.equal(builtButMissing.status, 78, builtButMissing.stderr)
  assert.match(builtButMissing.stderr, /bundle is degraded: desktop-driver;/)
  const mixed = run({ degraded: ['voice-input', 'js-debugger'], desktopDriver: { vendored: false } })
  assert.equal(mixed.status, 78, mixed.stderr)
  assert.match(mixed.stderr, /bundle is degraded: js-debugger;/)
  assert.doesNotMatch(mixed.stderr, /voice-input/)
  const doubled = run({ degraded: ['voice-input', 'voice-input'] })
  assert.equal(doubled.status, 78, doubled.stderr)
  assert.match(doubled.stderr, /lists a degraded pack twice/)
  console.log('PASS readings refuse missing, unreadable, malformed and degraded manifests; the empty list proceeds, and so does a list of only the built packs the manifest itself says this runner lacks')
} finally { rmSync(scratch, { recursive: true, force: true }) }
