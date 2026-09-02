import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// ============================================================================
//  knownAgentClis — the OUR-fingerprint inversion for harness-state in a
//  config home, plus the known agent-CLI signature table: Mercury knows the
//  ecosystem's tools the way a browser knows user-agents — every tool one
//  data row, none special.
//
//  THE LAW (own-naming lane): the health check detects ANY foreign harness
//  that wrote harness-state into a Mercury home — detection never depends on
//  knowing the foreigner's name. Mercury's own home-writers are identifiable:
//  the daemon's unconditional engage stamp (`[mercury-daemon] engaged …`,
//  daemon/main.ts), the product token in its log grammar, the control-socket
//  basename (`hermes-daemon-…`, daemon/controlSocket.ts) in supervisor
//  records, and roster rows written by this build. A daemon-plane artifact
//  carrying NO Mercury fingerprint was written by someone else — reported
//  with its evidence line. The signature table below only upgrades a report
//  with a friendly name; an unrecognized foreign writer still reports.
//
//  False-positive discipline:
//    · an OLDER Mercury's records are OURS — version variance alone is never
//      foreignness (roster rows from another build read `ours-stale` unless a
//      foreign daemon log corroborates a foreign writer);
//    · a plain text editor touching settings is not a harness — only the
//      daemon-plane artifact classes are classified;
//    · an unparseable record proves nothing (truncation of our own write is
//      indistinguishable from alien bytes) — skipped, never reported;
//    · file-granularity: an unrecognized writer interleaved into a log
//      Mercury also wrote is below the resolution floor — the dominant case
//      (a foreign daemon serving the home writes and rotates its own log) is
//      the one this classifier catches.
// ============================================================================

/** A known foreign tool: how its artifacts spell themselves. */
export interface AgentCliSignature {
  id: string
  displayName: string
  /** Recognizes the tool in harness-state text (log lines, record bytes). */
  pattern: RegExp
  /** Publisher-fixed on-disk names Mercury probes for interop. */
  jetbrainsPluginDir?: string
  /** The tool's session/auth env spellings (stripped from spawned children). */
  sessionEnvVars?: readonly string[]
  /** The tool's open-token file-descriptor env spelling (scrubbed from the daemon). */
  tokenFdEnvVar?: string
}

/**
 * The recognizer table: the ecosystem's agent tools this tree already knows
 * of (switchboard capacityCheck's vocabulary), each one data row of the same
 * shape — recognition pattern, interop spellings, session/token env
 * spellings. Consumers take a row by id (jetbrains.ts) or the derived scrub
 * surfaces below (subprocessEnv.ts, ownedDaemon.ts) — no tool owns a named
 * constant. Patterns stay package-path-tight — bare product words
 * ('claude', 'codex', 'gemini') appear in Mercury's OWN logs as model and
 * endpoint names and must never name a foreign writer.
 */
export const KNOWN_AGENT_CLIS: readonly AgentCliSignature[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    pattern: /@anthropic-ai\/claude-code|\bclaude[-_ ]code\b/i,
    jetbrainsPluginDir: 'claude-code-jetbrains-plugin',
    sessionEnvVars: [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_SUBSCRIPTION_TYPE',
      'CLAUDE_CODE_RATE_LIMIT_TIER',
    ],
    tokenFdEnvVar: 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  },
  {
    id: 'claude-agent-sdk',
    displayName: 'Claude Agent SDK',
    pattern: /@anthropic-ai\/claude-agent-sdk/i,
  },
  {
    id: 'codex-cli',
    displayName: 'Codex CLI',
    pattern: /@openai\/codex|\bcodex-cli\b/i,
    // Verified against the official Codex environment-variable reference
    // (developers.openai.com/codex/environment-variables, fetched
    // 2026-08-29): CODEX_API_KEY "provides an API key to a non-interactive
    // Codex process"; CODEX_ACCESS_TOKEN "provides a ChatGPT or Codex
    // access token for trusted automation". No token-descriptor env is
    // documented, so that field stays absent.
    sessionEnvVars: ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
  },
  {
    id: 'gemini-cli',
    displayName: 'Gemini CLI',
    pattern: /@google\/gemini-cli|\bgemini-cli\b/i,
    // Honest empty row: the official authentication docs
    // (google-gemini.github.io/gemini-cli, fetched 2026-08-29) name only
    // generic Google provider-key spellings (GEMINI_API_KEY, GOOGLE_API_KEY,
    // GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT/LOCATION) — the
    // provider-key class the CI scrub owns, never a per-tool session row —
    // and OAuth credentials cache to a local file, not env.
  },
]

