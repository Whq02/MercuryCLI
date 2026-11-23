import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getOriginalCwd } from '../../boot/process-state/processState.js'
import { isPathTrusted } from '../../platform/config/trust.js'
import { getProjectDir } from '../../sessions/transcripts/paths.js'
import { listSessions } from '../../sessions/transcripts/sessionListings.js'
import { readTranscriptChainSince } from '../../sessions/transcripts/transcriptReader.js'
import { readSessionWorkers, sessionOwnedByLiveWorker } from '../concourse-workers/concourseWorkers.js'
import { daemonControlRpc } from '../control/controlSocket.js'
import { resourceAdapterKinds, resolveResource } from '../../integrations/resources/registry.js'
import { parseMercuryRef } from '../../integrations/resources/contracts.js'
import { MERCURY_DAEMON_PROTO } from '../control/protocol.js'
import { processMainOwner } from '../../engine/run-owner/resolveOwner.js'
import { searchPointers } from '../../sessions/mneme/mnemePointers.js'
import { invalidParams, refused, type RpcError } from '../runner-wire/errors.js'
import type { ParamsOf } from '../runner-wire/methods.js'
import { SESSION_VERBS } from '../runner-wire/sessionVerbs.js'
import type { ToolPermissionContext } from '../../tools/kit/tool.js'
import { checkReadPermissionForTool } from '../../permissions/rules/filesystem.js'

const DAEMON_REFUSED = 'EREFUSED'
const DAEMON_REFUSED_THE_SIZE = 'ETOOLARGE'

function badParameter(message: string, ...paths: string[]): RpcError {
  return invalidParams(SESSION_VERBS.projectQuery.runner.name, paths.map(path => ({ path, message })))
}

function projectSession(id: string | undefined, parameter: 'session_id' | 'ref' = 'session_id'): string {
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw badParameter('A session_id UUID is required', parameter)
  const file = join(getProjectDir(getOriginalCwd()), `${id}.jsonl`)
  if (!existsSync(file)) throw refused(`No saved session ${id} in this project`, 'project')
  return file
}

export async function projectQuery(input: ParamsOf<typeof SESSION_VERBS.projectQuery.runner.name>, permissions: ToolPermissionContext): Promise<Record<string, unknown>> {
  const cwd = getOriginalCwd()
  if (!isPathTrusted(cwd)) throw refused('Trust this folder in Mercury before serving its project', 'trust')
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
      if (!input.sender?.trim() || !input.message?.trim()) throw badParameter('sender and message are required', ...(input.sender?.trim() ? [] : ['sender']), ...(input.message?.trim() ? [] : ['message']))
      const live = sessionOwnedByLiveWorker(input.session_id!)
      const record = Object.values(readSessionWorkers()).find(row => row.sessionId === input.session_id && row.endedAt === undefined)
      if (live === null || !record) throw refused(`Session ${input.session_id} is not live`, 'project')
      if (resolve(record.workspaceId) !== resolve(cwd)) throw refused('The session belongs to another project', 'project')
      const reply = await daemonControlRpc({
        op: SESSION_VERBS.sendWords.daemon.op,
        proto: MERCURY_DAEMON_PROTO,
        clientMessageId: input.message_id ?? randomUUID(),
        targetSessionId: input.session_id!,
        workspaceDir: cwd,
        prompt: input.message,
        origin: { kind: 'outside-report', sender: input.sender, via: 'mcp-server' },
        by: `mcp:${input.sender}`,
        sentAt: new Date().toISOString(),
      }, { timeoutMs: 15_000 })
      if (reply.ok !== true) {
        const words = typeof reply.error === 'string' ? reply.error : 'The session did not take the message'
        if (reply.code === DAEMON_REFUSED_THE_SIZE) throw badParameter(words, 'message')
        throw reply.code === DAEMON_REFUSED ? refused(words, 'project') : new Error(words)
      }
      return { ...reply }
    }
    case 'recall': {
      if (!input.query?.trim()) throw badParameter('query is required', 'query')
      return { ...searchPointers(input.query, { limit: input.limit }) }
    }
    case 'resources':
      return { resources: (await resourceAdapterKinds()).map(row => ({ uri: `mercury://${row.kind}`, name: row.kind, description: row.describe, mimeType: 'application/json' })) }
    case 'resource': {
      const ref = parseMercuryRef(input.ref ?? '')
      if (ref === null) throw badParameter('A mercury:// reference is required', 'ref')
      if (ref.kind === 'file' && ref.id) {
        const target = resolve(cwd, ref.id)
        const decision = checkReadPermissionForTool({ name: 'Inspect', getPath: () => target }, { ref: input.ref }, permissions)
        if (decision.behavior !== 'allow') throw refused(decision.message, 'project')
        const local = relative(realpathSync(cwd), existsSync(target) ? realpathSync(target) : target)
        if (local === '..' || local.startsWith('../') || local.startsWith('..\\') || isAbsolute(local)) throw refused('File resources must stay inside this project', 'project')
      }
      if (ref.kind === 'transcript') {
        const id = ref.id.split('/')[1]
        if (id) projectSession(id, 'ref')
      }
      return { ...await resolveResource(input.ref!, { cwd, owner: processMainOwner() }) }
    }
  }
}
