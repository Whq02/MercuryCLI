import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Tool } from '../Tool.js'
import type { PermissionResult } from '../types/permissions.js'

type InstallTarget = { root: string; dataDir: string; key: string }
const installs = new Map<string, InstallTarget>()
let wrapped = new WeakMap<Tool, Tool>()
export function registerBundledAppInstall(server: string, root: string, dataDir: string): string {
  const current = installs.get(server)
  if (current?.root === root && current.dataDir === dataDir) return current.key
  const key = randomBytes(32).toString('hex')
  installs.set(server, { root, dataDir, key })
  return key
}
export function clearBundledAppInstalls(): void { installs.clear(); wrapped = new WeakMap() }

async function inspectInstall(target: InstallTarget) {
  const { adapter } = await import(pathToFileURL(join(target.root, 'server/install.mjs')).href)
  const { planInstall, checkInstall } = await import(pathToFileURL(join(target.root, 'shared/install.mjs')).href)
  const plan = planInstall(adapter, { dataDir: target.dataDir })
  const check = await checkInstall(adapter, { dataDir: target.dataDir })
  return { adapter, plan, check }
}

export async function bundledAppInstallPermission(tool: Tool, input: Record<string, unknown>): Promise<PermissionResult | null> {
  const target = tool.mcpInfo?.toolName === 'craft_install' ? installs.get(tool.mcpInfo.serverName) : undefined
  if (!target) return null
  try {
    const { adapter, plan, check } = await inspectInstall(target)
    if (check.state === 'installed') return { behavior: 'allow', updatedInput: input }
    if (check.state === 'invalid') return { behavior: 'deny', message: `The existing ${adapter.title} installation did not pass verification. It was not replaced.`, decisionReason: { type: 'other', reason: check.reason } }
    const message = `Install ${plan.title} ${plan.version} (${plan.bytes.toLocaleString('en-US')} bytes) to ${plan.destination}?`
    return { behavior: 'ask', message, decisionReason: { type: 'safetyCheck', reason: message, operatorOnly: true } }
  } catch (error) {
    return { behavior: 'deny', message: 'The application installation request could not be verified.', decisionReason: { type: 'other', reason: String(error) } }
  }
}

export function withBundledAppInstallConsent(tool: Tool): Tool {
  const target = tool.mcpInfo?.toolName === 'craft_install' ? installs.get(tool.mcpInfo.serverName) : undefined
  if (!target) return tool
  const cached = wrapped.get(tool)
  if (cached) return cached
  const decorated: Tool = {
    ...tool,
    async checkPermissions(input, context) {
      const original = await tool.checkPermissions(input, context)
      if (original.behavior === 'deny') return original
      return await bundledAppInstallPermission(tool, input) ?? original
    },
    async call(input, context, canUseTool, parent, onProgress) {
      const { plan } = await inspectInstall(target)
      context.abortController.signal.throwIfAborted()
      const payload = Buffer.from(JSON.stringify({ digest: plan.digest, nonce: randomUUID(), expires: Date.now() + 60000 })).toString('base64url')
      const signature = createHmac('sha256', target.key).update(payload).digest('hex')
      return tool.call({ ...input, _mercuryInstallGrant: `${payload}.${signature}` }, context, canUseTool, parent, onProgress)
    },
  }
  wrapped.set(tool, decorated)
  return decorated
}