/**
 * The scrub surfaces DERIVE from the whole table — every row equally. A new
 * tool joins as one data row and its session/token env is stripped from
 * Mercury's children (subprocessEnv.ts) and its detached daemon
 * (ownedDaemon.ts) by construction.
 */
export const AGENT_CLI_SESSION_ENV_VARS: readonly string[] = KNOWN_AGENT_CLIS.flatMap(
  tool => tool.sessionEnvVars ?? [],
)
export const AGENT_CLI_TOKEN_FD_ENV_VARS: readonly string[] = KNOWN_AGENT_CLIS.flatMap(
  tool => (tool.tokenFdEnvVar !== undefined ? [tool.tokenFdEnvVar] : []),
)

/** The first table entry whose pattern matches the text, or null. */
export function recognizeAgentCli(text: string): AgentCliSignature | null {
  for (const tool of KNOWN_AGENT_CLIS) {
    if (tool.pattern.test(text)) return tool
  }
  return null
}

/**
 * What marks harness-state text as OURS: the product token (any Mercury
 * build — `[mercury-daemon]`, MERCURY_* env names, dist/mercury.mjs paths)
 * or the control-socket basename. Version-free by design: an older
 * Mercury's grammar still carries these.
 */
export const MERCURY_HOME_WRITER_FINGERPRINT = /mercury|hermes[-_]daemon/i

/** The PRE-STAMP builds' own boot grammar. Every daemon.log a fielded
 *  Mercury wrote before the unconditional engage stamp holds only
 *  `[daemon] …` stderr sentences — and carries the product token only by
 *  accident of the home PATH in its first line. A home whose path spells no
 *  'mercury' (a custom MERCURY_CONFIG_DIR, a scratch home) left those logs
 *  fingerprint-free, and the inversion then reported our own artifact as an
 *  unrecognized foreign writer — the exact false positive the
 *  older-Mercury discipline forbids. These two sentences are the base
 *  build's own console.error spellings (daemon/main.ts), bytes no foreign
 *  daemon writes. */
export const MERCURY_LEGACY_LOG_GRAMMAR =
  /^\[daemon\] (?:starting autonomous scheduler for |control socket up — RPC: )/m

export type HarnessArtifactClass = 'daemon-log' | 'daemon-roster' | 'daemon-supervisor'

export interface HarnessHomeArtifact {
  /** Home-relative path, forward slashes. */
  rel: string
  artifactClass: HarnessArtifactClass
  verdict: 'ours' | 'ours-stale' | 'foreign'
  /** Present only when the signature table recognizes the writer. */
  tool?: { id: string; displayName: string }
  evidence: string
}

export interface HarnessHomeReport {
  artifacts: HarnessHomeArtifact[]
  foreign: HarnessHomeArtifact[]
  oursStale: HarnessHomeArtifact[]
}

/** The daemon-plane surfaces the classifier reads (home-relative). The
 *  SEGMENT lists are the path truth — join() applies the platform separator,
 *  so no '/'-spelled string is ever split (the win32 seam ratchet); the
 *  '/'-joined rel spellings (artifact keys, display) DERIVE from them. */
