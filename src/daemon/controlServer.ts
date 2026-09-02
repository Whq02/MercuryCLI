// The control server — the RPC face of the daemon supervisor.
//
// Owns the unix socket at controlSockPath() and answers the protocol over
// it, one newline-framed request per connection:
//
//   keyless : ping | nudge | shutdown | leases | hello
//   then    : readiness gate (ESTARTING) → version gate (EPROTO)
//   keyed   : everything else, control-key checked
//
// Policy is deliberately absent from this layer. Auth and request SHAPE are
// checked here; intent then flows to the host through ControlServerDeps.
// Spawn specs, admission rules, and permission floors are composed on the
// host side, which means no request a key-holder can craft will ever widen
// what a worker is allowed to do. Terminal attach is not in the protocol; a
// client sending `attach` anyway receives the runtime's honest ENOTSUP
// explanation.
//
// Nothing here ever listens on a network interface — loopback unix socket only.

import { refuseRunnerArgv } from '../services/switchboard/runnerArgv.js'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { logForDebugging } from '../utils/debug.js'
import type { DaemonBreaker } from '../utils/daemonBreaker.js'
import { flagEnv, setFlagEnv } from '../substrate/flagRegistry.js'
import {
  CONTROL_FRAME_CAP,
  MERCURY_DAEMON_PROTO,
  MIN_PROTO,
  encodeFrame,
  readControlFrame,
  type DaemonHelloFacts,
  type DaemonReply,
  type LeaseClient,
  type SessionRewindMode,
  type SessionRewindOutcomeV1,
} from './protocol.js'
import {
  controlSockPath,
  currentVersion,
  ownsControlPlaneSync,
  supervisorStatePath,
  verifyControlAuth,
} from './controlSocket.js'
import { isProcessAlive } from './ownerWatch.js'
import { validateSessionKit, validateSessionKitEdit, type SessionKitEditV1, type SessionKitV1 } from './sessionKit.js'
import { validateSaturnSubmission, SATURN_ID_PATTERN, type ScheduleOpRequestV1 } from './saturn.js'
import { parseBusEnvelope } from '../utils/swarm/busEnvelopes.js'
import { canonicalizeBusTarget, isManagedBusTeam, knownBusTargets } from '../utils/scribe/busIdentity.js'
import { writeToMailbox } from '../utils/teammateMailbox.js'
import type { TaskRoster } from './roster.js'
import { attachToJobPty } from './runPtyHost.js'

