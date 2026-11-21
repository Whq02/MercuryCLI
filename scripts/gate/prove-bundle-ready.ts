#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { copyDistChunks } from '../lib/copyDistChunks.ts'

const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'readings-preflight-'))
const BR_FIX = 'fix scripts/gate/check-bundle-ready.mjs'
try {
  const script = join(root, 'scripts/gate/check-bundle-ready.mjs')
  const run = (value: unknown, raw = false) => {
    const path = join(scratch, 'manifest.json')
    writeFileSync(path, raw ? String(value) : JSON.stringify(value))
    return spawnSync('node', [script, path], { encoding: 'utf8' })
  }
  const missing = spawnSync('node', [script, join(scratch, 'missing.json')], { encoding: 'utf8' })
  assert.equal(missing.status, 78, `${missing.stderr} | ${BR_FIX} so a manifest path that cannot be read exits 78`)
  assert.match(missing.stderr, /REFUSED readings: cannot read bundle manifest/, `${missing.stderr} | ${BR_FIX} so an unreadable manifest prints REFUSED readings: cannot read bundle manifest`)
  for (const value of ['{', null, {}, { degraded: null }, { degraded: [''] }, { degraded: [1] }]) {
    const r = run(value, value === '{')
    assert.equal(r.status, 78, `${r.stderr} | ${BR_FIX} so a malformed manifest (not JSON, null, no degraded list, or a degraded entry that is not a non-empty string) exits 78`)
    assert.match(r.stderr, /REFUSED readings:/, `${r.stderr} | ${BR_FIX} so a malformed manifest prints REFUSED readings:`)
  }
  const absent = run({ degraded: ['python-debugger', 'structure-polyglot-extended'] })
  assert.equal(absent.status, 78, `${absent.stderr} | ${BR_FIX} so a manifest that lists degraded packs exits 78`)
  assert.match(absent.stderr, /python-debugger, structure-polyglot-extended/, `${absent.stderr} | ${BR_FIX} so the refusal names every degraded pack, comma separated`)
  assert.match(absent.stderr, /rebuild/, `${absent.stderr} | ${BR_FIX} so the refusal tells the reader to rebuild`)
  assert.equal(absent.stdout, '', `${BR_FIX} so a refused manifest prints nothing on stdout`)
  const complete = run({ degraded: [] })
  assert.equal(complete.status, 0, `${complete.stderr} | ${BR_FIX} so a manifest with an empty degraded list exits 0`)
  assert.match(complete.stdout, /degraded: \[\]/, `${complete.stdout} | ${BR_FIX} so a complete bundle prints degraded: []`)
  const linuxPool = run({ degraded: ['voice-input', 'on-device-transcriber', 'semantic-embedder', 'desktop-driver'], desktopDriver: { vendored: false }, semanticEmbedder: { vendored: false } })
  assert.equal(linuxPool.status, 0, `${linuxPool.stderr} | ${BR_FIX} so a list of only the built packs this runner cannot carry exits 0`)
  assert.match(linuxPool.stdout, /degraded only by the built packs this runner cannot carry: voice-input, on-device-transcriber, semantic-embedder, desktop-driver/, `${linuxPool.stdout} | ${BR_FIX} so it prints which built packs this runner cannot carry`)
  const builtButMissing = run({ degraded: ['desktop-driver'], desktopDriver: { vendored: true } })
  assert.equal(builtButMissing.status, 78, `${builtButMissing.stderr} | ${BR_FIX} so a pack the manifest says is vendored but lists as degraded exits 78`)
  assert.match(builtButMissing.stderr, /bundle is degraded: desktop-driver;/, `${builtButMissing.stderr} | ${BR_FIX} so the refusal names the vendored pack that is degraded`)
  const mixed = run({ degraded: ['voice-input', 'js-debugger'], desktopDriver: { vendored: false } })
  assert.equal(mixed.status, 78, `${mixed.stderr} | ${BR_FIX} so a list that mixes an excused pack with a real degraded pack exits 78`)
  assert.match(mixed.stderr, /bundle is degraded: js-debugger;/, `${mixed.stderr} | ${BR_FIX} so the refusal names the real degraded pack`)
  assert.doesNotMatch(mixed.stderr, /voice-input/, `${mixed.stderr} | ${BR_FIX} so the refusal leaves out the pack this runner is excused from`)
  const doubled = run({ degraded: ['voice-input', 'voice-input'] })
  assert.equal(doubled.status, 78, `${doubled.stderr} | ${BR_FIX} so a manifest that lists one degraded pack twice exits 78`)
  assert.match(doubled.stderr, /lists a degraded pack twice/, `${doubled.stderr} | ${BR_FIX} so the refusal says the manifest lists a degraded pack twice`)
  const source = join(scratch, 'source')
  const target = join(scratch, 'target')
  mkdirSync(source)
  mkdirSync(target)
  writeFileSync(join(source, 'mercury.mjs'), `const sibling = './new-chunk.mjs'; const example = 'import "./not-a-chunk.mjs"';`)
  writeFileSync(join(source, 'new-chunk.mjs'), 'export const value = 1')
  writeFileSync(join(source, 'manifest.json'), '{"buildTree":"source"}')
  writeFileSync(join(target, 'manifest.json'), '{"buildTree":"fixture"}')
  copyDistChunks(source, target)
  assert.equal(readFileSync(join(target, 'mercury.mjs'), 'utf8'), readFileSync(join(source, 'mercury.mjs'), 'utf8'), 'fix copyDistChunks in scripts/lib/copyDistChunks.ts so the entry mercury.mjs is copied into the target unchanged')
  assert.equal(readFileSync(join(target, 'new-chunk.mjs'), 'utf8'), 'export const value = 1', 'fix copyDistChunks in scripts/lib/copyDistChunks.ts so a sibling chunk the entry imports is copied into the target')
  assert.equal(readFileSync(join(target, 'manifest.json'), 'utf8'), '{"buildTree":"fixture"}', 'fix copyDistChunks in scripts/lib/copyDistChunks.ts so it leaves the target manifest.json as it was')
  assert.equal(existsSync(join(target, 'not-a-chunk.mjs')), false, 'fix copyDistChunks in scripts/lib/copyDistChunks.ts so a name inside a string literal is not copied as a chunk')
  rmSync(join(source, 'new-chunk.mjs'))
  assert.throws(() => copyDistChunks(source, join(scratch, 'missing-chunk')), /Fixture chunk mercury\.mjs references missing sibling \.\/new-chunk\.mjs/)
  console.log('PASS fixture copies include new chunks, preserve synthetic identities and name missing siblings')
  console.log('PASS readings refuse missing, unreadable, malformed and degraded manifests; the empty list proceeds, and so does a list of only the built packs the manifest itself says this runner lacks')
} finally { rmSync(scratch, { recursive: true, force: true }) }
