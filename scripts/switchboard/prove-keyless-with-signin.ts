#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-keyless-with-signin.ts — a home whose only
//  sign-in offers no usable row yet is born keyless, and the receipt names
//  THAT family and its gate — never the placeholder's.
//
//  The class (family grammar / the neutral default): a Gemini-only home under
//  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC — Gemini's catalogue is live-only and
//  the posture keeps it dark, so the computed default has no usable row and
//  goes keyless. The unnamed session launch then fell through to the
//  placeholder's own refusal, "model refused (no-credential:anthropic)": a
//  family nobody chose, on a home signed into another. Now the launch is
//  admitted keyless (the chat starts; /model names a row by id) and the note
//  names each sign-in's gate (Gemini, the switch) and the doors.
//
//   §1  the computed default: keyless, the no-usable-row word, the why
//       names the family, the switch and the typed-id door.
//   §2  the admission: an unnamed SESSION launch admits keyless with the
//       row word and the note; the note never names the placeholder's family.
//   §3  the note's road, by source: the daemon's reply carries it on the
//       same seam the retained-model receipt rides; the door mints it.
//
//  Hermetic: a scratch home, the file-backed credential store, every
//  credential key scrubbed, a fixture Gemini key, the traffic switch on —
//  no request leaves the box (the gate refuses before any socket).
//  Run:  ~/.bun/bin/bun run scripts/switchboard/prove-keyless-with-signin.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'keyless-signin-'))
const CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_OAUTH_TOKEN', 'MERCURY_GEMINI_OAUTH_TOKEN',
  'MOONSHOT_API_KEY', 'MOONSHOT_TOKEN', 'HF_TOKEN', 'HF_OAUTH_TOKEN', 'MERCURY_COMPAT_API_KEY', 'MERCURY_COMPAT_BASE_URL',
] as const
for (const key of CREDENTIAL_KEYS) delete process.env[key]
for (const ambient of ['ANTHROPIC_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_WORKFLOW_ROUTING']) delete process.env[ambient]
delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_EVOLUTION_LEDGER = '0'
mkdirSync(join(scratch, 'home'), { recursive: true })
mkdirSync(join(scratch, 'daemon'), { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
// The Gemini-only home under the privacy posture.
process.env.GEMINI_API_KEY = 'fixture-gemini-key-000'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail && !ok ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const computed = await import('../../src/utils/model/computedDefault.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')
recordSignIn('gemini', 'api-key')
computed.resetComputedDefaultMemo()

console.log('§1 the computed default on a Gemini-only home under the switch')
const decision = computed.computedDefault()
check('the default is keyless (no usable row)', decision.source === 'keyless' && decision.provider === null, `${decision.source} ${decision.provider}`)
check('the row word is the no-usable-row word (a sign-in exists)', decision.row === computed.NO_USABLE_ROW && decision.considered.length > 0, decision.row)
check('the why names Gemini', /Gemini/.test(decision.why), decision.why)
check('the why names the switch', /catalogue traffic is off \(MERCURY_DISABLE_NONESSENTIAL_TRAFFIC\)/.test(decision.why), decision.why)
check('the why names the typed-id door and the logins door', decision.why.includes('/model names a row by id') && decision.why.includes('/logins signs another provider in'), decision.why)
check('the why never names the placeholder\'s family', !/anthropic/i.test(decision.why), decision.why)

console.log('§2 the admission: an unnamed session launch admits keyless with the note')
const wm = await import('../../src/services/concourse/workerModels.ts')
const admit = await wm.validateWorkerModelChoice(undefined, 'session')
check('an unnamed session launch is admitted', admit.ok === true, JSON.stringify(admit))
if (admit.ok) {
  check('…keyless, wearing the no-usable-row word', admit.keyless === true && admit.entry.displayName === computed.NO_USABLE_ROW, `${admit.keyless} ${admit.entry.displayName}`)
  check('…with a note naming Gemini and the switch', admit.note !== undefined && /Gemini/.test(admit.note) && /MERCURY_DISABLE_NONESSENTIAL_TRAFFIC/.test(admit.note), admit.note ?? '')
  check('…and the note never says no-credential:anthropic', admit.note !== undefined && !admit.note.includes('no-credential'), admit.note ?? '')
}

console.log('§3 the note\'s road, by source')
{
  const wmSrc = read('src/services/concourse/workerModels.ts')
  check('the keyless arm reads the computed default (keyless with sign-ins present), session arm, unnamed only', wmSrc.includes("if (decision.source === 'keyless' && decision.considered.length > 0) {") && wmSrc.includes("return { ok: true, entry: { ...entry, displayName: NO_USABLE_ROW }, keyless: true, note: `${NO_USABLE_ROW} — ${keylessReason(decision)}` }"))
  const sup = read('src/daemon/concourseSupervisor.ts')
  check("the daemon's admit reply carries the keyless note on the retained-model seam", sup.includes('if (keyless && admission.note !== undefined && retainedNote === undefined) retainedNote = admission.note'))
  const needle = "if (typeof reply.note === 'string' && reply.note !== '') mintImmediateReceipt(`▲ ${reply.note}`, 'warning')"
  check('the birth door mints the reply\'s note as a warning receipt', read('src/services/switchboard/bornSession.ts').includes(needle))
  check('the resume door mints it the same way (one seam)', read('src/services/switchboard/hopIntoSession.ts').includes(needle))
}

rmSync(scratch, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\n ❌ keyless-with-signin — ${failures} failure(s)`)
  process.exit(1)
}
console.log('\n ✅ keyless-with-signin — a Gemini-only home under the switch is born keyless with a receipt naming Gemini and the switch, never the placeholder\'s family')
