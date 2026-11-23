import type { NonNullableUsage } from '../../request-parts/emptyUsage.js'
import { stepRow, type RowDraft, type RowScope } from '../project.js'

export class StepLedger {
  private open: { messageId: string; model: string; stop: string | null; usage: NonNullableUsage } | null = null
  private readonly done = new Set<string>()
  readonly blocks = new Map<string, number>()
  count = 0
  lastModel = ''
  constructor(private readonly scope: RowScope) {}

  see(messageId: string, model: string, usage: NonNullableUsage, stop: string | null): RowDraft | null {
    let flushed: RowDraft | null = null
    if (this.open !== null && this.open.messageId !== messageId) flushed = this.flush()
    if (this.done.has(messageId)) return flushed
    this.open = { messageId, model, usage, stop: stop ?? this.open?.stop ?? null }
    return flushed
  }

  flush(): RowDraft | null {
    if (this.open === null) return null
    const { messageId, model, usage, stop } = this.open
    this.open = null
    this.done.add(messageId)
    this.count += 1
    return stepRow(this.scope, { messageId, model, stopReason: stop, usage })
  }

  settle(messageId: string, usage: NonNullableUsage, stop: string | null): RowDraft | null {
    if (this.open !== null && this.open.messageId === messageId) {
      this.open.usage = usage
      if (stop !== null) this.open.stop = stop
      return this.flush()
    }
    if (this.done.has(messageId)) return null
    this.open = { messageId, model: this.lastModel, usage, stop }
    return this.flush()
  }
}
