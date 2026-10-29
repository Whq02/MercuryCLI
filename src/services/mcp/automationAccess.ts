import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { getMercuryHome } from '../../utils/envUtils.js'
import { readSessionWorkers, sessionOwnedByLiveWorker } from '../../daemon/concourseWorkers.js'
import type { PermissionMode } from '../../../sdk/src/door.js'

const name = z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/)
const secret = z.string().regex(/^[A-Za-z0-9._~+\/-]{32,}={0,2}$/)
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]'])
const redirectUri = z.url().refine(value => {
  const url = new URL(value)
  return !url.hash && !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback.has(url.hostname)))
}, 'A redirect URI must be HTTPS, or HTTP on the loopback address, without a fragment or credentials')
export const automationAccessSchema = z.strictObject({
  clients: z.array(z.strictObject({
    name,
    token: secret.optional(),
    oauth: z.strictObject({
      client_id: z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/),
      client_secret: secret.optional(),
      redirect_uris: z.array(redirectUri).min(1),
    }).optional(),
    run: z.boolean().default(false),
    send: z.array(z.union([z.string().uuid(), z.enum(['lead', 'coordinator'])])).default([]),
  }).refine(client => (client.token === undefined) !== (client.oauth === undefined), 'Each client needs either a token or an oauth entry')).min(1),
}).superRefine(({ clients }, ctx) => {
  const tokens = clients.flatMap(client => client.token === undefined ? [] : [client.token])
  const ids = clients.flatMap(client => client.oauth === undefined ? [] : [client.oauth.client_id])
  if (new Set(clients.map(client => client.name)).size !== clients.length || new Set(tokens).size !== tokens.length || new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Each client needs its own name, token and client id' })
})
export type AutomationClient = { name: string; run: boolean; send: readonly string[] }
export type AutomationOAuthClient = AutomationClient & { client_id: string; client_secret?: string; redirect_uris: readonly string[] }

export class AutomationPermissionRefusal extends Error {
  readonly code = 'permission_denied'
}

export async function launchingSession(cwd: string): Promise<string | undefined> {
  const workers = Object.values(readSessionWorkers()).filter(row => row.endedAt === undefined && row.workspaceId === cwd)
  const direct = workers.find(row => row.pid === process.ppid)
  if (direct && sessionOwnedByLiveWorker(direct.sessionId)) return direct.sessionId
  if (process.platform === 'win32' || workers.length === 0) return undefined
  const { collectPosixProcessTable } = await import('../../daemon/processSweepPosix.js')
  const table = await collectPosixProcessTable({ waitMs: 4000, recordedPids: workers.flatMap(row => row.pid ? [row.pid] : []) })
  if (!table.complete) return undefined
  const parents = new Map(table.observations.map(row => [row.process.pid, row.process.ppid]))
  const seen = new Set<number>()
  for (let pid: number | undefined = process.ppid; pid && !seen.has(pid); pid = parents.get(pid)) {
    seen.add(pid)
    const owner = workers.find(row => row.pid === pid)
    if (owner && sessionOwnedByLiveWorker(owner.sessionId)) return owner.sessionId
  }
  return undefined
}

export function clientReach(client: AutomationClient, roles: { lead?: string; coordinator?: string }): AutomationClient {
  return { ...client, send: client.send.map(target => {
    if (target !== 'lead' && target !== 'coordinator') return target
    const session = roles[target]
    if (!session) throw new Error(`The ${target} session must be named at server startup`)
    return z.string().uuid().parse(session)
  }) }
}

export class AutomationOwnership {
  private readonly cwd: string
  constructor(cwd: string) { this.cwd = realpathSync(cwd) }
  private path(id: string): string { return join(getMercuryHome(), 'mcp-server', 'sessions', `${z.string().uuid().parse(id)}.json`) }
  read(id: string): { client: string; mode: PermissionMode } | undefined {
    try {
      const value = JSON.parse(readFileSync(this.path(id), 'utf8')) as { cwd?: unknown; client?: unknown; mode?: PermissionMode }
      if (value.cwd === this.cwd && typeof value.client === 'string' && value.mode) return { client: value.client, mode: value.mode }
    } catch {}
    return undefined
  }
  record(id: string, client: string, mode: PermissionMode): void {
    const path = this.path(id)
    mkdirSync(join(getMercuryHome(), 'mcp-server', 'sessions'), { recursive: true, mode: 0o700 })
    writeFileSync(path, JSON.stringify({ cwd: this.cwd, client, mode }), { flag: 'wx', mode: 0o600 })
  }
}

export function modeWithinCeiling(mode: PermissionMode, ceiling: PermissionMode): boolean {
  if (mode === ceiling || ceiling === 'sovereign') return true
  if (mode === 'apollo') return true
  if (ceiling === 'implement') return mode === 'default' || mode === 'dontAsk'
  return ceiling === 'default' && mode === 'dontAsk'
}
