#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SELF = import.meta.path
const argOf = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const TITLE = 'a title given before the fold'
const AGENT = 'an-agent-chosen-before-the-fold'
const TAG = 'a-tag-given-before-the-fold'
const LATER_TITLE = 'a title given after the fold'
type Shape = 'fold' | 'memory-fold-keeps-a-tail' | 'memory-fold-keeps-nothing' | 'fold-then-retitled' | 'small'

if (process.argv.includes('--write')) {
  const session = argOf('--session')!
  const shape = argOf('--shape') as Shape
  const state = await import('../../src/bootstrap/state.ts')
  state.switchSession(session as never)
  const storage = await import('../../src/utils/sessionStorage.ts')
  const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
  const { createCompactBoundaryMessage } = await import('../../src/utils/messages/systemMessages.ts')
  const { annotateBoundaryWithPreservedSegment } = await import('../../src/services/compact/compact.ts')
  type Row = Parameters<typeof storage.recordTranscript>[0][number]
  const answer = shape === 'small' ? 'A short answer.' : 'A line of an old answer that the fold has since summarised. '.repeat(31_000)
  storage.saveAgentSetting(AGENT)
  storage.saveMode('coordinator')
  let conversation: Row[] = []
  const turn = async (words: string, reply: string): Promise<void> => {
    conversation = [...conversation, createUserMessage({ content: words }) as Row, createAssistantMessage({ content: reply }) as Row]
    await storage.recordTranscript(conversation)
  }
  await turn('the first prompt', answer)
  await storage.saveCustomTitle(session as never, TITLE)
  await storage.saveTag(session as never, TAG)
  await turn('the second prompt', answer)
  await turn('the third prompt', answer)
  const boundary = createCompactBoundaryMessage('auto', 100_000, conversation.at(-1)!.uuid as never)
  const summary = createUserMessage({ content: 'The summary of the folded conversation.', isCompactSummary: true, isVisibleInTranscriptOnly: true })
  const kept = shape === 'memory-fold-keeps-a-tail' ? conversation.slice(-2) : []
  if (shape.startsWith('memory-fold')) annotateBoundaryWithPreservedSegment(boundary, summary.uuid as never, kept as never)
  conversation = [boundary as Row, summary as Row, ...kept]
  await storage.recordTranscript(conversation)
  if (shape === 'fold-then-retitled') await storage.saveCustomTitle(session as never, LATER_TITLE)
  if (shape.startsWith('memory-fold')) await turn('a prompt after the fold', 'A short answer after the fold.')
  await storage.flushSessionStorage()
  writeSync(1, `${JSON.stringify({ file: storage.getTranscriptPath() })}\n`)
  process.kill(process.pid, 'SIGKILL')
  await new Promise(() => {})
}

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'session-rows-fold-')))
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok || !detail ? '' : ` — ${detail}`}`)
}
const section = (title: string): void => console.log(`\n${title}`)

const { loadTranscriptFile, transcriptLoadDegradation } = await import('../../src/utils/sessionStorage/loading.ts')
const { decodeTranscriptBuffer } = await import('../../src/fabric/transcriptDecode.ts')
const THRESHOLD = 5 * 1024 * 1024

type Written = { session: string; file: string; bytes: number; killed: boolean }
const write = (shape: Shape): Written => {
  const session = randomUUID()
  const home = join(scratch, `home-${shape}`)
  const cwd = join(home, 'project')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(home, 'tmp'), { recursive: true })
  const env: Record<string, string | undefined> = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_TMPDIR: join(home, 'tmp'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none' }
  delete env.NODE_ENV
  delete env.MERCURY_SKIP_PROMPT_HISTORY
  const child = spawnSync(process.execPath, [SELF, '--write', '--session', session, '--shape', shape], { cwd, env, encoding: 'utf8', timeout: 240_000 })
  const line = child.stdout.trim().split('\n').at(-1) ?? ''
  if (!line.startsWith('{')) throw new Error(`the writer of ${shape} did not answer: rc ${child.status} signal ${child.signal}\n${child.stdout.slice(-400)}\n${child.stderr.slice(-800)}`)
  const file = (JSON.parse(line) as { file: string }).file
  return { session, file, bytes: readFileSync(file).length, killed: child.signal === 'SIGKILL' }
}
type Read = { messages: number; title: string | undefined; agent: string | undefined; tag: string | undefined; mode: string | undefined }
const read = async (file: string, session: string): Promise<Read> => {
  const loaded = await loadTranscriptFile(file)
  return { messages: loaded.messages.size, title: loaded.customTitles.get(session as never), agent: loaded.agentSettings.get(session as never), tag: loaded.tags.get(session as never), mode: loaded.modes.get(session as never) }
}
const allFour = (seen: Read, title = TITLE): boolean => seen.title === title && seen.agent === AGENT && seen.tag === TAG && seen.mode === 'coordinator'
const kindsOf = (file: string): string[] => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => { const payload = (JSON.parse(line) as { payload: { kind: string; metaKind?: string } }).payload; return payload.kind === 'session-meta' ? String(payload.metaKind) : payload.kind })

try {
  section('§1 a record over the size from which a load starts at its last fold boundary: the process is killed between the boundary and the restamp')
  const fold = write('fold')
  const foldKinds = kindsOf(fold.file)
  const boundaryAt = foldKinds.lastIndexOf('boundary')
  const rowsBefore = ['custom-title', 'agent-setting', 'tag', 'mode'].every(kind => { const at = foldKinds.indexOf(kind); return at >= 0 && at < boundaryAt })
  const rowsAfter = foldKinds.slice(boundaryAt).filter(kind => ['custom-title', 'agent-setting', 'tag', 'mode'].includes(kind))
  check("the scene: the product's own writer wrote the record, was killed, and left the title, the agent, the tag and the mode before the boundary and none of them after it", fold.killed && boundaryAt > 0 && rowsBefore && rowsAfter.length === 0, `killed ${fold.killed} · boundary at row ${boundaryAt} of ${foldKinds.length} · after it: ${rowsAfter.join(' ')}`)
  const foldRead = await read(fold.file, fold.session)
  check('the scene: the record is over the size, and its load leaves the folded answers unread', fold.bytes > THRESHOLD && foldRead.messages <= 2, `${fold.bytes} bytes · ${foldRead.messages} messages read`)
  check('the title, the agent, the tag and the mode are read back', allFour(foldRead), JSON.stringify(foldRead))
  check('the load reports no damage', transcriptLoadDegradation(fold.file) === null, JSON.stringify(transcriptLoadDegradation(fold.file)))

  section('§2 a row written after the boundary outranks the one before it')
  const retitled = write('fold-then-retitled')
  const retitledRead = await read(retitled.file, retitled.session)
  check('the later title is the one read; the agent, the tag and the mode from before the boundary stand', retitled.bytes > THRESHOLD && allFour(retitledRead, LATER_TITLE), JSON.stringify(retitledRead))

  section('§3 the rows a session-memory fold leaves: a boundary and no restamp, the process killed later')
  const nothingKept = write('memory-fold-keeps-nothing')
  const nothingKeptRead = await read(nothingKept.file, nothingKept.session)
  check('a fold that keeps none of the conversation: all four are read back', nothingKept.killed && nothingKept.bytes > THRESHOLD && allFour(nothingKeptRead), JSON.stringify(nothingKeptRead))
  const tailKept = write('memory-fold-keeps-a-tail')
  const tailKeptRead = await read(tailKept.file, tailKept.session)
  check('a fold that keeps a tail of it: all four are read back', tailKept.killed && tailKept.bytes > THRESHOLD && allFour(tailKeptRead), JSON.stringify(tailKeptRead))

  section('§4 a record under the size is read whole, as before')
  const small = write('small')
  const smallRead = await read(small.file, small.session)
  check('all four are read back', small.bytes < THRESHOLD && allFour(smallRead), `${small.bytes} bytes · ${JSON.stringify(smallRead)}`)

  section('§5 the lines collected from before a boundary are session rows alone: the decoder takes them without a header and refuses nothing')
  const sessionLines = readFileSync(fold.file, 'utf8').split('\n').filter(line => ['custom-title', 'agent-setting', 'tag', 'mode'].some(kind => line.includes(`"metaKind":"${kind}"`)))
  const decoded = decodeTranscriptBuffer<{ type?: string }>(Buffer.from(sessionLines.join('\n')))
  check('every line decodes to a row that names its kind; no refusal, nothing malformed, nothing invalid', sessionLines.length >= 4 && decoded.refusal === undefined && decoded.malformed.length === 0 && decoded.invalid.length === 0 && decoded.entries.length === sessionLines.length && decoded.entries.every(entry => typeof entry.type === 'string'), `${decoded.entries.length} of ${sessionLines.length} · ${decoded.refusal ?? ''}`)

  section('§6 a damaged session row before the boundary is skipped, and is not counted as damage of the load')
  const damaged = join(scratch, `${fold.session}.jsonl`)
  const lines = readFileSync(fold.file, 'utf8').split('\n')
  const tagAt = lines.findIndex(line => line.includes('"metaKind":"tag"'))
  lines.splice(tagAt + 1, 0, lines[tagAt]!.slice(0, lines[tagAt]!.length - 40))
  writeFileSync(damaged, lines.join('\n'))
  const damagedRead = await read(damaged, fold.session)
  check('the whole rows are still read back', tagAt >= 0 && allFour(damagedRead), JSON.stringify(damagedRead))
  check('the load reports no damage for the half row it never reads as part of the conversation', transcriptLoadDegradation(damaged) === null, JSON.stringify(transcriptLoadDegradation(damaged)))
} finally {
  for (const entry of readdirSync(scratch)) rmSync(join(scratch, entry), { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} session-rows-read-across-a-fold: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
