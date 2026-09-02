// ============================================================================
//  crewClient — the FOREGROUND face of crew teammates (/teammates).
//
//  Everything the board needs, over the two proven transports and nothing else:
//
//    · CONTROL SOCKET (authed RPC) — spawn ('crewSpawn': the daemon owns the
//      spec floor; we send intent only), kill, and roster liveness ('list').
//    · MAILBOX FILES (the fileStore kernel, 1s pollFloor) — sending a message
//      is writeToMailbox(teams/crew/inboxes/<name>); the teammate's replies
//      land in teams/crew/inboxes/team-lead.json via its SendMessage; the
//      transcript is the MERGE of both, and per-chat unread rides the
//      team-lead inbox's read flags (markMessagesFromAsRead — never flatten
//      another chat's badge).
//
//  The daemon is the OWNED, SELF-REAPING kind (ensureCrewDaemon → the shared
//  spawnOwnedDaemon seam): engaged by an explicit operator act on the board,
//  reaped when this session exits — the same sanction shape as the Scribe and
//  party engages. Chat identity is DURABLE (team-file members persist across
//  daemon restarts; a roster-absent member renders offline with its transcript
//  intact, and respawning the same name re-attaches to the same chat).
// ============================================================================
import { flagPair } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../debug.js'
import { daemonSnapshot } from '../cockpit/daemonSnapshot.js'
import { decideScribeDaemonAction } from '../scribe/ensureScribeDaemon.js'
import {
  clearDeadSupervisorRecords,
  daemonControlRpc,
} from '../../daemon/controlSocket.js'
import { spawnOwnedDaemon } from '../../daemon/ownedDaemon.js'
import { clearDaemonHaltStanddown } from '../daemonStanddown.js'
import {
  CREW_TEAM,
  crewEnabled,
  isValidCrewName,
} from '../../daemon/crewSpawn.js'
import { readTeamFileAsync } from '../swarm/teamHelpers.js'
import {
  getMailboxStore,
  markMessagesFromAsRead,
  readMailbox,
  writeToMailbox,
  type TeammateMessage,
} from '../teammateMailbox.js'
import type { DaemonRequest, WireRosterEntry } from '../../daemon/protocol.js'

export const CREW_LEAD_INBOX = 'team-lead'

/** Reply codes that mean "the daemon is not SERVING yet" (cold spawn → socket
 *  bind takes ~1-2s): ESTARTING from a booting daemon, ENOCONN while the
 *  socket/pipe does not exist yet, ETIMEOUT while it wedges through boot.
 *  These RETRY; anything else is a REAL refusal surfaced verbatim. The
 *  field bug: ENOCONN (surfaced raw in that era as "connect ENOENT
 *  …control.sock" / the win32 named pipe; the client now types transport loss
 *  as "daemon unreachable (ENOENT)") was treated as a refusal, so the FIRST
 *  spawn on a cold daemon always failed instantly on both platforms. */
export function isRetryableSpawnReplyCode(code: string | undefined): boolean {
  return code === 'ESTARTING' || code === 'ENOCONN' || code === 'ETIMEOUT'
}

// ── the owned crew daemon ────────────────────────────────────────────────────

/**
 * Ensure a daemon is up to host crew teammates — the crew analog of
 * ensureScribeDaemon (same probe → spawn → ping-confirm shape, same
 * self-reaping ownedDaemon seam). Gated on crewEnabled(); marks the daemon
 * MERCURY_DAEMON_CREW=1 and stamps MERCURY_PARTY='0' (a crew engage is not a
 * party engage — combined use stays a deliberate operator act, exactly the
 * scribe-engage rule).
 */
