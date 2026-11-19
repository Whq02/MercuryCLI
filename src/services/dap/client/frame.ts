import type { DapSession } from '../dapClient.js'

export class FramePart {
  #stoppedFrameMemo: { stamp: number; frameId: number } | null = null

  constructor(private readonly session: DapSession) {}

  async stoppedFrameId(): Promise<number | null> {
    const stopped = this.session.lastStopped
    if (!stopped) return null
    const stamp = this.session.lastStoppedAt
    if (this.#stoppedFrameMemo?.stamp === stamp) return this.#stoppedFrameMemo.frameId
    let threadId = stopped.threadId
    if (threadId === undefined) {
      const body = await this.session.request('threads')
      const threads = Array.isArray(body.threads) ? (body.threads as Array<{ id?: number }>) : []
      threadId = threads[0]?.id
      if (threadId === undefined) return null
    }
    const body = await this.session.request('stackTrace', { threadId, startFrame: 0, levels: 1 })
    const frames = Array.isArray(body.stackFrames) ? (body.stackFrames as Array<{ id?: number }>) : []
    const frameId = frames[0]?.id
    if (typeof frameId !== 'number') return null
    if (this.session.lastStoppedAt === stamp) this.#stoppedFrameMemo = { stamp, frameId }
    return frameId
  }
}
