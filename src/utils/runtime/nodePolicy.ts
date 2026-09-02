
const MIN = { major: 24, minor: 20, patch: 0 } as const

const MINIMUM = `${MIN.major}.${MIN.minor}.${MIN.patch}`

export const NODE_SUPPORT = {
  range: `>=${MINIMUM} <${MIN.major + 1}`,
  major: MIN.major,
  minimum: MINIMUM,
  label: 'Node 24 LTS',
} as const

export const NODE_FLOOR_REASON = `Node ${MINIMUM} carries the fix for nodejs/node#56645 — below it, a headless -p run that dispatched any tool aborts at exit on win32 with 0xC0000409`

export type NodeRuntimeVerdict =
  | 'supported'
  | 'too-old'
  | 'unqualified-major'
  | 'prerelease'
  | 'invalid'

export interface NodeRuntimeDecision {
  verdict: NodeRuntimeVerdict
  observed: string | null
  detail: string
}

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

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
  if (decision.verdict === 'too-old' && decision.observed?.startsWith(`${NODE_SUPPORT.major}.`)) {
    lines.push(`mercury: ${NODE_FLOOR_REASON}.`)
  }
  lines.push(`mercury: install a current Node ${NODE_SUPPORT.major}.x release from https://nodejs.org and retry.`)
  return lines.join('\n')
}

export function nodeRuntimeProjection(version: string | null | undefined): {
  observed: string | null
  label: string
  range: string
  verdict: NodeRuntimeVerdict
} {
  const d = evaluateNodeRuntime(version)
  return { observed: d.observed, label: NODE_SUPPORT.label, range: NODE_SUPPORT.range, verdict: d.verdict }
}
