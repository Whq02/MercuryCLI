// ============================================================================
//  substrate/splashHandover — the ONE splash-action receipt consumer
//
//
//  History: the enter screen's launcher-card actions (continue / resume /
//  doctor / project + dir) would otherwise be consumed by the LAUNCHER SHELLS —
//  three dialects (sh `read -r` · cmd `set /p` · ps1 Get-Content) parsing a
//  product-written file on every boot. cmd's reader line-splits on CR, so
//  the LF-only receipt collapsed into ONE multi-line %VAR% whose first
//  `if "%…%"` expansion was a malformed command: cmd aborted the batch,
//  node never started, and the held alt-screen stranded the operator on the
//  splash frame. Every Windows interactive boot died this way in 1.5.4, and
//  the same reader had silently mis-parsed the rarer action receipts since
//  the native-batch handover landed.
//
//  The class fix: launchers branch on the splash's EXIT CODE alone
//  (0 handoff+HELD · 20 handoff+RESTORED · 130 cancel · else abnormal) and
//  arm MERCURY_SPLASH_HANDOFF=1 on a handoff;
//  THIS module — real code, one owner, unit-provable on every platform —
//  validates and applies the receipt at cli entry, before anything reads
//  argv or cwd. Absent env ⇒ the receipt is never touched (a concurrent
//  verb boot must not eat an interactive boot's receipt; the splash's own
//  startup sweep owns staleness).
//
//  THE FLOOR LAW: a receipt anomaly — stale, malformed, multi-line garbage,
//  unknown action, vanished dir, unreadable file — may cost the operator's
//  enter-screen choice, NEVER the boot. Nothing here throws outward, and
//  `cancel` is deliberately IGNORED (the launcher owns cancel via exit 130;
//  a leftover cancel receipt must never kill a later boot).
// ============================================================================

import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { deleteFlagEnv, flagEnv } from './flagRegistry.js'
import { getMercuryHome } from '../utils/envUtils.js'

/** Actions the splash can write — the closed vocabulary (splash + old-launcher
 *  consumers agreed on this set; `cancel` is consumed by the
 *  launcher's exit-code branch and ignored here by design; `kit` (L24(5))
 *  opens the MCPs & Skills manager on the Boot face; `saturn` opens the
 *  scheduler screen the same way;
 *  `logins` opens the sign-in layer; `agents`
 *  opens the agent studio layer — a
 *  runtime older than this set reads any of them as 'unknown-action' and
 *  boots plain, the protocol's own degradation law. `project` stays
 *  consumed although no current launcher writes it (the Projects row
 *  folded into 'Sessions · Projects'): a stale deployed
 *  splash may still hand it over, and it must keep costing only the
 *  choice, never the boot. */
const ACTIONS = new Set(['continue', 'doctor', 'project', 'resume', 'concourse', 'kit', 'saturn', 'logins', 'agents', 'cancel'])

// THE KIT MANAGER DEEP-LINK (the /bootmenu CB-09 sibling, owned HERE
// because the receipt consumer below must arm it and the substrate never
// imports a component): a typed process-local one-shot the Boot face
// consumes at mount so it lands with the MCPs & Skills manager already
// open; esc closes the manager to the face. A future in-process door (a
// slash command, a chord) arms the same one-shot.
let pendingKitManagerDeepLink = false
export function armKitManagerDeepLink(): void {
  pendingKitManagerDeepLink = true
}
/** Consume-on-read: the face takes it exactly once; a later mount never
 *  re-opens a stale choice. */
export function consumeKitManagerDeepLink(): boolean {
  const armed = pendingKitManagerDeepLink
  pendingKitManagerDeepLink = false
  return armed
}

// THE FACE-DOOR DEEP-LINKS (operator-ruled Way A): the splash's doctor and resume picks land the Boot face
// with its OWN sub-view open (BootHealthScreen · BootResumeScreen) — the
// kit deep-link's exact grammar: a typed process-local one-shot the face
// consumes at mount; the initial-surface resolver only PEEKS (the landing
// decision must never eat the face's one-shot). The receipt VOCABULARY is
// unchanged ('doctor' · 'resume' stay the wire words), so a stale deployed
// splash keeps working against this runtime, and an older runtime reading
// the same receipt splices as it always did — the protocol's degradation
// law both directions. 'logins' joins the union (the
// operator's boot-menu logins door) so any surface can land the face with
// the sign-in layer open; its wire word joins ACTIONS at the card recut,
// and the SATURN form's "re-login now" arming is a NAMED SEAM ONLY —
// armFaceDoorDeepLink('logins') IS that seam (building the arm is the
// saturn estate's own move).
export type FaceDoorDeepLink = 'health' | 'resume' | 'saturn' | 'logins' | 'agents'
let pendingFaceDoorDeepLink: FaceDoorDeepLink | null = null
export function armFaceDoorDeepLink(door: FaceDoorDeepLink): void {
  pendingFaceDoorDeepLink = door
}
/** The resolver's read: never consumes — the face owns the one-shot. */
export function peekFaceDoorDeepLink(): FaceDoorDeepLink | null {
  return pendingFaceDoorDeepLink
}
/** Consume-on-read: the face takes it exactly once at mount; a later
 *  mount never re-opens a stale choice. */
