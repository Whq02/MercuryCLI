#!/usr/bin/env bun
// ============================================================================
//  scripts/permissions/prove-auto-mode.ts
//  PROOF: the permission ladder / auto-mode classifier — wired-live for the fork
//  (permissions.ts mode==='flow' routes 'ask' through the API classifier instead
//  of prompting) and a real fork behavior change, yet it had NO regression suite.
//  `bun run typecheck` is strict (AGENTS.md); the suites + render-verify are the
//  behavioural gate.
//
//  LOADABILITY (memory/bun-run-proof-loadability): HISTORY — when this proof
//  was written, permissions.ts/classifierDecision.ts/permissionSetup.ts were
//  NOT bun-run importable (feature() macros from bun:bundle). The R1 native
//  build has no such blockers; permissions.ts LOADS live —
//  scripts/decisions/prove-decision-matrix.ts drives the real engine as a
//  live decision-table corpus. The SOURCE/DIST halves below remain valuable
//  as minification-survival pins; this proof keeps its three halves:
//
//    1. LIVE  — denialTracking.ts IS loadable (no feature() in its graph): the
//       consecutive/total limits + recordDenial/recordSuccess + the
//       shouldFallbackToPrompting threshold that decides "stop YOLO, ask the human".
//    2. SOURCE — the load-bearing constructs inside the unloadable owned files:
//       the FOUR auto-mode safety floors (ask-rule, org/MCP ask-ceiling, plan-mode,
//       Workflow-consent) that force a human 'ask' BEFORE the classifier;
//       isAutoModeAllowlistedTool's name/action gating; and the item-1 REGRESSION —
//       the mode gate honors the remote 'disabled' incident kill-switch in
//       isAutoModeGateEnabled()/getAutoModeUnavailableReason() (it was dead because
//       the fork never runs verifyAutoModeGateAccess, the only circuitBroken setter).
//    3. DIST  — those same decision branches survive minification into the shipped
//       dist/mercury.mjs, proved via durable STRING LITERALS (identifiers don't
//       survive — memory/host-harness-vs-built-binary). Skips cleanly if unbuilt.
//
//  Run:  ~/.bun/bin/bun run scripts/permissions/prove-auto-mode.ts
// ============================================================================

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const src = (...p: string[]): string =>
  readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Permission ladder / auto-mode classifier — surface proof')
console.log('============================================================')

// ── 1. LIVE: denial tracking — the YOLO "stop and ask the human" thresholds ───
section('denialTracking (LIVE) — limits + the fall-back-to-prompting threshold')
{
  const dt = await import('../../src/utils/permissions/denialTracking.js')
  const {
    DENIAL_LIMITS,
    createDenialTrackingState,
    recordDenial,
    recordSuccess,
    shouldFallbackToPrompting,
  } = dt

  check('limits are the canonical 3 consecutive / 20 total', DENIAL_LIMITS.maxConsecutive === 3 && DENIAL_LIMITS.maxTotal === 20)

  let s = createDenialTrackingState()
  check('fresh state does NOT fall back', !shouldFallbackToPrompting(s))

  // Consecutive floor: the 3rd consecutive denial trips the human-review fallback.
  s = recordDenial(recordDenial(s))
  check('2 consecutive denials: still classifying (no fallback)', !shouldFallbackToPrompting(s))
  s = recordDenial(s)
  check('3 consecutive denials: FALL BACK to prompting (consecutive floor)', shouldFallbackToPrompting(s))
  check('counters track both consecutive + total', s.consecutiveDenials === 3 && s.totalDenials === 3)

  // A success breaks the consecutive streak (but NOT the total).
  const after = recordSuccess(s)
  check('recordSuccess resets the consecutive streak', after.consecutiveDenials === 0)
  check('recordSuccess preserves the total (it is a session ceiling)', after.totalDenials === 3)
  check('after a success, no longer falling back on the consecutive floor', !shouldFallbackToPrompting(after))
  // recordSuccess is ref-stable when already zero (the persistDenialState fast-path).
  check('recordSuccess is a no-op (same ref) when consecutive is already 0', recordSuccess(after) === after)

  // Total floor: 20 cumulative denials trips the fallback even with no streak.
  let t = createDenialTrackingState()
  for (let i = 0; i < 19; i++) t = recordSuccess(recordDenial(t)) // denial then success → streak stays low, total climbs
  check('19 total denials, streak broken each time: not yet falling back', !shouldFallbackToPrompting(t) && t.totalDenials === 19)
  t = recordDenial(t)
  check('20 total denials: FALL BACK (total floor, independent of streak)', shouldFallbackToPrompting(t) && t.totalDenials === 20)
}