const HARNESS_LOG_SEGMENTS: readonly (readonly string[])[] = [['daemon.log'], ['daemon', 'daemon.log'], ['daemon', 'daemon.log.1']]
const HARNESS_ROSTER_SEGMENTS: readonly string[] = ['daemon', 'roster.json']
const HARNESS_SUPERVISOR_SEGMENTS: readonly string[] = ['daemon', 'supervisor.json']
export const HARNESS_LOG_RELS = HARNESS_LOG_SEGMENTS.map(segments => segments.join('/'))
export const HARNESS_ROSTER_REL = HARNESS_ROSTER_SEGMENTS.join('/')
export const HARNESS_SUPERVISOR_REL = HARNESS_SUPERVISOR_SEGMENTS.join('/')

const HARNESS_REL_SEGMENTS = new Map<string, readonly string[]>(
  [...HARNESS_LOG_SEGMENTS, HARNESS_ROSTER_SEGMENTS, HARNESS_SUPERVISOR_SEGMENTS].map(segments => [segments.join('/'), segments]),
)

/** Platform-safe absolute path for a harness artifact's home-relative key. */
export function harnessArtifactPath(home: string, rel: string): string {
  const segments = HARNESS_REL_SEGMENTS.get(rel)
  return segments !== undefined ? join(home, ...segments) : join(home, rel)
}

const EVIDENCE_LINE_CAP = 160

function truncateLine(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > EVIDENCE_LINE_CAP ? `${trimmed.slice(0, EVIDENCE_LINE_CAP)}…` : trimmed
}

function classifyLog(rel: string, raw: string): HarnessHomeArtifact | null {
  const lines = raw.split('\n').filter(line => line.trim().length > 0)
  if (lines.length === 0) return null
  for (const line of lines) {
    const tool = recognizeAgentCli(line)
    if (tool !== null) {
      return {
        rel,
        artifactClass: 'daemon-log',
        verdict: 'foreign',
        tool: { id: tool.id, displayName: tool.displayName },
        evidence: `${rel}: ${tool.displayName} daemon lines served this home — "${truncateLine(line)}"`,
      }
    }
  }
  if (MERCURY_HOME_WRITER_FINGERPRINT.test(raw) || MERCURY_LEGACY_LOG_GRAMMAR.test(raw)) {
    return {
      rel,
      artifactClass: 'daemon-log',
      verdict: 'ours',
      evidence: `${rel}: Mercury fingerprint present`,
    }
  }
  return {
    rel,
    artifactClass: 'daemon-log',
    verdict: 'foreign',
    evidence: `${rel}: an unrecognized tool's daemon served this home — no Mercury fingerprint in ${lines.length} line(s); first: "${truncateLine(lines[0] as string)}"`,
  }
}

function classifyRoster(
  rel: string,
  raw: string,
  expectedVersion: string | undefined,
  foreignLogTool: { id: string; displayName: string } | undefined,
): HarnessHomeArtifact | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null // unparseable proves nothing (could be our own truncated write)
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const workers = (parsed as { workers?: unknown }).workers
  if (workers === undefined || typeof workers !== 'object' || workers === null) {
    const tool = recognizeAgentCli(raw)
    if (tool !== null) {
      return {
        rel,
        artifactClass: 'daemon-roster',
        verdict: 'foreign',
        tool: { id: tool.id, displayName: tool.displayName },
        evidence: `${rel}: ${tool.displayName} record grammar (no Mercury roster shape)`,
      }
    }
    if (MERCURY_HOME_WRITER_FINGERPRINT.test(raw)) return null
    return {
      rel,
      artifactClass: 'daemon-roster',
      verdict: 'foreign',
      evidence: `${rel}: not Mercury's roster grammar — top-level keys: ${Object.keys(parsed as object).slice(0, 5).join(', ') || '(none)'}`,
    }
  }
  const versions = Object.values(workers as Record<string, { cliVersion?: unknown }>)
    .map(worker => worker?.cliVersion)
    .filter((version): version is string => typeof version === 'string')
  const alien = expectedVersion === undefined ? [] : versions.filter(version => version !== expectedVersion)
  if (alien.length === 0) {
    return { rel, artifactClass: 'daemon-roster', verdict: 'ours', evidence: `${rel}: worker rows from this build` }
  }
  if (foreignLogTool !== undefined) {
    return {
      rel,
      artifactClass: 'daemon-roster',
      verdict: 'foreign',
      tool: foreignLogTool,
      evidence: `${rel}: ${alien.length} worker row(s) from another runtime (${alien[0]}) beside ${foreignLogTool.displayName} daemon lines`,
    }
  }
  return {
    rel,
    artifactClass: 'daemon-roster',
    verdict: 'ours-stale',
    evidence: `${rel}: ${alien.length} worker row(s) recorded by a different Mercury build (${alien[0]}) — version variance, not foreignness`,
  }
}

