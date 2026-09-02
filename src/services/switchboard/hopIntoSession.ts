// ============================================================================
//  switchboard/hopIntoSession — THE HOP into a session, and the doors that
//  hand the focused slot a chat.
//
//  Every session is daemon-hosted and every chat on screen is one of them
//  (a chat exists only once a session does — the one-door law). The
//  board's ↵ on a row, /resume onto a running session, Boot › Continue
//  Session, a birth through bornSession: every road that lands the operator
//  in a session comes through here. The daemon's live record names the
//  session (its title, workspace, worktree, model); the focused slot
//  re-points at the session's connector; the caller flips the route. A
//  session with no live record resumes as a managed session (admit with
//  --resume) — its transcript paints first, the admission settles behind
//  it. Nothing is yielded, drained, killed, swapped or respawned.
// ============================================================================
import { statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { AwayRecapMetadata } from '../../types/message.js'
import { withLanding } from '../engine-connector/focusedConnector.js'
import { bootBirthFacts, carriedKitOf, peekWornPresetKit, takeWornPresetKit } from './bootBirthFacts.js'
import { mintImmediateReceipt } from '../../utils/model/seatReceipts.js'

/** The chat tag's LIVE derivation (L16 on the chat seat): the daemon's
 *  record title (minted or typed) wins, else the chat's own first words,
 *  else the stage-1 fact — the naming owner's one door, fed live. The
 *  records file is re-read only when its mtime moved; the first words, once
 *  found, never change (memoized per session). Exported for
 *  prove-chat-tag-live-title. */
export function liveTitleDeriverFor(
  supervisor: {
    readSessionWorkers: (dir?: string) => Record<string, { sessionId: string; title?: string }>
    concourseWorkersPath: (dir?: string) => string
  },
  titleOf: (rec: { title?: string; workspaceId: string }, briefOf: () => string | null) => string,
  briefLabel: (rec: { sessionId: string; workspaceId: string }, maxChars?: number) => string | null,
): (record: { sessionId: string; workspaceId: string; title: string }) => string | null {
  const briefs = new Map<string, string>()
  let recordsMtime = -1
  let titlesBySession = new Map<string, string | undefined>()
  return record => {
    try {
      const mtime = statSync(supervisor.concourseWorkersPath()).mtimeMs
      if (mtime !== recordsMtime) {
        recordsMtime = mtime
        titlesBySession = new Map()
        for (const rec of Object.values(supervisor.readSessionWorkers())) titlesBySession.set(rec.sessionId, rec.title)
      }
    } catch {
      // no records file yet — the words and the fact still answer
    }
    const stored = (titlesBySession.get(record.sessionId) ?? '').trim()
    const briefOf = (): string | null => {
      const memo = briefs.get(record.sessionId)
      if (memo !== undefined) return memo
      const found = briefLabel({ sessionId: record.sessionId, workspaceId: record.workspaceId }, 48)
      if (found !== null && found.trim().length > 0) briefs.set(record.sessionId, found.trim())
      return found
    }
    return titleOf({ title: stored, workspaceId: record.workspaceId }, briefOf)
  }
}

export type HopOutcome =
  | { ok: true; title: string }
  | { ok: false; reason: string }

/**
 * Re-point the focused slot at the session's connector. Resolves once the
 * session's records are on hand (the first read), bounded by `firstPaintMs`
 * so a slow read never delays the hand — the caller flips the route when
 * this settles. A landing in flight (the gate) — the face never yields to
 * the boot menu under it.
 */
export function hopIntoBoardSession(sessionId: string, opts?: { firstPaintMs?: number }): Promise<HopOutcome> {
  return withLanding(hopIntoBoardSessionLanding(sessionId, opts))
}

async function hopIntoBoardSessionLanding(sessionId: string, opts?: { firstPaintMs?: number }): Promise<HopOutcome> {
  const supervisor = await import('../../daemon/concourseSupervisor.js')
  const rec = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  if (!rec) return { ok: false, reason: 'no live session record owns this id' }
  const paths = await import('../../utils/sessionStorage/paths.js')
  const seat = await import('../engine-connector/daemonConnector.js')
  // SESSION-AWARE NAMING (L16): the chat's tag reads this record title —
  // the one owner's stages, never the worker short.
  const { sessionTitleOf } = await import('../concourse/sessionNaming.js')
  const { headBriefLabel } = await import('../concourse/concourseSnapshot.js')
  const title = sessionTitleOf(rec, () => headBriefLabel(rec, 48))
  // …and keeps reading it LIVE: the connector's status() asks this deriver
  // on every paint, so the tag walks the stages the board walks (the first
  // words, the minted or typed title) instead of freezing at this hop's
  // snapshot. The records file is re-read only when its mtime moved; the
  // first words, once found, never change.
  seat.registerLiveTitleDeriver(liveTitleDeriverFor(supervisor, sessionTitleOf, headBriefLabel))
  const hop = seat.focusDaemonSession({
    sessionId,
    runnerId: rec.runnerId,
    title,
    projectLabel: basename(rec.workspaceId) || rec.workspaceId,
    workspaceId: rec.workspaceId,
    home: paths.getProjectDir(rec.workspaceId),
    ...(rec.isolation !== undefined ? { isolation: rec.isolation } : {}),
    ...(rec.branchName !== undefined ? { branchLabel: rec.branchName } : {}),
    ...(rec.modelKey !== undefined ? { modelKey: rec.modelKey } : {}),
    ...(rec.effort !== undefined ? { effort: rec.effort } : {}),
    ...(rec.worktreePath !== undefined ? { worktreePath: rec.worktreePath } : {}),
  })
  // The flicker law: the records paint BEFORE the route flips (a ceiling so
  // a slow read never delays the hand). The slot re-points either way — and
  // the landing gate covers the tail: a transcript read slower than the
  // ceiling must not close the gate before the slot re-points, or the
  // caller's route flip refuses over a chat milliseconds from existing.
  await Promise.race([hop, new Promise<void>(r => setTimeout(r, opts?.firstPaintMs ?? 250))])
  void withLanding(hop.then(() => undefined)).catch(() => {})
  // The daemon heals in the background so the first typed words find it
  // awake — the records read without one.
  void import('./ensureDaemon.js')
    .then(m => m.ensureOwnedDaemon())
    .catch(() => {})
  return { ok: true, title }
}

export type ResumeOutcome = HopOutcome & {
  /** Settles when the daemon admitted the resume (true) or refused it
   *  (false); a session already live on the board settles true at once. */
  admitted: Promise<boolean>
  /** The daemon's own refusal sentence, null when admitted. */
  refusal: Promise<string | null>
}

/**
 * The no-live-runner notification, composed in ONE place (the operator's
 * ratified wording): the lead sentence says what is true and what happens
 * next, the reason follows in plain words (the daemon is starting / did
 * not start / refused the model — the refusal names it), and the action
 * closes. The daemon heals on the next message, so the line never orders
 * the operator to run anything by hand.
 */
export function composeNoRunnerLine(title: string, reason: string): string {
  const plain = /not ready/i.test(reason) ? 'the daemon is starting' : reason
  return `${title}: the session has no live runner — a replay revives it and delivers into the same chat · ${plain} · ↵ revives it`
}

/** The workspace a durable session worked in — its transcript head's cwd
 *  (the boot card's scan reads the same field); the current cwd is the
 *  honest fallback. */
async function workspaceOfTranscript(transcriptPath: string | undefined): Promise<string> {
  if (transcriptPath !== undefined) {
    try {
      // Bounded head read (one fd, first 8 KB) — the whole-file readFileSync
      // this replaces decoded a transcript of any size synchronously on the
      // cockpit thread just to keep 8192 chars, on THE ONE RESUME PATH. The
      // cwd field sits in the head entry; the title mint's HEAD_BYTES read
      // is the same idiom.
      const { open } = await import('node:fs/promises')
      const fh = await open(transcriptPath, 'r')
      let head: string
      try {
        const buf = Buffer.alloc(8192)
        const { bytesRead } = await fh.read(buf, 0, 8192, 0)
        head = buf.subarray(0, bytesRead).toString('utf8')
      } finally {
        await fh.close()
      }
      const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)
      if (m) return JSON.parse(`"${m[1]}"`) as string
    } catch {
      /* unreadable head — the fallback answers */
    }
  }
  const { getCwd } = await import('../../utils/cwd.js')
  return getCwd()
}

