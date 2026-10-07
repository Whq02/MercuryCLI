#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'agent-output-file-'))
process.env.NODE_ENV = 'development'
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.MERCURY_TMPDIR = join(scratch, 'tmp')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')
const WINDOWS = process.platform === 'win32'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
await import('../../src/tasks.ts')
const { generateTaskId } = await import('../../src/Task.ts')
const { registerAsyncAgent, completeAgentTask, enqueueAgentNotification } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const queue = await import('../../src/input-core/command-queue.ts')
const diskOutput = await import('../../src/utils/task/diskOutput.ts')
const { getTaskOutputPath, getTaskOutputDelta, initTaskOutputAsSymlink } = diskOutput
const { getAgentTranscriptPath, recordSidechainTranscript, flushSessionStorage } = await import('../../src/utils/sessionStorage.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { readTailWindow } = await import('../../src/services/resources/adapters/agent.ts')
const { SendMessageTool } = await import('../../src/tools/SendMessageTool/SendMessageTool.ts')
const { stopTask } = await import('../../src/tasks/stopTask.ts')
type AppState = import('../../src/state/AppStateStore.ts').AppState
type SendAnswer = { data: { success: boolean; message: string } }

const FAKE_DEF = { agentType: 'mercury-crew', source: 'built-in', whenToUse: '', systemPrompt: '' } as never
function makeStore(): { get: () => AppState; set: (u: (prev: AppState) => AppState) => void } {
  let st: AppState = getDefaultAppState()
  return {
    get: () => st,
    set: u => {
      st = u(st)
    },
  }
}
const store = makeStore()
const ctx = {
  getAppState: store.get,
  setAppState: store.set,
  setAppStateForTasks: store.set,
  options: { tools: [] },
  abortController: new AbortController(),
  messages: [],
} as never
const transcriptOf = (id: string): string => getAgentTranscriptPath(id as never)
const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const settleLinks: () => Promise<void> = (diskOutput as { settleTaskOutputOperations?: () => Promise<void> }).settleTaskOutputOperations ?? (() => settle(500))
const read = (path: string): string => readFileSync(path, 'utf8')

async function appears(path: string): Promise<boolean> {
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    try {
      lstatSync(path)
      return true
    } catch {
      await settle(25)
    }
  }
  return false
}
function sameFile(a: string, b: string): boolean {
  try {
    const x = statSync(a, { bigint: true })
    const y = statSync(b, { bigint: true })
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}
function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(path))
    else out.push(path)
  }
  return out
}
function isEmptyPlainFile(path: string): boolean {
  try {
    const st = lstatSync(path)
    return st.isFile() && !st.isSymbolicLink() && st.size === 0 && st.nlink === 1
  } catch {
    return false
  }
}
const namesOf = (id: string): string[] => readdirSync(dirname(getTaskOutputPath(id))).filter(name => name.startsWith(id))
async function land(id: string, text: string): Promise<void> {
  await recordSidechainTranscript([createUserMessage({ content: text })], id)
  await flushSessionStorage()
  await settleLinks()
}
async function refusing<T>(codes: { symlink?: string; link?: string; unlink?: string }, run: () => Promise<T>): Promise<T> {
  const api = nodeFs.promises as unknown as Record<string, unknown>
  const originals = new Map<string, unknown>()
  for (const [name, code] of Object.entries(codes)) {
    originals.set(name, api[name])
    api[name] = async () => {
      throw Object.assign(new Error(`${code}: operation not permitted, ${name}`), { code })
    }
  }
  try {
    return await run()
  } finally {
    for (const [name, original] of originals) api[name] = original
  }
}

console.log('============================================================')
console.log(' agent output file — the file a launch names shows the agent\'s progress')
console.log('============================================================')