/** Everything the server borrows from its host supervisor. */
export interface ControlServerDeps {
  roster: TaskRoster
  breaker: DaemonBreaker
  /** Scheduling dir, reported in the status snapshot. */
  dir: string
  /** epoch-ms of supervisor boot, for the uptime figure. */
  startedAt: number
  /** Concurrency ceiling for dispatched runs, for status. */
  maxInflight: number
  /** The secret every keyed op has to present. */
  controlKey: string
  /** Turns true once adoption / lock work is finished; until then the keyed
   *  tier answers ESTARTING. */
  isReady: () => boolean
  /** Runs the `shutdown` op; returns the reap count AND the reaped
   *  workers by name/purpose so the stop client can report honestly. */
  onShutdown: (reapWorkers: boolean) => {
    reaped: number
    workers: Array<{ short: string; kind: 'long-lived' | 'one-shot'; purpose: string; pid?: number }>
  }
  /** The host's version fact + idleness for the `hello` handshake
   *  (daemon/handshake.ts is the client half). Missing ⇒ the wire constants
   *  alone, with zero counts. */
  hello?: () => DaemonHelloFacts
  /** `restart-when-idle`: the host re-executes itself now (idle) or arms the
   *  restart for its next idle moment; a foreground daemon refuses. Missing
   *  ⇒ ENOTSUP. */
  restartWhenIdle?: (by: string) => { state: 'restarting' | 'armed' | 'refused'; live: number; detail?: string }
  /** Pokes a back-agent's dispatch drain right after an `envelope` op lands
   *  work in its journal — delivery in microseconds instead of at inbox-
   *  watcher cadence. */
  nudgeAgent?: (agentName: string) => void
  /** Boots a named crew teammate (op 'crewSpawn'). Auth and shape are the
   *  server's job; gate, floor-stamped spec, team file and drain all belong
   *  to the host — spawn policy has exactly one owner, and it is not the
   *  protocol layer. Missing ⇒ ENOTSUP. */
  crewSpawn?: (name: string, modelKey: string) => Promise<{ ok: boolean; pid?: number; error?: string }>
  /** Seats a session worker under the daemon-enforced runtime lease. Same
   *  split as crewSpawn: the server checks auth + shape, while workspace
   *  canonicalization, lease accounting, durable records and the scrubbed
   *  worker spec are all host concerns. Missing ⇒ ENOTSUP. */
  concourseAdmit?: (req: {
    effort?: string
    workspaceDir: string
    isolation?: 'exclusive' | 'shared' | 'worktree-isolated' | 'read-only'
    modelKey?: string
    title?: string
    /** The validated kit the admission carries (daemon/sessionKit.ts). */
    kit?: SessionKitV1
    /** A saved preset's name: the host derives from ITS
     *  deltas; unknown/damaged refuses typed. */
    kitPreset?: string
    /** The /clear seat-swap: the live session this birth replaces — its
     *  claim leaves the admission fold (concourseSupervisor field law). */
    vacatingSessionId?: string
  }) => Promise<
    | {
        ok: true
        runnerId: string
        sessionId: string
        workspaceId: string
        pid?: number
        /** The carved fork + the model the session runs on — the same
         *  receipt facts the dispatch door's answer carries. */
        branchName?: string
        mainHolderTitle?: string
        modelId?: string
        modelDisplayName?: string
        /** The effort the session started at — the receipt fact beside the
         *  model (the chain-of-custody law). */
        effort?: string
        /** Twins under ONE truth, never both: kitSource ⟺ a kit stamp ran;
         *  liveHop ⟺ a pure hop onto a LIVE record — nothing
         *  re-stamped (the worn one-shot is not spent). */
        kitSource?: 'carried' | 'derived' | 'preset'
        liveHop?: true
        /** The worn preset + its honesty note (kitSource 'preset' only). */
        presetName?: string
        presetNote?: string
      }
    | { ok: false; error: string; code: string }
  >
  /** Idempotent prompt→session dispatch: a clientMessageId reservation lands
   *  first; admit + stdin delivery are composed by the host. */
  concourseDispatch?: (req: {
    clientMessageId: string
    prompt: string
    workspaceDir: string
    isolation?: 'exclusive' | 'worktree-isolated' | 'read-only'
    modelKey?: string
    effort?: string
    title?: string
    agentName?: string
    seatsMax?: 1 | 2
    resumeSessionId?: string
    /** Redirect into an already-live session (no admit runs). */
    targetSessionId?: string
    /** The seat's extras: the composer mode, the queue band, rich content. */
    mode?: 'prompt' | 'bash' | 'task-notification'
    agentId?: string
    priority?: 'now' | 'next' | 'later'
    content?: unknown[]
    by?: string
    /** A saved preset's name, forwarded to the admit. */
    kitPreset?: string
  }) => Promise<{
    ok: boolean
    clientMessageId: string
    state: string
    stateRevision: number
    runnerId?: string
    sessionId?: string
    error?: string
    replay?: string
    /** Typed hold + its executable moves, riding refusal receipts. */
    heldReason?: string
    heldByTitle?: string
    moves?: Array<{ verb: string; label: string }>
    /** A branch created to satisfy the dispatch names itself on the receipt. */
    branchName?: string
    mainHolderTitle?: string
    /** The model the admitted session runs on — every launch receipt names it. */
    modelId?: string
    modelDisplayName?: string
    /** The effort the admitted session started at — named beside the model. */
    effort?: string
    /** Where the admitted session's kit came from (admit-new road). */
    kitSource?: 'carried' | 'derived' | 'preset'
    /** The worn preset + its honesty note (kitSource 'preset' only). */
    presetName?: string
    presetNote?: string
  }>
  /** Bounded atomic summary of the session workers (records ∩ roster truth). */
  concourseList?: () => ReadonlyArray<Record<string, unknown>>
  /** Takes a queued or held dispatch off the board from INSIDE the ledger
   *  mutex — a direct file write from the UI process would race whatever
   *  dispatch is in flight. */
  concourseWithdraw?: (clientMessageId: string) => Promise<boolean>
  /** Kills the runner if live and settles its record exactly once. */
  concourseRelease?: (runnerId: string) => { settled: boolean; killed: boolean }
  /** Pre-spawns (or keeps) the ONE warm session runner for a workspace —
   *  the warm-runner pool's arming door (daemon/warmRunner.ts). Missing ⇒
   *  ENOTSUP. */
  concourseWarm?: (req: { workspaceDir: string; retiring?: string; bootCarriesRunnerOptions?: boolean; kit?: SessionKitV1 }) => Promise<{
    state: 'warmed' | 'kept' | 'refused'
    detail?: string
  }>
  /** Warm runners alive right now — the status op's honest count. */
  warmRunnerCount?: () => number
  /** Session-control verbs: the host resolves the worker from its sessionId
   *  and adjudicates, returning a typed outcome. pause/resume operate the
   *  delivery valve; interrupt cancels the worker's CURRENT turn on the
   *  child's own control channel — not a kill, not a valve change. */
  concourseControl?: (req: {
    action:
      | 'pause'
      | 'resume'
      | 'interrupt'
      | 'attach'
      | 'detach'
      | 'grant-workflows'
      | 'revoke-workflows'
      | 'answer-permission'
      | 'stop'
      | 'set-model'
      | 'set-permission-mode'
      | 'session-facts'
      | 'set-title'
      | 'focus'
      | 'blur'
      | 'park'
      | 'park-all'
      | 'set-effort'
      | 'contract'
      | 'set-kit'
      | 'set-schedule'
    sessionId: string
    by: string
    reason?: string
    /** answer-permission: which parked ask, and the verdict. */
    requestId?: string
    allow?: boolean
    /** answer-permission: the consent card's full answer. */
    answer?: { updatedInput?: Record<string, unknown>; permissionUpdates?: unknown[]; feedback?: string; interrupt?: boolean }
    /** set-model / set-effort / set-permission-mode payloads
     *  (effort's value grammar is the child's set_effort control). */
    model?: string
    effort?: string
    mode?: string
    /** set-title: the session's new title and who names it (L16). */
    title?: string
    titleSource?: 'operator' | 'minted'
    /** contract: the advisory contract op (sessionContract.ts — text rides
     *  set/amend only; nothing ever gates on a contract). */
    contract?: { op: 'set' | 'ack' | 'amend' | 'close'; text?: string }
    /** set-kit: the validated dial edits (daemon/sessionKit.ts). */
    kitEdit?: SessionKitEditV1
    /** set-schedule: SATURN's op (daemon/saturn.ts — an 'add' submission is
     *  server-validated and the writer re-validates; the account is always
     *  daemon-derived, never this payload's to claim). */
    scheduleEdit?: ScheduleOpRequestV1
    /** detach: mint time of the hand-back marker — one older than the
     *  newest attach grant is refused rather than respawned. */
    mintedAtMs?: number
    /** Durable op identity: a replayed id yields the stored receipt with no
     *  re-execution. interrupt mutates state, so recovering from a lost
     *  response depends on this; the attach/detach/grant/revoke verbs are
     *  state-idempotent and never touch the ledger. */
    clientOpId?: string
  }) => { outcome: 'applied' | 'noop' | 'refused' | 'draining' | 'queued'; detail?: string }
  /** The /rewind verb (v5): the host forwards a rewind_session control to
   *  the session's own runner and AWAITS its typed answer — the one op
   *  whose adjudicator lives in the child, so the dependency is async
   *  (the sessionAdmit shape, not sessionControl's synchronous one).
   *  Missing ⇒ ENOTSUP. */
  sessionRewind?: (req: {
    sessionId: string
    by: string
    mode: SessionRewindMode
    userMessageId: string
    dryRun?: boolean
  }) => Promise<SessionRewindOutcomeV1>
}

export interface ControlServerHandle {
  close(): Promise<void>
  /** Self-heal: bind the socket again after its path disappeared. */
  rebind(): Promise<void>
  leaseCount(): number
}

/** Emit one newline-framed JSON reply, then end the connection. */
function answer(sock: net.Socket, payload: DaemonReply): void {
  if (sock.destroyed) return
  sock.end(encodeFrame(payload))
}

/**
 * Peer-uid gate, best-effort. Node offers no portable way to read peer
 * credentials off this socket, so on most platforms the connecting uid is
 * simply unknowable. The degradation is deliberate: the socket sits under
 * the user's own config home behind owner-only ancestry, and no network
 * listener exists — so an uncheckable uid yields "allowed" instead of
 * locking the owner out of their own daemon. A runtime that can probe peer
 * credentials would return its rejection text from here.
 */
function peerUidRejection(_sock: net.Socket): string | null {
  return null
}

