import { RequestError } from '@agentclientprotocol/sdk'
import { getProjectDir } from '../../../utils/sessionStorage/paths.js'
import { defineStore } from '../../../substrate/fileStore.js'
import { join } from 'node:path'
import { isSovereignDisabled } from '../../../utils/permissions/permissionSetup.js'
import { PERMISSION_MODES as MODE_WORDS, type PermissionMode } from '../../../types/permissions.js'
import { permissionModeTitle } from '../../../utils/permissions/PermissionMode.js'
import { MODE_GLOSS } from '../../../utils/settings/validationTips.js'

export function refuse(sentence: string): never {
  throw new RequestError(-32602, sentence)
}

export function permissionModesOffered(): ReadonlyArray<{ id: PermissionMode; name: string; description: string }> {
  return MODE_WORDS.filter(mode => mode !== 'sovereign' || !isSovereignDisabled()).map(mode => ({ id: mode, name: permissionModeTitle(mode), description: MODE_GLOSS[mode] }))
}

export function savedModePath(cwd: string, sessionId: string): string {
  return join(getProjectDir(cwd), `${encodeURIComponent(sessionId)}.acp.json`)
}

export const savedModeStore = defineStore<{ permissionMode?: string }, [path: string]>({
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
