import { readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { getOriginalCwd } from '../bootstrap/state.js'
import { readSessionWorkers } from '../daemon/concourseWorkers.js'
import { binaryName } from '../utils/config/derived.js'
import { getProjectDir, getProjectsDir } from '../utils/sessionStorage/paths.js'
import { buildSessionDeleteOffer, operatorPruneTranscripts } from '../utils/sessionStorage/transcriptPruneDoor.js'
import { validateUuid } from '../utils/sessionStoragePortable.js'

export type SessionsCliIo = {
  out: (line: string) => void
  err: (line: string) => void
  interactive: boolean
  ask: (question: string) => Promise<boolean>
}

const defaultIo: SessionsCliIo = {
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask: async question => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise<string>(resolveAnswer => rl.question(`${question} [y/N] `, resolveAnswer))
    rl.close()
    return /^y(es)?$/i.test(answer.trim())
  },
}

type SavedSession = { sessionId: string; fullPath: string; fileSize: number; modified: Date; store: string }

async function savedSessionNamed(sessionId: string, projectStore: string): Promise<SavedSession | null> {
  const stores = [projectStore]
  try {
    for (const entry of await readdir(getProjectsDir(), { withFileTypes: true })) {
      const store = join(getProjectsDir(), entry.name)
      if (entry.isDirectory() && store !== projectStore) stores.push(store)
    }
  } catch {
    return null
  }
  for (const store of stores) {
    const fullPath = join(store, `${sessionId}.jsonl`)
    try {
      const facts = await stat(fullPath)
      if (facts.isFile()) return { sessionId, fullPath, fileSize: facts.size, modified: facts.mtime, store }
    } catch {
      continue
    }
  }
  return null
}

function liveSessionIds(): Set<string> {
  const live = new Set<string>()
  for (const record of Object.values(readSessionWorkers())) {
    if (record.endedAt === undefined) live.add(record.sessionId)
  }
  return live
}

const kib = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`

export async function sessionsDeleteCli(
  given: string,
  options: { yes?: boolean },
  io: SessionsCliIo = defaultIo,
): Promise<number> {
  const cli = binaryName()
  const sessionId = validateUuid(given.trim())
  if (sessionId === null) {
    io.err(`${cli} sessions delete needs a session id (a UUID): ${JSON.stringify(given)} is not one.`)
    return 2
  }
  const projectStore = getProjectDir(getOriginalCwd())
  const saved = await savedSessionNamed(sessionId, projectStore)
  if (saved === null) {
    io.err(`No saved session ${sessionId}: nothing in this project's sessions (${projectStore}) or the other project stores under ${getProjectsDir()}.`)
    io.err(`The roster is /sessions inside ${cli}; a session's id is the UUID in its .jsonl file name.`)
    return 1
  }
  const offer = buildSessionDeleteOffer(saved, { scopeLabel: `session ${sessionId}`, liveSessionIds: liveSessionIds() })
  if (offer === null) {
    io.err(`Session ${sessionId} is live: the background process that hosts your sessions (the daemon) runs it now. Stop it first, then delete it.`)
    return 1
  }
  const where = saved.store === projectStore ? "this project's sessions" : `another project's sessions (${saved.store})`
  io.out(`Session ${sessionId} — ${saved.fullPath} (${kib(saved.fileSize)}, modified ${saved.modified.toISOString()}), in ${where}.`)
  if (options.yes !== true) {
    if (!io.interactive) {
      io.err(`No terminal to ask on: pass --yes to delete session ${sessionId} without the question.`)
      return 2
    }
    if (!(await io.ask(`Delete it, with the records kept beside it (receipts, resume snapshot)?`))) {
      io.out('Nothing deleted.')
      return 0
    }
  }
  const receipt = await operatorPruneTranscripts(offer)
  if (receipt.deleted !== 1) {
    io.err(`Session ${sessionId} was not deleted: its transcript could not be removed (${saved.fullPath}).`)
    return 1
  }
  const sidecars = [
    receipt.receiptsDeleted > 0 ? 'its receipts' : null,
    receipt.snapshotsDeleted > 0 ? 'its resume snapshot' : null,
  ].filter((part): part is string => part !== null)
  io.out(`Deleted session ${sessionId}: the transcript${sidecars.length > 0 ? ` and ${sidecars.join(' and ')}` : ''} — ${kib(receipt.bytesFreed)} freed.`)
  return 0
}
