// ============================================================================
//  providers/deferralProbe — the gateway probe for the tool-deferral wire
//  form, and its durable verdict store.
//
//  A gateway in front of Anthropic may or may not pass the beta form through
//  (defer_loading on a schema, the advanced-tool-use header, tool_reference
//  blocks). The study's open question 3 rules that a PROBE RESULT decides,
//  never an assumption. The probe is one bounded, output-capped request
//  carrying exactly the beta shape a deferring request would carry (one
//  fixture tool marked defer_loading, the header, max_tokens 1); its answer
//  is classified here and recorded per gateway host in the config home, so
//  the verdict is durable across sessions and honest about its evidence.
//
//  Classification (pure — classifyGatewayProbe, fixture-provable):
//    2xx                          ⇒ 'block' (the gateway passed the shape)
//    400 naming the beta field,
//        the header or the block  ⇒ 'text'  (the gateway refused the shape)
//    401 / 403                    ⇒ indeterminate: auth refused the PROBE, not
//                                   the shape — no verdict is recorded, the
//                                   form stays text until a credentialed probe
//    any other status / no reply  ⇒ indeterminate (unreachable, 5xx, …)
//
//  The store is the honest fallback's memory too: an indeterminate probe
//  leaves no verdict, so the next armed process probes again (bounded once
//  per process per host); a recorded verdict is re-probed after seven days
//  — gateways get upgraded.
//
//  THE TRIGGER IS THE OPERATOR'S: the probe runs only under
//  MERCURY_TOOL_DEFER_PROBE=1. Unarmed, a gateway rides the text form —
//  which already delivers the whole economy and can never 400 — and no
//  request the session did not ask for ever leaves the box (an automatic
//  probe is one extra request per process per host: every request-counting
//  harness and every metered gateway would see it). The nonessential-
//  traffic switch keeps it off even when armed.
//
//  The SEND is the caller's (the Anthropic lane, through its own client and
//  auth); this module owns the shape, the classification, the single-flight
//  and the store. Dependency-light: fs, the home resolver, the flag reader.
// ============================================================================
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getMercuryHome } from '../../utils/envUtils.js'

export type GatewayProbeVerdict = 'block' | 'text'

export interface GatewayProbeRecord {
  verdict: GatewayProbeVerdict
  /** What the gateway answered — status + the first line of the body. */
  evidence: string
  status: number | null
  probedAt: string
}

interface ProbeStoreFile {
  version: 1
  hosts: Record<string, GatewayProbeRecord>
}

const STORE_FILE = 'tool-deferral-probe.json'
const REPROBE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
/** The beta header the deferring request carries (the first-party spelling). */
export const PROBE_BETA_HEADER = 'advanced-tool-use-2025-11-20'

// ── the store ───────────────────────────────────────────────────────────────

let cache: { path: string; file: ProbeStoreFile } | null = null

function storePath(): string {
  return join(getMercuryHome(), STORE_FILE)
}

function readStore(): ProbeStoreFile {
  const path = storePath()
  if (cache && cache.path === path) return cache.file
  let file: ProbeStoreFile = { version: 1, hosts: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProbeStoreFile>
    if (parsed && parsed.version === 1 && parsed.hosts && typeof parsed.hosts === 'object') {
      file = { version: 1, hosts: { ...parsed.hosts } }
    }
  } catch {
    // Absent or unreadable ⇒ no verdicts; every host reads unprobed.
  }
  cache = { path, file }
  return file
}

function writeStore(file: ProbeStoreFile): void {
  const path = storePath()
  try {
    mkdirSync(getMercuryHome(), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(file, null, 2))
    renameSync(tmp, path)
  } catch {
    // A store that cannot be written still serves this process from memory.
  }
  cache = { path, file }
}

/** The recorded verdict for a gateway host (undefined = unprobed / stale). */
export function readGatewayProbeVerdict(host: string, now: () => number = Date.now): GatewayProbeVerdict | undefined {
  const record = readStore().hosts[host]
  if (!record) return undefined
  const at = Date.parse(record.probedAt)
  if (Number.isFinite(at) && now() - at > REPROBE_AFTER_MS) return undefined
  return record.verdict
}

/** The whole record — receipts and the health surface print the evidence. */
export function readGatewayProbeRecord(host: string): GatewayProbeRecord | undefined {
  return readStore().hosts[host]
}

export function recordGatewayProbe(host: string, record: GatewayProbeRecord): void {
  const file = readStore()
  writeStore({ version: 1, hosts: { ...file.hosts, [host]: record } })
}

