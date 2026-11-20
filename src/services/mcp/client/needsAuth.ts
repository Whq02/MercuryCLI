import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getMercuryHome } from '../../../utils/envUtils.js'
import { logMCPDebug } from '../../../utils/log.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from '../types.js'
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
  needsAuthWriteChain = needsAuthWriteChain.then(async () => {
    const cache = await readNeedsAuthCache()
    cache[serverName] = { timestamp: Date.now() }
    const path = needsAuthCachePath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(cache, null, 2))
    needsAuthReadMemo = null
  }).catch(passedOverAs(undefined))
  return needsAuthWriteChain
}

export function clearMcpAuthCache(): void {
  needsAuthReadMemo = null
  void rm(needsAuthCachePath(), { force: true }).catch(error => {
    passedOver(error)
    needsAuthReadMemo = Promise.resolve({})
  })
}

export function forgetMcpNeedsAuth(serverName: string): Promise<void> {
  let unwritten: Record<string, { timestamp: number }> | null = null
  needsAuthWriteChain = needsAuthWriteChain
    .then(async () => {
      const cache = await readNeedsAuthCache()
      if (!(serverName in cache)) return
      delete cache[serverName]
      unwritten = cache
      const path = needsAuthCachePath()
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(cache, null, 2))
      unwritten = null
    })
    .catch(passedOverAs(undefined))
    .finally(() => {
      needsAuthReadMemo = unwritten === null ? null : Promise.resolve(unwritten)
    })
  return needsAuthWriteChain
}

export async function handleRemoteAuthFailure(name: string, config: ScopedMcpServerConfig, transportClass: string): Promise<MCPServerConnection> {
  logMCPDebug(name, `Authentication required for ${transportClass} server`)
  await writeNeedsAuth(name)
  return { name, type: 'needs-auth', config }
}
