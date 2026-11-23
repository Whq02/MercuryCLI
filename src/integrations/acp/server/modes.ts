import { methods, RequestError } from '@agentclientprotocol/sdk'
import type {
  AgentContext,
} from '@agentclientprotocol/sdk'
import { getProjectDir } from '../../../sessions/transcripts/paths.js'
import { defineStore } from '../../../platform/substrate/fileStore.js'
import { join } from 'node:path'
import { isSovereignDisabled } from '../../../permissions/rules/permissionSetup.js'
import { PERMISSION_MODES as MODE_WORDS, type PermissionMode } from '../../../permissions/rules/permissions.js'
import { permissionModeTitle } from '../../../permissions/rules/permissionMode.js'
import { MODE_GLOSS } from '../../../platform/settings/validationTips.js'
import { permissionAskWire, permissionAllowedOf } from './asks.js'
import type { AcpSessionState } from './state.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export function refuse(sentence: string): never {
  throw new RequestError(-32602, sentence)
}

export function permissionModesOffered(): ReadonlyArray<{ id: PermissionMode; name: string; description: string }> {
  return MODE_WORDS.filter(mode => mode !== 'sovereign' || !isSovereignDisabled()).map(mode => ({ id: mode, name: permissionModeTitle(mode), description: MODE_GLOSS[mode] }))
}

export function savedModePath(cwd: string, sessionId: string): string {
  return join(getProjectDir(cwd), `${encodeURIComponent(sessionId)}.acp.json`)
}

const savedModeStore = defineStore<{ permissionMode?: string }, [path: string]>({
  name: 'acp-session-mode',
  path: path => path,
  schemaVersion: 1,
  empty: () => ({}),
  onReadFailure: 'throw',
  decode: raw => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const mode = (raw as { permissionMode?: unknown }).permissionMode
    return mode === undefined ? {} : typeof mode === 'string' ? { permissionMode: mode } : null
  },
})

export async function readSavedMode(cwd: string, sessionId: string): Promise<string | undefined> {
  try {
    return (await savedModeStore(savedModePath(cwd, sessionId)).read()).permissionMode
  } catch (error) {
    process.stderr.write(`[acp] saved permission mode unreadable: ${error instanceof Error ? error.message : String(error)}\n`)
    return undefined
  }
}

export const modesFor = (modeId: string) => ({
  currentModeId: modeId,
  availableModes: permissionModesOffered().map(m => ({
    id: m.id,
    name: m.name,
    description: m.description,
  })),
})

export const configOptionsFor = (modeId: string) => [
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

export const setSessionMode = (ctx: AgentContext, sessionId: string, state: AcpSessionState, modeId: string): Promise<void> => {
  const change = state.modeChanges.catch(passedOver).then(async () => {
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
