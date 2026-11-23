import type { Message } from '../../message-shapes/message.js'
import { createStreamingTailStore, type StreamingTailStore } from '../../message-shapes/streamingTailStore.js'
import { computeTailRelease } from '../../message-shapes/tailRetirement.js'
import { createTextRow, textRowLanded, type CommittedTextRow } from '../midTurnText.js'
import type { SessionTailV1 } from '../seatProjections.js'
import { connectorTrace, ECHO_RETIRE_MS } from './shared.js'

interface TailNeeds {
  sessionId(): string
  rows(): Message[]
  model(): string
  paint(): void
}

export class TailPart {
  private readonly tailStore: StreamingTailStore = createStreamingTailStore()
  private tailAtMs = -1
  private tailMessageId: string | null = null
  private interruptedMessageId: string | null = null
  private withdrawnMessageId: string | null = null
  private arrivalSeq = 0
  private tailSeq: number | null = null
  private tailSinceMs = 0
  private textRows: CommittedTextRow[] = []
  private landings = new Map<string, number>()

  constructor(private readonly needs: TailNeeds) {}

  store(): StreamingTailStore {
    return this.tailStore
  }

  seq(): number | null {
    return this.tailSeq
  }

  committedRows(): readonly CommittedTextRow[] {
    return this.textRows
  }

  dropCommittedRows(): void {
    this.textRows = []
  }

  landingsAfter(seq: number | null): ReadonlyMap<string, number> {
    for (const [uuid, place] of this.landings) if (seq === null || place <= seq) this.landings.delete(uuid)
    return this.landings
  }

  private landedAt(messageId: string, text: string, seq: number): boolean {
    for (let i = this.needs.rows().length - 1, walked = 0; i >= 0 && walked < 200; i--, walked++) {
      const row = this.needs.rows()[i]!
      if (!textRowLanded(row, messageId, text)) continue
      this.landings.set(row.uuid, Math.max(seq, this.landings.get(row.uuid) ?? seq))
      return true
    }
    return false
  }

  detached(): void {
    this.tailStore.reset(null)
    this.tailStore.dropSettled()
    this.tailStore.setMessageId(null)
    this.tailStore.setPhase(null)
    this.tailSeq = null
    this.tailAtMs = -1
  }

  arrivalSeqFor(seenAtMs?: number): number {
    const newest = this.textRows[this.textRows.length - 1]
    const anchor = this.tailSeq !== null ? { seq: this.tailSeq, sinceMs: this.tailSinceMs } : newest === undefined ? null : { seq: newest.seq, sinceMs: newest.sinceMs }
    const before = anchor !== null && seenAtMs !== undefined && seenAtMs < anchor.sinceMs
    this.arrivalSeq += 2
    return before && anchor !== null ? anchor.seq - 1 : this.arrivalSeq
  }

  noticeSeqAt(atMs: number): number {
    this.arrivalSeq += 2
    return this.tailSeq !== null && atMs <= this.tailSinceMs ? this.tailSeq - 1 : this.arrivalSeq
  }

  interrupted(atMs: number): void {
    this.interruptedMessageId = this.tailStore.readIds().current ?? this.tailMessageId
    if (this.interruptedMessageId !== null) {
      if (this.textRows.length > 0) {
        connectorTrace({ ev: 'interrupted-rows-dropped', sid: this.needs.sessionId(), count: this.textRows.length })
        this.textRows = []
        this.needs.paint()
      }
      this.clearTail(atMs)
    }
  }

  interruptUndone(): void {
    this.interruptedMessageId = null
  }

