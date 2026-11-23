import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getMercuryHome } from '../../../utils/envUtils.js'
import { logMCPDebug } from '../../../utils/log.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from '../../../utils/mcp/types.js'
import { passedOver, passedOverAs } from '../../../utils/passedOver.js'

const NEEDS_AUTH_TTL_MS = 15 * 60 * 1000

function needsAuthCachePath(): string {
  return join(getMercuryHome(), 'mcp-needs-auth-cache.json')
}

let needsAuthReadMemo: Promise<Record<string, { timestamp: number }>> | null = null
let needsAuthWriteChain: Promise<void> = Promise.resolve()

function readNeedsAuthCache(): Promise<Record<string, { timestamp: number }>> {
  if (needsAuthReadMemo === null) {
    needsAuthReadMemo = readFile(needsAuthCachePath(), 'utf8')
      .then(text => JSON.parse(text) as Record<string, { timestamp: number }>)
      .catch((error) => { passedOver(error); return ({}) })
  }
  return needsAuthReadMemo
}

export async function isNeedsAuthWarm(serverName: string): Promise<boolean> {
  const cache = await readNeedsAuthCache()
  const entry = cache[serverName]
  return entry !== undefined && Date.now() - entry.timestamp < NEEDS_AUTH_TTL_MS
}

function writeNeedsAuth(serverName: string): Promise<void> {
  const next = needsAuthWriteChain.then(async () => {
    try {
      const filePath = needsAuthCachePath()
      const existing = await readFile(filePath, 'utf8')
        .then(text => JSON.parse(text) as Record<string, { timestamp: number }>)
        .catch(passedOverAs({} as Record<string, { timestamp: number }>))
      existing[serverName] = { timestamp: Date.now() }
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, JSON.stringify(existing, null, 2), 'utf8')
      needsAuthReadMemo = null
    } catch (error) {
      passedOver(error)
    }
  })
  needsAuthWriteChain = next
  return next
}

export function clearMcpAuthCache(): void {
  needsAuthReadMemo = null
  void rm(needsAuthCachePath(), { force: true }).catch(error => {
    passedOver(error)
    needsAuthReadMemo = Promise.resolve({})
  })
}

export function forgetMcpNeedsAuth(serverName: string): Promise<void> {
  const next = needsAuthWriteChain.then(async () => {
    const filePath = needsAuthCachePath()
    const existing = await readFile(filePath, 'utf8')
      .then(text => JSON.parse(text) as Record<string, { timestamp: number }>)
      .catch(passedOverAs({} as Record<string, { timestamp: number }>))
    if (!Object.hasOwn(existing, serverName)) return
    delete existing[serverName]
    try {
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, JSON.stringify(existing, null, 2), 'utf8')
      needsAuthReadMemo = null
    } catch (error) {
      passedOver(error)
      needsAuthReadMemo = Promise.resolve(existing)
    }
  })
  needsAuthWriteChain = next
  return next
}

export async function handleRemoteAuthFailure(name: string, config: ScopedMcpServerConfig, transportClass: string): Promise<MCPServerConnection> {
  logMCPDebug(name, `Authentication required for ${transportClass} server`)
  await writeNeedsAuth(name)
  return { name, type: 'needs-auth', config }
}
