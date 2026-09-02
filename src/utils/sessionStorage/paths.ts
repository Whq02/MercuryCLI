// sessionStorage/paths — where transcript bytes LIVE and what counts as a
// transcript entry. Three concerns share this module because every other
// sessionStorage submodule needs them first:
//   1. entry-kind predicates (isTranscriptMessage & friends) — the single
//      vocabulary for "does this line participate in the chain";
//   2. path derivation for session/agent/workflow JSONL files — the on-disk
//      shape hooks, attachments, and the daemon all read back;
//   3. the agent .meta.json sidecar IO that resume routing depends on.
// Mercury-owned; the parity oracle
// pins both the export surface and the path shapes.

import { readFile } from 'fs/promises'
import { join } from 'path'
import type { UUID } from 'crypto'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from '../../bootstrap/state.js'
import type { AgentId } from '../../types/ids.js'
import type { Entry, TranscriptMessage } from '../../types/logs.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../debug.js'
import { getMercuryHome } from '../envUtils.js'
import { isFsInaccessible } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import { durableAtomicPublish } from '../../substrate/durablePublish.js'
import { getProjectDir as resolveProjectDirWithAdoption } from '../sessionStoragePortable.js'

/**
 * The one predicate that decides chain membership on read: user, assistant,
 * attachment, and system entries are conversation; everything else on the
 * line stream is session metadata. loadTranscriptFile admits entries into
 * the uuid→message map through this gate and nowhere else.
 *
 * Progress is deliberately OUTSIDE the set. It is throwaway UI state; giving
 * it uuid-chain membership forked the parentUuid graph and stranded real
 * turns on resume (#14373, #23537), so it neither persists as conversation
 * nor anchors children.
 */
export function isTranscriptMessage(entry: Entry): entry is TranscriptMessage {
  switch (entry.type) {
    case 'user':
    case 'assistant':
    case 'attachment':
    case 'system':
      return true
    default:
      return false
  }
}

/**
 * Chain membership on WRITE: may a child point its parentUuid at this
 * message? Everything but progress. insertMessageChain and useLogMessages
 * consult this when advancing the parent cursor; transcripts from before
 * the progress purge get their chains healed read-side by the
 * progressBridge pass in loadTranscriptFile.
 */
export function isChainParticipant(m: Pick<Message, 'type'>): boolean {
  return m.type !== 'progress'
}

type PersistedProgressEntry = {
  type: 'progress'
  uuid: UUID
  parentUuid: UUID | null
}

/**
 * Shape test for persisted on-disk progress lines. The live Entry union
 * does not contain them (the writer filters progress), but files written
 * by earlier builds do — with uuid/parentUuid intact — and the loader must
 * bridge chains ACROSS them rather than truncate at them.
 */
export function isPersistedProgressEntry(
  entry: unknown,
): entry is PersistedProgressEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'type' in entry &&
    entry.type === 'progress' &&
    'uuid' in entry &&
    typeof entry.uuid === 'string'
  )
}

/**
 * Progress subtypes that tick at tool frequency (Bash chunk output, the
 * per-second Sleep counter, MCP notifications). The REPL replaces these
 * in place rather than appending rows, and the loader drops any that old
 * transcripts persisted. Never sent to the API.
 */
const EPHEMERAL_PROGRESS_TYPES = new Set([
  'bash_progress',
  'powershell_progress',
  'mcp_progress',
])

export function isEphemeralToolProgress(dataType: unknown): boolean {
  return typeof dataType === 'string' && EPHEMERAL_PROGRESS_TYPES.has(dataType)
}

export function getProjectsDir(): string {
  return join(getMercuryHome(), 'projects')
}

export function getTranscriptPath(): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, `${getSessionId()}.jsonl`)
}

export function getTranscriptPathForSession(sessionId: string): string {
  // The CURRENT session must resolve through the same sessionProjectDir
  // override getTranscriptPath honors. switchActiveSession (resume/branch)
  // moves the write target there; deriving from originalCwd instead handed
  // hooks a transcript_path pointing at a directory the file was never
  // written to. sessionId+sessionProjectDir switch
  // atomically; this function reads them as the pair.
  if (sessionId === getSessionId()) {
    return getTranscriptPath()
  }
  // Any OTHER session: originalCwd is the best available guess — no
  // sessionId→projectDir index exists. Callers that know the real location
  // pass fullPath explicitly (the save* functions all accept one).
  const projectDir = getProjectDir(getOriginalCwd())
  return join(projectDir, `${sessionId}.jsonl`)
}

// Ceiling for whole-transcript reads: 50 MB. Session JSONL grows into the
// gigabytes (inc-3930); raw readers must refuse beyond this rather than OOM.
export const MAX_TRANSCRIPT_READ_BYTES = 50 * 1024 * 1024

// agentId → grouping subdir under <session>/subagents/ (workflow runs group
// as workflows/<runId>/). Registered before the agent's first write;
// process-lifetime only — the run manifest carries the durable copy.
const agentTranscriptSubdirs = new Map<string, string>()

export function setAgentTranscriptSubdir(agentId: string, subdir: string): void {
  agentTranscriptSubdirs.set(agentId, subdir)
}

export function clearAgentTranscriptSubdir(agentId: string): void {
  agentTranscriptSubdirs.delete(agentId)
}

export function getAgentTranscriptPath(agentId: AgentId): string {
  // Sidechain files live under the session's own directory, so the
  // sessionProjectDir override applies here exactly as it does for the
  // main transcript — one session, one tree.
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  const sessionId = getSessionId()
  const subdir = agentTranscriptSubdirs.get(agentId)
  const base = subdir
    ? join(projectDir, sessionId, 'subagents', subdir)
    : join(projectDir, sessionId, 'subagents')
  return join(base, `agent-${agentId}.jsonl`)
}

