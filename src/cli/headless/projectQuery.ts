import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { isPathTrusted } from '../../utils/config/trust.js'
import { getProjectDir } from '../../utils/sessionStorage/paths.js'
import { listSessions } from '../../utils/sessionStorage/logs.js'
import { readTranscriptChainSince } from '../../utils/sessionStorage/transcriptReader.js'
import { readSessionWorkers, sessionOwnedByLiveWorker } from '../../daemon/concourseWorkers.js'
import { daemonControlRpc } from '../../daemon/controlSocket.js'
import { resourceAdapterKinds, resolveResource } from '../../services/resources/registry.js'
import { parseMercuryRef } from '../../services/resources/contracts.js'
import { MERCURY_DAEMON_PROTO } from '../../daemon/protocol.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import { searchPointers } from '../../mneme/mnemePointers.js'
import type { ParamsOf } from '../../runner/wire/methods.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'

function projectSession(id: string | undefined): string {
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('A session_id UUID is required')
  const file = join(getProjectDir(getOriginalCwd()), `${id}.jsonl`)
  if (!existsSync(file)) throw new Error(`No saved session ${id} in this project`)
  return file
}

export async function projectQuery(input: ParamsOf<'project/query'>, permissions: ToolPermissionContext): Promise<Record<string, unknown>> {
  const cwd = getOriginalCwd()
  if (!isPathTrusted(cwd)) throw new Error('Trust this folder in Mercury before serving its project')
  switch (input.op) {
    case 'sessions': {
      const saved = await listSessions()
      const workers = Object.values(readSessionWorkers()).filter(row => resolve(row.workspaceId) === resolve(cwd))
      const sessions = saved.map(row => ({
        session_id: row.sessionId ?? row.fullPath?.split(/[\\/]/).pop()?.replace(/\.jsonl$/, ''),
        modified: row.modified.toISOString(),
        title: row.customTitle ?? row.summary ?? row.firstPrompt,
        live: workers.some(worker => worker.sessionId === row.sessionId && sessionOwnedByLiveWorker(worker.sessionId) !== null),
        mode: workers.find(worker => worker.sessionId === row.sessionId)?.permissionMode,
      }))
      return { sessions }
    }
    case 'rows': {
      const file = projectSession(input.session_id)
      const { rows } = await readTranscriptChainSince(file, null)
      const end = Math.min(input.before ?? rows.length, rows.length)
      const start = Math.max(0, end - (input.limit ?? 50))
      return { session_id: input.session_id, rows: rows.slice(start, end), total: rows.length, ...(start > 0 ? { next_before: start } : {}) }
    }
    case 'send': {
      projectSession(input.session_id)
      if (!input.sender?.trim() || !input.message?.trim()) throw new Error('sender and message are required')
      const live = sessionOwnedByLiveWorker(input.session_id!)
      const record = Object.values(readSessionWorkers()).find(row => row.sessionId === input.session_id && row.endedAt === undefined)
      if (live === null || !record) throw new Error(`Session ${input.session_id} is not live`)
      if (resolve(record.workspaceId) !== resolve(cwd)) throw new Error('The session belongs to another project')
      const reply = await daemonControlRpc({
        op: 'sessionDispatch',
        proto: MERCURY_DAEMON_PROTO,
        clientMessageId: input.message_id ?? randomUUID(),
        targetSessionId: input.session_id!,
        workspaceDir: cwd,
        prompt: `From ${JSON.stringify(input.sender)} (MCP):\n${input.message}`,
        by: `mcp:${input.sender}`,
        sentAt: new Date().toISOString(),
      }, { timeoutMs: 15_000 })
      if (reply.ok !== true) throw new Error(typeof reply.error === 'string' ? reply.error : 'The session did not take the message')
      return { ...reply }
    }
    case 'recall': {
      if (!input.query?.trim()) throw new Error('query is required')
      return { ...searchPointers(input.query, { limit: input.limit }) }
    }
    case 'resources':
      return { resources: resourceAdapterKinds().map(row => ({ uri: `mercury://${row.kind}`, name: row.kind, description: row.describe, mimeType: 'application/json' })) }
    case 'resource': {
      const ref = parseMercuryRef(input.ref ?? '')
      if (ref === null) throw new Error('A mercury:// reference is required')
      if (ref.kind === 'file' && ref.id) {
        const target = resolve(cwd, ref.id)
        const decision = checkReadPermissionForTool({ name: 'Inspect', getPath: () => target }, { ref: input.ref }, permissions)
        if (decision.behavior !== 'allow') throw new Error(decision.message)
        const local = relative(realpathSync(cwd), existsSync(target) ? realpathSync(target) : target)
        if (local === '..' || local.startsWith('../') || local.startsWith('..\\') || isAbsolute(local)) throw new Error('File resources must stay inside this project')
      }
      if (ref.kind === 'transcript') {
        const id = ref.id.split('/')[1]
        if (id) projectSession(id)
      }
      return { ...await resolveResource(input.ref!, { cwd, owner: processMainOwner() }) }
    }
  }
}
