import { methods } from '@agentclientprotocol/sdk'
import type {
  AgentContext,
} from '@agentclientprotocol/sdk'
import { listTasks, getTasksDir } from '../../../engine/task-framework/tasks.js'
import { existsSync } from 'node:fs'
import { MercuryChildSession } from '../childSession.js'
import { isSovereignDisabled } from '../../../permissions/rules/permissionSetup.js'
import { questionFormOf } from '../questionForm.js'
import { savedModePath } from './modes.js'
import { permissionAskWire, permissionAnswerOf, elicitationWire, elicitationAnswerOf } from './asks.js'
import { toolKindOf, toolLocationsOf, toolDiffsOf, toolOutputContentOf, acpMcpServersToConfig, planEntriesOf, usageWireOf } from './toolWire.js'
import type { AcpServerState, AcpSessionState } from './state.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

const TASK_PLAN_TOOLS = new Set(['TaskCreate', 'TaskUpdate'])

export function attachSession(
  server: AcpServerState,
  ctx: AgentContext,
  args: {
    cwd: string
    acpSessionId: string
    resumeSessionId?: string
    modeId?: string
    mcpServers?: unknown
  },
): AcpSessionState {
  const { sessions, entry } = server
  const acpSessionId = args.acpSessionId
  let state: AcpSessionState
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
      .catch(passedOver)
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
      elicitation: server.clientElicitation,
      fsReadTextFile: server.clientFsReadTextFile,
      fsWriteTextFile: server.clientFsWriteTextFile,
      terminal: server.clientTerminal,
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
            if (!server.clientFormElicitation) return { outcome: 'deny', message: 'This editor cannot present question forms; the questions were not answered.' }
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
        if (params.mode === 'url' ? !server.clientUrlElicitation : !server.clientFormElicitation) return { action: 'cancel' }
        try {
          const result = await ctx.request(methods.client.elicitation.create, elicitationWire(params, acpSessionId), { cancellationSignal: withdrawn })
          return elicitationAnswerOf(result)
        } catch {
          return { action: 'cancel' }
        }
      },
      onElicitationComplete: (_server, elicitationId) => {
        void ctx.notify(methods.client.elicitation.complete, { sessionId: acpSessionId, elicitationId })
      },
      onReadTextFile: async (params, withdrawn) => {
        if (!server.clientFsReadTextFile) throw new Error('fs/read_text_file was not advertised by this ACP client')
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
        if (!server.clientFsWriteTextFile) throw new Error('fs/write_text_file was not advertised by this ACP client')
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
        if (!server.clientTerminal) throw new Error('terminal was not advertised by this ACP client')
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
        if (!server.clientTerminal) throw new Error('terminal was not advertised by this ACP client')
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
        if (!server.clientTerminal) throw new Error('terminal was not advertised by this ACP client')
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
        if (!server.clientTerminal) throw new Error('terminal was not advertised by this ACP client')
        await ctx.request(
          methods.client.terminal.kill,
          { sessionId: acpSessionId, terminalId: params.terminal_id },
          { cancellationSignal: withdrawn },
        )
        return {}
      },
      onTerminalRelease: async (params, withdrawn) => {
        if (!server.clientTerminal) throw new Error('terminal was not advertised by this ACP client')
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
  state = {
    child,
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
  sessions.set(acpSessionId, state)
  return state
}
