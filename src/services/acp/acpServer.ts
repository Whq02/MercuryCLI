
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import {
  agent,
  ndJsonStream,
  methods,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'
import type {
  AgentContext,
} from '@agentclientprotocol/sdk'
import {
  listReviewArtifactHeadsSource,
  readReviewArtifactState,
} from '../../utils/artifacts/reviewStore.js'
import { healthOf, valueOr } from '../../substrate/sourceState.js'
import { getRunSnapshot } from '../run/runCoordinator.js'
import { loadRunSidecar, runRevision } from '../run/runSidecar.js'
import { processMainOwner } from '../run/resolveOwner.js'
import { isOwnerKey, type OwnerKey } from '../run/ownerKey.js'
import { getCwd } from '../../utils/cwd.js'
import { listSessionsImpl } from '../../utils/listSessionsImpl.js'
import { getProjectDir } from '../../utils/sessionStorage/paths.js'
import { loadTranscriptFile } from '../../utils/sessionStorage/loading.js'
import { withoutRetractedReplies } from '../engine-connector/midTurnText.js'
import { join } from 'node:path'
import { MERCURY_VERSION } from '../../constants/product.js'
import { resolveWorkbenchSnapshot } from '../workbench/projection.js'
import { listTasks, getTasksDir } from '../../utils/tasks.js'
import { existsSync } from 'node:fs'
import { MercuryChildSession, type TurnEndDetail } from './childSession.js'
import { selfScriptPath } from '../../daemon/daemonBuild.js'
import { isFlowGateEnabled, isSovereignDisabled } from '../../utils/permissions/permissionSetup.js'
import { questionFormOf } from './questionForm.js'
import { acpAuthMethods, acpAuthRequiredError, acpAuthenticate, acpClientAuthFacts, acpSignInRequired, type AcpClientAuthFacts, type AcpSignInRoads } from './acpSignIn.js'
import { refuse, permissionModesOffered, savedModePath, savedModeStore, readSavedMode } from './acpServer/modes.js'
import { permissionAskWire, permissionAllowedOf, permissionAnswerOf, elicitationWire, elicitationAnswerOf } from './acpServer/asks.js'
import { toolKindOf, toolLocationsOf, toolDiffsOf, toolOutputContentOf, stopReasonOf, acpMcpServersToConfig, planEntriesOf, usageWireOf } from './acpServer/toolWire.js'
import { editorContextOf, editorContextResource, type EditorContextWire } from './acpServer/editorContext.js'
import { sessionLineOf, replayUpdatesOf } from './acpServer/replay.js'
import { acpPromptToComposerDocument, composerDocumentBlocks } from './acpServer/prompt.js'
import { attentionWireFromSnapshot } from './acpServer/attention.js'

export { permissionAskWire, permissionAllowedOf, permissionAnswerOf } from './acpServer/asks.js'
export { toolKindOf, toolLocationsOf, toolDiffsOf, TOOL_OUTPUT_WIRE_LIMIT, boundedToolText, toolOutputContentOf, stopReasonOf, acpMcpServersToConfig, planEntriesOf, usageWireOf } from './acpServer/toolWire.js'
export { editorContextOf, editorContextResource } from './acpServer/editorContext.js'
export { replayUpdatesOf } from './acpServer/replay.js'
export { acpPromptToComposerDocument, composerDocumentBlocks } from './acpServer/prompt.js'
export { attentionWire, attentionWireFromSnapshot } from './acpServer/attention.js'

const TASK_PLAN_TOOLS = new Set(['TaskCreate', 'TaskUpdate'])

interface AcpSessionState {
  child: MercuryChildSession
  cwd: string
  modeId: string
  modePath: string
  modeChanges: Promise<void>
  turnResolve: ((outcome: 'success' | 'error' | 'cancelled', detail?: TurnEndDetail) => void) | null
  cancelled: boolean
  promptAbort: AbortController | null
  editorContext: EditorContextWire | null
  toolNames: Map<string, string>
  planChain: Promise<void>
  planEverSent: boolean
  costTotalUsd: number
}

interface AcpServerOptions {
  entry?: { node: string; script: string }
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  signIn?: AcpSignInRoads
}

export async function runAcpServer(opts: AcpServerOptions = {}): Promise<void> {
  const sessions = new Map<string, AcpSessionState>()
  let transportClosed = false
  let clientElicitation = false
  let clientFormElicitation = false
  let clientUrlElicitation = false
  let clientFsReadTextFile = false
  let clientFsWriteTextFile = false
  let clientTerminal = false
  let authFacts: AcpClientAuthFacts = { terminalAuth: false, urlElicitation: false }
  const entry = opts.entry ?? { node: process.execPath, script: selfScriptPath() }
  const requireSignIn = async (): Promise<void> => {
    if (await acpSignInRequired()) throw acpAuthRequiredError(authFacts)
  }

  const attachSession = (
    ctx: AgentContext,
    args: {
      cwd: string
      acpSessionId: string
      resumeSessionId?: string
      modeId?: string
      mcpServers?: unknown
    },
  ): AcpSessionState => {
    const acpSessionId = args.acpSessionId
    const state: AcpSessionState = {
      child: null as unknown as MercuryChildSession,
      cwd: args.cwd,
      modeId: args.modeId ?? 'default',
      modePath: savedModePath(args.cwd, acpSessionId),
      modeChanges: Promise.resolve(),
      turnResolve: null,
      cancelled: false,
      promptAbort: null,
      editorContext: null,
      toolNames: new Map(),
      planChain: Promise.resolve(),
      planEverSent: false,
      costTotalUsd: 0,
    }
    const emitPlan = (): void => {
      state.planChain = state.planChain
        .then(async () => {
          const listId = state.child.mercurySessionId ?? acpSessionId
          const entries = planEntriesOf(await listTasks(listId))
          if (entries.length === 0 && !state.planEverSent) return
          if (entries.length === 0 && !existsSync(getTasksDir(listId))) return
          state.planEverSent = true
          void ctx.notify(methods.client.session.update, {
            sessionId: acpSessionId,
            update: { sessionUpdate: 'plan', entries },
          })
        })
        .catch(() => {
        })
    }
    const mcp = acpMcpServersToConfig(args.mcpServers)
    if (mcp && mcp.skipped.length > 0) {
      process.stderr.write(`[acp] mcpServers not carried (unsupported shape): ${mcp.skipped.join(', ')}\n`)
    }
    const child = new MercuryChildSession(
      {
        cwd: args.cwd,
        ...(args.resumeSessionId !== undefined
          ? { resumeSessionId: args.resumeSessionId }
          : { sessionId: acpSessionId }),
        permissionMode: args.modeId ?? 'default',
        allowSovereign: !isSovereignDisabled(),
        elicitation: clientElicitation,
        fsReadTextFile: clientFsReadTextFile,
        fsWriteTextFile: clientFsWriteTextFile,
        terminal: clientTerminal,
        entry,
        ...(mcp !== null && { mcpConfig: mcp.json }),
      },
      {
        onInit: sessionId => {
          if (sessionId !== acpSessionId && !sessions.has(sessionId)) {
            sessions.set(sessionId, state)
          }
        },
        onAssistantText: text => {
          void ctx.notify(methods.client.session.update, {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
          })
        },
        onAssistantThought: text => {
          void ctx.notify(methods.client.session.update, {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text },
            },
          })
        },
        onToolUse: (toolUseId, name, input) => {
          state.toolNames.set(toolUseId, name)
          const diffs = toolDiffsOf(name, input)
          void ctx.notify(methods.client.session.update, {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: toolUseId,
              title: name,
              kind: toolKindOf(name),
              status: 'in_progress',
              rawInput: (input as Record<string, unknown>) ?? {},
              locations: toolLocationsOf(name, input),
              ...(diffs.length > 0 && { content: diffs.map(d => ({ type: 'diff' as const, ...d })) }),
            },
          })
        },
        onToolProgress: (parentToolUseId, text) => {
          void ctx.notify(methods.client.session.update, {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: parentToolUseId,
              status: 'in_progress',
              content: [{ type: 'content', content: { type: 'text', text } }],
            },
          })
        },
        onMode: modeId => {
          void ctx.notify(methods.client.session.update, {
            sessionId: acpSessionId,
            update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
          })
        },
        onToolResult: (toolUseId, isError, output) => {
          const content = toolOutputContentOf(output)
          void ctx.notify(methods.client.session.update, {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: toolUseId,
              status: isError ? 'failed' : 'completed',
              ...(content !== undefined && { content }),
            },
          })
          const name = state.toolNames.get(toolUseId)
          state.toolNames.delete(toolUseId)
          if (name !== undefined && TASK_PLAN_TOOLS.has(name) && !isError) emitPlan()
        },
        onUsage: (lastRoundTrip, model, turnCostUsd) => {
          if (turnCostUsd !== undefined) state.costTotalUsd += turnCostUsd
          void ctx.notify(methods.client.session.update, {
            sessionId: acpSessionId,
            update: {
              sessionUpdate: 'usage_update',
              ...usageWireOf(lastRoundTrip, model),
              ...(state.costTotalUsd > 0 && {
                cost: { amount: state.costTotalUsd, currency: 'USD' as const },
              }),
            },
          })
        },
        onTurnEnd: (outcome, detail) => {
          if (state.turnResolve) {
            const resolveTurn = state.turnResolve
            state.turnResolve = null
            resolveTurn(state.cancelled ? 'cancelled' : outcome, detail)
            state.cancelled = false
          }
        },
        onPermissionAsk: async (requestId, ask, withdrawn) => {
          try {
            if (ask.tool_name === 'AskUserQuestion') {
              if (!clientFormElicitation) return { outcome: 'deny', message: 'This editor cannot present question forms; the questions were not answered.' }
              const form = questionFormOf(ask, acpSessionId)
              if (!form) return { outcome: 'deny', message: 'The question form is invalid; the questions were not answered.' }
              const result = await ctx.request(methods.client.elicitation.create, form.request, { cancellationSignal: withdrawn })
              return form.answer(result)
            }
            const result = await ctx.request(
              methods.client.session.requestPermission,
              permissionAskWire({ toolUseId: ask.tool_use_id, toolName: ask.tool_name, input: ask.input, title: ask.title, description: ask.description, ...(ask.suggestions !== undefined ? { suggestions: ask.suggestions } : {}) }, requestId, acpSessionId),
              { cancellationSignal: withdrawn },
            )
            return permissionAnswerOf(result, ask)
          } catch (e) {
            return { outcome: 'deny', message: `the editor did not answer the permission request: ${e}` }
          }
        },
        onElicitation: async (params, withdrawn) => {
          if (params.mode === 'url' ? !clientUrlElicitation : !clientFormElicitation) return { action: 'cancel' }
          try {
            const result = await ctx.request(methods.client.elicitation.create, elicitationWire(params, acpSessionId) as never, { cancellationSignal: withdrawn })
            return elicitationAnswerOf(result)
          } catch {
            return { action: 'cancel' }
          }
        },
        onElicitationComplete: (_server, elicitationId) => {
          void ctx.notify(methods.client.elicitation.complete, { sessionId: acpSessionId, elicitationId })
        },
        onReadTextFile: async (params, withdrawn) => {
          if (!clientFsReadTextFile) throw new Error('fs/read_text_file was not advertised by this ACP client')
          const result = (await ctx.request(
            methods.client.fs.readTextFile,
            {
              sessionId: acpSessionId,
              path: params.path,
              ...(params.line !== undefined ? { line: params.line } : {}),
              ...(params.limit !== undefined ? { limit: params.limit } : {}),
            },
            { cancellationSignal: withdrawn },
          )) as { content: string }
          return { content: result.content }
        },
        onWriteTextFile: async (params, withdrawn) => {
          if (!clientFsWriteTextFile) throw new Error('fs/write_text_file was not advertised by this ACP client')
          await ctx.request(
            methods.client.fs.writeTextFile,
            {
              sessionId: acpSessionId,
              path: params.path,
              content: params.content,
            },
            { cancellationSignal: withdrawn },
          )
          return {}
        },
        onTerminalCreate: async (params, withdrawn) => {
          if (!clientTerminal) throw new Error('terminal was not advertised by this ACP client')
          const result = (await ctx.request(
            methods.client.terminal.create,
            {
              sessionId: acpSessionId,
              command: params.command,
              ...(params.args !== undefined ? { args: params.args } : {}),
              ...(params.env !== undefined ? { env: params.env } : {}),
              ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
              ...(params.output_byte_limit !== undefined ? { outputByteLimit: params.output_byte_limit } : {}),
            },
            { cancellationSignal: withdrawn },
          )) as { terminalId: string }
          return { terminal_id: result.terminalId }
        },
        onTerminalOutput: async (params, withdrawn) => {
          if (!clientTerminal) throw new Error('terminal was not advertised by this ACP client')
          const result = (await ctx.request(
            methods.client.terminal.output,
            { sessionId: acpSessionId, terminalId: params.terminal_id },
            { cancellationSignal: withdrawn },
          )) as { output: string; truncated: boolean; exitStatus?: { exitCode?: number | null; signal?: string | null } | null }
          return {
            output: result.output,
            truncated: result.truncated,
            ...(result.exitStatus !== undefined && result.exitStatus !== null
              ? {
                  exit_status: {
                    ...(result.exitStatus.exitCode !== undefined ? { exit_code: result.exitStatus.exitCode } : {}),
                    ...(result.exitStatus.signal !== undefined ? { signal: result.exitStatus.signal } : {}),
                  },
                }
              : {}),
          }
        },
        onTerminalWaitForExit: async (params, withdrawn) => {
          if (!clientTerminal) throw new Error('terminal was not advertised by this ACP client')
          const result = (await ctx.request(
            methods.client.terminal.waitForExit,
            { sessionId: acpSessionId, terminalId: params.terminal_id },
            { cancellationSignal: withdrawn },
          )) as { exitCode?: number | null; signal?: string | null }
          return {
            ...(result.exitCode !== undefined ? { exit_code: result.exitCode } : {}),
            ...(result.signal !== undefined ? { signal: result.signal } : {}),
          }
        },
        onTerminalKill: async (params, withdrawn) => {
          if (!clientTerminal) throw new Error('terminal was not advertised by this ACP client')
          await ctx.request(
            methods.client.terminal.kill,
            { sessionId: acpSessionId, terminalId: params.terminal_id },
            { cancellationSignal: withdrawn },
          )
          return {}
        },
        onTerminalRelease: async (params, withdrawn) => {
          if (!clientTerminal) throw new Error('terminal was not advertised by this ACP client')
          await ctx.request(
            methods.client.terminal.release,
            { sessionId: acpSessionId, terminalId: params.terminal_id },
            { cancellationSignal: withdrawn },
          )
          return {}
        },
        onExit: code => {
          if (state.turnResolve) {
            const resolveTurn = state.turnResolve
            state.turnResolve = null
            resolveTurn('error', {
              status: 'child_exited',
              errors: [`the session process exited${code === null ? '' : ` (${code})`} mid-turn`],
            })
          }
          for (const [key, value] of sessions) {
            if (value === state) sessions.delete(key)
          }
        },
      },
    )
    state.child = child
    sessions.set(acpSessionId, state)
    return state
  }

  const modesFor = (modeId: string) => ({
    currentModeId: modeId,
    availableModes: permissionModesOffered().map(m => ({
      id: m.id,
      name: m.name,
      description: m.description,
    })),
  })

  const configOptionsFor = (modeId: string) => [
    {
      id: 'permission-mode',
      name: 'Permission mode',
      description: 'The Mercury permission ladder for this session',
      category: 'mode' as const,
      type: 'select' as const,
      currentValue: modeId,
      options: permissionModesOffered().map(m => ({
        value: m.id,
        name: m.name,
        description: m.description,
      })),
    },
  ]

  const notifyModeChanged = (ctx: AgentContext, sessionId: string, modeId: string): void => {
    void ctx.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
    })
    void ctx.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions: configOptionsFor(modeId) },
    })
  }

  const setSessionMode = (ctx: AgentContext, sessionId: string, state: AcpSessionState, modeId: string): Promise<void> => {
    const change = state.modeChanges.catch(() => {}).then(async () => {
      if (modeId === 'sovereign') {
        const consent = await ctx.request(
          methods.client.session.requestPermission,
          permissionAskWire({ toolName: 'Sovereign Mode', input: { mode: 'sovereign', effect: 'every tool call auto-approved for this session' } }, 'sovereign-consent', sessionId),
        )
        if (!permissionAllowedOf(consent)) refuse('Sovereign Mode needs your consent — the request was declined')
      }
      await state.child.setPermissionMode(modeId).catch((error: unknown) => refuse(error instanceof Error ? error.message : String(error)))
      state.modeId = modeId
      notifyModeChanged(ctx, sessionId, modeId)
      await savedModeStore(state.modePath).write({ permissionMode: modeId === 'sovereign' ? 'default' : modeId })
    })
    state.modeChanges = change
    return change
  }

  const pendingLoads = new Map<string, Promise<{
    modes: ReturnType<typeof modesFor>
    configOptions: ReturnType<typeof configOptionsFor>
  }>>()

  const app = agent({ name: 'mercury' })
    .onRequest('initialize', ctx => {
      const caps = ctx.params.clientCapabilities?.elicitation
      clientFormElicitation = caps?.form !== undefined && caps.form !== null
      clientUrlElicitation = caps?.url !== undefined && caps.url !== null
      clientElicitation = clientFormElicitation || clientUrlElicitation
      clientFsReadTextFile = ctx.params.clientCapabilities?.fs?.readTextFile === true
      clientFsWriteTextFile = ctx.params.clientCapabilities?.fs?.writeTextFile === true
      clientTerminal = ctx.params.clientCapabilities?.terminal === true
      authFacts = acpClientAuthFacts(ctx.params.clientCapabilities)
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { list: {} },
        },
        authMethods: acpAuthMethods(authFacts),
        agentInfo: { name: 'mercury', title: 'Mercury', version: MERCURY_VERSION },
      }
    })
    .onRequest('authenticate', async ctx => {
      await acpAuthenticate(ctx, authFacts, opts.signIn)
      return {}
    })
    .onRequest('session/new', async ctx => {
      await requireSignIn()
      const sessionId = randomUUID()
      attachSession(ctx.client, {
        cwd: ctx.params.cwd,
        acpSessionId: sessionId,
        mcpServers: ctx.params.mcpServers,
      })
      return {
        sessionId,
        modes: modesFor('default'),
        configOptions: configOptionsFor('default'),
      }
    })
    .onRequest('session/load', async ctx => {
      await requireSignIn()
      const requested = ctx.params.sessionId
      const pending = pendingLoads.get(requested)
      if (pending) return pending
      if (sessions.has(requested)) {
        const modeId = sessions.get(requested)!.modeId
        return { modes: modesFor(modeId), configOptions: configOptionsFor(modeId) }
      }
      const loading = (async () => {
        const transcriptPath = join(getProjectDir(ctx.params.cwd), `${requested}.jsonl`)
        const savedMode = await readSavedMode(ctx.params.cwd, requested)
        const hasTranscript = existsSync(transcriptPath)
        if (!hasTranscript && savedMode === undefined) {
          throw new Error(`unknown session '${requested}' — no transcript or saved mode exists for it here`)
        }
        const { messages } = await loadTranscriptFile(transcriptPath)
        if (transportClosed) throw new Error('the ACP connection closed during session/load')
        let modeId = savedMode
        if (modeId === undefined) {
          for (const message of messages.values()) {
            if (message.type === 'user' && !message.isSidechain && !message.isMeta && typeof message.permissionMode === 'string') {
              modeId = message.permissionMode
            }
          }
        }
        modeId = modeId ?? 'default'
        if (!permissionModesOffered().some(mode => mode.id === modeId) || (modeId === 'flow' && !isFlowGateEnabled()) || modeId === 'sovereign') {
          process.stderr.write(`[acp] saved permission mode '${modeId}' is not resumed here — resuming in the default mode\n`)
          modeId = 'default'
        }
        attachSession(ctx.client, {
          cwd: ctx.params.cwd,
          acpSessionId: requested,
          ...(hasTranscript ? { resumeSessionId: requested } : {}),
          modeId,
          mcpServers: ctx.params.mcpServers,
        })
        try {
          for (const update of replayUpdatesOf(withoutRetractedReplies(sessionLineOf(messages)) as unknown as Iterable<Record<string, unknown>>)) {
            await ctx.client.notify(methods.client.session.update, {
              sessionId: requested,
              update: update as never,
            })
          }
        } catch (e) {
          process.stderr.write(`[acp] session/load replay skipped: ${e instanceof Error ? e.message : String(e)}\n`)
        }
        return { modes: modesFor(modeId), configOptions: configOptionsFor(modeId) }
      })()
      pendingLoads.set(requested, loading)
      try {
        return await loading
      } finally {
        pendingLoads.delete(requested)
      }
    })
    .onRequest('session/list', async ctx => {
      const cursor = ctx.params?.cursor ? Number(ctx.params.cursor) : 0
      const limit = 50
      const all = await listSessionsImpl({ limit: cursor + limit + 1 })
      const page = all.slice(cursor, cursor + limit)
      return {
        sessions: page.map(s => {
          const raw = s as unknown as Record<string, unknown>
          return {
            sessionId: String(raw.sessionId ?? raw.id ?? ''),
            cwd: String(raw.cwd ?? raw.projectPath ?? ''),
            ...(typeof raw.summary === 'string' && raw.summary !== ''
              ? { title: raw.summary }
              : {}),
          }
        }),
        ...(all.length > cursor + limit ? { nextCursor: String(cursor + limit) } : {}),
      }
    })
    .onRequest('session/prompt', async ctx => {
      const state = sessions.get(ctx.params.sessionId)
      if (!state) {
        throw new Error(`unknown session '${ctx.params.sessionId}' — session/new or session/load first`)
      }
      if (state.turnResolve) {
        throw new Error('a prompt turn is already in flight for this session')
      }
      const editorResource = editorContextResource(state.editorContext)
      const blocks = composerDocumentBlocks(
        acpPromptToComposerDocument([
          ...(editorResource !== null ? [editorResource as unknown as Record<string, unknown>] : []),
          ...(ctx.params.prompt as unknown as Array<Record<string, unknown>>),
        ]),
      )
      state.cancelled = false
      const promptAbort = new AbortController()
      state.promptAbort = promptAbort
      const settled = await new Promise<{
        outcome: 'success' | 'error' | 'cancelled'
        detail: TurnEndDetail | undefined
      }>(resolve => {
        const resolveTurn: NonNullable<AcpSessionState['turnResolve']> = (outcome, detail) => resolve({ outcome, detail })
        state.turnResolve = resolveTurn
        state.child.writeUserPrompt(blocks, promptAbort.signal).catch((e: unknown) => {
          if (state.turnResolve !== resolveTurn) return
          state.turnResolve = null
          if (promptAbort.signal.aborted) {
            resolve({ outcome: 'cancelled', detail: undefined })
            return
          }
          const why = e instanceof Error ? e.message : String(e)
          process.stderr.write(`[acp] session/prompt failed to reach the child: ${why}\n`)
          resolve({ outcome: 'error', detail: { status: 'prompt_undelivered', errors: [why] } })
        })
      })
      if (state.promptAbort === promptAbort) state.promptAbort = null
      const verdict = stopReasonOf(settled.outcome, settled.detail)
      if ('error' in verdict) throw new Error(verdict.error)
      return { stopReason: verdict.stopReason }
    })
    .onRequest('session/set_mode', async ctx => {
      const state = sessions.get(ctx.params.sessionId)
      if (!state) throw new Error(`unknown session '${ctx.params.sessionId}'`)
      const modeId = ctx.params.modeId
      if (!permissionModesOffered().some(m => m.id === modeId)) {
        refuse(`unknown mode '${modeId}' — modes: ${permissionModesOffered().map(m => m.id).join(', ')}`)
      }
      await setSessionMode(ctx.client, ctx.params.sessionId, state, modeId)
      return {}
    })
    .onRequest('session/set_config_option', async ctx => {
      const state = sessions.get(ctx.params.sessionId)
      if (!state) throw new Error(`unknown session '${ctx.params.sessionId}'`)
      if (ctx.params.configId !== 'permission-mode') {
        throw new Error(`unknown config option '${ctx.params.configId}' — options: permission-mode`)
      }
      const value = ctx.params.value
      if (typeof value !== 'string' || !permissionModesOffered().some(m => m.id === value)) {
        refuse(`unknown permission-mode value '${String(value)}' — values: ${permissionModesOffered().map(m => m.id).join(', ')}`)
      }
      await setSessionMode(ctx.client, ctx.params.sessionId, state, value)
      return { configOptions: configOptionsFor(value) }
    })
    .onRequest('session/close', async ctx => {
      const state = sessions.get(ctx.params.sessionId)
      if (state) {
        state.promptAbort?.abort()
        if (state.turnResolve) {
          const resolveTurn = state.turnResolve
          state.turnResolve = null
          resolveTurn('cancelled')
        }
        await state.child.close()
        for (const [key, value] of sessions) {
          if (value === state) sessions.delete(key)
        }
      }
      return {}
    })
    .onNotification('session/cancel', ctx => {
      const state = sessions.get(ctx.params.sessionId)
      if (state && state.turnResolve) {
        state.cancelled = true
        state.promptAbort?.abort()
        state.child.interrupt()
      }
    })
    .onNotification('_mercury/editor_context', (v: unknown) => editorContextOf(v), ctx => {
      const wire = ctx.params
      if (wire === null) return
      const state = sessions.get(wire.sessionId)
      if (state) state.editorContext = wire
    })
    .onRequest('_mercury/workbench', (v: unknown) => (v ?? {}), async () => {
      const snap = await resolveWorkbenchSnapshot()
      if (!snap) {
        return {
          threads: [],
          lanes: [],
          missions: [],
          artifactHeads: [],
          unavailable: 'the workbench projection is disabled',
        }
      }
      return {
        generation: snap.generation,
        nextAction: snap.nextAction,
        attention: attentionWireFromSnapshot(snap),
        threads: [snap.root, ...snap.threads].map(t => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          phase: t.phase,
          state: t.state,
          ...(t.model !== undefined && { model: t.model }),
          ...(t.worktreePath !== undefined && { worktreePath: t.worktreePath }),
          ...(t.blocker !== undefined && { blocker: t.blocker }),
        })),
        lanes: snap.lanes,
        missions: snap.missions,
        artifactHeads: snap.artifactHeads,
        sources: snap.sources,
      }
    })
    .onRequest('_mercury/artifacts', (v: unknown) => (v ?? {}), () => {
      const src = listReviewArtifactHeadsSource({ root: getCwd() })
      return {
        heads: valueOr(src, []).map(h => ({
          id: h.id,
          kind: h.kind,
          title: h.title,
          latestVersion: h.latestVersion,
          status: h.status,
          openComments: h.openComments,
        })),
        source: healthOf(src),
      }
    })
    .onRequest('_mercury/crew', (v: unknown) => (v ?? {}), async () => {
      const { crewDirectoryEnabled } = await import('../crew/identity.js')
      if (!crewDirectoryEnabled()) {
        return {
          members: [],
          inbox: [],
          conversations: [],
          descriptors: [],
          unavailable: 'the crew directory is disabled (MERCURY_CREW_DIRECTORY=0)',
        }
      }
      const [{ resolveCrewSnapshot }, conversationsMod, { deriveInbox }, descriptorMod, graphMod, identityMod] =
        await Promise.all([
          import('../crew/projection.js'),
          import('../crew/conversations.js'),
          import('../crew/inbox.js'),
          import('../crew/descriptor.js'),
          import('../crew/graph.js'),
          import('../../substrate/identity/identity.js'),
        ])
      const snap = await resolveCrewSnapshot()
      const operatorId = identityMod.operatorPrincipal().id
      const [conversations, cursors, descriptors, graph] = await Promise.all([
        conversationsMod.listConversations().catch(() => []),
        conversationsMod.listReadCursors(operatorId).catch(() => new Map<string, number>()),
        descriptorMod.listSessionDescriptors().catch(() => []),
        graphMod.assembleSessionGraph().catch(() => null),
      ])
      const inbox = deriveInbox(conversations, id => (cursors as Map<string, number>).get(id) ?? 0)
      const labels = new Map((snap?.members ?? []).map(m => [m.agentId as string, m.label]))
      const { foldScopeDecisions } = await import('../../utils/artifacts/reviewContracts.js')
      const folioSrc = listReviewArtifactHeadsSource({ root: getCwd() })
      const folioHeads = valueOr(folioSrc, []).slice(0, 40).map(h => {
        const state = readReviewArtifactState(h.id)
        const fold = state ? foldScopeDecisions(state.scopeDecisions, state.latestVersion) : null
        return {
          id: h.id,
          kind: h.kind,
          title: h.title,
          latestVersion: h.latestVersion,
          status: h.status,
          openComments: h.openComments,
          ...(fold
            ? {
                scopeFold: {
                  accepted: fold.accepted,
                  revisionRequested: fold.revisionRequested,
                  suggestion: fold.suggestion,
                },
              }
            : {}),
        }
      })
      return {
        members: (snap?.members ?? []).map(m => ({
          agentId: m.agentId,
          label: m.label,
          displayName: m.displayName,
          presence: m.presence,
          ...(m.lifecycle !== undefined ? { lifecycle: m.lifecycle } : {}),
          ...(m.focus !== undefined ? { focus: m.focus } : {}),
          ...(m.worktreeRef !== undefined ? { worktreeRef: m.worktreeRef } : {}),
          openSessions: m.sessions.filter(s => s.endedAt === undefined).length,
        })),
        sources: snap?.sources ?? null,
        inbox: inbox.map(r => ({
          conversationId: r.conversationId,
          bucket: r.bucket,
          title: r.title,
          kind: r.kind,
          unreadCount: r.unreadCount,
          resumeSeq: r.resumeSeq,
          updatedAt: r.updatedAt,
        })),
        conversations: conversations.slice(-100).map(c => ({
          conversationId: c.conversationId,
          kind: c.kind,
          title: c.title,
          lastEventSeq: c.lastEventSeq,
          readCursor: (cursors as Map<string, number>).get(c.conversationId) ?? 0,
          updatedAt: c.updatedAt,
        })),
        descriptors: descriptors.map(d => ({
          agentId: d.agentId,
          sessionId: d.sessionId,
          ...(d.missionRef !== undefined ? { missionRef: d.missionRef } : {}),
          ...(d.worktreeRef !== undefined ? { worktreeRef: d.worktreeRef } : {}),
          revision: d.revision,
          title: descriptorMod.renderSessionTitle({
            agentLabel: labels.get(d.agentId as string) ?? (d.agentId as string),
            ...(d.missionRef !== undefined ? { missionLabel: d.missionRef } : {}),
            ...(d.worktreeRef !== undefined ? { worktreeLabel: d.worktreeRef } : {}),
          }),
        })),
        ...(graph !== null ? { graph } : {}),
        folioHeads,
        folioSource: healthOf(folioSrc),
      }
    })
    .onRequest('_mercury/run', (v: unknown) => (v ?? {}), async ctx => {
      const asked = (ctx.params as { owner?: unknown } | null | undefined)?.owner
      let owner: OwnerKey
      if (asked === undefined) owner = processMainOwner()
      else if (isOwnerKey(asked)) owner = asked
      else return { error: 'malformed owner key' }
      let snap = getRunSnapshot(owner)
      if (snap === null) {
        try {
          const load = await loadRunSidecar(owner)
          if (load.state === 'loaded') snap = load.snapshot
          else if (load.state === 'unavailable') {
            return { unavailable: load.reason, retryable: load.retryable }
          }
        } catch {
        }
      }
      const revision = runRevision(owner)
      if (snap === null) return { run: null, revision }
      return {
        revision,
        run: {
          runId: snap.runId,
          objective: snap.objective,
          lifecycle: snap.lifecycle,
          phase: snap.phase,
          nextAction: snap.nextAction,
          totalChangedPaths: snap.totalChangedPaths,
          verification: snap.verification.state,
          ...(snap.blocker
            ? { blocker: { description: snap.blocker.description, ownedBy: snap.blocker.ownedBy } }
            : {}),
          ...(snap.modelState ? { model: snap.modelState } : {}),
        },
      }
    })
    .onRequest(
      '_mercury/artifact',
      (v: unknown) => {
        const id = (v as { id?: unknown } | null)?.id
        if (typeof id !== 'string') throw new Error('params.id (ra-…) required')
        return { id }
      },
      ctx => {
        const state = readReviewArtifactState(ctx.params.id)
        if (!state) throw new Error(`no review artifact '${ctx.params.id}'`)
        const latest = state.versions[state.versions.length - 1]!
        const lines: string[] = [
          `# ${state.title}`,
          '',
          `${state.kind} v${state.latestVersion} · ${state.statuses[state.latestVersion] ?? 'draft'}`,
          '',
        ]
        if ('markdown' in latest.body) lines.push(latest.body.markdown, '')
        if (latest.body.kind === 'diff') {
          for (const f of latest.body.files) lines.push(`- ${f.path} (${f.hunks.length} hunks)`)
          lines.push('')
        }
        if (state.comments.length > 0) {
          lines.push('## Comments', '')
          for (const c of state.comments) {
            lines.push(`- [${c.state}] ${c.author}: ${c.body}`)
          }
        }
        return {
          id: state.id,
          kind: state.kind,
          status: state.statuses[state.latestVersion] ?? 'draft',
          latestVersion: state.latestVersion,
          comments: state.comments,
          rendered: lines.join('\n'),
        }
      },
    )

  const input = Writable.toWeb(
    (opts.output ?? process.stdout) as NodeJS.WriteStream,
  ) as WritableStream<Uint8Array>
  const output = Readable.toWeb(
    (opts.input ?? process.stdin) as NodeJS.ReadStream,
  ) as ReadableStream<Uint8Array>
  const connection = app.connect(ndJsonStream(input, output))
  await connection.closed
  transportClosed = true
  const closes: Promise<void>[] = []
  for (const state of new Set(sessions.values())) {
    if (state.turnResolve) {
      const resolveTurn = state.turnResolve
      state.turnResolve = null
      resolveTurn('cancelled')
    }
    closes.push(state.child.close())
  }
  await Promise.all(closes)
}
