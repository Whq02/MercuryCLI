import { createHash, randomUUID } from 'node:crypto'
import { SESSION_VERBS } from '../../../daemon/runner-wire/sessionVerbs.js'
import { BASH_INPUT_TAG } from '../../message-shapes/messageTags.js'
import type { Message } from '../../message-shapes/message.js'
import type { ContentBlockParam } from '../../message-shapes/wire.js'
import type { PastedContent } from '../../../platform/config/schema.js'
import { createUserMessage } from '../../message-shapes/factories.js'
import { submitTrace } from '../../../screen/chat/submitTrace.js'
import type { SendReceiptV1, SendWordsOptions, WithdrawReceiptV1 } from '../types.js'
import { connectorTrace, REFUSED_EMPTY, type SeatSend } from './shared.js'
import { startTimeout, stopTimeout } from '../../../platform/async/timers.js'
import { controlFrame } from './controlCarrier.js'

const PENDING_WITHDRAW_WAIT_MS = 10_000
const UNCONFIRMED_LINE = 'Delivery is not confirmed. Sending the same draft again checks the original message.'

interface DeliveryNeeds {
  sessionId(): string
  factsBusy(): boolean
  folding(): boolean
  paint(): void
  wakeLive(): void
  openQuestion(): Promise<string | null>
  admissionPending(): Promise<string | null> | null
  sendDelivered(): void
  assertSeat(): void
  rpc(req: Record<string, unknown>): Promise<Record<string, unknown>>
  chainRpc(req: Record<string, unknown>): Promise<Record<string, unknown>>
  imageBlocks(pastes: Record<number, PastedContent>): Array<
    | ContentBlockParam
    | { type: 'image'; source: { type: 'mercury-stored-image'; path: string; media_type: string; sha256: string; imageId: number } }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  >
  lostLine(words: string): string
  recallTakenLine: string
  recallUnknownLine: string
  echo(clientMessageId: string, row: Message): void
  rekeyEcho(from: string, to: string): void
  enlist(send: SeatSend): void
  drop(clientMessageId: string): void
  withdrawn(clientMessageId: string): void
  dress(clientMessageId: string, state: SeatSend['state']): void
  unconfirmedDraft(key: string): SeatSend | undefined
  sendOf(clientMessageId: string): SeatSend | undefined
  markWithdrawing(clientMessageId: string, on: boolean): void
  retireUnknown(clientMessageId: string): void
}

type DeliveryOptions = { mode?: 'prompt' | 'bash'; pastedContents?: Record<number, PastedContent>; extraBlocks?: ContentBlockParam[]; metaFrom?: { command: string }; notesUnreadQuestion?: boolean }

export class DeliveryPart {
  private readonly inFlightDrafts = new Map<string, Promise<SendReceiptV1>>()
  private retainedSend: { draftKey: string; id: string; sentAtMs: number } | null = null
  private settleWaiters = new Map<string, Array<() => void>>()
  private unreadQuestion: string | null = null
  private unreadQuestionNoted = false

  constructor(private readonly needs: DeliveryNeeds) {}

  noteOpenQuestionRead(): void {
    this.unreadQuestion = null
    this.unreadQuestionNoted = false
  }

  noteOpenQuestionUnread(why: string): void {
    this.unreadQuestion = why
  }

  private accepted(notes: boolean): SendReceiptV1 {
    if (!notes) return { state: 'accepted' }
    const unread = this.unreadQuestion
    this.unreadQuestion = null
    if (unread === null || this.unreadQuestionNoted) return { state: 'accepted' }
    this.unreadQuestionNoted = true
    return {
      state: 'accepted',
      note: `open questions could not be read (${unread}), so this went out as an ordinary message; answer the question from its card if it still shows.`,
    }
  }

  deliver(text: string, opts: DeliveryOptions): Promise<SendReceiptV1> {
    const key = createHash('sha256').update(JSON.stringify([text, opts.mode ?? 'prompt', opts.pastedContents ?? {}, opts.extraBlocks ?? [], opts.metaFrom?.command ?? null])).digest('hex')
    const inFlight = this.inFlightDrafts.get(key)
    if (inFlight) return inFlight
    const delivery = this.deliverDraft(text, opts, key).finally(() => this.inFlightDrafts.delete(key))
    this.inFlightDrafts.set(key, delivery)
    return delivery
  }

