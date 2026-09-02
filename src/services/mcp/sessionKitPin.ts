// ============================================================================
//  sessionKitPin — the ONE session-kit carrier consumption.
//
//  A daemon-hosted runner is spawned with its session's kit on the spec:
//  extraEnv.MERCURY_SESSION_KIT = the JSON of the record's SessionKitV1 (the
//  admission stamp's own bytes, carried or derived; spec-carried ⇒ respawns
//  keep the pin). This module is the runner-side half: the pin is CONSUMED
//  ONCE at boot — read through the registered flag, scrubbed from
//  process.env so bash-spawned grandchild CLIs never inherit another
//  session's kit, validated by the wire's own narrowing, and LATCHED as the
//  process's kit. Membership decisions read the latch through the one owner
//  (services/mcp/membership.ts); the skills table reads it through the
//  catalogue overlay (commands.ts).
//
//  ABSENT ≠ EMPTY ≠ MALFORMED, at the process seam (the kit laws):
//    · no pin      ⇒ the latch stays undefined — whole-config membership
//      (a plain or interactive boot, a warm runner before its claim, a
//      pre-kit record's respawn);
//    · a valid pin ⇒ the latch is that kit (resolved: its lists ARE the
//      membership; unresolved: deltas-only until the runner's completion
//      flips it — the only road from provisional to resolved);
//    · a MALFORMED pin ⇒ the latch is the EMPTY resolved kit — the session
//      lives and loads NO extensions, said in one typed stderr line.
//      Falling to whole-config would be the scope leak the wire's refusal
//      law exists to prevent; dying in a respawn loop would trade a scope
//      bug for a dead session (lane ruling, named in the kit-runner
//      receipt).
//
//  The latch is idempotent: the first consume decides for the process
//  lifetime; later calls re-scrub the env (defence in depth) and answer
//  the standing receipt. DIALS' live edits arrive over the control wire,
//  never by re-reading env.
// ============================================================================
import { deleteFlagEnv, flagEnv } from '../../substrate/flagRegistry.js'
import {
  applyKitEdit,
  materializedWholeConfigKit,
  validateSessionKit,
  type SessionKitEditV1,
  type SessionKitV1,
} from '../../daemon/sessionKit.js'
import { appendSessionReceipt } from '../switchboard/sessionReceipts.js'
import { logForDebugging } from '../../utils/debug.js'

/** What the one consumption decided (latched for the process lifetime). */
export type SessionKitPinReceipt =
  | { outcome: 'none' }
  | { outcome: 'pinned'; kit: SessionKitV1 }
  | { outcome: 'refused'; reason: string; kit: SessionKitV1 }

/** The refused arm's latch: the EMPTY resolved kit — loads nothing. */
function emptySessionKit(): SessionKitV1 {
  return { schema: 1, mcp: [], skills: [], invocable: [] }
}

let latched: SessionKitPinReceipt | null = null

/**
 * Read-and-scrub the session-kit pin, once. Every later call answers the
 * first call's receipt (and re-scrubs the env spelling, so a late consumer
 * can never leak it to a grandchild).
 */
export function consumeSessionKitPin(): SessionKitPinReceipt {
  const raw = flagEnv('MERCURY_SESSION_KIT')
  deleteFlagEnv('MERCURY_SESSION_KIT')
  if (latched !== null) return latched
  if (raw === undefined || raw.trim() === '') {
    latched = { outcome: 'none' }
    return latched
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    latched = refuse('the pin is not JSON')
    return latched
  }
  const validated = validateSessionKit(parsed)
  latched = validated.ok ? { outcome: 'pinned', kit: validated.kit } : refuse(validated.reason)
  return latched
}

function refuse(reason: string): SessionKitPinReceipt {
  const line = `kit refused — ${reason}; this session loads no extensions`
  try {
    process.stderr.write(`${line}\n`)
  } catch {
    /* a torn stderr never blocks the boot */
  }
  logForDebugging(`[kit] ${line}`)
  return { outcome: 'refused', reason, kit: emptySessionKit() }
}

/** The process's kit: undefined = no pin (whole-config membership). */
export function sessionKitOf(): SessionKitV1 | undefined {
  return latched !== null && latched.outcome !== 'none' ? latched.kit : undefined
}

/**
 * THE COMPLETION FLIP: an UNRESOLVED latch becomes the
 * RESOLVED kit the runner composed from its own roster — the only lawful
 * re-latch, and only in that direction. Every other state no-ops (a plain
 * boot has nothing to complete; a resolved latch never moves again — the
 * dials' live edits ride the control wire, not this seam). The flip is
 * validated by the wire's own narrowing first: a composer bug must not
 * latch what the daemon would refuse to stamp.
 */
export function completeProcessSessionKit(resolved: SessionKitV1): boolean {
  if (latched === null || latched.outcome !== 'pinned' || latched.kit.resolved !== false) return false
  const validated = validateSessionKit(resolved)
  if (!validated.ok || validated.kit.resolved === false) {
    logForDebugging(`[kit] completion refused — ${validated.ok ? 'the composed kit is still unresolved' : validated.reason}`)
    return false
  }
  latched = { outcome: 'pinned', kit: validated.kit }
  return true
}

