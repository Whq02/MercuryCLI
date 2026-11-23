import { statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { Message } from '../../message-shapes/message.js'
import { createLiveTurnFold, deserializeLiveMessages, type LiveTurnFold } from '../../../sessions/resume/conversationRecovery.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import type { TranscriptChainCursor } from '../../../sessions/transcripts/transcriptReader.js'
import { projectOperatorRewinds } from '../../compaction/checkpointRewind.js'
import { readClearModelReceipt } from '../../../daemon/switchboard/sessionReceipts.js'
import { endedRunResults } from '../endedRunCalls.js'
import { placeLocalCommandRows } from '../localCommandRows.js'
import { withoutRetractedReplies, type CommittedTextRow } from '../midTurnText.js'
import { mergeRecordsContentKeyed } from '../recordIdentity.js'
import { IDLE_LIVE, type SessionLiveV1 } from '../seatLive.js'
import type { SessionFactsV1 } from '../seatProjections.js'
import { createProjectionFeed, HEARTBEAT_MS, type ProjectionFeedHandle } from '../projectionFeed.js'
import { connectorTrace, emitAll, type Listeners } from './shared.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

const IDLE_TRANSCRIPT_FLOOR_MS = 2000

interface TranscriptNeeds {
  transcriptPath: string
  armWatcherByHand(): boolean
  armTimerByHand(): boolean
  tickByHand(pass: () => Promise<void>): Promise<void> | undefined
  record(): { readonly sessionId: string; readonly home: string }
  attached(): boolean
  turnInFlight(): boolean
  facts(): SessionFactsV1 | null
  carrierGone(): boolean
  admissionAwaiting(): boolean
  readFacts(): void
  recomputeLive(): void
  tailSeq(): number | null
  textRows(): readonly CommittedTextRow[]
  dropCommittedRows(): void
  releaseTail(): void
  retireTextRows(): boolean
  echoes(tailSeq: number | null): { held: Array<{ seq: number; row: Message }>; afterTail: Message[] }
  reconcileSends(): boolean
  placeDelivered(rows: readonly Message[]): readonly Message[]
  landingsAfter(seq: number | null): ReadonlyMap<string, number>
}

function placeEarlierArrivals(rows: readonly Message[], waiting: ReadonlyArray<{ seq: number; row: Message }>, landings: ReadonlyMap<string, number>): readonly Message[] {
  if (landings.size === 0) return rows
  const seqs = new Map(waiting.map(entry => [entry.row.uuid, entry.seq]))
  const placed: Message[] = []
  let moved = false
  for (const row of rows) {
    const seq = seqs.get(row.uuid)
    const at = seq === undefined ? -1 : placed.findIndex(above => (landings.get(above.uuid) ?? seq) > seq)
    if (at === -1) placed.push(row)
    else {
      placed.splice(at, 0, row)
      moved = true
    }
  }
  return moved ? placed : rows
}

export class TranscriptPart {
  private rawRecords: Message[] = []
  private recordSigs: string[] = []
  private painted: readonly Message[] = []
  private keptRecords: readonly Message[] = []
  private answeredRows: readonly Message[] = []
  private liveState: SessionLiveV1 = IDLE_LIVE
  private displayRows: Array<{ row: Message; anchor: number }> = []
  private clearModelReceipt: Message | null | undefined
  private rowsAfterTail = 0
  private lastSize = -1
  private lastLen = -1
  private transcriptUnreadableFp: string | null = null
  private chainCursor: TranscriptChainCursor | null = null
  private readonly liveFold: LiveTurnFold = createLiveTurnFold()
  private releaseTranscript: (() => void) | null = null
  private readonly feed: ProjectionFeedHandle
  private tickInFlight: Promise<void> | null = null
  private tickDirty = false
  private readonly transcriptPath: string
  private readonly recordListeners: Listeners = new Set()

  constructor(private readonly needs: TranscriptNeeds) {
    this.transcriptPath = needs.transcriptPath
    this.feed = createProjectionFeed(
      dirname(this.transcriptPath),
      this.transcriptPath,
      () => void this.tick(),
      () => (this.needs.turnInFlight() ? HEARTBEAT_MS : IDLE_TRANSCRIPT_FLOOR_MS),
      { createDir: false, filename: basename(this.transcriptPath) },
    )
  }

  rows(): Message[] {
    return this.rawRecords
  }

  displayCount(): number {
    return this.displayRows.length
  }

  live(): SessionLiveV1 {
    return this.liveState
  }

  kept(): readonly Message[] {
    return this.keptRecords
  }

  answered(): readonly Message[] {
    return this.answeredRows
  }

  clearReceipt(): Message | null | undefined {
    return this.clearModelReceipt
  }

  heartbeatMs(): number {
    return this.feed.heartbeatMs()
  }

  detached(): void {
    this.feed.stop()
    this.releaseTranscript?.()
    this.releaseTranscript = null
  }

  armTranscriptWatcher(): void {
    if (this.needs.armWatcherByHand()) return
    this.feed.armWatcher()
  }

  armTranscriptTimer(): void {
    if (this.needs.armTimerByHand()) return
    if (!this.needs.attached()) return
    this.feed.armTimer()
  }

  toolStartedAtMs(inProgress: ReadonlySet<string>): number | null {
    let earliest: number | null = null
    for (let i = this.rawRecords.length - 1; i >= 0; i--) {
      const row = this.rawRecords[i] as { type?: string; timestamp?: string; message?: { content?: unknown } } | undefined
      if (row?.type !== 'assistant' || !Array.isArray(row.message?.content)) continue
      const carries = (row.message.content as Array<{ type?: string; id?: string }>).some(b => b.type === 'tool_use' && typeof b.id === 'string' && inProgress.has(b.id))
      if (!carries) continue
      const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
      if (Number.isNaN(at)) continue
      earliest = earliest === null ? at : Math.min(earliest, at)
    }
    return earliest
  }

  addDisplayRow(row: Message): void {
    const subtype = (row as { subtype?: string }).subtype
    const kept =
      row.type === 'system' && subtype === 'away_summary'
        ? this.displayRows.filter(d => !(d.row.type === 'system' && (d.row as { subtype?: string }).subtype === 'away_summary'))
        : this.displayRows
    connectorTrace({ ev: 'display-row', sid: this.needs.record().sessionId, anchor: this.rawRecords.length, subtype: subtype ?? row.type, display: kept.length + 1 })
    this.displayRows = [...kept, { row, anchor: this.rawRecords.length }]
    this.paint()
  }

  private releaseDisplayRowsPast(since: number): void {
    const kept = this.displayRows.filter(d => d.anchor <= since)
    if (kept.length === this.displayRows.length) return
    connectorTrace({ ev: 'display-release', sid: this.needs.record().sessionId, since, released: this.displayRows.length - kept.length, display: kept.length })
    this.displayRows = kept
  }

  transcriptFile(): string {
    return this.transcriptPath
  }

  tick(): Promise<void> {
    if (this.tickInFlight !== null) {
      this.tickDirty = true
      return this.tickInFlight
    }
    const flight = (async () => {
      try {
        do {
          this.tickDirty = false
          await (this.needs.tickByHand(() => this.tickOnce()) ?? this.tickOnce())
        } while (this.tickDirty && this.needs.attached())
      } finally {
        this.tickInFlight = null
      }
    })()
    this.tickInFlight = flight
    return flight
  }

  private async tickOnce(): Promise<void> {
    if (!this.needs.attached()) return
    let fpNow: string | null = null
    try {
      let sizeNow = -1
      try {
        const st = statSync(this.transcriptPath, { bigint: true })
        sizeNow = Number(st.size)
        fpNow = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
      } catch {
        sizeNow = -1
      }
      connectorTrace({ ev: 'tick', sid: this.needs.record().sessionId, sizeNow, lastSize: this.lastSize, lastLen: this.lastLen })
      if (sizeNow === this.lastSize && this.lastLen >= 0) return
      if (sizeNow !== -1 && !this.feed.hasWatcher()) {
        this.armTranscriptWatcher()
        this.armTranscriptTimer()
      }
      const reader = await import('../../../sessions/transcripts/transcriptReader.js')
      if (this.releaseTranscript === null) this.releaseTranscript = reader.retainTranscript(this.transcriptPath)
      const chain = await reader.readTranscriptChainSince(this.transcriptPath, this.chainCursor)
      if (!this.needs.attached()) return
      this.transcriptUnreadableFp = null
      this.chainCursor = chain.cursor
      const raw = chain.rows
      this.lastSize = sizeNow
      this.lastLen = raw.length
      const since = chain.since <= this.rawRecords.length && chain.since <= this.recordSigs.length ? chain.since : 0
      const tail = since === 0 ? raw : chain.appended
      const merge = mergeRecordsContentKeyed(
        this.rawRecords,
        this.recordSigs,
        raw,
        deserializeLiveMessages(tail),
        reader.chainRowSigner(),
        since,
      )
      this.recordSigs = merge.sigs
      connectorTrace({ ev: 'load', sid: this.needs.record().sessionId, rawLen: raw.length, reusedAll: merge.reusedAll, prevLen: this.rawRecords.length, since: chain.since, rewound: chain.rewound })
      if (merge.reusedAll) {
        this.needs.recomputeLive()
        return
      }
      this.rawRecords = merge.records
      if (chain.rewound) {
        this.releaseDisplayRowsPast(chain.since)
        this.needs.dropCommittedRows()
      }
      this.liveState = this.liveFold.fold(this.rawRecords, chain.since)
      this.needs.releaseTail()
      this.needs.reconcileSends()
      this.needs.retireTextRows()
      this.paint()
      if (this.needs.admissionAwaiting() || this.needs.facts()?.runner?.state === 'starting') this.needs.readFacts()
      this.needs.recomputeLive()
    } catch (error) {
      this.feed.forgetKey()
      if (fpNow !== null) this.transcriptUnreadableFp = fpNow
      connectorTrace({ ev: 'tick-error', sid: this.needs.record().sessionId, message: error instanceof Error ? error.message : String(error) })
      if (this.needs.attached()) this.needs.recomputeLive()
    }
  }

  hasUnreadTranscript(): boolean {
    if (!this.needs.attached()) return false
    try {
      const st = statSync(this.transcriptPath, { bigint: true })
      const sizeNow = Number(st.size)
      if (sizeNow <= 0 || sizeNow === this.lastSize) return false
      const fp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
      return fp !== this.transcriptUnreadableFp
    } catch (error) {
      passedOver(error)
      return false
    }
  }

  paint(): void {
    const tailSeq = this.needs.tailSeq()
    const { held, afterTail } = this.needs.echoes(tailSeq)
    for (const committed of this.needs.textRows()) {
      const at = held.findIndex(entry => entry.seq > committed.seq)
      const entry = { seq: committed.seq, row: committed.row }
      if (at === -1) held.push(entry)
      else held.splice(at, 0, entry)
    }
    const echoes: Message[] = [...held.map(entry => entry.row), ...afterTail]
    this.rowsAfterTail = afterTail.length
    const kept = withoutRetractedReplies(projectOperatorRewinds(this.rawRecords))
    const dropped = kept.length === this.rawRecords.length ? null : new Set<Message>(kept)
    const answered = endedRunResults(kept, this.needs.facts(), this.needs.carrierGone())
    this.keptRecords = kept
    this.answeredRows = answered
    if (echoes.length === 0 && this.displayRows.length === 0 && dropped === null && answered.length === 0) {
      this.painted = this.rawRecords
    } else {
      const rows: Message[] = []
      let d = 0
      for (let i = 0; i <= this.rawRecords.length; i++) {
        if (i === this.rawRecords.length) rows.push(...answered)
        while (d < this.displayRows.length && this.displayRows[d]!.anchor <= i) rows.push(this.displayRows[d++]!.row)
        if (i < this.rawRecords.length) {
          const record = this.rawRecords[i]!
          if (dropped === null || dropped.has(record)) rows.push(record)
        }
      }
      while (d < this.displayRows.length) rows.push(this.displayRows[d++]!.row)
      this.painted = [...rows, ...echoes]
    }
    if (this.clearModelReceipt === undefined) {
      try { this.clearModelReceipt = readClearModelReceipt(this.needs.record().home, this.needs.record().sessionId) }
      catch (error) { logForDebugging(`[engine-connector] clear receipt unreadable: ${error}`) }
    }
    if (this.clearModelReceipt != null && !this.rawRecords.some(row => row.uuid === this.clearModelReceipt!.uuid)) {
      this.painted = [this.clearModelReceipt, ...this.painted]
    }
    const waiting = held.filter(entry => (entry.row as { queued?: true }).queued === true)
    this.painted = placeEarlierArrivals(placeLocalCommandRows(this.needs.placeDelivered(this.painted)), waiting, this.needs.landingsAfter(waiting[0]?.seq ?? null))
    connectorTrace({ ev: 'paint', sid: this.needs.record().sessionId, raw: this.rawRecords.length, display: this.displayRows.length, echoes: echoes.length, painted: this.painted.length, listeners: this.recordListeners.size })
    emitAll(this.recordListeners, 'records')
  }

  records(): readonly Message[] {
    return this.painted
  }

  subscribeRecords(listener: () => void): () => void {
    this.recordListeners.add(listener)
    return () => {
      this.recordListeners.delete(listener)
    }
  }

  tailAnchor(): number {
    return this.painted.length - this.rowsAfterTail
  }
}
