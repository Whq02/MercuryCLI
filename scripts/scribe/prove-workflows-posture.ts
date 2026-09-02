#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-workflows-posture.ts
//  PROOF: the workflow-capable Implementer wiring (the /model "Scribe +
//  workflows" row, MERCURY_SCRIBE_WORKFLOWS).
//
//  The chain under proof:
//    picker → setImplementerWorkflowsPosture(true) → buildScribeDaemonExtraEnv
//    stamps MERCURY_DAEMON_SCRIBE_WORKFLOWS=1 onto the auto-started daemon →
//    daemon main.ts stamps the Implementer child SPEC with
//    MERCURY_IMPLEMENTER_WORKFLOWS=1 (spec-carried; respawns keep it) →
//    buildStreamJsonInvocation overlays spec.extraEnv into the child env
//    (NEVER overriding the floored model / effort pin / swarm / role hygiene) →
//    implementerMode compiles the workflow-capable pack VARIANT (base pack +
//    ONE tool-policy section) — posture OFF ⇒ byte-identical base append.
//
//  Checks are DIFFERENTIAL (on-vs-off in one run) so a vacuous pass is
//  impossible: the off branch must equal the independently-computed base
//  compile, the on branch must differ in exactly the expected way.
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-workflows-posture.ts
// ============================================================================

import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Env prep BEFORE any dynamic import: stamped-build sim, the Implementer role, a config
// sandbox (route-pref reads), and a clean posture/seat slate.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const TMP = mkdtempSync(join(tmpdir(), 'hermes-workflows-posture-'))
process.env.MERCURY_CONFIG_DIR = TMP
process.env.MERCURY_IMPLEMENTER = '1'
delete process.env.MERCURY_SCRIBE
delete process.env.MERCURY_IMPLEMENTER_WORKFLOWS
delete process.env.MERCURY_IMPLEMENTER_MODEL
delete process.env.MERCURY_IMPLEMENTER_EFFORT