/**
 * THE DIAL'S SETTER (ledger L24(3)) — the one lawful re-latch
 * beside the completion: a session's own dial replaces the process kit with
 * the kit the record's one writer just produced (the control wire's
 * `kit_edit` forward), or with the process's own edited kit where no record
 * exists (the SDK child's `mcp_toggle`, the screen estate's panel dial).
 * Validated by the wire's own narrowing first — a dial must not latch what
 * the daemon would refuse to stamp. Every prior latch state is lawful
 * ground: `none` (a pre-kit process's first dial — the edit road
 * materializes before it calls here), `pinned` (the ordinary dial), and
 * `refused` (the record's kit is the truth; a validated forward heals the
 * torn-env boot honestly — record and process agree again). The COMPLETION
 * law is untouched: unresolved → resolved still moves only through
 * completeProcessSessionKit below.
 */
export function setProcessSessionKit(kit: SessionKitV1): { ok: true; kit: SessionKitV1 } | { ok: false; reason: string } {
  const validated = validateSessionKit(kit)
  if (!validated.ok) return { ok: false, reason: validated.reason }
  latched = { outcome: 'pinned', kit: validated.kit }
  return { ok: true, kit: validated.kit }
}

/**
 * THE PROCESS-LOCAL DIAL (the record-less arms: the SDK child's
 * `mcp_toggle`, the screen estate's own panel rows — a process that IS its
 * own session and has no daemon record to write): materialize-then-edit,
 * the same law as the record's one writer (sessionKitOp.ts). A process with
 * no kit materializes from its standing reality first — the caller renders
 * the off-record it was actually enforcing (`standingOffNames`, the
 * disabledRecord rendering; an un-kitted process applied no skill or
 * extension state, so those materialize empty) — and the dial then edits
 * that kit. Identity ⇒ 'noop' (nothing latched anew). Daemon-hosted dials
 * never ride this: they arrive as whole kits over the control wire, the
 * record edited first.
 */
export function applyProcessSessionKitEdit(
  edit: SessionKitEditV1,
  standingOffNames: readonly string[],
): { outcome: 'applied' | 'noop' | 'refused'; kit?: SessionKitV1; detail?: string } {
  const standing = sessionKitOf()
  const materialized = standing === undefined
  const base = standing ?? materializedProcessKit(standingOffNames)
  const next = applyKitEdit(base, edit)
  if (next === base && !materialized) return { outcome: 'noop', detail: 'the kit already reads so' }
  const set = setProcessSessionKit(next === base ? base : next)
  if (!set.ok) return { outcome: 'refused', detail: `kit refused — ${set.reason}` }
  return { outcome: 'applied', kit: set.kit }
}

/** The record-less arms' materialization: ONE spelling with the record
 *  writer's (materializedWholeConfigKit carries the standing off-record —
 *  the process's own rendering here, the workspace slice's at the daemon;
 *  without it, the first dial would WIDEN the process: a record-disabled
 *  server becomes a member the moment the latch exists, because the
 *  unresolved membership arm never consults the record again). */
function materializedProcessKit(standingOffNames: readonly string[]): SessionKitV1 {
  return materializedWholeConfigKit(standingOffNames)
}

/**
 * THE EXTENSION MASTER's process answer (the two-store AND):
 * is this extension's master row ON in the process's kit? The install-level
 * contribution switches (extensions/records.ts) are the OTHER store — the
 * switch door ANDs the two, so an extension off in EITHER contributes
 * nothing. No kit, or a kit that never names the extension ⇒ true (absent
 * = on; the install switch alone decides).
 */
export function processKitExtensionOn(name: string): boolean {
  const kit = sessionKitOf()
  if (kit === undefined) return true
  if (kit.resolved === false) return !(kit.deltas?.extensionsOff ?? []).includes(name)
  return (kit.extensions?.[name] ?? 'on') !== 'off'
}

let refusalNoted = false

/**
 * THE REFUSAL's RECEIPT ROW (the lead's ruling 2, second half): a session
 * that booted on a REFUSED pin says so on its own receipt too — the same
 * typed sentence stderr carried, durable beside the transcript, once.
 * Called from the shared prep once session identity is bound; fail-soft
 * (the receipt is the honesty valve, the EMPTY-kit latch is the law).
 */
export function noteRefusedKitOnSessionReceipt(home: string, sessionId: string): boolean {
  if (refusalNoted || latched === null || latched.outcome !== 'refused') return false
  refusalNoted = true
  try {
    appendSessionReceipt(home, sessionId, {
      at: new Date().toISOString(),
      by: 'runner',
      kind: 'kit-refused',
      summary: `kit refused — ${latched.reason}; this session loads no extensions`,
      details: { reason: latched.reason },
    })
    return true
  } catch (err) {
    logForDebugging(`[kit] refusal receipt failed for ${sessionId}: ${err}`)
    return false
  }
}

/** Proof seam only — a live process never unlatches. */
export function _resetSessionKitPinForTesting(): void {
  latched = null
  refusalNoted = false
}