function classifySupervisor(rel: string, raw: string): HarnessHomeArtifact | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as { pid?: unknown; controlSock?: unknown }
  if (typeof record.pid !== 'number') return null // not a supervisor record shape
  const sock = typeof record.controlSock === 'string' ? record.controlSock : ''
  if (MERCURY_HOME_WRITER_FINGERPRINT.test(sock) || MERCURY_HOME_WRITER_FINGERPRINT.test(raw)) {
    return { rel, artifactClass: 'daemon-supervisor', verdict: 'ours', evidence: `${rel}: Mercury control-plane record` }
  }
  const tool = recognizeAgentCli(raw)
  return {
    rel,
    artifactClass: 'daemon-supervisor',
    verdict: 'foreign',
    ...(tool !== null ? { tool: { id: tool.id, displayName: tool.displayName } } : {}),
    evidence: `${rel}: ${tool !== null ? `${tool.displayName} supervisor record` : "an unrecognized tool's supervisor record"} — controlSock ${sock || '(absent)'}`,
  }
}

/**
 * Classify the daemon-plane artifacts of a config home as OURS / OURS-STALE /
 * FOREIGN. `expectedVersion` is THIS build's version (the caller owns the
 * MACRO read so the classifier stays runner-agnostic); absent, roster version
 * variance is not assessed.
 */
export async function classifyHarnessHome(
  home: string,
  opts?: { expectedVersion?: string },
): Promise<HarnessHomeReport> {
  const artifacts: HarnessHomeArtifact[] = []

  for (const rel of HARNESS_LOG_RELS) {
    const raw = await readFile(harnessArtifactPath(home, rel), 'utf8').catch(() => null)
    if (raw === null) continue
    const verdict = classifyLog(rel, raw)
    if (verdict !== null) artifacts.push(verdict)
  }

  // Logs first: a foreign daemon log attributes same-home roster rows.
  const foreignLog = artifacts.find(artifact => artifact.verdict === 'foreign')

  const rosterRaw = await readFile(harnessArtifactPath(home, HARNESS_ROSTER_REL), 'utf8').catch(() => null)
  if (rosterRaw !== null) {
    const verdict = classifyRoster(HARNESS_ROSTER_REL, rosterRaw, opts?.expectedVersion, foreignLog?.tool)
    if (verdict !== null) artifacts.push(verdict)
  }

  const supervisorRaw = await readFile(harnessArtifactPath(home, HARNESS_SUPERVISOR_REL), 'utf8').catch(() => null)
  if (supervisorRaw !== null) {
    const verdict = classifySupervisor(HARNESS_SUPERVISOR_REL, supervisorRaw)
    if (verdict !== null) artifacts.push(verdict)
  }

  return {
    artifacts,
    foreign: artifacts.filter(artifact => artifact.verdict === 'foreign'),
    oursStale: artifacts.filter(artifact => artifact.verdict === 'ours-stale'),
  }
}
