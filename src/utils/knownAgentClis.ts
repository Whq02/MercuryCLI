import { readFile } from 'node:fs/promises'
import { join } from 'node:path'


export interface AgentCliSignature {
  id: string
  displayName: string
  pattern: RegExp
  jetbrainsPluginDir?: string
  sessionEnvVars?: readonly string[]
  tokenFdEnvVar?: string
}

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
    sessionEnvVars: ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
  },
  {
    id: 'gemini-cli',
    displayName: 'Gemini CLI',
    pattern: /@google\/gemini-cli|\bgemini-cli\b/i,
  },
]

export const AGENT_CLI_SESSION_ENV_VARS: readonly string[] = KNOWN_AGENT_CLIS.flatMap(
  tool => tool.sessionEnvVars ?? [],
)
export const AGENT_CLI_TOKEN_FD_ENV_VARS: readonly string[] = KNOWN_AGENT_CLIS.flatMap(
  tool => (tool.tokenFdEnvVar !== undefined ? [tool.tokenFdEnvVar] : []),
)

export function recognizeAgentCli(text: string): AgentCliSignature | null {
  for (const tool of KNOWN_AGENT_CLIS) {
    if (tool.pattern.test(text)) return tool
  }
  return null
}

export const MERCURY_HOME_WRITER_FINGERPRINT = /mercury|hermes[-_]daemon/i

export const MERCURY_LEGACY_LOG_GRAMMAR =
  /^\[daemon\] (?:starting autonomous scheduler for |control socket up — RPC: )/m

export type HarnessArtifactClass = 'daemon-log' | 'daemon-roster' | 'daemon-supervisor'

export interface HarnessHomeArtifact {
  rel: string
  artifactClass: HarnessArtifactClass
  verdict: 'ours' | 'ours-stale' | 'foreign'
  tool?: { id: string; displayName: string }
  evidence: string
}

export interface HarnessHomeReport {
  artifacts: HarnessHomeArtifact[]
  foreign: HarnessHomeArtifact[]
  oursStale: HarnessHomeArtifact[]
}

const HARNESS_LOG_SEGMENTS: readonly (readonly string[])[] = [['daemon.log'], ['daemon', 'daemon.log'], ['daemon', 'daemon.log.1']]
const HARNESS_ROSTER_SEGMENTS: readonly string[] = ['daemon', 'roster.json']
const HARNESS_SUPERVISOR_SEGMENTS: readonly string[] = ['daemon', 'supervisor.json']
export const HARNESS_LOG_RELS = HARNESS_LOG_SEGMENTS.map(segments => segments.join('/'))
export const HARNESS_ROSTER_REL = HARNESS_ROSTER_SEGMENTS.join('/')
export const HARNESS_SUPERVISOR_REL = HARNESS_SUPERVISOR_SEGMENTS.join('/')

const HARNESS_REL_SEGMENTS = new Map<string, readonly string[]>(
  [...HARNESS_LOG_SEGMENTS, HARNESS_ROSTER_SEGMENTS, HARNESS_SUPERVISOR_SEGMENTS].map(segments => [segments.join('/'), segments]),
)

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
    return null
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
  if (typeof record.pid !== 'number') return null
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
