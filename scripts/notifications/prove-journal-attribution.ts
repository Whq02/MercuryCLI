#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'sg7-attribution-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = join(scratch, 'home')
}
mkdirSync(join(scratch, 'home'), { recursive: true })

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${label}`)
  else {
    failures += 1
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const REPO = join(import.meta.dir, '../../')
const src = (p: string) => readFileSync(join(REPO, p), 'utf8')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

console.log('§1 — no credential material in the channel frame path')
{
  const emitters = ['src/services/channel/frame.ts']
  const offenders = emitters.filter(p => /openai-auth|ANTHROPIC_API_KEY|apiKey|access_token|client_secret/.test(src(p)))
  check('the frame emitter references NO account-connection material', offenders.length === 0, offenders.join(','))
}

console.log('§2 — attention comes from TYPED events only')
{
  const bridge = src('src/services/crew/obligationsBridge.ts')
  check('the gatherer consumes the obligations owner (typed rows)', bridge.includes("from './obligations.js'") || bridge.includes('openObligations'))
  check('…and performs NO prose inference (no message-text scanning)', !/match\(|\.includes\('\?'\)|sounds|regex/i.test(bridge))
  const obligations = src('src/services/crew/obligations.ts')
  check('the owner mints obligations from typed upserts only (no free-text parser)', !obligations.includes('parseMessage') && !obligations.includes('inferFrom'))
}

console.log('§3 — the main Chat is managed session #1 (ruling 26)')
{
  const turnMachine = src('src/run-core/turn-machine.ts')
  check("the main Chat's own turns hold counted FOREGROUND permits (the backstop)", turnMachine.includes("'foreground'") && turnMachine.includes('acquireModelPermit'))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nPROVE-JOURNAL-ATTRIBUTION: PASS' : `\nPROVE-JOURNAL-ATTRIBUTION: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
