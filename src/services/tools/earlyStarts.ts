import { randomUUID } from 'node:crypto'
import type { ToolUseContext } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { ToolUseBlock } from '../../types/wire.js'
import { parkBeforeTool } from '../../run-core/pauseGate.js'
import { logError } from '../../utils/log.js'
import { Stream } from '../../utils/stream.js'
import { batchClaimOf, claimsCompatible, type BatchClaim } from './toolBatching.js'
import { runToolUse, type MessageUpdateLazy } from './toolExecution.js'
import { openResultRoomForRound } from './toolOrchestration.js'

type EarlyCall = {
  updates: Stream<MessageUpdateLazy>
  settled: Promise<void>
}

function childAbortController(parent: AbortController): AbortController {
  const child = new AbortController()
  const forward = (): void => child.abort(parent.signal.reason)
  if (parent.signal.aborted) forward()
  else parent.signal.addEventListener('abort', forward, { once: true })
  return child
}

export class EarlyStarts {
  roundID = `round:${randomUUID()}`
  private claims: BatchClaim[] = []
  private started = new Map<string, EarlyCall>()
  private controllers = new Map<string, AbortController>()
  private queue: Promise<void> = Promise.resolve()
  private generation = 0

  constructor(
    private readonly context: ToolUseContext,
    private readonly canUseTool: CanUseToolFn,
  ) {}

  offer(block: ToolUseBlock, parent: AssistantMessage, ordinal: number): void {
    const generation = this.generation
    this.queue = this.queue.then(async () => {
      try {
        const claim = await batchClaimOf(block, this.context)
        if (generation !== this.generation) return
        const launchesCrewmate = findToolByName(this.context.options.tools, block.name)?.name === AGENT_TOOL_NAME
        const admitted = !launchesCrewmate && (claim.kind === 'free' || claim.kind === 'reads') && this.claims.every(held => claimsCompatible(held, claim))
        this.claims.push(claim)
        if (admitted) this.start(block, parent, ordinal)
      } catch (error) {
        logError(error)
      }
    })
  }

  private start(block: ToolUseBlock, parent: AssistantMessage, ordinal: number): void {
    const controller = childAbortController(this.context.abortController)
    const context: ToolUseContext = { ...this.context, abortController: controller }
    const updates = new Stream<MessageUpdateLazy>()
    const roundID = this.roundID
    const settled = (async () => {
      try {
        await parkBeforeTool(context, block.name)
        openResultRoomForRound(roundID, [parent], this.context)
        for await (const update of runToolUse(block, parent, this.canUseTool, context, { id: roundID, ordinal })) updates.enqueue(update)
        updates.done()
      } catch (error) {
        updates.error(error)
      }
    })()
    this.controllers.set(block.id, controller)
    this.started.set(block.id, { updates, settled })
  }

  async ready(): Promise<void> {
    await this.queue
  }

  take(toolUseID: string): EarlyCall | undefined {
    const call = this.started.get(toolUseID)
    if (call === undefined) return undefined
    this.started.delete(toolUseID)
    this.controllers.delete(toolUseID)
    return call
  }

  reset(): void {
    this.generation++
    for (const controller of this.controllers.values()) controller.abort(this.context.abortController.signal.reason ?? 'retry')
    this.claims = []
    this.started = new Map()
    this.controllers = new Map()
    this.roundID = `round:${randomUUID()}`
  }
}