  takeTail(tail: SessionTailV1): void {
    const withdrawn = typeof tail.withdrawn === 'string' && tail.withdrawn !== '' ? tail.withdrawn : null
    if (withdrawn !== null && withdrawn !== this.withdrawnMessageId) {
      this.withdrawnMessageId = withdrawn
      const kept = this.textRows.filter(committed => committed.messageId !== withdrawn)
      if (kept.length !== this.textRows.length) {
        connectorTrace({ ev: 'withdrawn-rows-dropped', sid: this.needs.sessionId(), count: this.textRows.length - kept.length })
        this.textRows = kept
        this.needs.paint()
      }
    }
    if (tail.atMs === this.tailAtMs && tail.text === this.tailStore.read()) return
    this.tailAtMs = tail.atMs
    const id = typeof tail.messageId === 'string' && tail.messageId !== '' ? tail.messageId : null
    this.tailMessageId = id
    if (id !== null && id === this.interruptedMessageId) return
    const landed = id !== null && tail.text !== null && computeTailRelease(this.needs.rows(), { current: id, settled: null }).publishedShown
    const text = landed ? null : tail.text
    if (text !== null && this.tailStore.read() === null) {
      this.arrivalSeq += 2
      this.tailSeq = this.arrivalSeq
      this.tailSinceMs = typeof tail.blockSinceMs === 'number' ? tail.blockSinceMs : tail.atMs
    }
    this.tailStore.setMessageId(typeof tail.messageId === 'string' && tail.messageId !== '' ? tail.messageId : null)
    this.tailStore.setPhase(tail.phase === 'commentary' || tail.phase === 'final_answer' ? tail.phase : null)
    if (text === null) {
      this.clearTail(tail.atMs)
      return
    }
    this.tailStore.update(() => text)
  }

  clearTail(atMs: number): void {
    const held = this.tailStore.read()
    const verdict = held === null || held === '' ? 'nothing' : this.commitHeldText(held, atMs)
    if (held !== null) this.tailStore.update(() => null)
    if (verdict === 'committed' || verdict === 'standing' || verdict === 'dropped') {
      this.tailStore.dropSettled()
      this.needs.paint()
    }
  }

  private commitHeldText(text: string, atMs: number): 'committed' | 'standing' | 'dropped' | 'unidentified' {
    const id = this.tailStore.readIds().current
    if (id === null) return 'unidentified'
    if (id === this.interruptedMessageId || id === this.withdrawnMessageId) {
      this.tailSeq = null
      connectorTrace({ ev: id === this.withdrawnMessageId ? 'withdrawn-text-dropped' : 'interrupted-text-dropped', sid: this.needs.sessionId(), chars: text.length })
      return 'dropped'
    }
    if (computeTailRelease(this.needs.rows(), { current: id, settled: null }).publishedShown) {
      this.tailSeq = null
      return 'standing'
    }
    const seq = this.tailSeq ?? (this.arrivalSeq += 2)
    const row = createTextRow({ messageId: id, text, phase: this.tailStore.readPhases().current, atMs, model: this.needs.model() })
    this.textRows = [...this.textRows, { seq, sinceMs: this.tailSinceMs, atMs, messageId: id, text, row }]
    this.tailSeq = null
    connectorTrace({ ev: 'text-row', sid: this.needs.sessionId(), seq, chars: text.length })
    return 'committed'
  }

  retireTextRows(): boolean {
    if (this.textRows.length === 0) return false
    const now = Date.now()
    const kept = this.textRows.filter(committed => now - committed.atMs <= ECHO_RETIRE_MS && !this.landedAt(committed.messageId, committed.text, committed.seq))
    if (kept.length === this.textRows.length) return false
    connectorTrace({ ev: 'text-row-landed', sid: this.needs.sessionId(), count: this.textRows.length - kept.length })
    this.textRows = kept
    return true
  }

  retireTextRowsWithRunner(): void {
    if (this.textRows.length === 0) return
    connectorTrace({ ev: 'lost', sid: this.needs.sessionId(), reason: 'runner-relaunched-text', count: this.textRows.length })
    this.textRows = []
    this.needs.paint()
  }

  releaseTail(): void {
    const ids = this.tailStore.readIds()
    if (ids.current === null && ids.settled === null) return
    const release = computeTailRelease(this.needs.rows(), ids)
    if (!release.publishedShown && !release.settledShown) return
    if (release.publishedShown) {
      const held = this.tailStore.read()
      if (ids.current !== null && held !== null && held !== '' && this.tailSeq !== null) this.landedAt(ids.current, held, this.tailSeq)
      this.tailStore.reset(null)
    }
    this.tailStore.dropSettled()
    this.tailSeq = null
  }
}