section('A0 · an agent that registers and never writes leaves the files it leaves on 7301d95d0, and its id gets the same answers')
const quiet = generateTaskId('local_agent')
const quietNamed = getTaskOutputPath(quiet)
const quietTranscript = transcriptOf(quiet)
const filesBefore = new Set(filesUnder(scratch))
await refusing({ symlink: 'EPERM' }, async () => {
  registerAsyncAgent({ agentId: quiet, description: 'never writes', prompt: 'p', selectedAgent: FAKE_DEF, setAppState: store.set as never })
  await appears(quietNamed)
  await settleLinks()
})
const added = filesUnder(scratch).filter(file => !filesBefore.has(file))
check('registering it adds the one named file and nothing else', added.length === 1 && added[0] === quietNamed, JSON.stringify(added))
check('that file is the plain empty file', isEmptyPlainFile(quietNamed))
check('no transcript and no transcript folder exist for it', !existsSync(quietTranscript) && !existsSync(dirname(quietTranscript)))
const neighbour = generateTaskId('local_agent')
await refusing({ symlink: 'EPERM' }, () => initTaskOutputAsSymlink(neighbour, transcriptOf(neighbour)))
await land(neighbour, 'rows of another agent')
check('rows another agent lands leave its empty file and its missing transcript alone', isEmptyPlainFile(quietNamed) && !existsSync(quietTranscript))
completeAgentTask({ agentId: quiet }, store.set as never)
store.set(prev => ({ ...prev, tasks: {} }))
const stopWords = await stopTask(quiet, { getAppState: store.get, setAppState: store.set }).then(() => '', (error: unknown) => (error as Error).message)
check('TaskStop on its id answers with the plain miss', stopWords.startsWith('No task found with id'), stopWords)
const toQuiet = (await SendMessageTool.call({ to: quiet, message: 'anyone there' } as never, ctx, undefined as never, { requestId: 'req_quiet' } as never)) as SendAnswer
check('SendMessage treats an id with no task or transcript as an unknown address', toQuiet.data.success === false && /no (?:agent named|crewmate by that name or id)/i.test(toQuiet.data.message), toQuiet.data.message)
check('and still no transcript exists for it', !existsSync(quietTranscript) && isEmptyPlainFile(quietNamed))
await land(quiet, 'a straggler row after the task ended')
check('a task that ended before any row landed no longer waits: a straggler row leaves its empty file', existsSync(quietTranscript) && isEmptyPlainFile(quietNamed))

section('A1 · a background agent as the product registers it, this machine\'s own symlink rules')
const id = generateTaskId('local_agent')
registerAsyncAgent({ agentId: id, description: 'plant the foliage', prompt: 'plant the foliage', selectedAgent: FAKE_DEF, setAppState: store.set as never })
const named = getTaskOutputPath(id)
const transcript = transcriptOf(id)
const agentTool = src('src/tools/AgentTool/AgentTool.tsx')
check('the launch receipt names the agent\'s output path, getTaskOutputPath(its id)', /outputFile: getTaskOutputPath\(earlyAgentId\)/.test(agentTool) && /Output file: \$\{async\.outputFile\}/.test(agentTool))
check('the output file the launch names appears', await appears(named))
await settleLinks()
check('before any row lands there is no transcript on disk', !existsSync(transcript))
await land(id, 'plant the foliage')
const first = read(transcript)
check('the real transcript writer lands the first row on the transcript', first.length > 0 && first.includes('plant the foliage'), `${first.length} bytes`)
check('the named file shows that row', read(named) === first, `named ${statSync(named).size} bytes, transcript ${first.length}`)
check('the named file is the transcript itself: a symlink to it, or a link to the same file', sameFile(named, transcript))
if (lstatSync(named).isSymbolicLink()) {
  check('a symlink points straight at the transcript path', resolve(dirname(named), readlinkSync(named)) === resolve(transcript), readlinkSync(named))
}
check('the folder holds the output file and no other name for the agent', namesOf(id).join() === `${id}.output`, namesOf(id).join())
await land(id, 'water the foliage')
const second = read(transcript)
check('a row written later shows through the same named file', second.length > first.length && read(named) === second, `named ${statSync(named).size} bytes, transcript ${second.length}`)
const whole = await getTaskOutputDelta(id, 0)
check('the delta reader the task framework polls returns the transcript from offset 0', whole.content === second && whole.newOffset === Buffer.byteLength(second), `${whole.content.length} chars from offset 0`)
await land(id, 'prune the foliage')
const third = read(transcript)
const tail = await getTaskOutputDelta(id, whole.newOffset)
check('...and only the new row from the next offset', tail.content === third.slice(second.length) && tail.content.includes('prune the foliage'), JSON.stringify(tail.content.slice(0, 80)))
check('the agent view\'s tail window over the named file is the transcript', readTailWindow(named).text === third)
queue.resetCommandQueue()
enqueueAgentNotification({ taskId: id, description: 'plant the foliage', status: 'completed', setAppState: store.set as never })
const notice = queue.getCommandQueue().map(c => String(c.value ?? '')).find(v => v.includes(`<task-id>${id}</task-id>`)) ?? ''
const noticed = /<output-file>([^<]+)<\/output-file>/.exec(notice)?.[1]
check('the completion notice names that same file', noticed === named, String(noticed))
check('...and that file reads as the whole transcript', noticed !== undefined && read(noticed) === third)
queue.resetCommandQueue()