/**
 * THE ONE RESUME PATH — the reactivate door: Boot › Continue Session,
 * /resume, `--resume <id>`, `--continue` and ↵ on a PARKED board row all
 * bring a session back through here. A session live on the board is
 * entered (a hop — nothing resumes, nothing respawns). Otherwise the
 * session's transcript paints AT ONCE from its file (the connector attaches
 * and the slot re-points before this resolves) and the daemon REACTIVATES
 * the SAME durable session behind the paint: a standing record (parked by
 * the operator, crashed, stopped) comes back in place on its own record —
 * the warm pool's claim when the pool can serve it, the cold --resume
 * respawn otherwise — and a record-less transcript (history) admits as a
 * managed session; the first words typed wait for that admission. The
 * focus fact lands through the connector's attach and is said again once
 * the record stands (a record-less resume's first verb found nothing to
 * stamp). A refusal leaves the row parked with the daemon's sentence on it.
 * The recap paints as a display-only row, never in the model conversation.
 */
export function focusResumedSession(
  sessionId: string,
  transcriptPath: string | undefined,
  opts?: { title?: string; firstPaintMs?: number; permissionMode?: string },
): Promise<ResumeOutcome> {
  return withLanding(focusResumedSessionLanding(sessionId, transcriptPath, opts))
}

