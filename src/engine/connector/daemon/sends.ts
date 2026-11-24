import type { Message } from '../../message-shapes/message.js'
import { createNoticeRow, deliveredNoticeRow, foldClockOf, isNoticeFact, isNoticeKey, noticeKeyOf, noticeRowLanded, placeDeliveredNotices, queueOrderedSends } from '../queuedNotices.js'
import type { LostLineV1 } from '../seatLive.js'
import type { SessionFactsV1 } from '../seatProjections.js'
import type { RecallableSendV1 } from '../types.js'
import { connectorTrace, ECHO_RETIRE_MS, type SeatSend } from './shared.js'

const UUID_SHAPE = Object.freeze(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

function textOfUserRow(m: Message): string {
  if (m.type !== 'user') return ''
  if ((m as { isMeta?: boolean }).isMeta) return ''
  const content = (m as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(b => ((b as { type?: string; text?: string }).type === 'text' ? ((b as { text?: string }).text ?? '') : ''))
      .join('')
  }
  return ''
}

function latestRecallableSend(sends: readonly SeatSend[]): RecallableSendV1 | null {
  let latest: SeatSend | null = null
  for (const s of sends) {
    if (s.state === 'taken' || s.withdrawing === true || s.source === undefined) continue
    if (!UUID_SHAPE.test(s.clientMessageId)) continue
    if (s.source.text === '' && Object.keys(s.source.pastedContents).length === 0) continue
    if (latest === null || s.sentAtMs >= latest.sentAtMs) latest = s
  }
  return latest === null || latest.source === undefined ? null : { clientMessageId: latest.clientMessageId, text: latest.source.text }
}

function earliestPendingSend(sends: readonly SeatSend[]): number | null {
  let since: number | null = null
  for (const s of sends) {
    if (s.state === 'pending' && (since === null || s.sentAtMs < since)) since = s.sentAtMs
  }
  return since
}

interface SendsNeeds {
  sessionId(): string
  rows(): readonly Message[]
  paint(): void
  folding(): boolean
  wakeLive(): void
  arrivalSeqFor(seenAtMs?: number): number
  noticeSeqAt(atMs: number): number
  retireTextRowsWithRunner(): void
  noteSendDemoted(): void
  noteSendTaken(): void
  lostWithRunnerLine(lines: readonly string[]): string
}

export class SendsPart {
  private echoRows = new Map<string, Message>()
  private deliveredNotices = new Map<string, { row: Message; text: string; sentAtMs: number; seq: number }>()
  private sends: SeatSend[] = []
  private sendSeq = new Map<string, number>()
  private textRetiredRowUuids = new Set<string>()
  private runnerGeneration: number | null = null
  private lostLineNotice: LostLineV1 | null = null

  constructor(private readonly needs: SendsNeeds) {}

  reconcileQueuedSends(facts: SessionFactsV1): void {
    if (facts.queueReady === false) return
    const queue = facts.queue ?? []
    if (typeof facts.runnerGeneration === 'number') {
      const moved = this.runnerGeneration !== null && facts.runnerGeneration !== this.runnerGeneration
      this.runnerGeneration = facts.runnerGeneration
      if (moved) {
        if (this.reconcileSends()) this.needs.paint()
        this.retireSendsLostWithRunner(queue, facts.recoveredCommandIds)
        this.needs.retireTextRowsWithRunner()
      }
    }
    let born = false
    for (const entry of queue) {
      if (!isNoticeFact(entry)) continue
      const key = noticeKeyOf(entry.value)
      if (this.sends.some(s => s.clientMessageId === key)) continue
      const atMs = Date.now()
      this.sends = [...this.sends, { clientMessageId: key, text: entry.value, sentAtMs: atMs, state: 'queued', mode: 'prompt' }]
      this.stampArrival(key, atMs)
      this.echoRows.set(key, createNoticeRow(entry.value, atMs, entry.origin))
      connectorTrace({ ev: 'notice', sid: this.needs.sessionId(), state: 'queued' })
      born = true
    }
    if (this.sends.length === 0) return
    const queuedIds = new Set<string>()
    for (const entry of queue) {
      if (typeof entry.uuid === 'string') queuedIds.add(entry.uuid)
      if (isNoticeFact(entry)) queuedIds.add(noticeKeyOf(entry.value))
    }
    for (const s of this.sends) {
      if (s.state === 'pending' || s.withdrawing === true) continue
      if (queuedIds.has(s.clientMessageId)) {
        if (s.state !== 'queued') this.dressSend(s.clientMessageId, 'queued')
      } else if (s.state === 'queued' || (s.state === 'delivered' && facts.atMs >= s.sentAtMs)) {
        this.dressSend(s.clientMessageId, 'taken', facts.atMs)
      }
    }
    const ordered = queueOrderedSends(this.sends, queue)
    const moved = ordered.some((entry, i) => entry !== this.sends[i])
    if (moved) this.sends = ordered
    if (born || moved) this.needs.paint()
  }

  dressSend(clientMessageId: string, state: SeatSend['state'], takenAtMs = Date.now()): void {
    const current = this.sends.find(s => s.clientMessageId === clientMessageId)
    if (state === 'taken' && isNoticeKey(clientMessageId) && current !== undefined) {
      const row = this.echoRows.get(clientMessageId)
      if (row !== undefined) {
        const atMs = Number.isFinite(takenAtMs) ? Math.max(current.sentAtMs, takenAtMs) : Date.now()
        const seq = this.needs.noticeSeqAt(atMs)
        this.deliveredNotices.set(row.uuid, { row: deliveredNoticeRow(row, atMs), text: current.text, sentAtMs: current.sentAtMs, seq })
      }
      this.sends = this.sends.filter(s => s.clientMessageId !== clientMessageId)
      this.echoRows.delete(clientMessageId)
      this.sendSeq.delete(clientMessageId)
      this.needs.paint()
      return
    }
    if (current?.state === 'delivered' && state === 'queued') {
      this.needs.noteSendDemoted()
    } else if (current?.state === 'delivered' && state === 'taken') {
      this.needs.noteSendTaken()
    }
    const enqueuedUnderTheFold = current !== undefined && (current.state !== 'queued' || current.heldFor === 'compaction')
    const heldFor = state === 'queued' && this.needs.folding() && enqueuedUnderTheFold ? ('compaction' as const) : undefined
    this.sends = this.sends.map(s => {
      if (s.clientMessageId !== clientMessageId) return s
      const next: SeatSend = { ...s, state }
      if (heldFor !== undefined) next.heldFor = heldFor
      else delete next.heldFor
      return next
    })
    const row = this.echoRows.get(clientMessageId) as (Message & { queued?: true; heldFor?: 'compaction' }) | undefined
    if (row === undefined) return
    const queued = state === 'queued'
    if (queued === (row.queued === true) && heldFor === row.heldFor) return
    const next: Message & { queued?: true; heldFor?: 'compaction' } = queued
      ? { ...row, queued: true }
      : isNoticeKey(clientMessageId)
        ? deliveredNoticeRow(row, Date.now())
        : { ...row, timestamp: new Date().toISOString() }
    if (!queued) delete next.queued
    if (heldFor !== undefined) next.heldFor = heldFor
    else delete next.heldFor
    this.echoRows.set(clientMessageId, next)
    this.needs.paint()
  }

  heldForCompaction(): string[] {
    return this.sends.filter(s => s.heldFor === 'compaction').map(s => s.clientMessageId)
  }

  private retireSendsLostWithRunner(queue: SessionFactsV1['queue'], recoveredCommandIds: readonly string[] = []): void {
    const listed = new Set<string>(recoveredCommandIds.filter(id => typeof id === 'string'))
    for (const entry of queue) if (typeof entry.uuid === 'string') listed.add(entry.uuid)
    const carried = (s: SeatSend): boolean => s.state === 'queued' || s.state === 'unconfirmed'
    this.sends = this.sends.map(s => carried(s) && listed.has(s.clientMessageId) ? { ...s, crossedRunner: true as const } : s)
    const lost = this.sends.filter(
      s => carried(s) && s.withdrawing !== true && !isNoticeKey(s.clientMessageId) && !listed.has(s.clientMessageId),
    )
    if (lost.length === 0) return
    const gone = new Set(lost.map(s => s.clientMessageId))
    for (const id of gone) this.echoRows.delete(id)
    this.sends = this.sends.filter(s => !gone.has(s.clientMessageId))
    if (this.sends.length === 0) this.textRetiredRowUuids.clear()
    this.lostLineNotice = { text: this.needs.lostWithRunnerLine(lost.map(s => s.source?.text ?? s.text)), atMs: Date.now() }
    connectorTrace({ ev: 'lost', sid: this.needs.sessionId(), reason: 'runner-relaunched', count: lost.length })
    this.needs.paint()
    this.needs.wakeLive()
  }

  retireSendUnknownToRunner(clientMessageId: string): void {
    this.sends = this.sends.filter(s => s.clientMessageId !== clientMessageId)
    this.echoRows.delete(clientMessageId)
    if (this.sends.length === 0) this.textRetiredRowUuids.clear()
    connectorTrace({ ev: 'lost', sid: this.needs.sessionId(), reason: 'unknown' })
    this.needs.paint()
    this.needs.wakeLive()
  }

  lostLine(): LostLineV1 | null {
    return this.lostLineNotice
  }

  reconcileSends(): boolean {
    if (this.sends.length === 0) return false
    const now = Date.now()
    const landed = new Set<string>()
    const identityKeys = new Set(this.sends.filter(s => UUID_SHAPE.test(s.clientMessageId)).map(s => s.clientMessageId))
    for (let i = this.needs.rows().length - 1; i >= 0 && landed.size < identityKeys.size; i--) {
      const row = this.needs.rows()[i]!
      if (row.type === 'user') {
        const ids = [row.uuid, ...((row as { batchUuids?: string[] }).batchUuids ?? [])]
        if (ids.some(id => identityKeys.has(id))) {
          for (const id of ids) if (identityKeys.has(id)) landed.add(id)
          this.textRetiredRowUuids.add(row.uuid)
        }
      } else if (row.type === 'attachment' && row.attachment.type === 'queued_command') {
        const id = row.attachment.source_uuid
        if (id !== undefined && identityKeys.has(id)) landed.add(id)
      } else if (row.type === 'system' && identityKeys.has(row.uuid)) {
        landed.add(row.uuid)
      }
    }
    for (const s of this.sends) {
      if (landed.has(s.clientMessageId)) continue
      if (now - s.sentAtMs > ECHO_RETIRE_MS && (s.state === 'delivered' || s.state === 'taken')) {
        landed.add(s.clientMessageId)
        continue
      }
      if (isNoticeKey(s.clientMessageId)) {
        for (let i = this.needs.rows().length - 1; i >= 0; i--) {
          if (noticeRowLanded(this.needs.rows()[i]!, s.text, s.sentAtMs)) {
            landed.add(s.clientMessageId)
            break
          }
        }
        continue
      }
      const idKeyed = UUID_SHAPE.test(s.clientMessageId)
      if (idKeyed && s.crossedRunner !== true) continue
      for (let i = this.needs.rows().length - 1; i >= 0; i--) {
        const m = this.needs.rows()[i]!
        if (m.type !== 'user') continue
        const rowUuid = (m as { uuid?: string }).uuid
        if (rowUuid !== undefined && this.textRetiredRowUuids.has(rowUuid)) continue
        const ts = Date.parse((m as { timestamp?: string }).timestamp ?? '')
        if (s.crossedRunner === true) {
          if (!Number.isFinite(ts) || ts < s.sentAtMs || m.isMeta === true) continue
        } else if (!Number.isNaN(ts) && ts + 1000 < s.sentAtMs) continue
        const text = textOfUserRow(m)
        if (text !== '' && (s.crossedRunner === true ? text === s.text : text.includes(s.text))) {
          if (rowUuid !== undefined) this.textRetiredRowUuids.add(rowUuid)
          landed.add(s.clientMessageId)
          break
        }
      }
    }
    if (landed.size === 0) return false
    connectorTrace({ ev: 'send-landed', sid: this.needs.sessionId(), count: landed.size })
    this.sends = this.sends.filter(s => !landed.has(s.clientMessageId))
    for (const id of landed) this.echoRows.delete(id)
    if (this.sends.length === 0) this.textRetiredRowUuids.clear()
    return true
  }

  private stampArrival(clientMessageId: string, seenAtMs?: number): void {
    this.sendSeq.set(clientMessageId, this.needs.arrivalSeqFor(seenAtMs))
  }

  echo(clientMessageId: string, row: Message): void {
    this.echoRows.set(clientMessageId, row)
  }

  rekeyEcho(from: string, to: string): void {
    const rows = [...this.echoRows]
    this.echoRows.clear()
    for (const [key, row] of rows) this.echoRows.set(key === from ? to : key, row)
  }

  enlist(send: SeatSend): void {
    this.sends = [...this.sends.filter(s => s.clientMessageId !== send.clientMessageId), send]
    this.stampArrival(send.clientMessageId)
  }

  drop(clientMessageId: string): void {
    this.sends = this.sends.filter(s => s.clientMessageId !== clientMessageId)
    this.echoRows.delete(clientMessageId)
  }

  withdrawn(clientMessageId: string): void {
    this.drop(clientMessageId)
    if (this.sends.length === 0) this.textRetiredRowUuids.clear()
  }

  unconfirmedDraft(key: string): SeatSend | undefined {
    return this.sends.find(s => s.state === 'unconfirmed' && s.draftKey === key)
  }

  sendOf(clientMessageId: string): SeatSend | undefined {
    return this.sends.find(s => s.clientMessageId === clientMessageId)
  }
  recallableSend(): RecallableSendV1 | null {
    return latestRecallableSend(this.sends)
  }
  markWithdrawing(clientMessageId: string, on: boolean): void {
    this.sends = this.sends.map(s => {
      if (s.clientMessageId !== clientMessageId) return s
      if (on) return { ...s, withdrawing: true as const }
      const { withdrawing: _off, ...rest } = s
      return rest
    })
  }
  queuedSendCount(): number {
    let count = 0
    for (const s of this.sends) {
      if (s.state === 'queued' && s.heldFor === undefined && s.withdrawing !== true && !isNoticeKey(s.clientMessageId)) count += 1
    }
    return count
  }
  echoes(tailSeq: number | null): { held: Array<{ seq: number; row: Message }>; afterTail: Message[] } {
    const held: Array<{ seq: number; row: Message }> = []
    const afterTail: Message[] = []
    const live = new Set<string>()
    for (const s of this.sends) {
      live.add(s.clientMessageId)
      const row = this.echoRows.get(s.clientMessageId)
      if (row === undefined) continue
      const seq = this.sendSeq.get(s.clientMessageId) ?? 0
      if (tailSeq !== null && seq > tailSeq) afterTail.push(row)
      else held.push({ seq, row })
    }
    for (const key of this.sendSeq.keys()) if (!live.has(key)) this.sendSeq.delete(key)
    const foldAtMs = this.deliveredNotices.size === 0 ? Number.NaN : foldClockOf(this.needs.rows())
    for (const [key, notice] of this.deliveredNotices) {
      if (Date.parse(notice.row.timestamp) < foldAtMs || this.needs.rows().some(row => noticeRowLanded(row, notice.text, notice.sentAtMs))) {
        this.deliveredNotices.delete(key)
        continue
      }
      if (tailSeq !== null && notice.seq > tailSeq) afterTail.push(notice.row)
      else held.push({ seq: notice.seq, row: notice.row })
    }
    held.sort((a, b) => a.seq - b.seq)
    return { held, afterTail }
  }

  placeDelivered(rows: readonly Message[]): readonly Message[] {
    return placeDeliveredNotices(rows, this.deliveredNotices)
  }

  anyDelivered(): boolean {
    return this.sends.some(s => s.state === 'delivered')
  }

  pendingSinceMs(): number | null {
    return earliestPendingSend(this.sends)
  }

  redressQueued(): void {
    for (const s of this.sends) if (s.state === 'queued') this.dressSend(s.clientMessageId, 'queued')
  }

  states(): string {
    return this.sends.map(s => s.state).join(',')
  }
}
