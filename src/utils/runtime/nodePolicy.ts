/**
 * nodePolicy.ts — the ONE canonical Node runtime support policy.
 *
 * Mercury ships as a self-contained Node-targeted ESM bundle; this module owns
 * the runtime promise around that bundle. THREE truths, never one number:
 *
 *   1. supported product range — NODE_SUPPORT here (projected mechanically into
 *      package.json `engines.node`, dist/manifest.json `node`, the packaged
 *      POSIX/PowerShell/CMD launchers, the join kit, doctor text+JSON, and
 *      current docs; scripts/node-runtime/prove-node-policy.ts pins every projection);
 *   2. calibration runtime — the exact root `.node-version` patch (development +
 *      hosted-CI reproduction; may advance within Node 24 independently);
 *   3. build runtime — Bun (build.ts). Never this module's concern.
 *
 * DELIBERATELY zero-import and side-effect-free: the earliest entry seam
 * (src/entrypoints/cli.tsx main()) evaluates this before anything else boots,
 * so it must produce a clear decision without the product having started. The
 * parse is a strict hand-rolled semver triple rather than the bundled `semver`
 * package — the node-runtime suite locks every matrix verdict to the real `semver`
 * semantics, so behavior cannot drift from the range string while the boot
 * path stays dependency-free.
 *
 * No feature flag gates this: a runtime prerequisite is not optional product
 * behavior.
 */

/** The single numeric source for the supported line (everything below derives).
 *  24.20.0 is the operator-ruled floor: the first Node 24 that
 *  carries the fix for nodejs/node#56645 — see NODE_FLOOR_REASON. */
const MIN = { major: 24, minor: 20, patch: 0 } as const

const MINIMUM = `${MIN.major}.${MIN.minor}.${MIN.patch}`

export const NODE_SUPPORT = {
  /** Supported semver range — MUST equal package.json `engines.node` (prover-pinned). */
  range: `>=${MINIMUM} <${MIN.major + 1}`,
  /** The one qualified major line. Node 25/26 are unqualified — an
   *  open-ended "24 or newer" claim is banned everywhere. */
  major: MIN.major,
  /** Minimum stable version (the Node 24 LTS promotion floor). */
  minimum: MINIMUM,
  /** The generated human label used by launchers, kits, diagnostics, and docs. */
  label: 'Node 24 LTS',
} as const

/**
 * WHY the floor sits at 24.20.0 — named in the refusal a below-floor Node 24
 * receives and in the doctor's fix line, so an operator on an older 24 learns
 * what breaks: nodejs/node#56645 (fixed by PR #61999, shipped in 24.20.0) —
 * below it, a headless `-p` run that dispatched any tool (run or denied)
 * aborts at exit on win32 with 0xC0000409, libuv's src/win/async.c assert
 * inside Node's own platform teardown. The floor is operator policy (ruled);
 * an older major gets the plain line-support refusal instead.
 */
export const NODE_FLOOR_REASON = `Node ${MINIMUM} carries the fix for nodejs/node#56645 — below it, a headless -p run that dispatched any tool aborts at exit on win32 with 0xC0000409`

export type NodeRuntimeVerdict =
  | 'supported'
  | 'too-old'
  | 'unqualified-major'
  | 'prerelease'
  | 'invalid'

export interface NodeRuntimeDecision {
  verdict: NodeRuntimeVerdict
  /** The version string as observed (trimmed, `v` prefix kept off), or null when absent. */
  observed: string | null
  /** One short human clause naming the decision. */
  detail: string
}

// Strict semver shape (no leading zeros, optional prerelease/build metadata) —
// deterministic and locale-independent by construction (character classes only).
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * The pure decision: is `version` a Node runtime Mercury supports?
 *
 * Verdict order (total, deterministic): invalid → major<24 `too-old` →
 * major>24 `unqualified-major` → 24.x prerelease `prerelease` →
 * below the floor (MIN) `too-old` → `supported`.
 */
export function evaluateNodeRuntime(version: string | null | undefined): NodeRuntimeDecision {
  if (typeof version !== 'string' || version.trim() === '') {
    return { verdict: 'invalid', observed: null, detail: 'no Node.js version could be read' }
  }
  const raw = version.trim()
  const observed = raw.startsWith('v') ? raw.slice(1) : raw
  const m = SEMVER_RE.exec(observed)
  if (!m) {
    return { verdict: 'invalid', observed, detail: `"${raw}" is not a recognizable Node.js version` }
  }
  const major = Number(m[1])
  const minor = Number(m[2])
  const prerelease = m[4]
  if (major < MIN.major) {
    return { verdict: 'too-old', observed, detail: `Node ${major} is older than the supported ${NODE_SUPPORT.label} line` }
  }
  if (major > MIN.major) {
    return { verdict: 'unqualified-major', observed, detail: `Node ${major} is not yet qualified for Mercury` }
  }
  if (prerelease !== undefined) {
    return { verdict: 'prerelease', observed, detail: `prerelease Node builds are not supported` }
  }
  if (minor < MIN.minor) {
    return { verdict: 'too-old', observed, detail: `Node ${observed} is below the supported minimum ${MINIMUM}` }
  }
  return { verdict: 'supported', observed, detail: `Node ${observed} is inside ${NODE_SUPPORT.range}` }
}

/**
 * The concise refusal (stderr, then exit non-zero — the caller owns the I/O).
 * Names the observed version, the label, the FULL range incl. the upper bound,
 * and one action. Never a stack trace.
 */
export function nodeRefusalMessage(decision: NodeRuntimeDecision): string {
  const found = decision.observed === null ? 'none detected' : `found v${decision.observed}`
  const why =
    decision.verdict === 'invalid'
      ? `could not recognize the Node.js runtime (${found})`
      : `unsupported Node.js runtime (${found} — ${decision.detail})`
  const lines = [
    `mercury: ${why}`,
    `mercury: Mercury currently supports ${NODE_SUPPORT.label} (${NODE_SUPPORT.range}); newer majors are not yet qualified.`,
  ]
  // A Node 24 below the floor is told WHY the floor moved; an older major
  // gets the plain line-support refusal.
  if (decision.verdict === 'too-old' && decision.observed?.startsWith(`${NODE_SUPPORT.major}.`)) {
    lines.push(`mercury: ${NODE_FLOOR_REASON}.`)
  }
  lines.push(`mercury: install a current Node ${NODE_SUPPORT.major}.x release from https://nodejs.org and retry.`)
  return lines.join('\n')
}

/** The bounded projection for JSON/doctor/build records. */
export function nodeRuntimeProjection(version: string | null | undefined): {
  observed: string | null
  label: string
  range: string
  verdict: NodeRuntimeVerdict
} {
  const d = evaluateNodeRuntime(version)
  return { observed: d.observed, label: NODE_SUPPORT.label, range: NODE_SUPPORT.range, verdict: d.verdict }
}