export function ensureCrewDaemon(projectDir: string): void {
  // An explicit crew engage lifts a /halt stand-down.
  clearDaemonHaltStanddown()
  if (!crewEnabled()) return
  let state: string
  try {
    state = daemonSnapshot().state
  } catch (e) {
    logForDebugging(`[crew] ensureCrewDaemon: probe failed: ${e}`)
    return
  }
  if (decideScribeDaemonAction(state) === 'spawn') {
    spawnCrewDaemon(projectDir)
    return
  }
  // pid-alive can lie (reused pid / wedged daemon). Confirm it actually SERVES;
  // if not, clear the dead records and respawn. Fire-and-forget, never throws.
  // Fix 3: a pid-ALIVE daemon gets ~8s of retries before any
  // clearance — a live daemon whose phone line vanished self-heals within
  // ~4s, and one 1s ping would otherwise condemn it (the plane-wipe race).
  void (async () => {
    // SB-C9 (close audit): condemnation needs a CONNECTION-refused signal,
    // not slowness alone — a daemon blocked a few seconds on synchronous
    // work (a cold worktree carve) times out every 1s ping and an
    // all-ETIMEOUT streak would otherwise wipe its live records (split-brain). A
    // missing socket surfaces as ENOCONN; a wedged-but-listening daemon
    // still gets condemned once its socket actually refuses.
    let sawConnRefusal = false
    for (let i = 0; i < 8; i++) {
      try {
        const ping = await daemonControlRpc({ op: 'ping' }, { timeoutMs: 1000 })
        if (ping.ok) return
      } catch (e) {
        const msg = String(e)
        if (msg.includes('ENOCONN') || msg.includes('ENOENT') || msg.includes('ECONNREFUSED')) {
          sawConnRefusal = true
        }
      }
      await new Promise(res => setTimeout(res, 1000))
    }
    if (!sawConnRefusal) {
      logForDebugging('[crew] daemon slow but its socket never refused — alive-but-busy, no clearance')
      return
    }
    logForDebugging('[crew] recorded daemon is pid-alive but not serving — clearing + respawning')
    try {
      await clearDeadSupervisorRecords()
    } catch {
      /* best-effort */
    }
    spawnCrewDaemon(projectDir)
  })()
}

function spawnCrewDaemon(projectDir: string): void {
  spawnOwnedDaemon(projectDir, {
    label: 'crew',
    extraEnv: { ...flagPair('MERCURY_DAEMON_CREW', '1') },
  })
}

// ── spawn / kill / liveness ──────────────────────────────────────────────────

export interface CrewSpawnResult {
  ok: boolean
  pid?: number
  error?: string
}

/**
 * Spawn a teammate: ensure the daemon, then RPC 'crewSpawn' with retry while
 * the daemon boots (ESTARTING / socket-not-yet-bound). Client-side validation
 * mirrors the daemon's for INSTANT feedback; the daemon re-validates — its
 * floor is the authority, never this mirror.
 */
export async function spawnCrewTeammate(
  name: string,
  /** A family word ('openai', 'anthropic', …), an Anthropic generation key
   *  or a model id — the daemon's seat resolver validates it against the
   *  crew arm and answers typed; the client never pre-judges a family. */
  modelKey: string,
  projectDir: string,
): Promise<CrewSpawnResult> {
  if (!crewEnabled()) return { ok: false, error: 'crew is disabled (MERCURY_CREW=0)' }
  if (!isValidCrewName(name)) {
    return { ok: false, error: 'name must be [a-z][a-z0-9-]{1,15} (reserved names refused)' }
  }
  if (String(modelKey).trim() === '') {
    return { ok: false, error: 'pick a model — a family word (openai, anthropic, …), a generation key or a model id' }
  }
  ensureCrewDaemon(projectDir)
  // The daemon needs ~1-2s from cold spawn to a serving socket; a mid-boot RPC
  // gets ESTARTING or a connect error. Bounded retry, honest final error.
  let lastError = 'daemon did not become ready'
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const reply = await daemonControlRpc(
        // proto+auth are stamped by the client for authed ops (the list-site idiom).
        { op: 'crewSpawn', name, model: String(modelKey) } as DaemonRequest,
        { timeoutMs: 3000 },
      )
      if (reply.ok && reply.op === 'crewSpawn') return { ok: true, pid: reply.pid }
      if (!reply.ok) {
        // Boot-race codes retry (ESTARTING · ENOCONN · ETIMEOUT — the socket
        // may simply not be bound yet); anything else is a REAL refusal
        // (cap, name, gate) to surface verbatim, not to retry into.
        if (isRetryableSpawnReplyCode(reply.code)) {
          lastError = reply.error ?? 'daemon still starting'
        } else {
          return { ok: false, error: reply.error }
        }
      }
    } catch (e) {
      lastError = String(e)
    }
    await new Promise(r => setTimeout(r, 400))
  }
  return { ok: false, error: `spawn timed out: ${lastError}` }
}

/** Kill a live teammate (roster worker). The team-file member — the durable
 *  chat — is deliberately kept; the board shows it offline. */