section('A2 · an account that may not create symlinks (EPERM), simulated whatever this machine allows')
const id2 = generateTaskId('local_agent')
const named2 = getTaskOutputPath(id2)
const transcript2 = transcriptOf(id2)
const settled2 = await refusing({ symlink: 'EPERM' }, () => initTaskOutputAsSymlink(id2, transcript2))
check('the init settles on the path it names', settled2 === named2, String(settled2))
check('until a row lands it is the plain empty file and no transcript exists', isEmptyPlainFile(named2) && !existsSync(transcript2))
await land(id2, 'plant the foliage')
const lines2 = read(transcript2)
if (WINDOWS) {
  check('Windows: the named file shows the row the writer lands', lines2.length > 0 && read(named2) === lines2, `named ${statSync(named2).size} bytes, transcript ${lines2.length}`)
  check('Windows: it is one file with the transcript, linked and not copied', sameFile(named2, transcript2) && !lstatSync(named2).isSymbolicLink())
  check('Windows: the folder holds the output file and no other name for the agent', namesOf(id2).join() === `${id2}.output`, namesOf(id2).join())
  await land(id2, 'water the foliage')
  check('Windows: a later row shows through it', read(named2) === read(transcript2) && read(named2).includes('water the foliage'))
} else {
  check('outside Windows a refused symlink still leaves the plain empty file after the rows land', isEmptyPlainFile(named2) && lines2.length > 0)
}

section('A3 · the link cannot be made when the first rows land (another volume, a file system without links)')
const id3 = generateTaskId('local_agent')
const named3 = getTaskOutputPath(id3)
const transcript3 = transcriptOf(id3)
const settled3 = await refusing({ symlink: 'EPERM' }, () => initTaskOutputAsSymlink(id3, transcript3))
check('the init still settles on the path it names', settled3 === named3, String(settled3))
await refusing({ link: 'EXDEV' }, () => land(id3, 'plant the foliage'))
check('the transcript is written untouched', read(transcript3).includes('plant the foliage'))
check('the named file is the plain empty file it always was', isEmptyPlainFile(named3))
check('the folder holds that file and no other name for the agent', namesOf(id3).join() === `${id3}.output`, namesOf(id3).join())
const id3b = generateTaskId('local_agent')
const named3b = getTaskOutputPath(id3b)
const transcript3b = transcriptOf(id3b)
await refusing({ symlink: 'EPERM' }, () => initTaskOutputAsSymlink(id3b, transcript3b))
await refusing({ unlink: 'EBUSY' }, () => land(id3b, 'plant the foliage'))
check('a file that cannot be replaced (held open elsewhere) stays the plain empty file', isEmptyPlainFile(named3b) && read(transcript3b).includes('plant the foliage'))
check('...and the folder holds that file and no other name for the agent', namesOf(id3b).join() === `${id3b}.output`, namesOf(id3b).join())

