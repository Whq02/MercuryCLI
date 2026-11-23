import type { DapSession } from '../dapClient.js'
import { waitForDap } from '../dapCancellation.js'
import { startBodyOf, type DapStartOptions } from './launch.js'
import { adapterSilenceMessage } from './probes.js'
import { CLIENT_INIT_ARGS, REQUEST_TIMEOUT_MS, type DapAdapterSpec, type DapBreakpointSpec, type DapFunctionBreakpointSpec } from './shared.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

interface StartNeeds {
  rootStart(): StartPart
  initializedEvent(): Promise<void>
  operationSignal(): AbortSignal | undefined
  spec(): DapAdapterSpec
  cwd(): string
  pushOutput(line: string): void
}

export class StartPart {
  #requestedBreakpoints: Map<string, Array<number | DapBreakpointSpec>> | null = null
  #requestedFunctionBreakpoints: DapFunctionBreakpointSpec[] | null = null

  constructor(
    private readonly session: DapSession,
    private readonly needs: StartNeeds,
  ) {}

  async setBreakpointsTree(
    path: string,
    breakpoints: Array<number | DapBreakpointSpec>,
  ): Promise<Array<{ line: number; verified: boolean; message?: string; id?: number; verifier?: string }>> {
    const root = this.session.root()
    const rootStart = this.needs.rootStart()
    const clearing = breakpoints.length === 0
    if (clearing) {
      rootStart.#requestedBreakpoints?.delete(path)
    } else {
      if (!rootStart.#requestedBreakpoints) rootStart.#requestedBreakpoints = new Map()
      rootStart.#requestedBreakpoints.set(path, breakpoints)
    }
    for (const s of root.treeSessions()) {
      if (!s.alive) {
        s.breakpoints.delete(path)
        continue
      }
      try {
        await s.setBreakpoints(path, breakpoints)
      } catch (err) {
        this.needs.pushOutput(`[dap] breakpoints for ${path} on '${s.label}' failed: ${(err as Error).message}`)
      }
    }
    return root.treeVerifiedBreakpoints().get(path) ?? []
  }

  async setFunctionBreakpointsTree(
    specs: DapFunctionBreakpointSpec[],
  ): Promise<Array<{ name: string; verified: boolean; message?: string; id?: number; verifier?: string }>> {
    const root = this.session.root()
    this.needs.rootStart().#requestedFunctionBreakpoints = specs.length > 0 ? specs : null
    for (const s of root.treeSessions()) {
      if (!s.alive) {
        s.functionBreakpoints = []
        continue
      }
      if (!s.acceptsFunctionBreakpoints()) continue
      try {
        await s.setFunctionBreakpoints(specs)
      } catch (err) {
        this.needs.pushOutput(`[dap] function breakpoints on '${s.label}' failed: ${(err as Error).message}`)
      }
    }
    return root.treeVerifiedFunctionBreakpoints()
  }

  async runChildDance(
    requestKind: 'launch' | 'attach',
    configuration: Record<string, unknown>,
  ): Promise<void> {
    this.session.startMode = requestKind
    this.session.capabilities = await this.session.request('initialize', {
      ...CLIENT_INIT_ARGS,
      adapterID: this.session.adapterKey,
    })
    const startDone = this.session.request(requestKind, configuration, 20_000)
    startDone.catch(passedOver)
    const sawInitialized = await waitForDap(this.needs.initializedEvent().then(() => true), this.needs.operationSignal(), 10_000)
    if (!sawInitialized) {
      throw new Error(adapterSilenceMessage('child adapter never sent initialized (10s)', this.session.adapterKey))
    }
    const requested = this.needs.rootStart().#requestedBreakpoints
    if (requested) {
      for (const [path, lines] of requested) {
        await this.session.setBreakpoints(path, lines).catch(err =>
          this.needs.pushOutput(
            `[dap] child '${this.session.label}' breakpoints for ${path} failed: ${(err as Error).message}`,
          ),
        )
      }
    }
    const requestedFunctions = this.needs.rootStart().#requestedFunctionBreakpoints
    if (requestedFunctions && this.session.acceptsFunctionBreakpoints()) {
      await this.session.setFunctionBreakpoints(requestedFunctions).catch(err =>
        this.needs.pushOutput(`[dap] child '${this.session.label}' function breakpoints failed: ${(err as Error).message}`),
      )
    }
    await this.session.request('configurationDone').catch(passedOver)
    await startDone
  }

  async launch(options: DapStartOptions): Promise<void> {
    this.#requestedBreakpoints = options.breakpoints ?? null
    this.session.capabilities = await this.session.request('initialize', {
      ...CLIENT_INIT_ARGS,
      adapterID: this.session.adapterKey,
    }).catch((error: unknown) => {
      if (this.session.listener === null || !(error instanceof Error) || !/timed out/.test(error.message)) throw error
      throw new Error(`the program listening at ${this.session.listener.host}:${this.session.listener.port} did not answer initialize within ${REQUEST_TIMEOUT_MS}ms — is it a debugpy --listen socket?`)
    })
    const attach = options.mode === 'attach' || this.needs.spec().startRequest === 'attach'
    this.session.startMode = attach ? 'attach' : 'launch'
    const startBody = startBodyOf(this.needs.spec(), this.needs.cwd(), options, attach)
    const launchDone = this.session.request(attach ? 'attach' : 'launch', startBody, 20_000)
    launchDone.catch(passedOver)
    const initializedTimeoutMs = options.noDebug ? 2_000 : 10_000
    const sawInitialized = await waitForDap(this.needs.initializedEvent().then(() => true), this.needs.operationSignal(), initializedTimeoutMs)
    if (!sawInitialized && !options.noDebug) {
      if (this.session.listener !== null) {
        throw new Error(`the program listening at ${this.session.listener.host}:${this.session.listener.port} never sent initialized (10s) — is it a debugpy --listen socket?`)
      }
      throw new Error(adapterSilenceMessage('adapter never sent initialized (10s)', this.session.adapterKey))
    }
    if (sawInitialized) {
      if (options.breakpoints && !options.noDebug) {
        for (const [path, lines] of options.breakpoints) {
          try {
            await this.session.setBreakpoints(path, lines)
          } catch (err) {
            this.#recordUnboundBreakpoints(path, lines, err)
          }
        }
      }
      await this.session.request('configurationDone').catch(passedOver)
    }
    await launchDone
  }

  #recordUnboundBreakpoints(path: string, breakpoints: Array<number | DapBreakpointSpec>, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err)
    this.session.breakpoints.set(
      path,
      breakpoints.map(b => ({ line: typeof b === 'number' ? b : b.line, verified: false, message: `setBreakpoints failed: ${reason}` })),
    )
    this.needs.pushOutput(`[dap] breakpoints for ${path} on '${this.session.label}' failed: ${reason} — the program runs without them; op:"breakpoints" retries the binding`)
  }
}
