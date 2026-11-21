#!/usr/bin/env bun

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
  check('path is <project>/Library/mercury-unity-bridge-token', file === path.join(proj, 'Library', 'mercury-unity-bridge-token'), 'unityBridgeTokenPath in src/services/unity/bridgeToken.ts must return <project>/Library/mercury-unity-bridge-token')
  check('read-only probe answers undefined before creation', readUnityBridgeToken(proj) === undefined, 'readUnityBridgeToken in src/services/unity/bridgeToken.ts must return undefined while no token file exists')
  check('the probe created nothing', !existsSync(file), 'readUnityBridgeToken in src/services/unity/bridgeToken.ts must only read, never create the token file')
  const token = ensureUnityBridgeToken(proj)
  check('64-hex token minted', /^[0-9a-f]{64}$/.test(token), 'ensureUnityBridgeToken in src/services/unity/bridgeToken.ts must mint a 64-character lowercase hex token')
  check('file exists under Library/', existsSync(file), 'ensureUnityBridgeToken in src/services/unity/bridgeToken.ts must write the token file at unityBridgeTokenPath')
  if (process.platform !== 'win32') {
    check('mode 0600 pinned', (statSync(file).mode & 0o777) === 0o600, `${(statSync(file).mode & 0o777).toString(8)} (ensureUnityBridgeToken in src/services/unity/bridgeToken.ts must write the file with mode 0600)`)
  }
}

section('2. stability + regeneration')
{
  const again = ensureUnityBridgeToken(proj)
  const first = readUnityBridgeToken(proj)
  check('stable per project (concurrent sessions agree)', again === first && typeof first === 'string', 'ensureUnityBridgeToken in src/services/unity/bridgeToken.ts must return the token already on disk, not mint a new one')
  writeFileSync(unityBridgeTokenPath(proj), 'HAND-EDITED-GARBAGE\n')
  check('the probe refuses a malformed file', readUnityBridgeToken(proj) === undefined, 'readUnityBridgeToken in src/services/unity/bridgeToken.ts must return undefined for a file that is not a 64-hex token')
  const regenerated = ensureUnityBridgeToken(proj)
  check('ensure regenerates over garbage instead of trusting it', /^[0-9a-f]{64}$/.test(regenerated) && regenerated !== 'HAND-EDITED-GARBAGE', 'ensureUnityBridgeToken in src/services/unity/bridgeToken.ts must replace a malformed token file with a fresh 64-hex token')
  check('the regenerated token persists', readUnityBridgeToken(proj) === regenerated, 'ensureUnityBridgeToken in src/services/unity/bridgeToken.ts must write the regenerated token to disk')
}

section('3. the env override — wins, never written')
{
  const onDisk = readUnityBridgeToken(proj)
  process.env.MERCURY_UNITY_BRIDGE_TOKEN = 'override-tok'
  check('override wins for ensure', ensureUnityBridgeToken(proj) === 'override-tok', 'ensureUnityBridgeToken in src/services/unity/bridgeToken.ts must return MERCURY_UNITY_BRIDGE_TOKEN when it is set')
  check('override wins for the probe', readUnityBridgeToken(proj) === 'override-tok', 'readUnityBridgeToken in src/services/unity/bridgeToken.ts must return MERCURY_UNITY_BRIDGE_TOKEN when it is set')
  delete process.env.MERCURY_UNITY_BRIDGE_TOKEN
  check('disk untouched by the override', readUnityBridgeToken(proj) === onDisk, 'src/services/unity/bridgeToken.ts must not change the token on disk when MERCURY_UNITY_BRIDGE_TOKEN is set')
  check('the file still carries the disk token, not the override', !readFileSync(unityBridgeTokenPath(proj), 'utf8').includes('override-tok'), 'ensureUnityBridgeToken in src/services/unity/bridgeToken.ts must never write MERCURY_UNITY_BRIDGE_TOKEN into the token file')
}

console.log('\n' + (failures === 0 ? '✅ unity-bridge token proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