// ── 2. SOURCE: the unloadable owned-file invariants ───────────────────────────
// The mode-wrapper band moved to the owned decision package (core-ownership
// Phase 3): decision/wrapper.ts carries the floors; live behavior is pinned by
// scripts/decisions/prove-decision-{matrix,wrapper}.ts.
section('the FOUR auto-mode safety floors (decision/wrapper.ts) — force a human ask BEFORE the classifier')
{
  const perms = src('utils', 'permissions', 'decision', 'wrapper.ts')
  const has = (needle: string) => perms.includes(needle)
  // Floor #1: an explicit user/settings ASK rule (recurses Bash compounds).
  check('floor: ask-rule reason → reasonCarriesAskRule', has('function reasonCarriesAskRule') && has('reasonCarriesAskRule(engineDecision.decisionReason)'))
  // Floor #2: an org/MCP toolPermissions ask CEILING.
  check("floor: org/MCP ask-ceiling (effectiveMaxPermission === 'ask')", has("tool.mcpInfo?.effectiveMaxPermission === 'ask'"))
  // Floor #3: plan-mode floor.
  check('floor: plan-mode → reasonIsPlanFloor', has('function reasonIsPlanFloor') && has('reasonIsPlanFloor(engineDecision.decisionReason)'))
  // Floor #4: a dynamic Workflow needing usage consent (arbitrary on-device VM glue).
  check('floor: Workflow usage-consent → workflowRequiresConsent', has('function workflowRequiresConsent') && has('workflowRequiresConsent(tool.name)'))
  // All four converge to one guard that returns the un-classified result (ask);
  // each tripped floor is named in the trace note via floorTags.
  check(
    'the four floors converge on ONE guard before the classifier',
    has("floorTags.push('ask-rule')") &&
      has("floorTags.push('org-ceiling')") &&
      has("floorTags.push('plan-floor')") &&
      has("floorTags.push('workflow-consent')") &&
      has('if (floorTags.length > 0)'),
  )
  // The kill-switch is the FIRST thing checked (step 0), scoped to the per-call
  // agent — stage 0 of the OWNED decision engine since the Phase 3 cutover
  // (decision/engine.ts consults it through the injected ports; the live
  // behavior is pinned by scripts/decisions/prove-decision-trace.ts).
  const engine = src('utils', 'permissions', 'decision', 'engine.ts')
  check(
    'kill-switch is step 0 of the ladder (per-call agentType)',
    engine.includes('ports.isToolKilled(tool, context.agentType)'),
  )
}

section('isAutoModeAllowlistedTool name/action gating (classifierDecision.ts)')
{
  const cd = src('utils', 'permissions', 'classifierDecision.ts')
  const has = (needle: string) => cd.includes(needle)
  check('exists + gates safe-tool names on the allowlist SET', has('export function isAutoModeAllowlistedTool') && has('SAFE_YOLO_ALLOWLISTED_TOOLS.has(toolName)'))
  // The in-Chrome integration was REMOVED (operator ruling
  // and its name-based allowlist rows went with it: an external
  // MCP server squatting the mcp__claude-in-chrome__* names must NOT inherit
  // a free auto-mode pass — it goes through the classifier like any MCP tool.
  check('no chrome-name allowlist residue (removed feature cannot re-grant)', !has('CHROME_READONLY_TOOLS') && !has('claude-in-chrome') && !has('ALLOWLISTED_COMPUTER_ACTIONS'))
  // The read/search tools are on the safe set; write/edit are NOT (they go via the
  // implement fast-path, classified outside CWD) — guards against someone adding
  // an edit tool to the safe set and silently bypassing the classifier.
  check('write/edit tools are NOT on the safe set (comment + absence)', has('Does NOT include write/edit tools') && !has('FILE_WRITE_TOOL_NAME,') && !has('FILE_EDIT_TOOL_NAME,'))
}