export function getAgentMetadataPath(agentId: AgentId): string {
  return getAgentTranscriptPath(agentId).replace(/\.jsonl$/, '.meta.json')
}

/**
 * The directory a workflow run's agent transcripts land in — the
 * `workflows/<runId>` grouping resolved the same way getAgentTranscriptPath
 * resolves it. The run manifest (WorkflowTool/runManifest.ts) records this
 * absolute path so the /workflows board can rejoin run↔transcripts after a
 * restart; the in-memory subdir map above does not survive the process.
 */
export function getWorkflowTranscriptDir(runId: string): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, getSessionId(), 'subagents', 'workflows', runId)
}

export type AgentMetadata = {
  agentType: string
  /** Set when the spawn used isolation:"worktree" — resume restores this cwd. */
  worktreePath?: string
  /** The AgentTool task description as given at spawn, so a resumed agent's
   * notification names its real task. Absent in older sidecars. */
  description?: string
 /** The model the spawn RESOLVED and dispatched launch-parity:
   * what was shown is what resume runs). If absent, resume re-resolves
   * against the live parent — which silently discards a spawn-time `model`
   * param and can move a zai (glm-*) agent onto an Anthropic model. Never
   * written for codex engine jobs, which hold no in-process model. */
  model?: string
  /** Spawn-time effort override (workflow `effort` opt) — restored on resume
   * under the same launch-parity rule. */
  effortOverride?: string
  /** The effort the run RESOLVED (pin, then the definition's, then the
   * session's at launch) — what the agent actually carried; a badge or a
   * replayed row reads this, never a rebuilt current default. */
  effort?: string
 /** Instruction profile the spawn composed under capture:
   * agent > session > auto, frozen at spawn). Parent profile changes shape
   * future spawns only, never a resumed child. Absent in older sidecars. */
  instructionProfile?: string
  /** Digest of the composed instruction bundle — lets resume/health report
   * whether effective instructions drifted under a running agent. */
  instructionDigest?: string
}

/**
 * Persist the launch facts a resume cannot re-derive. The primary field is
 * agentType: without it, resuming a fork with subagent_type omitted decays
 * to general-purpose (default prompt, no inherited history). A sidecar file
 * keeps the JSONL schema untouched; worktreePath rides along so resume can
 * land in the right checkout.
 */
export async function writeAgentMetadata(
  agentId: AgentId,
  metadata: AgentMetadata,
): Promise<void> {
  const path = getAgentMetadataPath(agentId)
  // The whole-file atomic law: a plain writeFile TRUNCATES first, so a hard
  // kill between truncate and write left a zero-byte sidecar and the next
  // resume silently re-resolved the agent onto a different model (the file's
  // own read-side warning). durableAtomicPublish is temp+fsync+rename with the
  // win32 retry ladder (TASK-017 S2, agent-sidecar-not-durably-published).
  await durableAtomicPublish(path, JSON.stringify(metadata))
}

/**
 * Read the launch sidecar. null on every unreadable/undecodable shape — a
 * missing file (agent predates sidecars), a torn write, or corrupt JSON all
 * degrade to the documented fallback (resume re-resolves); only a genuine
 * I/O fault outside the inaccessible-fs class propagates. The corrupt case
 * is logged once so the degradation is visible, not silent.
 */
export async function readAgentMetadata(
  agentId: AgentId,
): Promise<AgentMetadata | null> {
  const path = getAgentMetadataPath(agentId)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (e) {
    if (isFsInaccessible(e)) return null
    throw e
  }
  try {
    return JSON.parse(raw) as AgentMetadata
  } catch {
    logForDebugging(
      `agent metadata sidecar unreadable (corrupt JSON) at ${path} — resume falls back to re-resolution`,
      { level: 'warn' },
    )
    return null
  }
}

export function sessionIdExists(sessionId: string): boolean {
  const projectDir = getProjectDir(getOriginalCwd())
  const sessionFile = join(projectDir, `${sessionId}.jsonl`)
  const fs = getFsImplementation()
  try {
    fs.statSync(sessionFile)
    return true
  } catch {
    return false
  }
}

/** Test seam — production reads NODE_ENV exactly once through here. */
export function getNodeEnv(): string {
  return process.env.NODE_ENV || 'development'
}

/** Mercury ships externally; the ant/external forks all resolve external. */
export function getUserType(): string {
  return 'external'
}

export function getEntrypoint(): string | undefined {
  return process.env.MERCURY_ENTRYPOINT
}

export function isCustomTitleEnabled(): boolean {
  return true
}

// Resolution delegates to the ONE adoption ladder (sessionStoragePortable):
// existing stores are honoured in place, while a project without a store
// gets the injective hashed slug — the bare sanitizer folded all
// punctuation to one hyphen, so paths differing only by `_`/`-`/`.`
// collided into a single transcript directory.
//
// Delegation is DIRECT — no memo at this layer. The ladder memoises inside,
// keyed by IDENTITY under the key-stability law: a resolution built on a
// FAILED canonicalization is answered but never cached. A memo here (once
// added for the hook input builder's 12+ calls per turn) was keyed by the
// raw spelling and cached every answer — re-freezing exactly the wrong
// raw-slug key the ladder refuses to freeze, for the process lifetime. A
// warm call still costs one Map.get (the ladder's own memo hit); only a
// spelling that cannot canonicalize re-resolves per call, the priced honest
// answer.
export const getProjectDir = (projectDir: string): string => {
  return resolveProjectDirWithAdoption(projectDir)
}