export function consumeFaceDoorDeepLink(): FaceDoorDeepLink | null {
  const v = pendingFaceDoorDeepLink
  pendingFaceDoorDeepLink = null
  return v
}

// RFI-3: the splash's boot-surface intent as a typed process-local
// one-shot — the initial-surface resolver consumes it BEFORE the first
// visible commit (never an argv-spliced command executing post-paint).
// NEW-2 (amended): the union is CLOSED over its
// destinations — an explicit CONTINUE choice records 'repl' so the
// operator's chosen conversation owns the first frame even under a
// policy-always Concourse (ambient policy must never eat an explicitly
// chosen journey); doctor/resume carry the same outrank through the
// face-door deep-link above instead.
// A PLAIN handoff (the animation-first splash's screen-fact-only receipt)
// records no intent: the Boot face is every interactive boot's landing
// (the resolver's one landing rule), whichever door the boot came through.
export type BootSurfaceIntent = 'concourse' | 'repl'
let pendingBootSurfaceIntent: BootSurfaceIntent | null = null

// The explicit-journey fact: main.tsx's launch classification
// marks argv-chosen journeys (--continue/--resume/teleport/--from-pr/an
// initial prompt) so the Boot face landing can never eat an explicitly
// chosen conversation (the NEW-2 law extended to argv journeys — the
// launcher runs the splash for these boots too).
let explicitBootJourney = false
export function markExplicitBootJourney(): void {
  explicitBootJourney = true
}
/** A chat-forward boot whose birth the daemon REFUSED has no chat to land
 *  on: the journey retracts before the first frame so the resolver lands
 *  the Boot face directly — never a settle-long flash of the empty chat
 *  before the REPL's own yield. */
export function retractExplicitBootJourney(): void {
  explicitBootJourney = false
}
export function bootJourneyIsExplicit(): boolean {
  return explicitBootJourney
}

/** Consume-on-read: the resolver takes the intent exactly once; a later
 *  visit never re-applies a stale splash choice. */
export function consumeBootSurfaceIntent(): BootSurfaceIntent | null {
  const v = pendingBootSurfaceIntent
  pendingBootSurfaceIntent = null
  return v
}

/** Proof seam. */
export function _setBootSurfaceIntentForTesting(v: BootSurfaceIntent | null): void {
  pendingBootSurfaceIntent = v
}

/** Receipt freshness window — matches the retired launcher-side consumer. */
const FRESH_MS = 120_000

export interface SplashReceiptDecision {
  /** null ⇒ nothing to apply (plain boot). */
  apply: { chdir?: string; spliceArg?: string } | null
  reason:
    | 'applied'
    | 'no-file'
    | 'malformed'
    | 'stale'
    | 'foreign-launch'
    | 'screen-only'
    | 'cancel-ignored'
    | 'unknown-action'
}

/**
 * The pure decision: raw receipt bytes → what (if anything) to apply.
 * Exported for the conformance prover — the validation matrix runs on every
 * platform without touching a real home. `ownLaunchId` is the launch
 * id the launcher minted for THIS boot (env-down only): a receipt carrying a
 * DIFFERENT id belongs to a live sibling launch sharing the home and is
 * treated as foreign — never applied, and (in the consumer) never deleted.
 * Receipts without an id (older splash) and boots without an id (direct
 * `node mercury.mjs` with the handoff env set by hand) keep matching.
 */
