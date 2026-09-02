import { flagEnv } from '../substrate/flagRegistry.js'

/**
 * The ALWAYS-ON (default-register) mechanistic anti-sycophancy arm.
 *
 * The lever: "convert a confident claim into a verifying check before you agree". The
 * ALWAYS-ON arm — the lever firing on EVERY turn — was HELD, because
 * flipping an always-on system-prompt behavioral default cannot be validated by the in-repo
 * proof suites (they assert directive PRESENCE / not-weakened, NOT a tone / over-refusal
 * regression). It needs an EXTERNAL held-out A/B that cannot run in-session.
 *
 * This seam ships the arm as a NEW DEFAULT-OFF, stamp-gated, opt-in section so it becomes
 * A/B-able by ONE env toggle WITHOUT (i) changing any default behavior (OFF ⇒ [] ⇒
 * byte-identical), (ii) touching the digest-guarded identity floor text, or (iii)
 * putting a behavioral clause in the harm-bound identity FLOOR. The actual DEFAULT FLIP stays the operator's call, gated on that external
 * held-out A/B. (the patch-then-gate / held-out-gated pattern, scoped to a
 * wrapper-pack-style section, never the off-distribution core.)
 *
 * The clause is strictly ADDITIVE to the always-on disagreement line already in the wrapper
 * .txt ("surface honest disagreement … rather than affirming a request you think is wrong") —
 * it sharpens that line with the mechanistic convert-to-verify lever; it never softens it.
 */
const ANTISYC_ALWAYS_ON_CLAUSE = `<honesty-discipline>
Before you confirm a confident claim — the operator's or your own — convert it into a verifying check first: read, grep, or run the thing, then report what the check actually shows. Agreement is earned by evidence, not offered as a reflex; when the check contradicts the claim, say so plainly. This sharpens — never softens — surfacing honest disagreement and tradeoffs over affirming a request you think is wrong.
</honesty-discipline>`

/**
 * The always-on anti-sycophancy section, in assembly order. Default-OFF, stamp-gated, opt-in via
 * MERCURY_ANTISYC_ALWAYS_ON=1. The gate re-reads process.env on EVERY call (never a cached const)
 * so a runtime toggle is honest — a stateful/cached gate would silently lie when flipped off
 * mid-session (the /authority feature-toggle lesson). Returns [] when off ⇒ byte-identical.
 */
export function getAntiSycophancyAlwaysOnSection(): string[] {
  
  if (flagEnv('MERCURY_ANTISYC_ALWAYS_ON') !== '1') return []
  return [ANTISYC_ALWAYS_ON_CLAUSE]
}