/** Provers reset the in-memory view between fixtures. */
export function _resetGatewayProbeStoreForTesting(): void {
  cache = null
}

// ── the shape and the classification ────────────────────────────────────────

/** The request body a deferring request would carry, minimal: one fixture
 *  tool marked defer_loading, one user turn, one output token. */
export function gatewayProbeBody(model: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'probe' }],
    tools: [
      {
        name: 'deferral_probe',
        description: 'A probe of the deferral wire form; never called.',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        defer_loading: true,
      },
    ],
  }
}

export interface GatewayProbeAnswer {
  status: number | null
  bodyText: string
}

export type GatewayProbeClassification =
  | { kind: 'verdict'; verdict: GatewayProbeVerdict; evidence: string }
  | { kind: 'indeterminate'; reason: 'auth-refused' | 'unreachable' | 'other-status'; evidence: string }

const SHAPE_REFUSAL = /defer_loading|tool_reference|advanced-tool-use|anthropic-beta|beta/i

function firstLine(text: string): string {
  const line = text.split('\n').find(l => l.trim() !== '') ?? ''
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/** Pure: the gateway's answer → a verdict or an honest indeterminate. */
export function classifyGatewayProbe(answer: GatewayProbeAnswer): GatewayProbeClassification {
  const { status, bodyText } = answer
  const evidence = status === null ? `no reply: ${firstLine(bodyText)}` : `http ${status}: ${firstLine(bodyText)}`
  if (status === null) return { kind: 'indeterminate', reason: 'unreachable', evidence }
  if (status >= 200 && status < 300) return { kind: 'verdict', verdict: 'block', evidence }
  if (status === 400 && SHAPE_REFUSAL.test(bodyText)) return { kind: 'verdict', verdict: 'text', evidence }
  if (status === 401 || status === 403) return { kind: 'indeterminate', reason: 'auth-refused', evidence }
  if (status === 400 || status === 404 || status === 422) {
    // The gateway rejected the request for some other reason (an unknown
    // model, a path it does not serve). The shape was not judged; text is
    // the honest form, and a verdict cannot be recorded from it.
    return { kind: 'indeterminate', reason: 'other-status', evidence }
  }
  return { kind: 'indeterminate', reason: 'other-status', evidence }
}

// ── the single-flight driver ────────────────────────────────────────────────

/** Is a live probe allowed right now? Only when the operator armed it
 *  (MERCURY_TOOL_DEFER_PROBE=1), and never under the nonessential-traffic
 *  posture. */
export function gatewayProbePolicyAllows(env: Record<string, string | undefined> = process.env): boolean {
  if (flagEnv('MERCURY_TOOL_DEFER_PROBE') !== '1') return false
  const traffic = env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  if (traffic !== undefined && traffic !== '' && traffic !== '0' && traffic.toLowerCase() !== 'false') return false
  return true
}

const inFlight = new Map<string, Promise<GatewayProbeClassification>>()
const attempted = new Set<string>()

/**
 * Run the probe for `host` at most once per process (single-flight), record
 * a verdict when one lands, and answer the classification. `send` performs
 * the one bounded request through the caller's own client and auth; it
 * must resolve (never throw) with the status and the body text, or with
 * status null when the wire did not answer.
 */
export async function ensureGatewayProbe(
  host: string,
  send: (body: Record<string, unknown>, betaHeader: string) => Promise<GatewayProbeAnswer>,
  model: string,
): Promise<GatewayProbeClassification | null> {
  if (attempted.has(host)) {
    const running = inFlight.get(host)
    return running ? running : null
  }
  attempted.add(host)
  const work = (async (): Promise<GatewayProbeClassification> => {
    let answer: GatewayProbeAnswer
    try {
      answer = await send(gatewayProbeBody(model), PROBE_BETA_HEADER)
    } catch (error) {
      answer = { status: null, bodyText: error instanceof Error ? error.message : String(error) }
    }
    const classification = classifyGatewayProbe(answer)
    if (classification.kind === 'verdict') {
      recordGatewayProbe(host, {
        verdict: classification.verdict,
        evidence: classification.evidence,
        status: answer.status,
        probedAt: new Date().toISOString(),
      })
    }
    return classification
  })()
  inFlight.set(host, work)
  try {
    return await work
  } finally {
    inFlight.delete(host)
  }
}

/** Provers: forget which hosts this process already probed. */
export function _resetGatewayProbeFlightsForTesting(): void {
  inFlight.clear()
  attempted.clear()
}
