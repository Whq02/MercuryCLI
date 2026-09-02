// prove-unavailable-honesty — a real command is never "Unknown skill"
// (gate member; needs dist — the gate prebuilds it).
//
// The command estate's honesty law at the dispatch seam: when a seat's
// roster cannot serve a name, the answer depends on what the name IS —
//
//   · a REGISTERED command the seat cannot serve → its typed reason
//     (mode, sign-in, or enablement), stated as the result text;
//   · a name registered NOWHERE → the unknown-skill line, unchanged.
//
// Driven against the BUILT artifact headless (-p), where the roster is the
// narrowest (no local-jsx, locals only with supportsNonInteractive) and the
// lie class was live: `-p "/critter"` answered "Unknown skill: critter".
//
// Controls ride along: a servable local command (/context, the pair's -p
// twin) still serves, and a truly unknown name still says unknown — the
// honest arm must never widen into serving or hiding either neighbour.

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const repo = path.resolve(import.meta.dir, '../..')
const dist = path.join(repo, 'dist/mercury.mjs')

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('prove-unavailable-honesty — a real command is never an unknown skill')

if (!existsSync(dist)) {
  console.error('prove-unavailable-honesty: dist/mercury.mjs missing — run the build first (the gate prebuilds it)')
  process.exit(1)
}

const RUN_HOME = mkdtempSync(path.join(tmpdir(), 'mercury-verity-honesty-'))
const PROBE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-verity-shape-probe'
writeFileSync(
  path.join(RUN_HOME, '.mercury.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    projects: { [repo]: { hasTrustDialogAccepted: true } },
    customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
  }),
)

function drive(prompt: string): { result: string; ok: boolean; refused: boolean; raw: string } {
  const res = spawnSync('node', [dist, '-p', prompt, '--output-format', 'json'], {
    encoding: 'utf-8',
    // The headless product boot rides the hosted profile too — the 2-core
    // runner needs the same authored wall at 1/scale speed (run 2's
    // "-p /critter exits cleanly" red carried no other tell).
    timeout: vshotBudgetMs(60000),
    cwd: repo,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: RUN_HOME,
      NODE_ENV: 'test',
      ANTHROPIC_API_KEY: PROBE_KEY,
    },
  })
  const raw = res.stdout ?? ''
  try {
    const envelope = JSON.parse(raw.slice(raw.indexOf('{'))) as { result?: string; is_error?: boolean }
    return { result: envelope.result ?? '', ok: res.status === 0, refused: res.status === 1 && envelope.is_error === true, raw }
  } catch {
    return { result: '', ok: false, refused: false, raw: `${raw}\n${res.stderr ?? ''}` }
  }
}

// ── the healed lie: a screen surface answers its typed reason ──────────────
{
  const { result, refused } = drive('/critter')
  // Re-trued to the commandRefused envelope law (processUserInput.ts): the
  // asked command did NOT run, and the headless road answers a TYPED REFUSAL
  // as an error envelope — is_error true, exit 1 — so a script can tell
  // "the model answered" from "the command was refused". "Exits cleanly"
  // predated that law; a clean exit here would now be the lie.
  check('-p /critter answers the refusal envelope (exit 1, is_error — the command did not run)', refused)
  check(
    '/critter (local-jsx) answers the interactive-surface reason',
    result.includes('/critter command is an interactive surface'),
    result.slice(0, 160),
  )
  check('/critter is NOT called an unknown skill', !result.includes('Unknown skill'), result.slice(0, 160))
}

// ── an interactive-only local answers its typed reason ─────────────────────
{
  // /concourse: type local without supportsNonInteractive — headless cannot
  // serve it and must say so.
  const { result } = drive('/concourse')
  check(
    '/concourse (interactive-only local) answers the foreground reason',
    result.includes('/concourse command is an interactive surface') ||
      result.includes('/concourse command is interactive-only'),
    result.slice(0, 160),
  )
  check('/concourse is NOT called an unknown skill', !result.includes('Unknown skill'), result.slice(0, 160))
}

// ── control: the pair's -p twin still serves ───────────────────────────────
{
  const { result } = drive('/context')
  check(
    'control: /context serves its headless breakdown (the pair twin still answers)',
    result.length > 0 && !result.includes('Unknown skill') && !result.includes('is an interactive surface'),
    result.slice(0, 160),
  )
}

// ── control: a truly unknown name keeps the unknown-skill line ─────────────
{
  const { result } = drive('/zz-not-a-command-zz')
  check(
    'control: an unregistered name still answers the unknown-skill line',
    result.startsWith('Unknown skill: zz-not-a-command-zz'),
    result.slice(0, 160),
  )
}

rmSync(RUN_HOME, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nprove-unavailable-honesty: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-unavailable-honesty: green')
process.exit(0)