export function decideSplashReceipt(
  raw: string | null,
  now: number,
  dirExists: (dir: string) => boolean,
  ownLaunchId: string | null = null,
): SplashReceiptDecision {
  if (raw === null) return { apply: null, reason: 'no-file' }
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    return { apply: null, reason: 'malformed' }
  }
  if (
    typeof o !== 'object' ||
    o === null ||
    (o as { version?: unknown }).version !== 1 ||
    typeof (o as { ts?: unknown }).ts !== 'number'
  ) {
    return { apply: null, reason: 'malformed' }
  }
  const receipt = o as { ts: number; action?: unknown; dir?: unknown; launchId?: unknown }
  if (
    typeof receipt.launchId === 'string' &&
    receipt.launchId !== '' &&
    ownLaunchId !== null &&
    receipt.launchId !== ownLaunchId
  ) {
    return { apply: null, reason: 'foreign-launch' }
  }
  if (Math.abs(now - receipt.ts) >= FRESH_MS) return { apply: null, reason: 'stale' }
  if (receipt.action === undefined) {
    // A plain handoff writes {screen} alone — nothing to apply: the Boot
    // face is the landing for every interactive boot (the resolver's one
    // landing rule), so the handoff needs no intent of its own.
    return { apply: null, reason: 'screen-only' }
  }
  if (typeof receipt.action !== 'string' || !ACTIONS.has(receipt.action)) {
    return { apply: null, reason: 'unknown-action' }
  }
  if (receipt.action === 'cancel') return { apply: null, reason: 'cancel-ignored' }
  const dir =
    typeof receipt.dir === 'string' && receipt.dir && dirExists(receipt.dir)
      ? receipt.dir
      : undefined
  // RFI-3: the 'concourse' action no
  // longer splices '/concourse' — the argv splice executed POST-PAINT via
  // the initialMessage effect, so the first visible commit was the
  // un-navigated Main REPL (the operator's ~1s flash). The intent now rides
  // a typed one-shot the initial-surface resolver consults BEFORE the first
  // commit; the mid-session /concourse path is untouched (RFI-4 PRESERVE).
  if (receipt.action === 'concourse') pendingBootSurfaceIntent = 'concourse'
  // NEW-2: the explicit continue choice records the OTHER direction —
  // under a policy-always/auto-live Concourse the chosen conversation
  // would otherwise mount COVERED beneath the opaque host, the policy
  // eating the journey's first frame. 'project' stays intent-free: it is
  // a chdir alone, and the destination is the policy's to decide.
  else if (receipt.action === 'continue') pendingBootSurfaceIntent = 'repl'
  // Way A: the doctor and resume picks arm the FACE-DOOR
  // deep-link instead of a splice — the boot lands the face with its own
  // sub-view open (the resolver's peek outranks a policy-always
  // Concourse), the doctor flash dies, and resume's esc lands the face
  // instead of the standalone chooser's process exit. A hand-typed
  // `mercury --resume` / `--continue` never passes here and keeps its
  // journey untouched.
  else if (receipt.action === 'doctor') pendingFaceDoorDeepLink = 'health'
  else if (receipt.action === 'resume') pendingFaceDoorDeepLink = 'resume'
  // The scheduler row rides the face-door grammar whole —
  // the boot lands the face with the scheduler open; nothing to chdir or
  // splice, no boot-surface intent (the face is the landing).
  else if (receipt.action === 'saturn') pendingFaceDoorDeepLink = 'saturn'
  // The logins row rides the same grammar — the boot lands
  // the face with the sign-in layer open.
  else if (receipt.action === 'logins') pendingFaceDoorDeepLink = 'logins'
  // The agents row rides the same grammar — the boot lands
  // the face with the agent studio layer open.
  else if (receipt.action === 'agents') pendingFaceDoorDeepLink = 'agents'
  // 'kit' arms NO boot-surface intent (the Boot face is the landing, the
  // resolver's one rule) — it arms the manager deep-link the face consumes
  // at mount; nothing to chdir or splice.
  else if (receipt.action === 'kit') pendingKitManagerDeepLink = true
  const spliceArg =
    receipt.action === 'continue'
      ? '--continue'
      : undefined // 'project' is a chdir alone; 'concourse'/'doctor'/'resume' ride the typed one-shots above
  if (dir === undefined && spliceArg === undefined) {
    // 'project' whose dir vanished — nothing left to apply.
    return { apply: null, reason: 'applied' }
  }
  return {
    apply: { ...(dir ? { chdir: dir } : {}), ...(spliceArg ? { spliceArg } : {}) },
    reason: 'applied',
  }
}

/**
 * The applying entry — called from src/entrypoints/cli.tsx BEFORE the argv
 * snapshot, only when the launcher armed MERCURY_SPLASH_HANDOFF=1. One-shot:
 * the env is deleted immediately (children must never inherit a claim about
 * THIS boot's handover), both receipt spellings are deleted after the read
 * (the legacy plain-text twin is dead vocabulary — swept if a crashed
 * 1.5.4-era boot left one), and the validated choice lands as a chdir +
 * an argv splice at index 2 (exactly where the launchers would otherwise prepend).
 */
export function consumeSplashHandover(): void {
  if (flagEnv('MERCURY_SPLASH_HANDOFF') !== '1') return
  deleteFlagEnv('MERCURY_SPLASH_HANDOFF')
  let raw: string | null = null
  let home: string
  try {
    home = getMercuryHome()
  } catch {
    return // no resolvable home — plain boot
  }
  const receiptPath = join(home, 'splash-action.json')
  try {
    raw = readFileSync(receiptPath, 'utf8')
  } catch {
    raw = null
  }
  const ownLaunchId = flagEnv('MERCURY_LAUNCH_ID') || null
  const decision = decideSplashReceipt(raw, Date.now(), dir => {
    try {
      return statSync(dir).isDirectory()
    } catch {
      return false
    }
  }, ownLaunchId)
  // a FOREIGN receipt belongs to a live sibling launch — leave it on
  // disk for that launch's runtime; everything else is ours to consume.
  if (decision.reason !== 'foreign-launch') {
    for (const f of [receiptPath, join(home, 'splash-action.txt')]) {
      try {
        rmSync(f, { force: true })
      } catch {
        /* consumed best-effort */
      }
    }
  }
  if (!decision.apply) return
  if (decision.apply.chdir) {
    try {
      process.chdir(decision.apply.chdir)
    } catch {
      /* dir vanished between stat and chdir — boot where we are */
    }
  }
  if (decision.apply.spliceArg) {
    process.argv.splice(2, 0, decision.apply.spliceArg)
  }
}
