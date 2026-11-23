#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

delete process.env.MERCURY_UNITY_BRIDGE_TOKEN
const { ensureUnityBridgeToken, readUnityBridgeToken, unityBridgeTokenPath } = await import('../../src/integrations/unity/bridgeToken.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'unity-bridge-token-'))
const proj = path.join(scratch, 'game')
mkdirSync(path.join(proj, 'Assets'), { recursive: true })
mkdirSync(path.join(proj, 'ProjectSettings'), { recursive: true })

section('1. creation — Library/ home, 64-hex, 0600')
{
  const file = unityBridgeTokenPath(proj)
  check('path is <project>/Library/mercury-unity-bridge-token', file === path.join(proj, 'Library', 'mercury-unity-bridge-token'), '', 'fix unityBridgeTokenPath in src/integrations/unity/bridgeToken.ts to return <project>/Library/mercury-unity-bridge-token')
  check('read-only probe answers undefined before creation', readUnityBridgeToken(proj) === undefined, '', 'readUnityBridgeToken in src/integrations/unity/bridgeToken.ts must return undefined when no token file exists')
  check('the probe created nothing', !existsSync(file), '', 'readUnityBridgeToken in src/integrations/unity/bridgeToken.ts must only read; only ensureUnityBridgeToken may create the file')
  const token = ensureUnityBridgeToken(proj)
  check('64-hex token minted', /^[0-9a-f]{64}$/.test(token), '', 'ensureUnityBridgeToken in src/integrations/unity/bridgeToken.ts must mint 32 random bytes as 64 lowercase hex characters')
  check('file exists under Library/', existsSync(file), '', 'ensureUnityBridgeToken in src/integrations/unity/bridgeToken.ts must write the token file at unityBridgeTokenPath')
  if (process.platform !== 'win32') {
    check('mode 0600 pinned', (statSync(file).mode & 0o777) === 0o600, (statSync(file).mode & 0o777).toString(8), 'ensureUnityBridgeToken in src/integrations/unity/bridgeToken.ts must write the file with mode 0o600 and chmod it to 0o600')
  }
}

section('2. stability + regeneration')
{
  const again = ensureUnityBridgeToken(proj)
  const first = readUnityBridgeToken(proj)
  check('stable per project (concurrent sessions agree)', again === first && typeof first === 'string', '', 'ensureUnityBridgeToken in src/integrations/unity/bridgeToken.ts must return the valid token already on disk instead of minting a new one')
  writeFileSync(unityBridgeTokenPath(proj), 'HAND-EDITED-GARBAGE\n')
  check('the probe refuses a malformed file', readUnityBridgeToken(proj) === undefined, '', 'readUnityBridgeTokenOutcome in src/integrations/unity/bridgeToken.ts must report absent for a file that is not 64 lowercase hex characters')
  const regenerated = ensureUnityBridgeToken(proj)
  check('ensure regenerates over garbage instead of trusting it', /^[0-9a-f]{64}$/.test(regenerated) && regenerated !== 'HAND-EDITED-GARBAGE', '', 'ensureUnityBridgeToken in src/integrations/unity/bridgeToken.ts must mint a new token when the existing file fails the 64-hex test')
  check('the regenerated token persists', readUnityBridgeToken(proj) === regenerated, '', 'ensureUnityBridgeToken in src/integrations/unity/bridgeToken.ts must write the regenerated token over the bad file')
}

section('3. the env override — wins, never written')
{
  const onDisk = readUnityBridgeToken(proj)
  process.env.MERCURY_UNITY_BRIDGE_TOKEN = 'override-tok'
  check('override wins for ensure', ensureUnityBridgeToken(proj) === 'override-tok', '', 'ensureUnityBridgeToken in src/integrations/unity/bridgeToken.ts must return unityBridgeTokenOverride() (MERCURY_UNITY_BRIDGE_TOKEN) first')
  check('override wins for the probe', readUnityBridgeToken(proj) === 'override-tok', '', 'readUnityBridgeTokenOutcome in src/integrations/unity/bridgeToken.ts must return the MERCURY_UNITY_BRIDGE_TOKEN override as present before reading the file')
  delete process.env.MERCURY_UNITY_BRIDGE_TOKEN
  check('disk untouched by the override', readUnityBridgeToken(proj) === onDisk, '', 'with the override unset, readUnityBridgeToken in src/integrations/unity/bridgeToken.ts must return the token on disk again')
  check('the file still carries the disk token, not the override', !readFileSync(unityBridgeTokenPath(proj), 'utf8').includes('override-tok'), '', 'ensureUnityBridgeToken in src/integrations/unity/bridgeToken.ts must return the override before any write so the file never holds it')
}

console.log('\n' + (failures === 0 ? '✅ unity-bridge token proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