  private async deliverDraft(text: string, opts: DeliveryOptions, draftKey: string): Promise<SendReceiptV1> {
    const { expandPastedTextRefs, pasteUnavailableLine, resolvePastedContents } = await import('../../../sessions/promptHistory.js')
    const resolved = await resolvePastedContents(text, opts.pastedContents ?? {})
    if (resolved.missing.length > 0) {
      return { state: 'refused', detail: pasteUnavailableLine(resolved.missing[0]!) }
    }
    const pastes = resolved.pastedContents
    const expanded = expandPastedTextRefs(text, pastes).trim()
    const images = [...this.needs.imageBlocks(pastes), ...(opts.extraBlocks ?? [])]
    if (expanded === '' && images.length === 0) return REFUSED_EMPTY
    const mode: 'prompt' | 'bash' = opts.mode === 'bash' ? 'bash' : 'prompt'
    const unconfirmed = this.needs.unconfirmedDraft(draftKey)
    const retained = this.retainedSend?.draftKey === draftKey ? this.retainedSend : null
    const provisionalId = unconfirmed?.clientMessageId ?? retained?.id ?? randomUUID()
    const meta = opts.metaFrom !== undefined
    const echo = createUserMessage({ uuid: provisionalId, content: mode === 'bash' ? `<${BASH_INPUT_TAG}>${expanded}</${BASH_INPUT_TAG}>` : expanded, ...(meta ? { isMeta: true } : {}) })
    this.needs.echo(provisionalId, this.needs.factsBusy() ? ({ ...echo, queued: true } as Message) : echo)
    this.needs.paint()
    const answering = meta || unconfirmed !== undefined ? null : await this.needs.openQuestion()
    const clientMessageId = answering !== null ? `obl-answer:${answering}` : provisionalId
    if (clientMessageId !== provisionalId) this.needs.rekeyEcho(provisionalId, clientMessageId)
    submitTrace('connector-deliver', expanded, { mode, clientMessageId, ...(meta ? { metaFrom: opts.metaFrom!.command } : {}) })
    const send: SeatSend = { clientMessageId, draftKey, text: expanded, sentAtMs: unconfirmed?.sentAtMs ?? retained?.sentAtMs ?? Date.now(), state: 'pending', mode, ...(meta ? {} : { source: { text, mode, pastedContents: pastes } }) }
    this.needs.enlist(send)
    this.needs.paint()
    this.needs.wakeLive()
    const settle = (state: 'delivered' | 'held' | 'refused' | 'failed', detail?: string): SendReceiptV1 => {
      this.noteSettled(clientMessageId)
      if (state !== 'delivered') {
        this.needs.drop(clientMessageId)
        this.needs.paint()
      } else {
        const queuedNow = this.needs.factsBusy() || this.needs.folding()
        this.needs.dress(clientMessageId, queuedNow ? 'queued' : 'delivered')
        connectorTrace({ ev: 'send', sid: this.needs.sessionId(), state: queuedNow ? 'queued' : 'delivered' })
      }
      this.retainedSend = state === 'held' || state === 'failed' ? { draftKey, id: clientMessageId, sentAtMs: send.sentAtMs } : null
      if (state === 'delivered') this.needs.sendDelivered()
      this.needs.wakeLive()
      if (state === 'delivered') {
        return this.accepted(opts.notesUnreadQuestion === true)
      }
      if (opts.notesUnreadQuestion === true) this.unreadQuestion = null
      return { state: 'refused', detail: detail ?? (state === 'held' ? 'held — ↵ again replays it' : 'the session did not take it') }
    }
    try {
      const admission = this.needs.admissionPending()
      const refusal = admission !== null ? await admission : null
      if (refusal !== null) {
        return settle('failed', `the session could not resume — ${refusal} · ↵ again retries`)
      }
      const { ensureOwnedDaemon } = await import('../../../daemon/switchboard/ensureDaemon.js')
      if (!(await ensureOwnedDaemon())) {
        return settle('failed', 'the daemon that hosts sessions did not start — ↵ again starts it and retries')
      }
      this.needs.assertSeat()
      if (answering !== null) {
        const control = await import('../../../screen/concourse-model/boardControl.js')
        const receipt = await control.executeBoardControl({
          verb: 'obligation.answer',
          obligationId: answering,
          sessionId: this.needs.sessionId(),
          clientMessageId,
          answer: expanded,
          ...(images.length > 0 ? { content: [...(expanded !== '' ? [{ type: 'text', text: expanded }] : []), ...images] } : {}),
          by: 'operator',
        })
        if (receipt.outcome === 'applied' || receipt.outcome === 'noop') return settle('delivered')
        return settle(receipt.outcome === 'failed' ? 'held' : 'refused', receipt.detail)
      }
      const reply = await this.needs.rpc({
        op: SESSION_VERBS.sendWords.daemon.op,
        clientMessageId,
        prompt: expanded === '' ? '(attachment)' : expanded,
        workspaceDir: '',
        targetSessionId: this.needs.sessionId(),
        by: 'operator',
        sentAt: new Date(send.sentAtMs).toISOString(),
        ...(mode === 'bash' ? { mode } : {}),
        ...(meta ? { origin: { kind: 'screen-command', command: opts.metaFrom!.command } } : {}),
        ...(images.length > 0 ? { content: [...(expanded !== '' ? [{ type: 'text', text: expanded }] : []), ...images] } : {}),
      })
      const detail = typeof reply.error === 'string' ? reply.error : undefined
      if ((reply.ok === true && reply.state === 'starting') || (reply.ok !== true && (reply.code === 'EUNCONFIRMED' || reply.frameWritten === true))) {
        this.noteSettled(clientMessageId)
        this.needs.dress(clientMessageId, 'unconfirmed')
        this.needs.wakeLive()
        return { state: 'pending', detail: UNCONFIRMED_LINE }
      }
      if (reply.ok === true) return settle('delivered')
      const held = typeof reply.heldReason === 'string' || (detail ?? '').startsWith('session-paused')
      return settle(held ? 'held' : 'refused', detail)
    } catch (e) {
      return settle('failed', `the daemon was unreachable — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  sendWords(text: string, opts?: SendWordsOptions): Promise<SendReceiptV1> {
    this.unreadQuestion = null
    return this.deliver(text, {
      ...(opts?.mode === 'bash' ? { mode: 'bash' as const } : {}),
      ...(opts?.pastedContents !== undefined ? { pastedContents: opts.pastedContents } : {}),
      ...(opts?.metaFrom !== undefined ? { metaFrom: opts.metaFrom } : {}),
      notesUnreadQuestion: true,
    })
  }

  dispatchSlash(line: string): Promise<SendReceiptV1> {
    const trimmed = line.trim()
    return this.deliver(trimmed.startsWith('/') ? trimmed : `/${trimmed}`, {})
  }

  async withdrawSend(clientMessageId: string): Promise<WithdrawReceiptV1> {
    const taken: WithdrawReceiptV1 = { withdrawn: false, reason: 'taken', detail: this.needs.recallTakenLine }
    const nothing: WithdrawReceiptV1 = { withdrawn: false, reason: 'unknown', detail: this.needs.recallUnknownLine }
    let send = this.needs.sendOf(clientMessageId)
    if (send === undefined) return nothing
    if (send.state === 'taken') return taken
    if (send.withdrawing === true) return { withdrawn: false, reason: 'refused', detail: 'a withdraw is already on its way' }
    if (send.state === 'pending') {
      const settled = await this.settled(clientMessageId)
      send = this.needs.sendOf(clientMessageId)
      if (send === undefined) return nothing
      if (!settled) return { withdrawn: false, reason: 'refused', detail: 'the line is still on its way to the session — ↑ again in a moment' }
      if (send.state === 'taken') return taken
    }
    this.needs.markWithdrawing(clientMessageId, true)
    connectorTrace({ ev: 'withdraw', sid: this.needs.sessionId(), state: send.state })
    const refuse = (detail: string): WithdrawReceiptV1 => {
      this.needs.markWithdrawing(clientMessageId, false)
      connectorTrace({ ev: 'withdrawn', sid: this.needs.sessionId(), withdrawn: false, reason: 'refused' })
      return { withdrawn: false, reason: 'refused', detail }
    }
    try {
      const reply = await this.needs.chainRpc(controlFrame('withdrawSend', this.needs.sessionId(), { clientMessageId }))
      if (reply.ok !== true) return refuse(String(reply.error ?? 'the daemon refused the withdraw'))
      if (reply.withdrawn === true) {
        this.needs.withdrawn(clientMessageId)
        this.needs.paint()
        this.needs.wakeLive()
        connectorTrace({ ev: 'withdrawn', sid: this.needs.sessionId(), withdrawn: true })
        const source = send.source
        return {
          withdrawn: true,
          text: source?.text ?? (typeof reply.text === 'string' ? reply.text : send.text),
          mode: source?.mode ?? send.mode,
          pastedContents: source?.pastedContents ?? {},
        }
      }
      if (reply.reason !== 'taken' && reply.reason !== 'unknown') {
        return refuse(typeof reply.detail === 'string' && reply.detail !== '' ? reply.detail : 'the daemon refused the withdraw')
      }
      this.needs.markWithdrawing(clientMessageId, false)
      connectorTrace({ ev: 'withdrawn', sid: this.needs.sessionId(), withdrawn: false, reason: reply.reason })
      if (reply.reason === 'taken') {
        this.needs.dress(clientMessageId, 'taken')
        return taken
      }
      if (send.state === 'unconfirmed') return { withdrawn: false, reason: 'unknown', detail: UNCONFIRMED_LINE }
      this.needs.retireUnknown(clientMessageId)
      return { withdrawn: false, reason: 'unknown', detail: this.needs.lostLine(send.source?.text ?? send.text), retired: true }
    } catch (e) {
      return refuse(`the daemon is not answering — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private noteSettled(clientMessageId: string): void {
    const waiters = this.settleWaiters.get(clientMessageId)
    if (waiters === undefined) return
    this.settleWaiters.delete(clientMessageId)
    for (const w of waiters) w()
  }

  private settled(clientMessageId: string): Promise<boolean> {
    const send = this.needs.sendOf(clientMessageId)
    if (send === undefined || send.state !== 'pending') return Promise.resolve(true)
    return new Promise<boolean>(resolve => {
      const timer = startTimeout(() => {
        const list = this.settleWaiters.get(clientMessageId)
        if (list !== undefined) this.settleWaiters.set(clientMessageId, list.filter(w => w !== done))
        resolve(false)
      }, PENDING_WITHDRAW_WAIT_MS)
      timer.unref?.()
      const done = (): void => {
        stopTimeout(timer)
        resolve(true)
      }
      this.settleWaiters.set(clientMessageId, [...(this.settleWaiters.get(clientMessageId) ?? []), done])
    })
  }
}