section('A4 · a resumed agent registers its id again')
const id4 = generateTaskId('local_agent')
const named4 = getTaskOutputPath(id4)
const transcript4 = transcriptOf(id4)
await refusing({ symlink: 'EPERM' }, () => initTaskOutputAsSymlink(id4, transcript4))
await land(id4, 'first life')
await refusing({ symlink: 'EPERM' }, () => initTaskOutputAsSymlink(id4, transcript4))
if (WINDOWS) {
  check('Windows: the re-registered file already shows the first life, before any new row', read(named4) === read(transcript4) && read(named4).includes('first life') && sameFile(named4, transcript4))
}
await land(id4, 'second life')
const lives = read(transcript4)
check('the transcript carries both lives', lives.includes('first life') && lives.includes('second life'))
if (WINDOWS) {
  check('Windows: the named file shows both lives', read(named4) === lives && sameFile(named4, transcript4), `named ${statSync(named4).size} bytes, transcript ${lives.length}`)
  check('Windows: the folder holds the output file and no other name for the agent', namesOf(id4).join() === `${id4}.output`, namesOf(id4).join())
} else {
  check('outside Windows the re-registered file is the plain empty file', isEmptyPlainFile(named4))
}

section('A5 · a transcript that already holds rows')
const id5 = generateTaskId('local_agent')
const named5 = getTaskOutputPath(id5)
const transcript5 = transcriptOf(id5)
mkdirSync(dirname(transcript5), { recursive: true })
writeFileSync(transcript5, 'a row written before the registration\n')
const longAgo = new Date(Date.now() - 86_400_000)
utimesSync(transcript5, longAgo, longAgo)
const before = statSync(transcript5)
await refusing({ symlink: 'EPERM' }, () => initTaskOutputAsSymlink(id5, transcript5))
const after = statSync(transcript5)
check('its bytes and modified time are left exactly as they were', read(transcript5) === 'a row written before the registration\n' && after.mtimeMs === before.mtimeMs && after.size === before.size)
if (WINDOWS) {
  check('Windows: the named file already shows its rows', read(named5) === 'a row written before the registration\n' && sameFile(named5, transcript5))
  appendFileSync(transcript5, 'and one after\n')
  check('Windows: and shows an appended row at once', read(named5) === 'a row written before the registration\nand one after\n')
}

section('A6 · rows that land while the registration is still settling')
const racers = [0, 2, 5, 9, 14, 20].map(delay => ({ id: generateTaskId('local_agent'), delay }))
await refusing({ symlink: 'EPERM' }, async () => {
  await Promise.all(
    racers.map(async ({ id: racer, delay }) => {
      const init = initTaskOutputAsSymlink(racer, transcriptOf(racer))
      await settle(delay)
      await land(racer, `row of ${racer}`)
      await init
    }),
  )
})
await settleLinks()
for (const { id: racer, delay } of racers) {
  if (WINDOWS) {
    check(`Windows: rows landing ${delay} ms after the registration began show through the named file`, read(getTaskOutputPath(racer)) === read(transcriptOf(racer)) && read(getTaskOutputPath(racer)).includes(`row of ${racer}`) && sameFile(getTaskOutputPath(racer), transcriptOf(racer)), namesOf(racer).join())
  } else {
    check(`outside Windows the file stays the plain empty file (${delay} ms)`, isEmptyPlainFile(getTaskOutputPath(racer)))
  }
}

rmSync(scratch, { recursive: true, force: true })

console.log(failures === 0 ? '\nprove-agent-output-file: ALL LAWS HOLD' : `\nprove-agent-output-file: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
