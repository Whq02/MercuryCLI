import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { getMercuryHome } from '../../utils/envUtils.js'
import { readSessionWorkers, sessionOwnedByLiveWorker } from '../../daemon/concourseWorkers.js'
import type { PermissionMode } from '../../../sdk/src/door.js'

const name = z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/)
export const automationAccessSchema = z.strictObject({
  clients: z.array(z.strictObject({
    name,
    token: z.string().regex(/^[A-Za-z0-9._~+\/-]{32,}={0,2}$/),
    run: z.boolean().default(false),
    send: z.array(z.union([z.string().uuid(), z.enum(['lead', 'coordinator'])])).default([]),
  })).min(1),
}).superRefine(({ clients }, ctx) => {
  if (new Set(clients.map(client => client.name)).size !== clients.length || new Set(clients.map(client => client.token)).size !== clients.length) ctx.addIssue({ code: 'custom', message: 'Each client needs its own name and token' })
})
export type AutomationClient = { name: string; run: boolean; send: readonly string[] }

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
