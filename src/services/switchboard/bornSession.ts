// ============================================================================
//  switchboard/bornSession — THE ONE BIRTH DOOR (Law 9, rule 2: born =
//  registered).
//
//  Chat = session = board row, born together. Every road that STARTS a chat
//  comes through here — the boot menu's New Session, a Projects pick with
//  no history, /clear's fresh chat, a plan's clear-context words, the
//  chat-forward boots (`--chat`, an argv prompt, an inline boot) — and does
//  one thing: the daemon ADMITS a real session for the workspace (the record
//  is on the board before this resolves — the warm runner's claim answers
//  in milliseconds, so the felt Enter is the old Enter) and the focused slot
//  re-points at the session's own connector. No words are sent: the session
//  is blank and ready, exactly like a row entered from the board.
//
//  What the birth carries: the model the screen shows (or the caller's
//  pick), and the boot's own facts (bootBirthFacts — the title once, the
//  posture, the effort, the runner options, the menu's kit when the screen
//  set one — absent otherwise, and the daemon derives). A birth the daemon
//  refuses is a typed refusal in the daemon's own sentence; nothing is
//  entered.
// ============================================================================
import { catalogFirstChat } from '../../utils/bootCardFacts.js'
import { logForDebugging } from '../../utils/debug.js'
import { withLanding } from '../engine-connector/focusedConnector.js'
import { birthModelOf, bootBirthFacts, carriedKitOf, screenBirthModel, takeBootTitle, takeWornPresetKit } from './bootBirthFacts.js'
import { hopIntoBoardSession } from './hopIntoSession.js'

export type BirthOutcome =
  | { ok: true; sessionId: string; title: string }
  | { ok: false; reason: string }

export interface BirthRequest {
  /** The folder the session works in. */
  workspaceDir: string
  /** The door's own model inheritance (/clear passes the cleared chat's);
   *  the next-session facts' model outranks it, the screen's main model (the
   *  boot menu's chip) is the floor — birthModelOf, the one precedence. */
  model?: string | null
  /** A title for THIS birth; absent = the boot's `-n` title (first birth). */
  title?: string | null
  /** The hop's first-paint ceiling (the flicker law). */
  firstPaintMs?: number
  /** The /clear seat-swap (operator-sighted): the live session
   *  this birth replaces — admission counts its seat as leaving, so /clear
   *  works on a FULL world; the caller parks it only after the birth lands. */
  vacatingSessionId?: string
}

/** The daemon's refusal when it cannot be brought up — the same sentence
 *  the first message used to answer with. */
// Never '↵ again starts it': against a daemon that holds the pipe but never
// answers, ↵ re-runs the same bounded wait and starts nothing (TASK-017 S2,
// wedged-daemon-reads-as-starting) — the sentence names the retry AND the
// remedy for that shape.
export const DAEMON_DID_NOT_START =
  'the daemon that hosts sessions did not become ready — ↵ retries; if it keeps waiting, `mercury daemon stop` clears a daemon that holds the pipe but never answers'

/**
 * Birth a session and focus it. Resolves once the record is on the board
 * and the slot points at the session's connector (its first — empty —
 * read done, bounded by `firstPaintMs`). A landing in flight (the gate):
 * the face never yields to the boot menu under a birth.
 */
export function bornSession(req: BirthRequest): Promise<BirthOutcome> {
  return withLanding(birth(req))
}

async function birth(req: BirthRequest): Promise<BirthOutcome> {
  const { ensureOwnedDaemon } = await import('./ensureDaemon.js')
  if (!(await ensureOwnedDaemon())) return { ok: false, reason: DAEMON_DID_NOT_START }
  const facts = bootBirthFacts()
  const title = req.title !== undefined ? (req.title === null || req.title.trim() === '' ? null : req.title.trim()) : takeBootTitle()
  // THE WORN PRESET rides exactly THIS birth (L24(4)'s operator door):
  // consumed at entry, the takeBootTitle law — at-most-once (two racing
  // doors can never both wear it; a refused birth spends it, visibly —
  // re-arming is one keystroke on the kit screen).
  const worn = takeWornPresetKit()
  // The screen arm is NOTHING on a keyless home (screenBirthModel): a
  // keyless birth carries no model — the daemon admits it modelless.
  const model = birthModelOf(facts, req.model ?? null, screenBirthModel())
  let reply: Record<string, unknown>
  try {
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    reply = (await daemonControlRpc(
      {
        op: 'sessionAdmit',
        workspaceDir: req.workspaceDir,
        // THE SOLO IN-PLACE CLAIM (L19): a birth through this door is the
        // operator's own chat — it lands on the ground and coexists with
        // their other solo chats, exactly like resume; it never rides the
        // defaulted fold into a worktree (that estate belongs to
        // coordinator dispatches and explicit opt-ins).
        isolation: 'shared',
        // A KEYLESS birth carries NO model: the field is absent on the wire.
        ...(model !== undefined ? { model } : {}),
        bornBlank: true,
        ...(title !== null ? { title } : {}),
        ...(facts.effort !== null ? { effort: facts.effort } : {}),
        ...(facts.permissionMode !== null ? { permissionMode: facts.permissionMode } : {}),
        ...(facts.runnerArgv.length > 0 ? { runnerArgv: [...facts.runnerArgv] } : {}),
        // THE KIT (the L18 road): a WORN PRESET outranks the sticky menu
        // carry for this ONE birth (consumed above — the menu's default
        // resumes after); else the menu's next-session kit when the screen
        // set one; absent otherwise — never null.
        ...(worn !== null ? { kit: worn.kit } : carriedKitOf(facts)),
        ...(req.vacatingSessionId !== undefined ? { vacatingSessionId: req.vacatingSessionId } : {}),
      } as never,
      { timeoutMs: 30_000 },
    )) as Record<string, unknown>
  } catch (e) {
    return { ok: false, reason: `the daemon was unreachable — ${e instanceof Error ? e.message : String(e)}` }
  }
  const sessionId = typeof reply.sessionId === 'string' ? reply.sessionId : undefined
  if (reply.ok !== true || sessionId === undefined) {
    return { ok: false, reason: String(reply.error ?? 'the session could not start') }
  }
  // THE FIRST-CHAT STAMP (the folder-as-project law): the record is on the
  // board — a chat was born in this folder — so the catalog owner
  // initializes the folder's `.mercury/` estate and its project card here,
  // AFTER the admission and never before it (a refused birth stamps
  // nothing); idempotent after the first chat, fail-soft always.
  catalogFirstChat(req.workspaceDir, sessionId)
  // Born = registered: the record is on the board; the hop re-points the
  // slot at the session's own connector (the same road a board row takes).
  const hop = await hopIntoBoardSession(sessionId, req.firstPaintMs !== undefined ? { firstPaintMs: req.firstPaintMs } : undefined)
  if (!hop.ok) {
    logForDebugging(`[switchboard] born session ${sessionId} could not be entered: ${hop.reason}`)
    return { ok: false, reason: hop.reason }
  }
  return { ok: true, sessionId, title: hop.title }
}
