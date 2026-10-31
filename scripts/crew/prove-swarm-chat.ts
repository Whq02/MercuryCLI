import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { open } from '../../src/services/crewBoard/store.ts'
import { chatRows } from '../../src/services/crewBoard/chat.ts'
import { gridToPng } from '../ui/gridToPng.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { readSessionWorkers } from '../../src/daemon/concourseWorkers.ts'

assert(process.env.MERCURY_CONFIG_DIR, 'run with a scratch MERCURY_CONFIG_DIR')
const arg = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const fixture = arg('--fixture')
const captures = arg('--captures') ?? join(process.env.MERCURY_CONFIG_DIR, 'captures')
mkdirSync(captures, { recursive: true })
const { CONFIG_HOME, RUNTIME_CWD, SID, scenario, cleanupScenario, encodeFixtureTranscript } = await import('../ui/renderScenarios.ts')
const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.ts')
const projects = getProjectDir(RUNTIME_CWD)
const path = join(projects, SID, 'boards', 'wave', 'board.sqlite')
mkdirSync(join(projects, SID, 'boards', 'wave'), { recursive: true })
if (fixture) {
  copyFileSync(fixture, path)
  const copy = new Database(path)
  copy.prepare('UPDATE identity SET session = ?').run(SID)
  copy.close()
} else {
  let now = Date.parse('2026-10-01T10:00:00Z')
  const board = open(path, SID, () => now += 15000)
  const a = { author: { sessionId: SID, agentId: 'alpha', executionId: 'run' }, name: 'Alpha', team: 'engine' }
  const b = { author: { sessionId: SID, agentId: 'beta', executionId: 'run' }, name: 'Beta', team: 'view' }
  board.enroll(a); board.enroll(b)
  const question = board.post(a, { clientOpId: 'q', kind: 'ask', text: '@view does the parser include the footer?' })
  assert(question.ok)
  const wrong = board.post(b, { clientOpId: 'a', kind: 'answer', replyTo: question.eventId, text: 'Four rows.' })
  assert(wrong.ok)
  assert(board.post(b, { clientOpId: 'c', kind: 'correction', corrects: wrong.eventId, text: '@Alpha five rows including the footer.' }).ok)
  assert(board.post(a, { clientOpId: 'message:mirror', kind: 'message', text: 'The shared message.', to: ['Beta'] }, 'body').ok)
  const view = board.view()
  const traffic = [{ key: 'crew:mirror', at: new Date(now).toISOString(), agent: 'Beta', dir: 'to' as const, via: 'message' as const, text: 'The shared message.' }]
  assert.equal(chatRows(view, traffic).filter(row => row.text === 'The shared message.').length, 1)
  assert(chatRows(view, [], 'view').every(row => row.team === 'view'))
  assert(chatRows(view).some(row => row.team === 'engine') && chatRows(view).some(row => row.team === 'view'))
  assert(chatRows(view).find(row => row.id === wrong.eventId)!.kind.includes('→ correction'))
  if (arg('--leg') === 'history') for (let i = 0; i < 33; i++) assert(board.post(b, { clientOpId: `history-${i}`, kind: 'correction', corrects: wrong.eventId, text: `Count revision ${i}.` }).ok)
  board.close()
}
const saved = open(path, SID, Date.now, true)
const corpus = saved.view()
assert(corpus.events.length > 0)
saved.close()
console.log(`PASS chat projection: ${corpus.events.length} corpus posts, public team filters and a single merged timeline`)
const settings = join(CONFIG_HOME, 'settings.json')
writeFileSync(settings, JSON.stringify({ swarm: { enabled: true } }))
const then = (awaitText: string, data: string) => ({ atTick: 999, awaitText, minTick: 5, awaitSettleTicks: 2, data })
const frames: [number, number, string][] = [[120, 44, 'timeline'], [80, 24, 'timeline'], ...(!fixture ? [[120, 44, 'team'], [80, 24, 'thread'], [120, 44, 'tail'], ...(arg('--leg') === 'history' ? [[120, 44, 'history']] : [])] as [number, number, string][] : [])]
try {
  for (const [cols, rows, leg] of frames.filter(frame => !arg('--leg') || frame[2] === arg('--leg'))) {
    const config = scenario('resume-2turn', cols, rows)
    appendFileSync(join(projects, `${SID}.jsonl`), encodeFixtureTranscript([{ type: 'swarm-switch', sessionId: SID, on: true }], SID))
    const tag = `crew-chat-${cols}x${rows}${leg === 'timeline' ? '' : `-${leg}`}`
    const gridPath = join(captures, `${tag}.grid.json`)
    const sends = [then('Type a prompt', '/swarm on'), then('/swarm on', '\r'), then('Swarm on for new crewmates', '/swarm'), then('/swarm', '\r')]
    if (leg === 'team') sends.push(then('open thread', '\u001b[C'))
    if (leg === 'thread') sends.push(then('open thread', '\u001b[A'), { atTick: 999, awaitText: 'correction', minTick: 5, awaitSettleTicks: 2, data: '\r' })
    if (leg === 'history') sends.push(then('open thread', '\r'), then('Count revision 1.', '\u001b[A'))
    const arrival = 'Arrived while Crew chat stayed open.'
    const readyText = leg === 'tail' ? ['Crew chat', arrival] : leg === 'history' ? ['Crew chat', 'Four rows.'] : ['Crew chat', 'General', 'open thread']
    const capture = { ...config, total: 170, out: gridPath, readyText, readySettleTicks: 3, sends }
    const configPath = join(captures, `${tag}.json`)
    writeFileSync(configPath, JSON.stringify(capture))
    const tee = join(captures, `${tag}.tee.bin`)
    writeFileSync(tee, '')
    let appended = false
    const observer = leg === 'tail' ? watch(tee, () => {
      if (appended || !readFileSync(tee).includes(Buffer.from('open thread'))) return
      appended = true
      const writer = open(path, SID)
      const seat = { author: { sessionId: SID, agentId: 'tail', executionId: 'run' }, name: 'Tail', team: 'view' }
      writer.enroll(seat)
      assert(writer.post(seat, { clientOpId: 'tail', kind: 'result', text: arrival }).ok)
      writer.close()
    }) : undefined
    let stderr = ''
    const status = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), configPath], { env: { ...process.env, VSHOT_TEE: tee }, timeout: vshotBudgetMs(120000), stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr.on('data', chunk => { stderr += chunk.toString() })
      child.on('error', reject)
      child.on('exit', resolve)
    }).finally(() => observer?.close())
    assert(leg !== 'tail' || appended, 'The live-tail fixture never observed an open chat')
    assert.equal(status, 0, stderr)
    const grid = JSON.parse(readFileSync(gridPath, 'utf8'))
    const text = grid.grid.map((line: { c: string }[]) => line.map(cell => cell.c || ' ').join('')).join('\n')
    writeFileSync(join(captures, `${tag}.txt`), text)
    await gridToPng(gridPath, join(captures, `${tag}.png`))
    assert(text.includes('Crew chat') && text.includes('General') && text.includes('open thread'), text)
    assert(corpus.events.some(event => text.includes(event.authorName ?? event.author.agentId)), text)
    assert(!text.includes('CREW TRAFFIC'), 'swarm has one timeline rather than a second traffic roll')
    if (!fixture && leg === 'timeline') assert(grid.grid.flat().some((cell: { c: string; bold: boolean }) => cell.c === '@' && cell.bold), 'mentions are highlighted in the rendered cells')
    if (leg === 'team') assert(text.includes('[engine]') && !text.includes('[view]') && !text.includes('Four rows.'), text)
    if (leg === 'thread') assert(text.includes('Four rows.') && text.includes('five rows including the footer.'), text)
    if (leg === 'tail') assert(appended && text.includes(arrival), text)
    if (leg === 'history') assert(text.includes('Four rows.') && text.includes('does the parser include the footer?'), text)
    console.log(`PASS Workbench ${leg} frame ${cols}×${rows}: ${join(captures, `${tag}.png`)}`)
  }
} finally {
  const dir = process.env.MERCURY_DAEMON_DIR
  if (dir?.endsWith(`mercury-render-daemon-${process.pid}`)) {
    for (const worker of Object.values(readSessionWorkers(dir))) if (worker.pid && worker.endedAt === undefined) { try { process.kill(worker.pid, 'SIGTERM') } catch {} }
    try { const pid = Number(readFileSync(join(dir, 'daemon.pid'), 'utf8').trim()); if (pid > 1) process.kill(pid, 'SIGTERM') } catch {}
  }
  cleanupScenario('resume-2turn')
}