/**
 * Bring the control server up: bind the socket, wire per-connection framing,
 * and route each request through {@link routeControlRequest}. The returned
 * handle closes it, re-binds it, and exposes the live lease count.
 */
export async function startControlServer(
  deps: ControlServerDeps,
): Promise<ControlServerHandle> {
  const sockPath = controlSockPath()
  // Remove whatever socket a crashed predecessor left behind. This is safe
  // only because our caller already holds the per-home supervisor lock: as
  // that lock's sole owner, any socket file we find can only be dead — the
  // lock would have refused our startup if its owner were alive.
  await unlink(sockPath).catch(() => {})

  const conns = new Set<net.Socket>()
  const leases = new Map<net.Socket, LeaseClient>()

  const server = net.createServer(sock => {
    sock.on('error', () => sock.destroy())
    sock.setTimeout(30_000, () => sock.destroy())
    conns.add(sock)
    sock.once('close', () => {
      conns.delete(sock)
      leases.delete(sock)
    })

    const uidErr = peerUidRejection(sock)
    if (uidErr) {
      answer(sock, { ok: false, code: 'EPEERUID', error: uidErr })
      return
    }

    readControlFrame(
      sock,
      line => {
        sock.setTimeout(0)
        void routeControlRequest(deps, leases, sock, line).catch(err => {
          // Painted on operator surfaces as refusal detail: typed
          // attribution, message preserved (the message IS the diagnostic),
          // never a bare stringified Error.
          answer(sock, {
            ok: false,
            code: 'EUNKNOWN',
            error: `daemon error — ${err instanceof Error ? err.message : String(err)}`,
          })
        })
      },
      () => {
        answer(sock, {
          ok: false,
          code: 'ETOOLARGE',
          error: `request exceeds ${CONTROL_FRAME_CAP >> 20}MB — shorten the prompt or send in parts`,
        })
      },
    )
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    logForDebugging(`[daemon] control server error: ${err}`)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(sockPath, () => {
      server.removeListener('error', reject)
      logForDebugging(`[daemon] control server listening at ${sockPath}`)
      resolve()
    })
  })

  return {
    close: () =>
      new Promise<void>(resolve => {
        for (const c of conns) c.destroy()
        server.close(() => {
          // Delete only what is still OURS: when a predecessor's shutdown
          // races a successor's fresh bind, the loser must not take the
          // winner's live socket down with it.
          if (ownsControlPlaneSync()) void unlink(sockPath).catch(() => {})
          resolve()
        })
      }),
    // The heal half: this same server binds its socket again when the path
    // has vanished underneath it. Open conns are killed — each one is a
    // single RPC anyway — and the next connect finds the fresh node.
    rebind: () =>
      new Promise<void>(resolve => {
        for (const c of conns) c.destroy()
        server.close(() => {
          // Same ownership rule as close(): a foreign LIVE daemon that took
          // the plane during our await gap keeps its socket — this beat
          // stands down and a later beat re-examines.
          if (!ownsControlPlaneSync()) {
            let foreignLive = false
            try {
              const raw = JSON.parse(readFileSync(supervisorStatePath(), 'utf8')) as { pid?: number }
              foreignLive =
                typeof raw?.pid === 'number' && raw.pid !== process.pid && isProcessAlive(raw.pid)
            } catch {
              foreignLive = false
            }
            if (foreignLive) {
              logForDebugging('[daemon] rebind aborted — a live foreign pid owns the plane')
              resolve()
              return
            }
          }
          // Even a failed listen settles the promise — otherwise one bad
          // rebind wedges every heal beat queued after it.
          server.once('error', err => {
            logForDebugging(`[daemon] rebind listen failed (next beat retries): ${err}`)
            resolve()
          })
          void unlink(sockPath)
            .catch(() => {})
            .then(() => {
              server.listen(sockPath, () => {
                logForDebugging(`[daemon] control server re-bound at ${sockPath} (self-heal)`)
                resolve()
              })
            })
        })
      }),
    leaseCount: () => leases.size,
  }
}

/**
 * THE SESSION-OP ALIAS TABLE (the two-phase wire-rename recipe, phase 1 at
 * proto 3 — Law 9: the daemon hosts SESSIONS). Exactly the five renamed
 * spellings, old → new, routed onto ONE handler each — never a second
 * handler, and never an alias for any other verb (concourseWithdraw /
 * concourseWarm keep their names; the L16 set-title and park family are new
 * verbs with no old spelling). Replies echo the asker's own spelling.
 * RETIREMENT (written, not executed): delete this table — and the
 * concourse* reply literals in protocol.ts — at proto 4, when no serving
 * daemon below proto 3 can exist; the shape hash forces that bump to be
 * conscious.
 */
const SESSION_OP_ALIASES: Record<string, string> = {
  concourseAdmit: 'sessionAdmit',
  concourseDispatch: 'sessionDispatch',
  concourseList: 'sessionList',
  concourseRelease: 'sessionRelease',
  concourseControl: 'sessionControl',
}

/**
 * The op router: keyless frames first, then the readiness gate, the version
 * gate, and behind those the keyed ops.
 */
