import { randomUUID } from 'node:crypto'
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { AgentApp } from '@agentclientprotocol/sdk'
import { listSessionsImpl } from '../../../sessions/transcripts/listSessions.js'
import { getProjectDir } from '../../../sessions/transcripts/paths.js'
import { loadTranscriptFile } from '../../../sessions/transcripts/loading.js'
import { withoutRetractedReplies } from '../../../engine/connector/midTurnText.js'
import { join } from 'node:path'
import { MERCURY_VERSION } from '../../../platform/product/product.js'
import { existsSync } from 'node:fs'
import type { TurnEndDetail } from '../childSession.js'
import { isFlowGateEnabled } from '../../../permissions/rules/permissionSetup.js'
import { acpAuthMethods, acpAuthRequiredError, acpAuthenticate, acpClientAuthFacts, acpSignInRequired } from '../acpSignIn.js'
import { refuse, permissionModesOffered, readSavedMode, modesFor, configOptionsFor, setSessionMode } from './modes.js'
import { stopReasonOf } from './toolWire.js'
import { editorContextOf, editorContextResource } from './editorContext.js'
import { sessionLineOf, replayUpdatesOf } from './replay.js'
import { acpPromptToComposerDocument, composerDocumentBlocks } from './prompt.js'
import type { AcpServerOptions, AcpServerState, AcpSessionState } from './state.js'
import { attachSession } from './attach.js'

export function sessionRequests(app: AgentApp, server: AcpServerState, opts: AcpServerOptions): AgentApp {
  const { sessions, pendingLoads } = server
  const requireSignIn = async (): Promise<void> => {
    if (await acpSignInRequired()) throw acpAuthRequiredError(server.authFacts)
  }
  return app
    .onRequest('initialize', ctx => {
      const caps = ctx.params.clientCapabilities?.elicitation
      server.clientFormElicitation = caps?.form !== undefined && caps.form !== null
      server.clientUrlElicitation = caps?.url !== undefined && caps.url !== null
      server.clientElicitation = server.clientFormElicitation || server.clientUrlElicitation
      server.clientFsReadTextFile = ctx.params.clientCapabilities?.fs?.readTextFile === true
      server.clientFsWriteTextFile = ctx.params.clientCapabilities?.fs?.writeTextFile === true
      server.clientTerminal = ctx.params.clientCapabilities?.terminal === true
      server.authFacts = acpClientAuthFacts(ctx.params.clientCapabilities)
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { list: {} },
        },
        authMethods: acpAuthMethods(server.authFacts),
        agentInfo: { name: 'mercury', title: 'Mercury', version: MERCURY_VERSION },
      }
    })
    .onRequest('authenticate', async ctx => {
      await acpAuthenticate(ctx, server.authFacts, opts.signIn)
      return {}
    })
    .onRequest('session/new', async ctx => {
      await requireSignIn()
      const sessionId = randomUUID()
      attachSession(server, ctx.client, {
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
        if (server.transportClosed) throw new Error('the ACP connection closed during session/load')
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
        attachSession(server, ctx.client, {
          cwd: ctx.params.cwd,
          acpSessionId: requested,
          ...(hasTranscript ? { resumeSessionId: requested } : {}),
          modeId,
          mcpServers: ctx.params.mcpServers,
        })
        try {
          for (const update of replayUpdatesOf(withoutRetractedReplies(sessionLineOf(messages)))) {
            await ctx.client.notify(methods.client.session.update, {
              sessionId: requested,
              update,
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
        sessions: page.map(s => ({
          sessionId: s.sessionId,
          cwd: s.cwd ?? '',
          ...(s.summary !== '' ? { title: s.summary } : {}),
        })),
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
          ...(editorResource !== null ? [editorResource] : []),
          ...ctx.params.prompt,
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
}
