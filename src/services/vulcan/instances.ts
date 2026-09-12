import { randomBytes } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import { engineTreesDir } from './engine/paths.js'

export const VULCAN_INSTANCE_ENV = 'MERCURY_VULCAN_INSTANCE'
export const VULCAN_INSTANCE_ROLES = ['operator-editor', 'agent-editor', 'headless-worker', 'native-worker'] as const
export type VulcanInstanceRole = typeof VULCAN_INSTANCE_ROLES[number]
export interface VulcanInstance {
  version: 1
  id: string
  role: VulcanInstanceRole
  port: number
  pid: number
  projectRoot: string
  ownerPid: number
}
export type VulcanInstanceSelector = string | { id?: string; role?: VulcanInstanceRole }
export type VulcanInstanceSelection = { ok: true; instance: VulcanInstance } | { ok: false; error: { code: string; message: string } }
export interface VulcanInstanceLaunch {
  id: string
  role: VulcanInstanceRole
  port: number
  token: string
  projectRoot: string
  ownerPid: number
}

export function vulcanProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function canonical(root: string): string {
  try { return realpathSync(root) } catch { return path.resolve(root) }
}

export function parseVulcanInstance(value: unknown): VulcanInstance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.version !== 1 || typeof v.id !== 'string' || !/^[a-f0-9]{32}$/.test(v.id) || !VULCAN_INSTANCE_ROLES.includes(v.role as VulcanInstanceRole)) return null
  if (!Number.isInteger(v.port) || Number(v.port) < 1 || Number(v.port) > 65535 || !Number.isInteger(v.pid) || Number(v.pid) < 1) return null
  if (typeof v.projectRoot !== 'string' || !path.isAbsolute(v.projectRoot) || !Number.isInteger(v.ownerPid) || Number(v.ownerPid) < 0) return null
  return { version: 1, id: v.id, role: v.role as VulcanInstanceRole, port: Number(v.port), pid: Number(v.pid), projectRoot: canonical(v.projectRoot), ownerPid: Number(v.ownerPid) }
}

export function sameVulcanInstance(a: VulcanInstance, b: VulcanInstance): boolean {
  return a.id === b.id && a.role === b.role && a.port === b.port && a.pid === b.pid && a.projectRoot === b.projectRoot && a.ownerPid === b.ownerPid
}

function instanceDir(root: string, id: string): string {
  return path.join(root, '.godot', 'mercury-vulcan', id)
}

function privateFile(file: string, maxBytes: number): string {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > maxBytes || (process.platform !== 'win32' && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()))) throw new Error('instance credentials are not private')
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}

export function readVulcanInstanceToken(instance: VulcanInstance): string {
  if (!parseVulcanInstance(instance)) throw new Error('instance identity is invalid')
  for (const relative of ['.godot', path.join('.godot', 'mercury-vulcan')]) {
    const parent = lstatSync(path.join(instance.projectRoot, relative))
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('instance directory cannot follow a symbolic link')
  }
  const dir = instanceDir(instance.projectRoot, instance.id)
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink() || (process.platform !== 'win32' && ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()))) throw new Error('instance directory is not private')
  const token = privateFile(path.join(dir, 'token'), 256).trim()
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('instance token is invalid')
  return token
}

function discoverRoot(root: string): VulcanInstance[] {
  const out: VulcanInstance[] = []
  let names: string[]
  try { names = readdirSync(path.join(root, '.godot', 'mercury-vulcan')) } catch { return out }
  for (const id of names.slice(0, 4096)) {
    if (!/^[a-f0-9]{32}$/.test(id)) continue
    try {
      const row = parseVulcanInstance(JSON.parse(privateFile(path.join(instanceDir(root, id), 'instance.json'), 8192)))
      if (!row || row.id !== id || row.projectRoot !== canonical(root) || !vulcanProcessAlive(row.pid)) continue
      readVulcanInstanceToken(row)
      out.push(row)
    } catch { continue }
  }
  return out
}

export function listVulcanInstances(projectRoot: string): VulcanInstance[] {
  const root = canonical(projectRoot)
  const out = discoverRoot(root)
  const trees = engineTreesDir(root)
  try {
    for (const entry of readdirSync(trees, { withFileTypes: true }).slice(0, 4096)) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) out.push(...discoverRoot(path.join(trees, entry.name)))
    }
  } catch { void 0 }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export function selectVulcanInstance(projectRoot: string, selector?: unknown, roles: readonly VulcanInstanceRole[] = ['agent-editor']): VulcanInstanceSelection {
  let id: string | undefined
  let role: VulcanInstanceRole | undefined
  if (typeof selector === 'string' && selector.length > 0) {
    if (VULCAN_INSTANCE_ROLES.includes(selector as VulcanInstanceRole)) role = selector as VulcanInstanceRole
    else id = selector
  } else if (selector !== undefined) {
    if (!selector || typeof selector !== 'object' || Array.isArray(selector)) return { ok: false, error: { code: 'BAD_INSTANCE_SELECTOR', message: 'instance must name an instance ID or role' } }
    const obj = selector as Record<string, unknown>
    if (Object.keys(obj).some(k => k !== 'id' && k !== 'role') || (obj.id !== undefined && typeof obj.id !== 'string') || (obj.role !== undefined && !VULCAN_INSTANCE_ROLES.includes(obj.role as VulcanInstanceRole)) || (!obj.id && !obj.role)) return { ok: false, error: { code: 'BAD_INSTANCE_SELECTOR', message: 'instance must contain id or role' } }
    id = obj.id as string | undefined
    role = obj.role as VulcanInstanceRole | undefined
  }
  const rows = listVulcanInstances(projectRoot).filter(row => (!id || row.id === id) && (role ? row.role === role : id ? true : roles.includes(row.role)))
  if (rows.length !== 1) return { ok: false, error: { code: rows.length ? 'INSTANCE_AMBIGUOUS' : 'INSTANCE_NOT_FOUND', message: rows.length ? `more than one matching Godot instance; pass instance with an ID (${rows.map(r => `${r.id} ${r.role}`).join(', ')})` : 'no matching Godot instance; operator-editor is never selected implicitly' } }
  return { ok: true, instance: rows[0]! }
}

export async function prepareVulcanInstance(projectRoot: string, role: VulcanInstanceRole): Promise<VulcanInstanceLaunch> {
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('no loopback port allocated')); return }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
  return { id: randomBytes(16).toString('hex'), role, port, token: randomBytes(32).toString('hex'), projectRoot: canonical(projectRoot), ownerPid: process.pid }
}

export function engineTreeHasLiveOwner(treeRoot: string): boolean {
  try {
    const row = JSON.parse(readFileSync(`${treeRoot}.owner.json`, 'utf8')) as { pid?: number }
    return typeof row.pid === 'number' && vulcanProcessAlive(row.pid)
  } catch { return discoverRoot(treeRoot).length > 0 }
}
