import { randomUUID } from 'node:crypto'
import type { ToolUseContext } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import { AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { PermissionDecision } from '../../types/permissions.js'
import type { ToolUseBlock } from '../../types/wire.js'
import { parkBeforeTool } from '../../run-core/pauseGate.js'
import { logError } from '../../utils/log.js'
import { Stream } from '../../utils/stream.js'
import { toolCallKey } from './loopGuard.js'
import { batchClaimOf, claimsCompatible, type BatchClaim } from './toolBatching.js'
import { runToolUse, type MessageUpdateLazy } from './toolExecution.js'
import { openResultRoomForRound } from './toolOrchestration.js'

type EarlyCall = {
  updates: Stream<MessageUpdateLazy>
  settled: Promise<void>
  finished: boolean
}

type Ask = {
  decision: Promise<PermissionDecision>
  controller: AbortController
  state: 'open' | 'answered' | 'withdrawn'
  superseded: boolean
  stops: boolean
  heir?: string
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
  private declined = false
  private roundOpen = false
  private callKeys = new Map<string, string>()
  private asked = new Map<string, Ask>()
  private kept = new Map<string, Ask[]>()
  private adopted = new Map<string, Ask>()

  constructor(
    private readonly context: ToolUseContext,
    private readonly canUseTool: CanUseToolFn,
  ) {}

  readonly gate: CanUseToolFn = async (tool, input, context, assistantMessage, toolUseID, forceDecision) => {
    const key = this.callKeys.get(toolUseID)
    if (key === undefined || forceDecision !== undefined || context.abortController.signal.aborted) return this.canUseTool(tool, input, context, assistantMessage, toolUseID, forceDecision)
    const earlier = this.adopted.get(toolUseID)
    if (earlier !== undefined) {
      const generation = this.generation
      const decision = await earlier.decision
      if (generation !== this.generation) return decision
      this.adopted.delete(toolUseID)
      if (earlier.state === 'answered') {
        this.asked.set(key, earlier)
        if (earlier.stops) this.decline(toolUseID)
        return decision
      }
    }
    if (this.controllers.get(toolUseID) !== context.abortController) return this.canUseTool(tool, input, context, assistantMessage, toolUseID)
    const ask: Ask = { decision: Promise.resolve({ behavior: 'ask', message: '' }), controller: context.abortController, state: 'open', superseded: false, stops: false }
    ask.decision = this.canUseTool(tool, input, context, assistantMessage, toolUseID).then(decision => {
      if (ask.state === 'open') ask.state = this.context.abortController.signal.aborted ? 'withdrawn' : 'answered'
      ask.stops = ask.state === 'answered' && decision.behavior !== 'allow' && ask.controller.signal.aborted
      if (ask.superseded) ask.controller.abort('retry')
      if (ask.stops) this.decline(ask.superseded ? ask.heir : toolUseID)
      return decision
    })
    this.asked.set(key, ask)
    return ask.decision
  }

  private decline(toolUseID: string | undefined): void {
    this.declined = true
    const kept = toolUseID === undefined ? undefined : this.controllers.get(toolUseID)
    for (const ask of this.asked.values()) if (ask.controller !== kept) this.withdraw(ask)
    for (const [id, controller] of this.controllers) {
      if (id === toolUseID || this.started.get(id)?.finished) continue
      controller.abort('retry')
      this.controllers.delete(id)
      this.started.delete(id)
    }
    if (this.roundOpen) this.context.abortController.abort()
  }

  offer(block: ToolUseBlock, parent: AssistantMessage, ordinal: number): void {
    const generation = this.generation
    const key = toolCallKey(block.name, block.input)
    this.callKeys.set(block.id, key)
    const earlier = this.kept.get(key)?.shift()
    if (earlier !== undefined) {
      earlier.heir = block.id
      this.adopted.set(block.id, earlier)
    }
    this.queue = this.queue.then(async () => {
      try {
        const claim = await batchClaimOf(block, this.context)
        if (generation !== this.generation) return
        const launchesCrewmate = findToolByName(this.context.options.tools, block.name)?.name === AGENT_TOOL_NAME
        const answersStop = this.adopted.get(block.id)?.stops === true
        const admitted = (!this.declined || answersStop) && !launchesCrewmate && (claim.kind === 'free' || claim.kind === 'reads') && this.claims.every(held => claimsCompatible(held, claim))
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
    const call: EarlyCall = { updates, settled: Promise.resolve(), finished: false }
    call.settled = (async () => {
      try {
        await parkBeforeTool(context, block.name)
        openResultRoomForRound(roundID, [parent], this.context)
        for await (const update of runToolUse(block, parent, this.gate, context, { id: roundID, ordinal })) updates.enqueue(update)
        call.finished = true
        updates.done()
      } catch (error) {
        updates.error(error)
      }
    })()
    this.controllers.set(block.id, controller)
    this.started.set(block.id, call)
  }

  async ready(): Promise<void> {
    await this.queue
    this.roundOpen = true
    for (const ask of [...this.kept.values()].flat()) {
      if (ask.stops) this.declined = true
      this.withdraw(ask)
    }
    this.kept = new Map()
    if (this.declined) this.context.abortController.abort()
  }

  take(toolUseID: string): EarlyCall | undefined {
    const call = this.started.get(toolUseID)
    if (call === undefined) return undefined
    this.started.delete(toolUseID)
    this.controllers.delete(toolUseID)
    return call
  }

  resetForRetry(): void {
    const waiting = new Set<AbortController>()
    const keep = (key: string | undefined, ask: Ask): void => {
      if (key === undefined || ask.state === 'withdrawn') return
      if (ask.state === 'open') {
        ask.superseded = true
        waiting.add(ask.controller)
      }
      this.kept.set(key, [...(this.kept.get(key) ?? []), ask])
    }
    for (const [key, ask] of this.asked) keep(key, ask)
    for (const [toolUseID, ask] of this.adopted) keep(this.callKeys.get(toolUseID), ask)
    this.clear(controller => !waiting.has(controller))
    this.declined = [...this.kept.values()].flat().some(ask => ask.stops)
  }

  reset(): void {
    for (const ask of [...this.asked.values(), ...this.adopted.values(), ...[...this.kept.values()].flat()]) this.withdraw(ask)
    this.kept = new Map()
    this.clear(() => true)
  }

  private withdraw(ask: Ask): void {
    if (ask.state === 'open') ask.state = 'withdrawn'
    ask.controller.abort(this.context.abortController.signal.reason ?? 'retry')
  }

  private clear(aborts: (controller: AbortController) => boolean): void {
    this.generation++
    for (const controller of this.controllers.values()) if (aborts(controller)) controller.abort(this.context.abortController.signal.reason ?? 'retry')
    this.claims = []
    this.started = new Map()
    this.controllers = new Map()
    this.callKeys = new Map()
    this.asked = new Map()
    this.adopted = new Map()
    this.declined = false
    this.roundOpen = false
    this.roundID = `round:${randomUUID()}`
  }
}