const { setImplementerWorkflowsPosture, getImplementerWorkflowsPosture } = await import(
  '../../src/utils/scribe/workflowsPosture.js'
)
const { buildScribeDaemonExtraEnv } = await import('../../src/utils/scribe/ensureScribeDaemon.js')
const { buildImplementerAppend } = await import('../../src/utils/scribe/implementerPack.js')
const { getImplementerModeSections } = await import('../../src/utils/implementerMode.js')
const { resolveImplementerSeat, seatDoctrineTier } = await import('../../src/utils/model/seatSlots.js')
const { buildStreamJsonInvocation } = await import('../../src/daemon/headlessRun.js')
const { isScribeWorkflowsDaemon } = await import('../../src/daemon/daemonFeatureGates.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

console.log('============================================================')
console.log(' workflow-capable Implementer posture — proof')
console.log('============================================================')

// ───────────────────────────────────────────────────────────────────────────
section('posture store + daemon extra-env stamping')
{
  check('posture starts un-armed', getImplementerWorkflowsPosture() === false)
  const offEnv = buildScribeDaemonExtraEnv()
  check('off: MERCURY_DAEMON_SCRIBE_WORKFLOWS absent', offEnv.MERCURY_DAEMON_SCRIBE_WORKFLOWS === undefined)
  check('off: the scribe-engage marker still stamps', offEnv.MERCURY_DAEMON_SCRIBE_ENGAGE === '1')

  setImplementerWorkflowsPosture(true)
  check('arm round-trips', getImplementerWorkflowsPosture() === true)
  const onEnv = buildScribeDaemonExtraEnv()
  check("armed: MERCURY_DAEMON_SCRIBE_WORKFLOWS stamps '1'", onEnv.MERCURY_DAEMON_SCRIBE_WORKFLOWS === '1')
  setImplementerWorkflowsPosture(false)
  check('disarm round-trips', getImplementerWorkflowsPosture() === false)

  delete process.env.MERCURY_DAEMON_SCRIBE_WORKFLOWS
  check('daemon gate: unset ⇒ not a workflows daemon', isScribeWorkflowsDaemon() === false)
  process.env.MERCURY_DAEMON_SCRIBE_WORKFLOWS = '1'
  check("daemon gate: '1' ⇒ workflows daemon (live re-read)", isScribeWorkflowsDaemon() === true)
  delete process.env.MERCURY_DAEMON_SCRIBE_WORKFLOWS
}

// ───────────────────────────────────────────────────────────────────────────
section('pack variant — pure derivation, base posture unchanged')
{
  const base = buildImplementerAppend({ workflows: false, lspEvidence: null, routed: false, executorSlot: false })
  const variant = buildImplementerAppend({ workflows: true, lspEvidence: null, routed: false, executorSlot: false })
  buildImplementerAppend({ workflows: true, lspEvidence: null, routed: false, executorSlot: false }) // second call — mutation would compound
  const baseAgain = buildImplementerAppend({ workflows: false, lspEvidence: null, routed: false, executorSlot: false })
  check('base posture unmutated across builds (no compounding splice)', base === baseAgain && !base.includes('workflow-capable'))
  const blocks = (a: string): string[] => a.split('\n\n')
  check('variant adds exactly one block', blocks(variant).length === blocks(base).length + 1)
  const busIdx = blocks(variant).findIndex(b => b.includes('Your ONLY channel to the Scribe'))
  const wfIdx = blocks(variant).findIndex(b => b.includes('workflow-capable'))
  check('workflows block rides immediately after the bus block', busIdx !== -1 && wfIdx === busIdx + 1)

  const wfText = blocks(variant)[wfIdx] ?? ''
  check('doctrine: explicit non-Haiku model rule on agent() calls', /non-Haiku `model:`/.test(wfText))
  check('doctrine: dispatch = relayed opt-in, ambiguity escalates (never re-asks a human)', /relayed\s+by proxy/.test(wfText) && /`escalate`/.test(wfText))
  check('doctrine: fail-closed permission asks named', /FAIL-CLOSES/.test(wfText))
  check('doctrine: never weakens the gate floor', /never as license to bypass a gate/.test(wfText))
}

// ───────────────────────────────────────────────────────────────────────────
section('implementerMode — posture selects the variant; OFF ⇒ byte-identical base')
{
  delete process.env.MERCURY_IMPLEMENTER_WORKFLOWS
  const base = getImplementerModeSections()
  check('role on, posture off: one section', base.length === 1)

  // The bridge must feed the builder the LIVE posture inputs — compare its
  // output to a direct builder call over independently-read inputs. Since the
  // IDE-hands bridge, the live path splices the ide-evidence
  // section at consumption when MERCURY_LSP is on; MERCURY_LSP=0 pins the
  // splice's OFF contract.
  const { getLspPackEvidenceText } = await import('../../src/services/lsp/mercuryLsp.js')
  const { routerEnabled } = await import('../../src/utils/router/routerGates.js')
  const deriveExpected = (workflows: boolean): string =>
    buildImplementerAppend({
      workflows,
      lspEvidence: getLspPackEvidenceText(),
      routed: routerEnabled(),
      executorSlot: seatDoctrineTier(resolveImplementerSeat().model) === 'executor',
    }).trim()
  check('posture off ⇒ the bridge passes the live inputs (byte-identical to the direct build)', base[0] === deriveExpected(false))
  check('posture off ⇒ no workflow-capable marker', !(base[0] ?? '').includes('workflow-capable'))

  // MERCURY_LSP=0 ⇒ no ide-evidence splice (the flag's OFF contract).
  const savedLsp = process.env.MERCURY_LSP
  process.env.MERCURY_LSP = '0'
  const baseNoLsp = getImplementerModeSections()
  const noLspExpected = buildImplementerAppend({
    workflows: false,
    lspEvidence: null,
    routed: routerEnabled(),
    executorSlot: seatDoctrineTier(resolveImplementerSeat().model) === 'executor',
  }).trim()
  check('MERCURY_LSP=0 ⇒ byte-identical to the spliceless build', baseNoLsp[0] === noLspExpected)
  check('MERCURY_LSP=0 ⇒ no ide-evidence text in the append', !(baseNoLsp[0] ?? '').includes('IDE evidence'))
  if (savedLsp === undefined) delete process.env.MERCURY_LSP
  else process.env.MERCURY_LSP = savedLsp

  process.env.MERCURY_IMPLEMENTER_WORKFLOWS = '1'
  const armed = getImplementerModeSections()
  check('posture on: still exactly one section (variant, not an extra splice)', armed.length === 1)
  check('posture on: the workflows doctrine is IN the compiled append', (armed[0] ?? '').includes('workflow-capable') && (armed[0] ?? '').includes('non-Haiku `model:`'))
  check('posture on ≠ posture off (differential)', armed[0] !== base[0])

  delete process.env.MERCURY_IMPLEMENTER_WORKFLOWS
  const back = getImplementerModeSections()
  check('posture cleared ⇒ base again (cache re-keys both directions)', back[0] === base[0])
}

// ───────────────────────────────────────────────────────────────────────────
section('buildStreamJsonInvocation — extraEnv lands; load-bearing stamps always win')
{
  const spec = {
    model: 'claude-opus-4-8[1m]',
    effort: 'max',
    appendSystemPrompt: '',
    role: 'MERCURY_IMPLEMENTER' as const,
    agentName: 'implementer',
    agentId: 'implementer@scribe',
    teamName: 'scribe',
  }
  const plain = buildStreamJsonInvocation(spec)
  check('no extraEnv ⇒ no posture key in the child env', plain.env.MERCURY_IMPLEMENTER_WORKFLOWS === undefined)

  const posture = buildStreamJsonInvocation({ ...spec, extraEnv: { MERCURY_IMPLEMENTER_WORKFLOWS: '1' } })
  check("extraEnv posture lands in the child env", posture.env.MERCURY_IMPLEMENTER_WORKFLOWS === '1')
  check('role stamped exactly once', posture.env.MERCURY_IMPLEMENTER === '1' && posture.env.MERCURY_SCRIBE === undefined)

  // Adversarial: extraEnv must NOT be able to override the floored model, the
  // effort pin, swarm enablement, or smuggle a second role var.
  const hostile = buildStreamJsonInvocation({
    ...spec,
    extraEnv: {
      ANTHROPIC_MODEL: 'claude-haiku-4-5-20251001',
      MERCURY_EFFORT_LEVEL: 'low',
      MERCURY_SWARMS: '0',
      MERCURY_SCRIBE: '1',
      MERCURY_IMPLEMENTER_WORKFLOWS: '1',
    },
  })
  check('hostile extraEnv cannot override the model (floor stamp wins)', hostile.env.ANTHROPIC_MODEL === 'claude-opus-4-8[1m]')
  // The effort pin rides the CANONICAL spelling, stamped AFTER the extraEnv
  // overlay; a hostile retired-spelling value sits one rung below and can
  // never outrank it (the registry's canonical-wins-live law). The
  // parent→child effort wire is MERCURY_EFFORT_LEVEL.
  check('hostile extraEnv cannot downgrade the effort pin (canonical stamp wins)', hostile.env.MERCURY_EFFORT_LEVEL === 'max')
  check('hostile extraEnv cannot disable swarms', hostile.env.MERCURY_SWARMS === '1')
  check('hostile extraEnv cannot smuggle a second role (sanitize wins)', hostile.env.MERCURY_SCRIBE === undefined && hostile.env.MERCURY_IMPLEMENTER === '1')
  check('benign key still lands from the hostile blob', hostile.env.MERCURY_IMPLEMENTER_WORKFLOWS === '1')
}

// ───────────────────────────────────────────────────────────────────────────
section('structural wiring — the seams a pure call cannot reach')
{
  const root = join(import.meta.dir, '..', '..')
  const g = (pattern: string, file: string): string => {
    try {
      return execSync(`grep -n ${JSON.stringify(pattern)} ${JSON.stringify(file)}`, { encoding: 'utf8', cwd: root })
    } catch {
      return ''
    }
  }
  const mainStamp = g('isScribeWorkflowsDaemon()', 'src/daemon/main.ts')
  const mainKey = g("flagPair('MERCURY_IMPLEMENTER_WORKFLOWS', '1')", 'src/daemon/main.ts')
  check('daemon main stamps the child SPEC off the workflows-daemon gate', mainStamp.length > 0 && mainKey.length > 0)

  const sel = g('setImplementerWorkflowsPosture', 'src/utils/scribe/scribeRouterSelect.ts')
  const selLines = sel.split('\n').filter(Boolean)
  check('router-select arms the posture (workflows branch) AND clears it on exit', selLines.some(l => l.includes('(true)')) && selLines.some(l => l.includes('(false)')))
  // Ordering: the arm must precede the engage call so ensureScribeDaemon sees it.
  const armLine = Number(selLines.find(l => l.includes('(true)'))?.split(':')[0] ?? 0)
  const engageLine = Number(g('engageRouterSession(null)', 'src/utils/scribe/scribeRouterSelect.ts').split(':')[0] ?? 0)
  check('posture arms BEFORE the workflows engage', armLine > 0 && engageLine > 0 && armLine < engageLine)

  const spawn = g('buildScribeDaemonExtraEnv()', 'src/utils/scribe/ensureScribeDaemon.ts')
  check('spawnScribeDaemon spawns through the pure extra-env builder', spawn.length > 0)
}

console.log('\n' + '═'.repeat(60))
rmSync(TMP, { recursive: true, force: true })
if (failures > 0) {
  console.log(`❌ ${failures} WORKFLOWS-POSTURE CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL WORKFLOWS-POSTURE PROOFS PASS')
