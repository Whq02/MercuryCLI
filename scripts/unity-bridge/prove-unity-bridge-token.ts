#!/usr/bin/env bun
// ============================================================================
//  scripts/unity-bridge/prove-unity-bridge-token.ts
//  PROOF: the bridge token file — the Library/ home (the EditorInstance.json
//  precedent), 64-hex grammar, 0600 mode, per-project stability,
//  malformed-file regeneration, the read-only probe's honesty, and the env
//  override winning without touching disk. Scratch trees only.
// ============================================================================

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

delete process.env.MERCURY_UNITY_BRIDGE_TOKEN
const { ensureUnityBridgeToken, readUnityBridgeToken, unityBridgeTokenPath } = await import('../../src/services/unity/bridgeToken.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'unity-bridge-token-'))
const proj = path.join(scratch, 'game')
mkdirSync(path.join(proj, 'Assets'), { recursive: true })
mkdirSync(path.join(proj, 'ProjectSettings'), { recursive: true })

section('1. creation — Library/ home, 64-hex, 0600')
{
  const file = unityBridgeTokenPath(proj)
  check('path is <project>/Library/mercury-unity-bridge-token', file === path.join(proj, 'Library', 'mercury-unity-bridge-token'))
  check('read-only probe answers undefined before creation', readUnityBridgeToken(proj) === undefined)
  check('the probe created nothing', !existsSync(file))
  const token = ensureUnityBridgeToken(proj)
  check('64-hex token minted', /^[0-9a-f]{64}$/.test(token))
  check('file exists under Library/', existsSync(file))
  if (process.platform !== 'win32') {
    check('mode 0600 pinned', (statSync(file).mode & 0o777) === 0o600, (statSync(file).mode & 0o777).toString(8))
  }
}

section('2. stability + regeneration')
{
  const again = ensureUnityBridgeToken(proj)
  const first = readUnityBridgeToken(proj)
  check('stable per project (concurrent sessions agree)', again === first && typeof first === 'string')
  writeFileSync(unityBridgeTokenPath(proj), 'HAND-EDITED-GARBAGE\n')
  check('the probe refuses a malformed file', readUnityBridgeToken(proj) === undefined)
  const regenerated = ensureUnityBridgeToken(proj)
  check('ensure regenerates over garbage instead of trusting it', /^[0-9a-f]{64}$/.test(regenerated) && regenerated !== 'HAND-EDITED-GARBAGE')
  check('the regenerated token persists', readUnityBridgeToken(proj) === regenerated)
}

section('3. the env override — wins, never written')
{
  const onDisk = readUnityBridgeToken(proj)
  process.env.MERCURY_UNITY_BRIDGE_TOKEN = 'override-tok'
  check('override wins for ensure', ensureUnityBridgeToken(proj) === 'override-tok')
  check('override wins for the probe', readUnityBridgeToken(proj) === 'override-tok')
  delete process.env.MERCURY_UNITY_BRIDGE_TOKEN
  check('disk untouched by the override', readUnityBridgeToken(proj) === onDisk)
  check('the file still carries the disk token, not the override', !readFileSync(unityBridgeTokenPath(proj), 'utf8').includes('override-tok'))
}

console.log('\n' + (failures === 0 ? '✅ unity-bridge token proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