section('item-1 (permissionSetup.ts) — fork AUTO is available-by-default; honors a REAL cached "disabled" incident')
{
  const ps = src('utils', 'permissions', 'permissionSetup.ts')
  // Auto is the fork's safer-than-bypass mode and must be in the shift+tab carousel BY DEFAULT.
  // The bug it replaced: the fork-disabled checks used getAutoModeEnabledState(), which DEFAULTS
  // to 'disabled' when no remote gate config is cached (always — no gate sink), so auto
  // was hidden by default. The fix uses getAutoModeEnabledStateIfCached() (undefined for
  // "not fetched" vs 'disabled' for "fetched-and-disabled"), so only a GENUINE incident blocks.
  // (the IfCached discipline is the load-bearing piece.)
  const cachedDisabledChecks = (ps.match(/getAutoModeEnabledStateIfCached\(\) === 'disabled'/g) || []).length
  check('both incident gates use the IfCached variant (not the default-disabled getAutoModeEnabledState)', cachedDisabledChecks === 2, `found ${cachedDisabledChecks}`)
  check('the default-disabled getAutoModeEnabledState() is NOT used in an incident check', !/getAutoModeEnabledState\(\) === 'disabled'/.test(ps))
  // The default IS 'disabled' (so the IfCached distinction is load-bearing) and IfCached returns
  // undefined when nothing is cached — proving the fork's no-GB-sink case is NOT treated as disabled.
  check("AUTO_MODE_ENABLED_DEFAULT is 'disabled' (why IfCached matters)", /AUTO_MODE_ENABLED_DEFAULT: AutoModeEnabledState = 'disabled'/.test(ps))
  check('getAutoModeEnabledStateIfCached returns undefined for the not-cached (no-GB-sink) case', /getAutoModeEnabledStateIfCached[\s\S]{0,400}return undefined/.test(ps))
  // The fork's positive default: isAutoModeGateEnabled returns true for the fork after the
  // (now incident-only) disabled check + the settings opt-out — i.e. available by default.
  check('auto is available by default (isAutoModeGateEnabled ends `return true` after the kill-switches)', /isAutoModeDisabledBySettings\(\)\) return false[\s\S]{0,700}return true\n\}/.test(ps.slice(ps.indexOf('export function isAutoModeGateEnabled'))))
  // The reason maps to 'circuit-breaker' (now IfCached-gated) so the surfaced notification matches.
  check("the incident-disabled reason maps to 'circuit-breaker'", /getAutoModeEnabledStateIfCached\(\) === 'disabled'\)[\s\S]{0,120}return 'circuit-breaker'/.test(ps))
  // The setter still exists for the verify path — we did NOT delete it.
  check('the verify-path circuitBroken setter is preserved (the verify path unaffected)', ps.includes('autoModeStateModule?.setAutoModeCircuitBroken('))
  // canCycleToAuto (the fork's sole carousel gate) routes through isAutoModeGateEnabled, and the
  // fork cycle places auto BEFORE bypass (auto is the lighter, safer station; bypass the escape hatch).
  const gnpm = src('utils', 'permissions', 'getNextPermissionMode.ts')
  check('the carousel gates auto SOLELY on canCycleToAuto (unconditional)', gnpm.includes('canCycleToAuto(toolPermissionContext)'))
  // Flow ≠ bypass: in the strategy-case branch the 'flow' station is reachable and
  // is returned BEFORE 'sovereign' (flow is the lighter/safer step; sovereign the escape hatch).
  const planBlock = gnpm.slice(gnpm.indexOf("case 'strategy':"), gnpm.indexOf("case 'flow':"))
  const autoIdx = planBlock.indexOf("return 'flow'")
  const bypassIdx = planBlock.indexOf("return 'sovereign'")
  check('the cycle reaches flow from strategy, BEFORE sovereign (flow ≠ bypass; flow is the safer step)', autoIdx > 0 && bypassIdx > 0 && autoIdx < bypassIdx && planBlock.includes('canCycleToAuto'))
}