async function routeControlRequest(
  deps: ControlServerDeps,
  leases: Map<net.Socket, LeaseClient>,
  sock: net.Socket,
  line: string,
): Promise<void> {
  let raw: { op?: string; [k: string]: unknown }
  try {
    raw = JSON.parse(line)
  } catch {
    return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'bad json' })
  }
  if (!raw || typeof raw !== 'object') {
    return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'bad json' })
  }
  // The asker's spelling is kept for the reply echo; the alias table folds
  // the old session-op names onto the canonical handlers.
  const requestedOp = raw.op
  const op = requestedOp !== undefined ? (SESSION_OP_ALIASES[requestedOp] ?? requestedOp) : requestedOp

  // --- keyless, version-exempt frames --------------------------------------
  if (op === 'ping') {
    return answer(sock, {
      ok: true,
      op: 'ping',
      version: currentVersion(),
      proto: MERCURY_DAEMON_PROTO,
    })
  }
  if (op === 'hello') {
    // The handshake answers in EVERY state: before the readiness gate, so a
    // client can compare versions while the daemon is still adopting, and
    // outside the version gate — a client of another version must be able
    // to ask, which is the whole point.
    const facts = deps.hello?.()
    logForDebugging(
      `[daemon] hello from client v${typeof raw.clientVersion === 'string' ? raw.clientVersion : '?'} proto ${
        typeof raw.proto === 'number' ? raw.proto : '?'
      } (this daemon v${currentVersion()} proto ${MERCURY_DAEMON_PROTO})`,
    )
    return answer(sock, {
      ok: true,
      op: 'hello',
      proto: MERCURY_DAEMON_PROTO,
      minProto: MIN_PROTO,
      ready: deps.isReady(),
      version: facts?.version ?? currentVersion(),
      buildTree: facts?.buildTree ?? null,
      pid: process.pid,
      startedAt: facts?.startedAt ?? deps.startedAt,
      ownerPid: facts?.ownerPid ?? null,
      foreground: facts?.foreground ?? false,
      live: facts?.live ?? 0,
      liveSessions: facts?.liveSessions ?? 0,
      warm: facts?.warm ?? 0,
      restartArmed: facts?.restartArmed ?? false,
    })
  }
  if (op === 'nudge') {
    return answer(sock, {
      ok: true,
      op: 'nudge',
      restarting: false,
      version: currentVersion(),
    })
  }
  if (op === 'leases') {
    return answer(sock, { ok: true, op: 'leases', clients: Array.from(leases.values()) })
  }
  if (op === 'shutdown') {
    const reapWorkers = raw.reapWorkers !== false
    const { reaped, workers } = deps.onShutdown(reapWorkers)
    return answer(sock, { ok: true, op: 'shutdown', reaped, workers })
  }

  // --- readiness gate ------------------------------------------------------
  if (!deps.isReady()) {
    return answer(sock, {
      ok: false,
      code: 'ESTARTING',
      error: 'daemon starting (adoption / lock acquisition in progress)',
    })
  }

  // --- version gate --------------------------------------------------------
  const proto = raw.proto
  if (
    typeof proto !== 'number' ||
    !Number.isInteger(proto) ||
    proto < MIN_PROTO ||
    proto > MERCURY_DAEMON_PROTO
  ) {
    return answer(sock, {
      ok: false,
      code: 'EPROTO',
      error: `proto mismatch (server=${MERCURY_DAEMON_PROTO}, client=${
        typeof proto === 'number' ? proto : -1
      }) — daemon and CLI versions differ; restart Mercury`,
      serverProto: MERCURY_DAEMON_PROTO,
      serverVersion: currentVersion(),
    })
  }

  // --- keyed ops -----------------------------------------------------------
  const auth = typeof raw.auth === 'string' ? raw.auth : undefined

  switch (op) {
    case 'list':
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      return answer(sock, { ok: true, op: 'list', jobs: deps.roster.list() })

    case 'has': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      const short = String(raw.short ?? '')
      const h = deps.roster.has(short)
      return answer(sock, { ok: true, op: 'has', ...h })
    }

    case 'status': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      const now = Date.now()
      const sup = deps.roster.getSupervisorState()
      return answer(sock, {
        ok: true,
        op: 'status',
        status: {
          pid: process.pid,
          version: currentVersion(),
          startedAt: deps.startedAt,
          uptimeSec: Math.floor((now - deps.startedAt) / 1000),
          dir: deps.dir,
          // The workers numbers exclude the warm pool (FC-087): an
          // unclaimed warm runner has its OWN honest line below — counting
          // it live too made an idle daemon read 1 live / 2 rostered, one
          // process wearing both of the numbers an operator reads to
          // decide whether anything still runs.
          workersLive: Math.max(
            0,
            deps.roster.liveCount() - (deps.warmRunnerCount !== undefined ? deps.warmRunnerCount() : 0),
          ),
          workersTotal: Math.max(
            0,
            deps.roster.totalCount() - (deps.warmRunnerCount !== undefined ? deps.warmRunnerCount() : 0),
          ),
          maxInflight: deps.maxInflight,
          breakerOpen: deps.breaker.shouldSuppressFire(),
          leaseCount: leases.size,
          proto: MERCURY_DAEMON_PROTO,
          degraded: sup.degraded,
          degradedReason: sup.degraded ? sup.reason : undefined,
          ...(deps.warmRunnerCount !== undefined ? { warmRunners: deps.warmRunnerCount() } : {}),
        },
      })
    }

    case 'dispatch': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      const body = raw.d
      if (!body || typeof body !== 'object' || typeof (body as { prompt?: unknown }).prompt !== 'string') {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'dispatch requires { d: { prompt } }' })
      }
      const out = await deps.roster.dispatch(body as Parameters<TaskRoster['dispatch']>[0])
      if (!out.ok) {
        return answer(sock, {
          ok: false,
          code: out.code ?? 'EUNKNOWN',
          error: out.error ?? 'dispatch failed',
        })
      }
      return answer(sock, { ok: true, op: 'dispatch', short: out.short, pid: out.pid, via: out.via })
    }

    case 'reply': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      const short = String(raw.short ?? '')
      const text = String(raw.text ?? '')
      const h = deps.roster.has(short)
      if (!h.present) {
        return answer(sock, { ok: false, code: 'ENOJOB', error: 'job not found — it may have already exited' })
      }
      const accepted = await deps.roster.reply(short, text)
      if (!accepted) {
        return answer(sock, {
          ok: false,
          code: 'ENOREPLY',
          error: "job isn't accepting replies — headless runs have no interactive stdin",
        })
      }
      return answer(sock, { ok: true, op: 'reply' })
    }

    case 'kill': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      const short = String(raw.short ?? '')
      const signal = (typeof raw.signal === 'string' ? raw.signal : 'SIGTERM') as NodeJS.Signals
      const killed = deps.roster.kill(short, signal)
      if (!killed) {
        return answer(sock, { ok: false, code: 'ENOJOB', error: 'job not found — it may have already exited' })
      }
      return answer(sock, { ok: true, op: 'kill' })
    }

    case 'envelope': {
      // Bus ingress over the keyed socket. Holding the control key proves
      // same-uid (that is all a 0600 file can prove) — it does NOT prove
      // dispatcher ROLE. Role is guarded solely by the from!==recipient
      // test further down, and a same-uid process forging any other `from`
      // clears both hurdles. In trust terms the socket therefore equals the
      // file bus it fronts (that journal was same-uid-writable all along);
      // what it contributes is the journal write, the sub-ms nudge, and a
      // single envelope schema.
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      const rawTo = String(raw.to ?? '')
      const team = typeof raw.team === 'string' && raw.team ? raw.team : 'default'
      // Canonicalize the address at the ingress (layered with the
      // sender-side resolve): journaling to an alias mints a dead-letter
      // inbox that no drain will ever read. Aliases resolve; a name a
      // managed team has never heard of is bounced, and the caller learns
      // loudly rather than having its work stranded.
      const resolvedTo = canonicalizeBusTarget(team, rawTo)
      if (rawTo && !resolvedTo.known && isManagedBusTeam(team)) {
        return answer(sock, {
          ok: false,
          code: 'EUNKNOWN',
          error: `unknown bus address '${rawTo}' for team '${team}' — valid: ${knownBusTargets(team).join(', ')}`,
        })
      }
      const to = resolvedTo.name
      let env: ReturnType<typeof parseBusEnvelope> = null
      try {
        env = parseBusEnvelope(JSON.stringify(raw.env))
      } catch {
        env = null
      }
      if (!to || !env) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'envelope requires { to, env: <bus envelope> }' })
      }
      // Role invariant at the door: work and directives are by definition
      // dispatcher-authored — even a key-holder may not sign them as the
      // recipient itself (that is role confusion, or a compromised child
      // replaying the key it can read).
      if (
        (env.kind === 'dispatch' || env.kind === 'control' || env.kind === 'note') &&
        (!env.from || env.from === to)
      ) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: `a ${env.kind} envelope must carry a dispatcher 'from', never the recipient itself` })
      }
      // Journal before anything else: the mailbox is the at-least-once
      // replay source, so a daemon that dies right after this write still
      // delivers on its next boot.
      const journaled = await writeToMailbox(
        to,
        {
          from: env.from,
          text: JSON.stringify(env),
          timestamp: new Date().toISOString(),
          ...(typeof raw.color === 'string' && raw.color ? { color: raw.color } : {}),
        },
        team,
      )
      if (!journaled) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'envelope journal write failed' })
      }
      // Fast path: poke the recipient's drain right now — the inbox watcher
      // would find it within ~50ms regardless; this shaves that to sub-ms.
      try {
        deps.nudgeAgent?.(to)
      } catch (e) {
        logForDebugging(`[daemon] envelope nudge for ${to} threw (ignored): ${e}`)
      }
      return answer(sock, { ok: true, op: 'envelope', journaled })
    }

    case 'reconfigure': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      const short = String(raw.short ?? '')
      const model = typeof raw.model === 'string' ? raw.model : undefined
      const effort = typeof raw.effort === 'string' ? raw.effort : undefined
      // Confirm the target exists in the roster BEFORE acting — a retarget
      // aimed at a bogus short must fail ENOJOB and write nothing.
      if (!deps.roster.has(short).present) {
        return answer(sock, {
          ok: false,
          code: 'ENOJOB',
          error:
            'not a long-lived worker — reconfigure only retargets a supervised seat',
        })
      }
      const r = deps.roster.reconfigureLongLived(short, { model, effort })
      if (!r.ok) {
        return answer(sock, {
          ok: false,
          code: 'ENOJOB',
          error: r.error ?? 'not a long-lived worker — reconfigure only retargets a supervised seat',
        })
      }
      // `note` is optional-additive: the seat validator's honest refusal or
      // adjustment reason; clean patches carry none. No auth/version impact.
      return answer(sock, { ok: true, op: 'reconfigure', respawned: r.respawned, pending: r.pending, note: r.note })
    }

    case 'crewSpawn': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.crewSpawn) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host crew teammates' })
      }
      const name = String(raw.name ?? '')
      const modelKey = String(raw.model ?? '')
      // Only shape is checked here; the HOST re-validates everything against
      // its allowlists — spawn policy never lives in the protocol layer.
      if (!name || !modelKey) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'crewSpawn requires { name, model }' })
      }
      const r = await deps.crewSpawn(name, modelKey)
      if (!r.ok) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: r.error ?? 'crew spawn refused' })
      }
      return answer(sock, { ok: true, op: 'crewSpawn', pid: r.pid })
    }

    case 'sessionAdmit': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.concourseAdmit) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      const workspaceDir = String(raw.workspaceDir ?? '')
      if (!workspaceDir) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'sessionAdmit requires { workspaceDir }' })
      }
      // Shape narrowing only; admission policy is the host's re-validated
      // domain, not the protocol layer's.
      const isolation =
        raw.isolation === 'exclusive' || raw.isolation === 'shared' || raw.isolation === 'worktree-isolated' || raw.isolation === 'read-only'
          ? raw.isolation
          : undefined
      // The runner-side options: only what the one table names crosses.
      if (raw.runnerArgv !== undefined) {
        const refusal = refuseRunnerArgv(raw.runnerArgv)
        if (refusal !== null) return answer(sock, { ok: false, code: 'EUNKNOWN', error: `runnerArgv refused — ${refusal}` })
      }
      // THE KIT (daemon/sessionKit.ts): the exact shape or a TYPED refusal —
      // a malformed kit dropped silently would birth whole-config, a leak
      // of scope. Absent stays absent (the daemon derives from the menu).
      let kit: SessionKitV1 | undefined
      if (raw.kit !== undefined) {
        const verdict = validateSessionKit(raw.kit)
        if (!verdict.ok) return answer(sock, { ok: false, code: 'EUNKNOWN', error: `kit refused — ${verdict.reason}` })
        kit = verdict.kit
      }
      // THE PRESET NAME: shape narrowing only — a non-string
      // or empty spelling refuses typed (a silent drop would birth the menu
      // default under a name the caller asked for); existence and the
      // grammar are the host's re-validated domain.
      if (raw.kitPreset !== undefined && (typeof raw.kitPreset !== 'string' || raw.kitPreset === '')) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'kitPreset must be a saved preset name (a non-empty string)' })
      }
      const r = await deps.concourseAdmit({
        workspaceDir,
        ...(isolation !== undefined ? { isolation } : {}),
        ...(typeof raw.model === 'string' && raw.model ? { modelKey: raw.model } : {}),
        ...(typeof raw.effort === 'string' && raw.effort ? { effort: raw.effort } : {}),
        ...(typeof raw.title === 'string' && raw.title ? { title: raw.title } : {}),
        ...(typeof raw.agentName === 'string' && raw.agentName ? { agentName: raw.agentName } : {}),
        ...(raw.seatsMax === 1 || raw.seatsMax === 2 ? { seatsMax: raw.seatsMax } : {}),
        // A resume names the durable session it brings back (the admit
        // door's own field — the dispatch door forwards it the same way).
        ...(typeof raw.resumeSessionId === 'string' && raw.resumeSessionId ? { resumeSessionId: raw.resumeSessionId } : {}),
        ...(typeof raw.permissionMode === 'string' && raw.permissionMode ? { permissionMode: raw.permissionMode as never } : {}),
        ...(Array.isArray(raw.runnerArgv) && raw.runnerArgv.length > 0 ? { runnerArgv: raw.runnerArgv as string[] } : {}),
        ...(raw.bornBlank === true ? { bornBlank: true } : {}),
        ...(kit !== undefined ? { kit } : {}),
        ...(typeof raw.kitPreset === 'string' && raw.kitPreset !== '' ? { kitPreset: raw.kitPreset } : {}),
        // The /clear seat-swap hint (shape narrowing only; the host judges
        // liveness — a stale hint is inert there, never a refusal here).
        ...(typeof raw.vacatingSessionId === 'string' && raw.vacatingSessionId !== '' ? { vacatingSessionId: raw.vacatingSessionId } : {}),
      })
      if (!r.ok) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: r.error, refusal: r.code })
      }
      return answer(sock, {
        ok: true,
        op: requestedOp === 'concourseAdmit' ? 'concourseAdmit' : 'sessionAdmit',
        runnerId: r.runnerId,
        // Legacy mirror for proto≤2 readers — dropped at proto 4.
        workerId: r.runnerId,
        sessionId: r.sessionId,
        workspaceId: r.workspaceId,
        pid: r.pid,
        // A birth is a launch: its receipt names the fork and the model the
        // way the dispatch door's answer does — a born-blank launch was the
        // one door whose receipt could name neither.
        ...(r.branchName !== undefined ? { branchName: r.branchName } : {}),
        ...(r.mainHolderTitle !== undefined ? { mainHolderTitle: r.mainHolderTitle } : {}),
        ...(r.modelId !== undefined ? { modelId: r.modelId } : {}),
        ...(r.modelDisplayName !== undefined ? { modelDisplayName: r.modelDisplayName } : {}),
        ...(r.effort !== undefined ? { effort: r.effort } : {}),
        // The twins cross the wire under one truth, never both: where the
        // kit came from when a stamp ran (the launch receipts
        // name it), or the pure-hop fact when nothing was re-stamped
        // (the client's worn one-shot preset stays armed).
        ...(r.kitSource !== undefined ? { kitSource: r.kitSource } : {}),
        ...(r.liveHop === true ? { liveHop: true } : {}),
        ...(r.presetName !== undefined ? { presetName: r.presetName } : {}),
        ...(r.presetNote !== undefined ? { presetNote: r.presetNote } : {}),
      })
    }

    case 'concourseWithdraw': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.concourseWithdraw) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      const clientMessageId = String(raw.clientMessageId ?? '')
      if (!clientMessageId) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'concourseWithdraw requires { clientMessageId }' })
      }
      const withdrawn = await deps.concourseWithdraw(clientMessageId)
      return answer(sock, { ok: true, op: 'concourseWithdraw', withdrawn })
    }

    case 'concourseWarm': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.concourseWarm) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      const warmWorkspaceDir = String(raw.workspaceDir ?? '')
      if (!warmWorkspaceDir) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'concourseWarm requires { workspaceDir }' })
      }
      // THE KIT (daemon/sessionKit.ts): the exact shape or a TYPED refusal —
      // the sessionAdmit arm's own law at the pool's arming door. Absent
      // stays absent (the ensure derives from the menu).
      let warmKit: SessionKitV1 | undefined
      if (raw.kit !== undefined) {
        const verdict = validateSessionKit(raw.kit)
        if (!verdict.ok) return answer(sock, { ok: false, code: 'EUNKNOWN', error: `kit refused — ${verdict.reason}` })
        warmKit = verdict.kit
      }
      const warm = await deps.concourseWarm({
        workspaceDir: warmWorkspaceDir,
        ...(typeof raw.retiring === 'string' && raw.retiring !== '' ? { retiring: raw.retiring } : {}),
        ...(raw.runnerOptionsPresent === true ? { bootCarriesRunnerOptions: true } : {}),
        ...(warmKit !== undefined ? { kit: warmKit } : {}),
      })
      return answer(sock, { ok: true, op: 'concourseWarm', state: warm.state, ...(warm.detail !== undefined ? { detail: warm.detail } : {}) })
    }
    case 'sessionDispatch': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.concourseDispatch) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      const clientMessageId = String(raw.clientMessageId ?? '')
      const prompt = String(raw.prompt ?? '')
      const workspaceDir = String(raw.workspaceDir ?? '')
      const targetSessionId = typeof raw.targetSessionId === 'string' && raw.targetSessionId ? raw.targetSessionId : undefined
      // A redirect goes to a session that already exists — no admit, so no
      // workspace requirement (the record has one).
      if (!clientMessageId || !prompt || (!workspaceDir && targetSessionId === undefined)) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'sessionDispatch requires { clientMessageId, prompt, workspaceDir } (workspaceDir optional with targetSessionId)' })
      }
      const isolation =
        raw.isolation === 'exclusive' || raw.isolation === 'worktree-isolated' || raw.isolation === 'read-only'
          ? raw.isolation
          : undefined
      // An isolation value from outside the closed set is a TYPED refusal —
      // quietly defaulting would run the session under a sharing posture the
      // caller never picked.
      if (raw.isolation !== undefined && isolation === undefined) {
        return answer(sock, {
          ok: false,
          code: 'EUNKNOWN',
          error: `unknown isolation '${String(raw.isolation)}' — the closed vocabulary is exclusive | worktree-isolated | read-only`,
        })
      }
      if (raw.runnerArgv !== undefined) {
        const refusal = refuseRunnerArgv(raw.runnerArgv)
        if (refusal !== null) return answer(sock, { ok: false, code: 'EUNKNOWN', error: `runnerArgv refused — ${refusal}` })
      }
      if (raw.kitPreset !== undefined && (typeof raw.kitPreset !== 'string' || raw.kitPreset === '')) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'kitPreset must be a saved preset name (a non-empty string)' })
      }
      const r = await deps.concourseDispatch({
        clientMessageId,
        prompt,
        workspaceDir,
        ...(isolation !== undefined ? { isolation } : {}),
        ...(typeof raw.model === 'string' && raw.model ? { modelKey: raw.model } : {}),
        ...(typeof raw.effort === 'string' && raw.effort ? { effort: raw.effort } : {}),
        ...(typeof raw.title === 'string' && raw.title ? { title: raw.title } : {}),
        // Forwarded on the LIVE submit path, not only on admit — the typed
        // agent/seats have to reach the worker record.
        ...(typeof raw.agentName === 'string' && raw.agentName ? { agentName: raw.agentName } : {}),
        ...(raw.seatsMax === 1 || raw.seatsMax === 2 ? { seatsMax: raw.seatsMax } : {}),
        ...(typeof raw.resumeSessionId === 'string' && raw.resumeSessionId ? { resumeSessionId: raw.resumeSessionId } : {}),
        ...(typeof raw.by === 'string' && raw.by ? { by: raw.by } : {}),
        ...(typeof raw.permissionMode === 'string' && raw.permissionMode ? { permissionMode: raw.permissionMode as never } : {}),
        ...(Array.isArray(raw.runnerArgv) && raw.runnerArgv.length > 0 ? { runnerArgv: raw.runnerArgv as string[] } : {}),
        ...(targetSessionId !== undefined ? { targetSessionId } : {}),
        // The seat's extras ride only in their closed vocabularies.
        ...(raw.mode === 'bash' || raw.mode === 'prompt' || raw.mode === 'task-notification' ? { mode: raw.mode } : {}),
        ...(raw.mode === 'task-notification' && typeof raw.agentId === 'string' && raw.agentId !== '' ? { agentId: raw.agentId } : {}),
        ...(raw.priority === 'now' || raw.priority === 'next' || raw.priority === 'later' ? { priority: raw.priority } : {}),
        ...(Array.isArray(raw.content) && raw.content.length > 0 ? { content: raw.content } : {}),
        // The preset name forwards to the admit; a non-string
        // spelling refuses above the dispatch the same way a bad isolation
        // does — never a silent menu-default birth.
        ...(typeof raw.kitPreset === 'string' && raw.kitPreset !== '' ? { kitPreset: raw.kitPreset } : {}),
      })
      if (!r.ok) {
        // A refusal still reports the ledger row's durable state: a held
        // dispatch is 'queued' + held, and the receipt has to say so on its
        // own — the caller is never sent back to the ledger file.
        return answer(sock, {
          ok: false,
          code: 'EUNKNOWN',
          error: r.error ?? 'dispatch refused',
          refusal: r.replay,
          state: r.state,
          stateRevision: r.stateRevision,
          // Typed hold + executable moves, on the wire.
          ...(r.heldReason !== undefined ? { heldReason: r.heldReason } : {}),
          ...(r.heldByTitle !== undefined ? { heldByTitle: r.heldByTitle } : {}),
          ...(r.moves !== undefined ? { moves: r.moves } : {}),
        })
      }
      return answer(sock, {
        ok: true,
        op: requestedOp === 'concourseDispatch' ? 'concourseDispatch' : 'sessionDispatch',
        clientMessageId: r.clientMessageId,
        state: r.state,
        stateRevision: r.stateRevision,
        runnerId: r.runnerId,
        // Legacy mirror for proto≤2 readers — dropped at proto 4.
        workerId: r.runnerId,
        sessionId: r.sessionId,
        replay: r.replay,
        // A branch created to satisfy the dispatch names itself here.
        ...(r.branchName !== undefined ? { branchName: r.branchName } : {}),
        ...(r.mainHolderTitle !== undefined ? { mainHolderTitle: r.mainHolderTitle } : {}),
        // The model the session runs on, so every launch receipt can name it.
        ...(r.modelId !== undefined ? { modelId: r.modelId } : {}),
        ...(r.modelDisplayName !== undefined ? { modelDisplayName: r.modelDisplayName } : {}),
        ...(r.effort !== undefined ? { effort: r.effort } : {}),
        // Where the admitted session's kit came from, and the
        // preset it wore when the dispatch named one.
        ...(r.kitSource !== undefined ? { kitSource: r.kitSource } : {}),
        ...(r.presetName !== undefined ? { presetName: r.presetName } : {}),
        ...(r.presetNote !== undefined ? { presetNote: r.presetNote } : {}),
      })
    }

    case 'sessionControl': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.concourseControl) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      const action =
        raw.action === 'pause' ||
        raw.action === 'resume' ||
        raw.action === 'interrupt' ||
        raw.action === 'attach' ||
        raw.action === 'detach' ||
        raw.action === 'grant-workflows' ||
        raw.action === 'revoke-workflows' ||
        raw.action === 'answer-permission' ||
        raw.action === 'stop' ||
        raw.action === 'set-model' ||
        raw.action === 'set-permission-mode' ||
        raw.action === 'session-facts' ||
        raw.action === 'set-title' ||
        raw.action === 'focus' ||
        raw.action === 'blur' ||
        raw.action === 'park' ||
        raw.action === 'park-all' ||
        raw.action === 'set-effort' ||
        raw.action === 'contract' ||
        raw.action === 'set-kit' ||
        raw.action === 'set-schedule'
          ? raw.action
          : undefined
      const sessionId = String(raw.sessionId ?? '')
      const by = String(raw.by ?? '')
      if (action === undefined || !sessionId || !by) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'sessionControl requires { action: pause|resume|interrupt|attach|detach|grant-workflows|revoke-workflows|answer-permission|stop|set-model|set-permission-mode|session-facts|set-title|focus|blur|park|park-all|set-effort|contract|set-kit|set-schedule, sessionId, by }' })
      }
      const rawAnswer = raw.answer && typeof raw.answer === 'object' && !Array.isArray(raw.answer) ? (raw.answer as Record<string, unknown>) : undefined
      const answerPayload =
        rawAnswer !== undefined
          ? {
              ...(rawAnswer.updatedInput && typeof rawAnswer.updatedInput === 'object' && !Array.isArray(rawAnswer.updatedInput)
                ? { updatedInput: rawAnswer.updatedInput as Record<string, unknown> }
                : {}),
              ...(Array.isArray(rawAnswer.permissionUpdates) ? { permissionUpdates: rawAnswer.permissionUpdates } : {}),
              ...(typeof rawAnswer.feedback === 'string' ? { feedback: rawAnswer.feedback.slice(0, 4000) } : {}),
              ...(rawAnswer.interrupt === true ? { interrupt: true } : {}),
            }
          : undefined
      const rawContract = raw.contract && typeof raw.contract === 'object' && !Array.isArray(raw.contract) ? (raw.contract as Record<string, unknown>) : undefined
      const contract =
        rawContract?.op === 'set' || rawContract?.op === 'ack' || rawContract?.op === 'amend' || rawContract?.op === 'close'
          ? {
              op: rawContract.op as 'set' | 'ack' | 'amend' | 'close',
              // The wire's own bound (the verb re-caps with CONTRACT_TEXT_CAP).
              ...(typeof rawContract.text === 'string' ? { text: rawContract.text.slice(0, 20_000) } : {}),
            }
          : undefined
      // THE KIT'S DIALS (daemon/sessionKit.ts): the exact edit shape or a
      // typed refusal — never a cast-through, never a silent drop.
      let kitEdit: SessionKitEditV1 | undefined
      if (raw.kitEdit !== undefined) {
        const verdict = validateSessionKitEdit(raw.kitEdit)
        if (!verdict.ok) return answer(sock, { ok: false, code: 'EUNKNOWN', error: `kitEdit refused — ${verdict.reason}` })
        kitEdit = verdict.edit
      }
      // SATURN's door (daemon/saturn.ts): the op grammar and — for 'add' —
      // the submission narrow HERE, typed; the one writer re-validates with
      // the same validator (one grammar, two call sites, zero drift). The
      // payload forwards RAW: the writer's rebuild is the canonical copy,
      // and the daemon's stamps (id, account, preflight) are never the
      // wire's to claim.
      let scheduleEdit: ScheduleOpRequestV1 | undefined
      if (raw.scheduleEdit !== undefined) {
        const rawSchedule =
          raw.scheduleEdit && typeof raw.scheduleEdit === 'object' && !Array.isArray(raw.scheduleEdit)
            ? (raw.scheduleEdit as Record<string, unknown>)
            : undefined
        const op =
          rawSchedule?.op === 'add' || rawSchedule?.op === 'remove' || rawSchedule?.op === 'pause' || rawSchedule?.op === 'resume'
            ? rawSchedule.op
            : undefined
        if (rawSchedule === undefined || op === undefined) {
          return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'scheduleEdit refused — op must be add|remove|pause|resume' })
        }
        if (op === 'add') {
          const verdict = validateSaturnSubmission(rawSchedule.schedule)
          if (!verdict.ok) return answer(sock, { ok: false, code: 'EUNKNOWN', error: `scheduleEdit refused — ${verdict.reason}` })
          scheduleEdit = { op, schedule: rawSchedule.schedule }
        } else {
          const scheduleId = typeof rawSchedule.scheduleId === 'string' ? rawSchedule.scheduleId : ''
          if (!SATURN_ID_PATTERN.test(scheduleId)) {
            return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'scheduleEdit refused — scheduleId must be eight hex characters' })
          }
          scheduleEdit = { op, scheduleId }
        }
      }
      const r = deps.concourseControl({
        action,
        sessionId,
        by,
        ...(typeof raw.reason === 'string' && raw.reason ? { reason: raw.reason } : {}),
        ...(typeof raw.requestId === 'string' && raw.requestId ? { requestId: raw.requestId.slice(0, 128) } : {}),
        ...(typeof raw.allow === 'boolean' ? { allow: raw.allow } : {}),
        ...(answerPayload !== undefined ? { answer: answerPayload } : {}),
        ...(typeof raw.model === 'string' && raw.model ? { model: raw.model.slice(0, 128) } : {}),
        ...(typeof raw.effort === 'string' && raw.effort ? { effort: raw.effort.slice(0, 32) } : {}),
        ...(typeof raw.mode === 'string' && raw.mode ? { mode: raw.mode.slice(0, 64) } : {}),
        ...(typeof raw.title === 'string' && raw.title ? { title: raw.title.slice(0, 200) } : {}),
        ...(raw.titleSource === 'operator' || raw.titleSource === 'minted' ? { titleSource: raw.titleSource } : {}),
        ...(contract !== undefined ? { contract } : {}),
        ...(kitEdit !== undefined ? { kitEdit } : {}),
        ...(scheduleEdit !== undefined ? { scheduleEdit } : {}),
        ...(typeof raw.clientOpId === 'string' && raw.clientOpId ? { clientOpId: raw.clientOpId.slice(0, 128) } : {}),
        ...(typeof raw.mintedAtMs === 'number' && Number.isFinite(raw.mintedAtMs) ? { mintedAtMs: raw.mintedAtMs } : {}),
      })
      return answer(sock, { ok: true, op: requestedOp === 'concourseControl' ? 'concourseControl' : 'sessionControl', outcome: r.outcome, ...(r.detail !== undefined ? { detail: r.detail } : {}) })
    }

    case 'sessionRewind': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.sessionRewind) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      const sessionId = String(raw.sessionId ?? '')
      const by = String(raw.by ?? '')
      const mode = raw.mode === 'code' || raw.mode === 'conversation' || raw.mode === 'both' ? raw.mode : undefined
      const userMessageId = typeof raw.userMessageId === 'string' ? raw.userMessageId.slice(0, 128) : ''
      if (!sessionId || !by || mode === undefined || !userMessageId) {
        return answer(sock, {
          ok: false,
          code: 'EUNKNOWN',
          error: 'sessionRewind requires { sessionId, by, mode: code|conversation|both, userMessageId }',
        })
      }
      // Shape narrowing only; the runner adjudicates (the point's existence,
      // the checkpoint, drift, the compaction fold) and answers typed.
      const r = await deps.sessionRewind({
        sessionId,
        by,
        mode,
        userMessageId,
        ...(raw.dryRun === true ? { dryRun: true } : {}),
      })
      return answer(sock, { ok: true, op: 'sessionRewind', ...r })
    }

    case 'sessionList': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.concourseList) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      return answer(sock, { ok: true, op: requestedOp === 'concourseList' ? 'concourseList' : 'sessionList', workers: deps.concourseList() })
    }

    case 'sessionRelease': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.concourseRelease) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      // TOLERATED LEGACY SPELLING (R2, wire read side): a proto≤2 client
      // sends `workerId`; it retires with the alias table (proto 4).
      const runnerId = String(raw.runnerId ?? raw.workerId ?? '')
      if (!runnerId) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'sessionRelease requires { runnerId }' })
      }
      const r = deps.concourseRelease(runnerId)
      return answer(sock, { ok: true, op: requestedOp === 'concourseRelease' ? 'concourseRelease' : 'sessionRelease', settled: r.settled, killed: r.killed })
    }

    case 'restart-when-idle': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.restartWhenIdle) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon cannot restart itself' })
      }
      // Shape only: whether the restart happens now, later or never is the
      // host's reading of its own roster.
      const by = typeof raw.by === 'string' && raw.by !== '' ? raw.by.slice(0, 64) : 'client'
      const r = deps.restartWhenIdle(by)
      return answer(sock, {
        ok: true,
        op: 'restart-when-idle',
        state: r.state,
        live: r.live,
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
      })
    }

    // Outside the protocol — but a client that asks gets the real capability
    // answer instead of a generic unknown-op.
    case 'attach': {
      const short = String(raw.short ?? '')
      const a = attachToJobPty(short)
      return answer(sock, { ok: false, code: 'ENOTSUP', error: a.ok ? '' : a.error })
    }

    default:
      return answer(sock, { ok: false, code: 'EUNKNOWN', error: `unknown op: ${String(op)}` })
  }
}

/** The one EAUTH shape every keyed op answers when the key check fails. */
function refuseAuth(sock: net.Socket, op: string): void {
  answer(sock, {
    ok: false,
    code: 'EAUTH',
    error: `${op} rejected: this client didn't present the daemon control key`,
  })
}
