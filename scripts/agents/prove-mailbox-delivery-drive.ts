#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun, FIXTURE_API_KEY } from '../lib/firstRunSeed.ts'

const root = resolve(import.meta.dir, '../..')
const dist = join(root, 'dist/mercury.mjs')
if (!existsSync(dist)) throw new Error('Build the product before running this check')
const vendoredNode = join(root, 'dist/vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const node = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'
const model = 'claude-fable-5-1'
const SILENCE_MS = 60_000
const CEILING_MS = 600_000
const RELEASE_AFTER_FINISH_MS = 1_000
const ATTEMPTS = 3

type Row = Record<string, unknown>
type Inbox = Array<{ text: string; read?: boolean; from: string }>
type Outcome = { formed: true; counts: Array<{ name: string; count: number }>; requests: number; workflowRequests: number; heldMs: number } | { formed: false; why: string }

function scriptFor(): ScriptedTurn[] {
  const main = (turn: Record<string, unknown>, whenBody?: string) => ({ ...turn, model, whenModel: 'fable-5-1', ...(whenBody ? { whenBody } : {}) })
  const send = (id: string, to: string, message: string) => ({ kind: 'tool_use', name: 'SendMessage', id, input: { to, message, summary: message } })
  return [
    main({ kind: 'tool_use', name: 'Agent', input: { name: 'water', crew_name: 'crew', model: 'claude-opus-4-6', subagent_type: 'mercury-crew', description: 'Water report', prompt: 'Send READY-WATER to crew-lead once.' } }, 'START-GROUP'),
    main({ kind: 'tool_use', name: 'Agent', input: { name: 'dragon', crew_name: 'crew', model: 'claude-sonnet-5', subagent_type: 'mercury-crew', description: 'Dragon report', prompt: 'Send READY-DRAGON to crew-lead once.' } }, 'START-GROUP'),
    main({ kind: 'text', text: 'GROUP-STARTED' }, 'START-GROUP'),
    main({ kind: 'text', text: 'FIRST-REPORT-RECEIVED' }, 'READY-WATER'),
    main(send('resume-water', 'water', 'RESUME-WATER: send REPORT-WATER-2 once.'), 'RESUME-GROUP'),
    main({ kind: 'tool_use', name: 'Workflow', input: { script: "export const meta = { name: 'report-wait', description: 'Wait for the test response', phases: [{ title: 'Wait' }] }; return await agent('Reply once.', { model: 'claude-opus-5', effort: 'max', phase: 'Wait' });" } }, 'RESUME-GROUP'),
    main({ kind: 'text', text: 'WORKFLOW-WAITING' }, 'RESUME-GROUP'),
    main({ kind: 'text', text: 'WORKFLOW-FINISHED' }, 'task-notification'),
    main({ kind: 'text', text: 'SECOND-REPORT-RECEIVED' }, 'REPORT-WATER-2'),
    ...Array.from({ length: 8 }, (_, i) => main({ kind: 'text', text: 'FINAL-' + i })),
    { ...send('water-report-1', 'crew-lead', 'READY-WATER'), model: 'claude-opus-4-6', whenModel: 'opus-4-6' },
    { kind: 'text', text: 'Water idle.', model: 'claude-opus-4-6', whenModel: 'opus-4-6' },
    { ...send('water-report-2', 'crew-lead', 'REPORT-WATER-2'), model: 'claude-opus-4-6', whenModel: 'opus-4-6', whenBody: 'RESUME-WATER' },
    { kind: 'text', text: 'Water done.', model: 'claude-opus-4-6', whenModel: 'opus-4-6' },
    { ...send('dragon-report', 'crew-lead', 'READY-DRAGON'), model: 'claude-sonnet-5', whenModel: 'sonnet-5' },
    { kind: 'text', text: 'Dragon done.', model: 'claude-sonnet-5', whenModel: 'sonnet-5' },
    { kind: 'paced', deltas: ['Workflow test done.'], gapMs: 0, startDelayMs: 5000, whenModel: 'opus-5' },
  ] as ScriptedTurn[]
}

async function attempt(n: number): Promise<Outcome> {
  const world = mkdtempSync(join(tmpdir(), 'mail-delivery-drive-'))
  const config = join(world, 'config')
  const project = join(world, 'project')
  const crews = join(world, 'crews')
  mkdirSync(project)
  seedFirstRun(config, [project])
  const sessionId = randomUUID()
  const crew = sessionId
  const fixture = await startFixtureApi(scriptFor())
  const startedAt = Date.now()
  const stamp = (): string => `${((Date.now() - startedAt) / 1000).toFixed(2)}s`
  const journal: string[] = []
  const note = (line: string): void => {
    journal.push(`[${stamp()}] ${line}`)
  }
  const child: ChildProcess = spawn(node, [dist, 'run', '--input', 'rows', '--format', 'rows', '--model', model, '--allowed-tools', 'Agent', 'SendMessage', 'Workflow', '--session-id', sessionId], {
    cwd: project,
    env: { HOME: world, PATH: '/usr/bin:/bin:' + dirname(node), TERM: 'dumb', MERCURY_CONFIG_DIR: config, MERCURY_DAEMON_DIR: join(world, 'daemon'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', BROWSER: '/usr/bin/true', ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: fixture.url },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let pendingLine = ''
  let taskEndedAt = 0
  let lockTakenAt = 0
  let lockReleasedAt = 0
  const rows: Row[] = []
  let progressAt = Date.now()
  const onRow = (row: Row): void => {
    rows.push(row)
    const text = row.type === 'text' ? String(row.text ?? '').slice(0, 40) : row.type === 'outcome' ? String(row.answer ?? '').slice(0, 40) : ''
    note(`row ${String(row.type)} turn=${String(row.turn ?? '')} ${text}`.trimEnd())
    if (row.type === 'task' && row.state === 'ended' && taskEndedAt === 0) taskEndedAt = Date.now()
  }
  child.stdout!.on('data', data => {
    stdout += data
    progressAt = Date.now()
    pendingLine += String(data)
    const lines = pendingLine.split('\n')
    pendingLine = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        onRow(JSON.parse(line) as Row)
      } catch {
        note(`out ${line.slice(0, 120)}`)
      }
    }
  })
  child.stderr!.on('data', data => {
    stderr += data
    progressAt = Date.now()
  })
  let exited = false
  const exit = new Promise<void>(resolveExit => child.on('close', () => { exited = true; resolveExit() }))
  const inboxPath = join(config, 'crew', 'livecomms', `${crew}.json`)
  const readInbox = (): Inbox | null => {
    if (!existsSync(inboxPath)) return null
    try {
      const file = JSON.parse(readFileSync(inboxPath, 'utf8')) as { messages?: Array<{ to: string; text: string; read?: boolean; from: string }> }
      return (file.messages ?? []).filter(row => row.to === 'crew-lead')
    } catch {
      return null
    }
  }
  const inboxWords = (): string => JSON.stringify((readInbox() ?? []).map(m => [m.from, m.text.slice(0, 40), m.read === true ? 'read' : 'unread']))
  let lastInboxWords = ''
  const submit = (text: string): void => {
    note(`submit ${text.slice(0, 40)}`)
    child.stdin!.write(JSON.stringify({ type: 'prompt', content: text }) + '\n')
  }

  const lock = inboxPath + '.lock'
  let lockRefresh: ReturnType<typeof setInterval> | undefined
  const releaseLock = (): void => {
    if (lockTakenAt === 0 || lockReleasedAt !== 0) return
    clearInterval(lockRefresh)
    rmSync(lock, { recursive: true, force: true })
    lockReleasedAt = Date.now()
    note(`lock released ${lockReleasedAt - lockTakenAt}ms after it was taken, ${lockReleasedAt - taskEndedAt}ms after the workflow's task ended; inbox ${inboxWords()}`)
  }
  const observe = setInterval(() => {
    const words = inboxWords()
    if (words !== lastInboxWords) {
      lastInboxWords = words
      progressAt = Date.now()
      note(`inbox ${words}`)
    }
    if (lockTakenAt !== 0) {
      if (lockReleasedAt === 0 && taskEndedAt !== 0 && Date.now() - taskEndedAt >= RELEASE_AFTER_FINISH_MS) releaseLock()
      return
    }
    const messages = readInbox()
    if (messages === null) return
    if (!messages.some(message => !message.read && message.text === 'REPORT-WATER-2') || messages.filter(message => !message.read && message.from === 'water').length < 2) return
    try {
      mkdirSync(lock)
    } catch {
      return
    }
    lockTakenAt = Date.now()
    note(`lock taken; inbox ${words}`)
    lockRefresh = setInterval(() => { const now = new Date(); if (existsSync(lock)) utimesSync(lock, now, now) }, 500)
  }, 20)

  const envelopesOf = (name: string): number => {
    const parent = fixture.messageRequests().filter(request => request.body.model === model)
    const last = parent.at(-1)
    if (last === undefined) return 0
    const body = last.body as { messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> }
    return body.messages.filter(message => message.role === 'user').flatMap(message => {
      const text = typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
      return [...text.matchAll(/<crewmate-message\b[^>]*>([\s\S]*?)<\/crewmate-message>/g)].map(match => match[1]!)
    }).filter(text => text.includes(name)).length
  }

  const report = (label: string): string =>
    [
      label,
      `attempt ${n}; lock taken ${lockTakenAt === 0 ? 'never' : `at ${((lockTakenAt - startedAt) / 1000).toFixed(2)}s`}, released ${lockReleasedAt === 0 ? 'never' : `at ${((lockReleasedAt - startedAt) / 1000).toFixed(2)}s`}, the workflow's task ended ${taskEndedAt === 0 ? 'never' : `at ${((taskEndedAt - startedAt) / 1000).toFixed(2)}s`}`,
      `inbox now ${inboxWords()}`,
      `${rows.length} rows; the journal:`,
      ...journal,
      stderr.trim() === '' ? '(no stderr)' : `stderr:\n${stderr.slice(-2000)}`,
    ].join('\n')
  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    const since = Date.now()
    while (!predicate()) {
      if (exited) throw new Error(report(`${label} — the product exited (code ${String(child.exitCode)})`))
      const silent = Date.now() - progressAt
      if (silent > SILENCE_MS) throw new Error(report(`${label} — no row, no inbox change and no stderr for ${Math.round(silent / 1000)}s`))
      if (Date.now() - since > CEILING_MS) throw new Error(report(`${label} — not within ${CEILING_MS / 1000}s`))
      await new Promise(resolveTick => setTimeout(resolveTick, 20))
    }
  }

  try {
    submit('START-GROUP: create both crewmates and receive their reports.')
    await waitFor(() => stdout.includes('FIRST-REPORT-RECEIVED'), 'First report did not arrive')
    submit('RESUME-GROUP: resume water, then run a workflow while its report arrives.')
    await waitFor(() => taskEndedAt !== 0, "The workflow's task did not end")
    if (lockTakenAt === 0 || lockTakenAt > taskEndedAt) {
      return {
        formed: false,
        why: report(lockTakenAt === 0
          ? `the interleaving did not form: the resumed report was ${envelopesOf('REPORT-WATER-2') === 0 ? 'not yet in the inbox' : 'delivered'} before the inbox could be held`
          : "the interleaving did not form: the inbox was held only after the workflow's task had ended"),
      }
    }
    const deliveredBeforeRelease = envelopesOf('REPORT-WATER-2') > 0
    await waitFor(() => lockReleasedAt !== 0, 'The inbox lock was not released')
    await waitFor(() => envelopesOf('REPORT-WATER-2') > 0, 'The resumed report did not reach the model after the held lock was released')
    note(`the resumed report reached the model ${deliveredBeforeRelease ? 'while the lock was held (prepared before it); its acknowledgement crossed the lock' : 'after the lock was released'}`)
    await waitFor(() => { const messages = readInbox(); return messages !== null && messages.every(message => message.read) }, 'Acknowledgements did not settle')
    submit('Finish by checking whether any report arrived again.')
    await waitFor(() => stdout.includes('FINAL-'), 'Final check did not settle')
    const requests = fixture.messageRequests()
    const counts = ['READY-WATER', 'READY-DRAGON', 'REPORT-WATER-2'].map(name => ({ name, count: envelopesOf(name) }))
    return { formed: true, counts, requests: requests.length, workflowRequests: requests.filter(request => request.body.model === 'claude-opus-5').length, heldMs: lockReleasedAt - lockTakenAt }
  } finally {
    clearInterval(observe)
    releaseLock()
    child.kill('SIGTERM')
    await exit
    await fixture.close()
    rmSync(world, { recursive: true, force: true })
  }
}

let outcome: Outcome = { formed: false, why: 'no attempt ran' }
for (let n = 1; n <= ATTEMPTS; n++) {
  outcome = await attempt(n)
  if (outcome.formed) break
  console.log(`attempt ${n} of ${ATTEMPTS}: ${outcome.why}\n`)
}
if (!outcome.formed) throw new Error(`The held-lock interleaving did not form in ${ATTEMPTS} attempts; the last: ${outcome.why}`)
console.log(JSON.stringify({ counts: outcome.counts, heldMs: outcome.heldMs, requests: outcome.requests, workflowRequests: outcome.workflowRequests }))
if (!outcome.counts.every(row => row.count === 1) || outcome.workflowRequests === 0) throw new Error('Reports were not delivered exactly once while the workflow ran')
console.log('Built report delivery passed')