section('STARTUP-AUTO DESYNC fix — a fork that BOOTS into auto arms the safety machinery')
{
  // The bug: the fork un-gated auto only at the TRANSITION path (transitionPermissionMode,
  // `feature('TRANSCRIPT_CLASSIFIER') || the build stamp`), reached on a runtime mode
  // change. A fork session that BOOTS with permissions.defaultMode:'flow' (or
  // --permission-mode flow) resolved mode==='flow' via the else-fallthroughs but never
  // armed: setAutoModeActive stayed false, dangerous Bash(*) allow rules were never
  // detected/stripped → blanket-allow (silent bypass, the classifier is fork-DCE-dead).
  // Fix = mirror the proven gate idiom at the FOUR startup sites (3 in
  // permissionSetup.ts + the load-bearing strip in main.tsx).
  const ps = src('utils', 'permissions', 'permissionSetup.ts')
  const mn = src('main.tsx')
  // feature('TRANSCRIPT_CLASSIFIER')
  // folded at source, so the canonical gate idiom at all four sites is now
  // the bare `(the build stamp)`. Same invariants as the original fix.
  // (the four startup sites arm UNCONDITIONALLY, the stronger posture.)

  // Site 1 — setAutoModeActive arming, co-located with result.mode==='auto'.
  check(
    'site1: setAutoModeActive arming fires on startup mode==="flow"',
    /result\.mode === 'flow'\n?\s*\) \{\n?\s*autoModeStateModule\?\.setAutoModeActive\(true\)/.test(ps),
  )
  check(
    'site1: the arming module require in permissionSetup.ts is real (not null)',
    /autoModeStateModule =\s*\n?\s*\(require\('\.\/autoModeState\.js'\)/.test(ps),
  )

  // Site 2 — dangerous-rule DETECTION (populates the list main.tsx strips).
  check(
    'site2: findDangerousClassifierPermissions detection fires on startup permissionMode==="flow"',
    /permissionMode === 'flow'\n?\s*\) \{\n?\s*dangerousPermissions = findDangerousClassifierPermissions/.test(ps),
  )

  // Site 3 — the isAutoModeAvailable context flag is set at startup.
  check(
    'site3: isAutoModeAvailable context flag is set unconditionally',
    /\{ isAutoModeAvailable: isAutoModeGateEnabled\(\) \}/.test(ps),
  )

  // Site 4 — the LOAD-BEARING strip in main.tsx.
  check(
    'site4: the main.tsx strip call fires on dangerous permissions',
    /dangerousPermissions\.length > 0/.test(mn),
  )

  // NULL-MODULE HAZARD — main.tsx must NOT try to arm setAutoModeActive (its module is
  // null for the fork); the strip is pure rule manipulation and is the only auto thing it
  // does at startup. Guards against a future "fix" moving the arming into main.tsx.
  check(
    'hazard-guard: main.tsx does NOT call setAutoModeActive at startup (module is null there)',
    !/setAutoModeActive\(true\)/.test(
      mn.slice(mn.indexOf('initializeToolPermissionContext'), mn.indexOf('assertMinVersion')),
    ),
  )

  // The feature()/version-gate idioms are both retired — no
  // feature() reads and no version seam may reappear at these sites.
  check(
    'no feature() or fork-seam reads remain at the startup-auto sites',
    !ps.includes("feature('TRANSCRIPT_CLASSIFIER')") &&
      !mn.includes("feature('TRANSCRIPT_CLASSIFIER')") &&
      !ps.includes('isHermesForkBuild') &&
      !mn.includes('isHermesForkBuild'),
  )
}

// ── 3. DIST: the shipped decision branches (string literals survive minify) ────
section('dist ships the auto-mode decision branches (floors, fast-paths, denial fallback, kill deny)')
{
  const dist = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` to grep-verify the shipped branches')
  } else {
    const present = (needle: string): boolean =>
      execSync(`grep -F -c ${JSON.stringify(needle)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
    // The floor → headless-deny message (shared by ask-rule/ceiling/plan/workflow).
    check('safety-floor headless-deny message ships', present('This action needs interactive approval, and this session cannot present a prompt'))
    // The org/MCP ask-ceiling reason.
    check('org/MCP ask-ceiling reason ships', present('Your organization requires approval for this tool'))
    // The two classifier fast-paths that skip an API call (implement + allowlist).
    check('implement fast-path log ships', present('implement mode would allow this outright'))
    check('safe-allowlist fast-path log ships', present('always-safe tool set membership'))
    // The denial-limit human-review fall-back (consecutive + total).
    check('denial-limit total fallback warning ships', present('actions were blocked this session'))
    check('denial-limit consecutive fallback warning ships', present('consecutive actions were blocked'))
    check('headless denial-limit hard abort ships', present('denial limit reached with no prompt available'))
    // The capability kill-switch deny on the permission path (step 0).
    check('capability kill-switch deny message ships', present('capability switched off by operator'))
    // PowerShell stays out of the classifier in auto unless POWERSHELL_AUTO_MODE.
    check('PowerShell auto-mode interactive-approval floor ships', present('PowerShell runs only with interactive approval'))
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL PERMISSION / AUTO-MODE PROOFS PASS')
else console.log(`❌ ${failures} PERMISSION / AUTO-MODE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