async function focusResumedSessionLanding(
  sessionId: string,
  transcriptPath: string | undefined,
  opts?: { title?: string; firstPaintMs?: number; permissionMode?: string },
): Promise<ResumeOutcome> {
  const supervisor = await import('../../daemon/concourseSupervisor.js')
  if (supervisor.sessionOwnedByLiveWorker(sessionId) !== null) {
    const hop = await hopIntoBoardSession(sessionId, opts)
    return { ...hop, admitted: Promise.resolve(hop.ok), refusal: Promise.resolve(hop.ok ? null : hop.reason) }
  }
  // A STANDING record names the session's workspace, home, title and model
  // — the door reads them from the record, never from the screen's cwd; a
  // record-less transcript (history) reads its own head.
  const standing = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  const workspaceDir = standing?.workspaceId ?? (await workspaceOfTranscript(transcriptPath))
  const paths = await import('../../utils/sessionStorage/paths.js')
  const seat = await import('../engine-connector/daemonConnector.js')
  // The resumed chat's name under L16's precedence: the caller's word (a
  // parked row hands its brief), else the standing record's stored title,
  // else the transcript's own first words, else the id's head — never a
  // worker short.
  const { headBriefLabel } = await import('../concourse/concourseSnapshot.js')
  const title = opts?.title ?? standing?.title ?? headBriefLabel({ sessionId, workspaceId: workspaceDir }, 48) ?? sessionId.slice(0, 8)
  const connector = seat.daemonSessionConnectorFor({
    sessionId,
    // The daemon's record names the worker once the admission settles (a
    // reactivate may move the record onto the claimed runner's short).
    runnerId: standing?.runnerId ?? '',
    title,
    projectLabel: basename(workspaceDir) || workspaceDir,
    workspaceId: workspaceDir,
    home:
      standing !== undefined
        ? paths.getProjectDir(standing.workspaceId)
        : transcriptPath !== undefined
          ? dirname(transcriptPath)
          : paths.getProjectDir(workspaceDir),
    ...(standing?.isolation !== undefined ? { isolation: standing.isolation } : {}),
    ...(standing?.branchName !== undefined ? { branchLabel: standing.branchName } : {}),
    ...(standing?.modelKey !== undefined ? { modelKey: standing.modelKey } : {}),
    ...(standing?.effort !== undefined ? { effort: standing.effort } : {}),
    ...(standing?.worktreePath !== undefined ? { worktreePath: standing.worktreePath } : {}),
  })
  // The admission runs behind the paint; the connector's first delivery
  // waits for it.
  // The refusal, when there is one, is the daemon's own sentence (the model
  // the session ran on is refused today, the workspace is held, …).
  const refusal = (async (): Promise<string | null> => {
    try {
      const { ensureOwnedDaemon } = await import('./ensureDaemon.js')
      if (!(await ensureOwnedDaemon())) return 'the daemon did not start'
      const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
      // A WORN PRESET rides the resume too (the both-doors law's operator
      // half: the operator armed it, then picked this session — that IS
      // the intent; the re-stamp takes the preset's kit instead of the
      // menu's). PEEKED, not consumed: for a LIVE session the daemon
      // answers `liveHop: true` — a pure hop re-stamps nothing and must
      // never spend the wear — so the one-shot is consumed below only
      // when this admission actually applied it.
      const worn = peekWornPresetKit()
      const reply = (await daemonControlRpc(
        // The operator's RESOLVED posture rides EVERY resume as it rides
        // the first message — from the caller when it says (the argv
        // boots), else from the next-session facts (L18: the face's
        // Continue, the picker and the parked row are the same door) — the
        // session runs the mode the screen shows, never the seat's own
        // convention. Its model and effort stay the session's OWN: a
        // resume is not a birth. THE KIT is the opposite (L24(3)): the
        // menu's current kit rides the resume when the screen set one, and
        // the daemon RE-STAMPS the standing record from it (else derives) —
        // a re-started transcript reloads with the new boot menu applied.
        // THE SOLO IN-PLACE CLAIM (L19) rides the resume exactly as it
        // rides the birth: a record-less resume lands on the ground beside
        // the operator's other solo chats — never the defaulted fold's
        // worktree. A STANDING record ignores the field (the reactivate
        // converges on the record's own claim).
        { op: 'sessionAdmit', workspaceDir, resumeSessionId: sessionId, isolation: 'shared', ...((): Record<string, string> => { const mode = opts?.permissionMode ?? bootBirthFacts().permissionMode ?? undefined; return mode !== undefined ? { permissionMode: mode } : {} })(), ...(worn !== null ? { kit: worn.kit } : carriedKitOf(bootBirthFacts())) } as never,
        { timeoutMs: 30_000 },
      )) as Record<string, unknown>
      if (reply.ok !== true) return typeof reply.error === 'string' && reply.error !== '' ? reply.error : 'the daemon refused the resume'
      // THE RETAINED MODEL'S RECEIPT: a resume admitted without the model it
      // ran on (no credential for its family here) names the dropped model
      // and its door on the screen-receipt seam — the chat's transcript
      // takes the row (queued until the chat subscribes).
      if (typeof reply.note === 'string' && reply.note !== '') mintImmediateReceipt(`▲ ${reply.note}`, 'warning')
      // The one-shot spends ONLY when the admission applied it: a live hop
      // (`liveHop: true`) re-stamped nothing — the wear stays armed; a
      // refused resume above kept it armed the same way.
      if (worn !== null && reply.liveHop !== true) takeWornPresetKit()
      // The daemon's own record lands on the connector (the claimed worker
      // short, the title, the model) WITHOUT re-pointing the slot: the
      // admission settles behind the paint and the operator may have hopped
      // on — a late admission must never yank the bridge back here (the
      // last-chosen session owns the slot). The connector is keyed by
      // session id, so the adoption refreshes the one the slot may still
      // hold; one that lost the slot meanwhile keeps the facts for its next
      // hop and stays detached.
      const settled = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
      if (settled === undefined) return 'no live session record owns this id'
      seat.daemonSessionConnectorFor({
        sessionId,
        runnerId: settled.runnerId,
        title: settled.title ?? title,
        projectLabel: basename(settled.workspaceId) || settled.workspaceId,
        workspaceId: settled.workspaceId,
        home: paths.getProjectDir(settled.workspaceId),
        ...(settled.isolation !== undefined ? { isolation: settled.isolation } : {}),
        ...(settled.branchName !== undefined ? { branchLabel: settled.branchName } : {}),
        ...(settled.modelKey !== undefined ? { modelKey: settled.modelKey } : {}),
        ...(settled.effort !== undefined ? { effort: settled.effort } : {}),
        ...(settled.worktreePath !== undefined ? { worktreePath: settled.worktreePath } : {}),
      })
      // THE FOCUS FACT MOVES WITH THE REACTIVATE: the record stands now —
      // the connector says the verb again through the one chain (attach-
      // gated: a connector that lost the slot says nothing).
      connector.assertSeat()
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })()
  connector.awaitAdmission(refusal)
  const admitted = refusal.then(r => r === null)
  // The flicker law: the records paint BEFORE the caller flips the route.
  const pointed = seat.focusDaemonSession(connector.record)
  await Promise.race([pointed, new Promise<void>(r => setTimeout(r, opts?.firstPaintMs ?? 250))])
  // The landing gate covers the tail (the ceiling fired first): the caller's
  // route flip must not refuse over a slot milliseconds from re-pointing.
  void withLanding(pointed.then(() => undefined)).catch(() => {})
  void paintResumeRecap(sessionId)
  void paintReactivationScheduleWarn(sessionId)
  return { ok: true, title, admitted, refusal }
}

export type CloseOutcome =
  | { ok: true; closed: boolean; sessionId: string | null; fate: 'parked' | 'draining' | 'released' | 'ended' | 'none' }
  | { ok: false; reason: string }

/**
 * THE ONE CLOSE PATH (the control-plane model, law 3 — close-all empties
 * the bridge): the focused chat leaves the screen. The record takes its
 * fate at the daemon — PARKED by default (a closed chat is parked: its
 * runner retires after its own turn, the row reads "parked · <age>", ↵
 * brings it back; a newborn is released instead) or ENDED for the
 * operator's own final release (x-x) — then the slot rests, which detaches
 * the connector and so says the blur through the one chain, and the chat
 * stop leaves the strip. Where the frame lands is the caller's (the REPL's
 * own yield settles the absent chat on the boot menu; the board stays the
 * board). A daemon that cannot be reached parks nothing here — the owned
 * daemon parks the estate at its own orphan reap — but the chat still
 * closes on screen.
 */
export async function closeFocusedChat(opts: { fate: 'park' | 'end' }): Promise<CloseOutcome> {
  const slot = await import('../engine-connector/focusedConnector.js')
  if (!slot.hasFocusedSession()) return { ok: true, closed: false, sessionId: null, fate: 'none' }
  const sessionId = slot.getFocusedSessionConnector().sessionId()
  let fate: Extract<CloseOutcome, { ok: true }>['fate'] = 'none'
  const supervisor = await import('../../daemon/concourseSupervisor.js')
  const rec = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  if (rec !== undefined) {
    try {
      const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
      if (opts.fate === 'end') {
        await daemonControlRpc({ op: 'sessionControl', action: 'stop', sessionId, by: 'operator' } as never, { timeoutMs: 15_000 })
        const released = (await daemonControlRpc({ op: 'sessionRelease', runnerId: rec.runnerId } as never, { timeoutMs: 15_000 })) as { ok?: boolean; settled?: boolean }
        if (released.ok === true && released.settled !== false) fate = 'ended'
      } else {
        const parked = (await daemonControlRpc(
          { op: 'sessionControl', action: 'park', sessionId, by: `operator:${process.pid}` } as never,
          { timeoutMs: 15_000 },
        )) as { ok?: boolean; outcome?: string; detail?: string }
        if (parked.ok === true) {
          fate = parked.outcome === 'draining' ? 'draining' : parked.outcome === 'applied' && (parked.detail ?? '').startsWith('released') ? 'released' : parked.outcome === 'applied' || parked.outcome === 'noop' ? 'parked' : 'none'
        }
      }
    } catch {
      /* the daemon reconciles on its own (the orphan reap parks the estate); the chat closes on screen either way */
    }
  }
  slot.releaseFocusedSessionConnector()
  return { ok: true, closed: true, sessionId, fate }
}

/**
 * /clear on the focused chat — "start fresh": the focused session PARKS
 * (law 1: a /clear'd chat is parked — on the board, reactivatable; its
 * transcript survives) and a FRESH session is born for the same workspace
 * on the same model and takes the slot — blank, ready, on the board (the
 * one-door law: a fresh chat IS a fresh session). No chat open ⇒ nothing
 * to clear. A session mid-turn is never dropped under the operator's feet:
 * the refusal names the one action that unblocks it. Birth FIRST, park
 * AFTER (the deliberate order — a failed birth must never strand the
 * operator chat-less), riding the SEAT-SWAP (operator-sighted):
 * the birth names the session it replaces, admission counts that seat as
 * leaving, so /clear works on a FULL capacity world instead of demanding a
 * third seat. A birth the daemon refuses for a NON-capacity reason still
 * answers with the daemon's own sentence — and the old chat stays focused,
 * parked only after a landed birth, never lost.
 */
export async function clearFocusedSession(): Promise<{ ok: true; cleared: boolean } | { ok: false; reason: string }> {
  const slot = await import('../engine-connector/focusedConnector.js')
  if (!slot.hasFocusedSession()) return { ok: true, cleared: false }
  const focused = slot.getFocusedSessionConnector()
  if (focused.turnActive()) {
    return { ok: false, reason: 'this session is mid-turn — esc to interrupt it, then /clear' }
  }
  const workspaceDir = focused.workspace().cwd
  const model = focused.modelFacts().effective
  const oldSessionId = focused.sessionId()
  // Birth FIRST, park AFTER: the born hop swaps the slot straight onto the
  // fresh chat, so the screen never has a released-slot moment for the
  // plain world to mount the Boot face into (park-then-birth landed on the
  // face: the release dropped the frame before the birth's landing gate
  // armed). A failed birth now moves NOTHING — the old chat stays focused.
  const { bornSession } = await import('./bornSession.js')
  const born = await bornSession({ workspaceDir, model, vacatingSessionId: oldSessionId })
  if (!born.ok) {
    return { ok: false, reason: `a fresh session could not start, so this one stands — ${born.reason}` }
  }
  await parkSessionById(oldSessionId)
  // The cleared mark's ONE writer, finally wired: every 'cleared' surface
  // downstream (the lanes rail, the session tabs, the picker's isCleared
  // filter) read a mark NOTHING ever recorded — /clear dropped the session
  // and the pickers kept offering it as if the operator never closed it.
  const { markSessionCleared } = await import('../../utils/sessionStorage/clearedSessions.js')
  markSessionCleared(oldSessionId)
  return { ok: true, cleared: true }
}

/** Park one session by id at the daemon — the /clear tail for the chat the
 *  born hop just swapped away from (fire-and-reconcile like the focused
 *  close: a failed RPC leaves the daemon's own orphan reap to settle it). */
async function parkSessionById(sessionId: string): Promise<void> {
  const supervisor = await import('../../daemon/concourseSupervisor.js')
  const rec = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
  if (rec === undefined) return
  try {
    const { daemonControlRpc } = await import('../../daemon/controlSocket.js')
    await daemonControlRpc({ op: 'sessionControl', action: 'park', sessionId, by: `operator:${process.pid}` } as never, { timeoutMs: 15_000 })
  } catch {
    /* the daemon reconciles on its own (the orphan reap parks the estate) */
  }
}

/** SATURN fork (ii)'s paint (SCREEN-owed, landed here): schedules RETAIN
 *  across reactivation — nothing re-stamps them — so a session coming back
 *  through the one resume door says when its retained fires would NOT run
 *  today. ONE display-only row (the away recap's own road), composed from
 *  THE ONE VERDICT over live facts (never a re-derived judgment; the
 *  engine re-preflights per tick regardless); a ready world paints
 *  nothing. Fail-soft everywhere — the warn is a courtesy, never a block. */
async function paintReactivationScheduleWarn(sessionId: string): Promise<void> {
  try {
    const supervisor = await import('../../daemon/concourseSupervisor.js')
    const rec = Object.values(supervisor.readSessionWorkers()).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    const schedules = rec?.schedules ?? []
    if (schedules.length === 0) return
    const { saturnNextFireMs } = await import('../../daemon/saturn.js')
    const { readLiveAccountFacts, scheduleAccountVerdict } = await import('../../daemon/saturnAccount.js')
    const now = Date.now()
    // The most severe non-ready verdict across the standing schedules —
    // the verdict function's own order (signed-out, with 'unreachable' its
    // keyless twin · expired · rate-limited · expiring); paused rows never
    // fire, so they never warn.
    const rank = { 'signed-out': 4, unreachable: 4, expired: 3, 'rate-limited': 2, expiring: 1, ready: 0 } as const
    let worst: import('../../daemon/saturn.js').ScheduleAccountVerdictV1 | null = null
    for (const s of schedules) {
      if (s.paused === true) continue
      const verdict = scheduleAccountVerdict({
        account: s.account,
        nextFireMs: saturnNextFireMs(s.when, now),
        nowMs: now,
        live: readLiveAccountFacts(s.account),
      })
      if (verdict.state !== 'ready' && (worst === null || rank[verdict.state] > rank[worst.state])) worst = verdict
    }
    if (worst === null) return
    const seat = await import('../engine-connector/daemonConnector.js')
    const connector = seat.getDaemonSessionConnector(sessionId)
    if (connector === undefined) return
    const sentence =
      worst.state === 'signed-out'
        ? 'signed out — /logins connects an account, or due fires hold'
        : worst.state === 'unreachable'
          ? 'no local server answering — start it (or set MERCURY_LOCAL_BASE_URL), or due fires hold'
          : worst.state === 'expired'
          ? 'sign-in expired — re-login now (/logins) or due fires hold'
          : worst.state === 'rate-limited'
            ? 'rate-limited — due fires hold until the window ends'
            : "the sign-in's known expiry lands before the next fire — re-login by then or it fires held"
    const count = schedules.length
    const { createSystemMessage } = await import('../../utils/messages/systemMessages.js')
    connector.addDisplayRow(
      createSystemMessage(`${count} schedule${count === 1 ? '' : 's'} retained — ${sentence}`, 'warning') as never,
    )
  } catch {
    /* the warn is a courtesy — never blocks the hop */
  }
}

/** The away recap for a resumed session — a display-only row (buildAwayRecap
 *  over the session's records + its workspace's git delta), gated by the
 *  away-summary setting; fail-soft everywhere. */
async function paintResumeRecap(sessionId: string): Promise<void> {
  try {
    const { isAwaySummaryEnabled, buildAwayRecap } = await import('../../utils/cockpit/awaySummary.js')
    if (!isAwaySummaryEnabled()) return
    const seat = await import('../engine-connector/daemonConnector.js')
    const connector = seat.getDaemonSessionConnector(sessionId)
    if (connector === undefined) return
    // The records land on the reader's first paint; bounded wait.
    const t0 = Date.now()
    while (Date.now() - t0 < 3000 && connector.records().length === 0) {
      await new Promise(r => setTimeout(r, 100))
    }
    const records = [...connector.records()]
    if (records.length === 0) return
    let gitDelta: { files: number; added: number; removed: number } | null = null
    try {
      const { execFileNoThrowWithCwd } = await import('../../utils/execFileNoThrow.js')
      const result = await execFileNoThrowWithCwd('git', ['diff', '--shortstat', 'HEAD'], { cwd: connector.workspace().cwd })
      const m = /(\d+) files? changed(?:, (\d+) insertions?...)?(?:, (\d+) deletions?...)?/.exec(result.stdout ?? '')
      if (m) gitDelta = { files: Number(m[1]), added: Number(m[2] ?? 0), removed: Number(m[3] ?? 0) }
    } catch {
      gitDelta = null
    }
    const recap = buildAwayRecap(records, Date.now(), gitDelta)
    if (!recap) return
    // The card's branch/dirty/cert fields are gathered HERE (sync + cheap) so
    // the renderer stays props-pure (the Law 9 hoist had dropped them — the
    // card rendered without its branch, uncommitted and doctor-cert rows).
    // Cert state 'off' means NO cert fields at all; a missing verdict reports
    // as 'none'.
    const { readBranchHeadSync } = await import('../../utils/cockpit/branchHeadSync.js')
    const { healthCertSnapshot } = await import('../../utils/cockpit/healthCertSnapshot.js')
    const branch = readBranchHeadSync(connector.workspace().cwd)
    const dirtyCount = gitDelta?.files
    const dirtyDelta =
      gitDelta && (gitDelta.added !== 0 || gitDelta.removed !== 0)
        ? `+${gitDelta.added}/-${gitDelta.removed}`
        : undefined
    const cert = healthCertSnapshot()
    const certFields =
      cert.state === 'off'
        ? {}
        : {
            certVerdict: cert.data.verdict ?? 'none',
            certAgeMs: cert.data.ageMs ?? undefined,
          }
    const enriched: AwayRecapMetadata = {
      endedOnError: recap.endedOnError,
      turns: recap.turns,
      filesTouched: recap.filesTouched,
      ...(recap.toolFailures > 0 ? { toolFailures: recap.toolFailures } : {}),
      topTools: recap.topTools,
      ...(recap.lastActiveGapMs !== undefined ? { lastActiveGapMs: recap.lastActiveGapMs } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(dirtyCount !== undefined ? { dirtyCount } : {}),
      ...(dirtyDelta !== undefined ? { dirtyDelta } : {}),
      ...certFields,
    }
    const { createAwaySummaryMessage } = await import('../../utils/messages/systemMessages.js')
    connector.addDisplayRow(createAwaySummaryMessage(recap.line, enriched) as never)
  } catch {
    /* the recap is a courtesy — never blocks the hop */
  }
}