export async function killCrewTeammate(name: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const reply = await daemonControlRpc({ op: 'kill', short: name } as DaemonRequest, { timeoutMs: 3000 })
    if (reply.ok) return { ok: true }
    return { ok: false, error: reply.error }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** Live roster entries for crew members (by name), keyed by short. Absent key
 *  ⇒ offline (durable chat, no live instance). Never throws — an unreachable
 *  daemon is the EMPTY map (everything offline), which is the honest render. */
export async function crewRosterStatus(names: readonly string[]): Promise<Map<string, WireRosterEntry>> {
  const out = new Map<string, WireRosterEntry>()
  if (names.length === 0) return out
  try {
    const reply = await daemonControlRpc({ op: 'list' } as DaemonRequest, { timeoutMs: 1500 })
    if (reply.ok && reply.op === 'list') {
      for (const j of reply.jobs) {
        if (!j.outcome && names.includes(j.short)) out.set(j.short, j)
      }
    }
  } catch {
    /* daemon down ⇒ all offline */
  }
  return out
}

// ── the chat model ───────────────────────────────────────────────────────────

export interface CrewMemberInfo {
  name: string
  model?: string
  joinedAt: number
}

/** Durable chat identities — the crew team file's non-lead members. */
export async function listCrewMembers(): Promise<CrewMemberInfo[]> {
  const team = await readTeamFileAsync(CREW_TEAM)
  if (!team) return []
  return team.members
    .filter(m => m.name !== CREW_LEAD_INBOX)
    .map(m => ({ name: m.name, model: m.model, joinedAt: m.joinedAt }))
}

export interface CrewChatRow {
  ts: number
  /** 'out' = operator → teammate · 'in' = teammate → operator. */
  dir: 'out' | 'in'
  text: string
  read: boolean
}

const toTs = (m: TeammateMessage): number => {
  const t = Date.parse(m.timestamp ?? '')
  return Number.isFinite(t) ? t : 0
}

/**
 * One teammate's transcript: operator messages from ITS inbox (what we sent)
 * merged with its replies from the team-lead inbox (what it sent), by time.
 */
export async function readCrewChat(name: string): Promise<CrewChatRow[]> {
  const [outbox, leadInbox] = await Promise.all([
    readMailbox(name, CREW_TEAM),
    readMailbox(CREW_LEAD_INBOX, CREW_TEAM),
  ])
  const rows: CrewChatRow[] = []
  for (const m of outbox) {
    if (m.from === CREW_LEAD_INBOX) rows.push({ ts: toTs(m), dir: 'out', text: m.text, read: !!m.read })
  }
  for (const m of leadInbox) {
    if (m.from === name) rows.push({ ts: toTs(m), dir: 'in', text: m.text, read: !!m.read })
  }
  rows.sort((a, b) => a.ts - b.ts)
  return rows
}

/** Unread reply count per teammate (the chips' badges) — team-lead inbox,
 *  grouped by sender, unread only. */
export async function crewUnreadCounts(): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const leadInbox = await readMailbox(CREW_LEAD_INBOX, CREW_TEAM)
  for (const m of leadInbox) {
    if (!m.read && m.from) out.set(m.from, (out.get(m.from) ?? 0) + 1)
  }
  return out
}

/** Send an operator message to a teammate. Plain text by design — the seat
 *  drain delivers non-envelope inbox text as an ATTRIBUTED frame (the
 *  plain-frame delivery), which is exactly a chat message. */
export async function sendCrewMessage(name: string, text: string): Promise<boolean> {
  const trimmed = text.trim()
  if (!trimmed) return false
  return writeToMailbox(
    name,
    { from: CREW_LEAD_INBOX, text: trimmed, timestamp: new Date().toISOString() },
    CREW_TEAM,
  )
}

/** Viewing @name's chat: mark ITS replies read — never another chat's. */
export async function markCrewChatRead(name: string): Promise<void> {
  await markMessagesFromAsRead(CREW_LEAD_INBOX, name, CREW_TEAM)
}

/** Store handles for the board's live subscriptions (fileStore kernel —
 *  watcher + 1s pollFloor): re-render on any change to this teammate's inbox
 *  or the shared team-lead inbox. */
export function crewChatStores(name: string): { outbox: { subscribe: (fn: () => void) => () => void }; leadInbox: { subscribe: (fn: () => void) => () => void } } {
  return {
    outbox: getMailboxStore(name, CREW_TEAM),
    leadInbox: getMailboxStore(CREW_LEAD_INBOX, CREW_TEAM),
  }
}
