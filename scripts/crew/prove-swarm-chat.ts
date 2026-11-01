import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { open } from '../../src/services/crewBoard/store.ts'
import { chatKindColor, chatNameColor, chatRows } from '../../src/services/crewBoard/chat.ts'
import { resolveMercuryTokens } from '../../src/utils/mercuryTokens.ts'
import { TERRA } from '../../src/components/mercuryPalette.ts'
import { gridToPng } from '../ui/gridToPng.ts'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { readSessionWorkers } from '../../src/daemon/concourseWorkers.ts'

assert(process.env.MERCURY_CONFIG_DIR, 'run with a scratch MERCURY_CONFIG_DIR')
const THREE_LINES = 'Three lines:\nthe header row,\nthe footer row.'
const LONG_POST = 'The parser keeps every row it reads: the header row, the footer row and each body row between them, in the order the file holds them, with the column widths measured over the whole table rather than the first page, so that a narrow first page never clips a wide later one and the footer lands under the right columns.'
const LONG_TAIL = 'lands under the right columns'
const palette = resolveMercuryTokens('dark', TERRA)
assert.equal(chatNameColor('main', palette), palette.agentAccents[0]!.color)
for (const name of ['Alpha', 'Beta', 'swarm-parser']) {
  assert.equal(chatNameColor(name, palette), chatNameColor(name, palette))
  assert(palette.agentAccents.some(accent => accent.color === chatNameColor(name, palette)))
  assert.notEqual(chatNameColor(name, palette), chatNameColor('main', palette))
}
assert.equal(new Set(['ask', 'answer', 'result', 'blocker', 'correction', 'notice'].map(kind => chatKindColor(kind, palette))).size, 6)
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
  const board = open(path, SID, undefined, () => now += 15000)
  const a = { author: { sessionId: SID, agentId: 'alpha', executionId: 'run' }, name: 'Alpha', team: 'engine' }
  const b = { author: { sessionId: SID, agentId: 'beta', executionId: 'run' }, name: 'Beta', team: 'view' }
  board.enroll(a); board.enroll(b)
  const question = board.post(a, { clientOpId: 'q', kind: 'ask', text: '@view does the parser include the footer?' })
  assert(question.ok)
  const wrong = board.post(b, { clientOpId: 'a', kind: 'answer', replyTo: question.eventId, text: 'Four rows.' })
  assert(wrong.ok)
  assert(board.post(b, { clientOpId: 'c', kind: 'correction', corrects: wrong.eventId, text: '@Alpha five rows including the footer.' }).ok)
  assert(board.post(a, { clientOpId: 'message:mirror', kind: 'message', text: 'The shared message.', to: ['Beta'] }, 'body').ok)
  assert(board.post(a, { clientOpId: 'three', kind: 'result', replyTo: question.eventId, text: THREE_LINES }).ok)
  assert(board.post(b, { clientOpId: 'long', kind: 'result', replyTo: question.eventId, text: LONG_POST }).ok)
  const view = board.view()
  assert.deepEqual(board.view(undefined, undefined, 'view').names, view.names, 'name column uses the whole wave in every channel')
  assert.deepEqual(board.view(3).names, view.names, 'name column uses the whole wave on earlier pages')
  assert(view.duplicateMinutes?.includes('2026-10-01T10:01'))
  const traffic = [{ key: 'crew:mirror', at: new Date(now).toISOString(), agent: 'Beta', dir: 'to' as const, via: 'message' as const, text: 'The shared message.' }]
  assert.equal(chatRows(view, traffic).filter(row => row.text === 'The shared message.').length, 1)
  assert(chatRows(view, [], 'view').every(row => row.team === 'view'))
  assert(chatRows(view).some(row => row.team === 'engine') && chatRows(view).some(row => row.team === 'view'))
  assert(chatRows(view).find(row => row.id === wrong.eventId)!.kind.includes('→ correction'))
  if (arg('--leg') === 'history') for (let i = 0; i < 33; i++) assert(board.post(b, { clientOpId: `history-${i}`, kind: 'correction', corrects: wrong.eventId, text: `Count revision ${i}.` }).ok)
  board.close()
}
const saved = open(path, SID, undefined, Date.now, true)
const corpus = saved.view()
assert(corpus.events.length > 0)
saved.close()
console.log(`PASS chat projection: ${corpus.events.length} corpus posts, public team filters and a single merged timeline`)
const settings = join(CONFIG_HOME, 'settings.json')
writeFileSync(settings, JSON.stringify({ swarm: { enabled: true } }))
const then = (awaitText: string, data: string) => ({ atTick: 999, awaitText, requireAwait: true, minTick: 5, awaitSettleTicks: 2, data })
const frames: [number, number, string][] = [[120, 44, 'timeline'], [80, 24, 'timeline'], ...(!fixture ? [[120, 44, 'team'], [80, 24, 'thread'], [80, 20, 'scroll'], [120, 44, 'tail'], ...(arg('--leg') === 'history' ? [[120, 44, 'history']] : [])] as [number, number, string][] : [])]
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') console.log(`SKIP the picture frames: they need the POSIX pty capture driver (scripts/ui/vshot.py); this host has ${driver.kind === 'unavailable' ? `none (${driver.reason}; ${driver.remedy})` : driver.kind}`)
try {
  for (const [cols, rows, leg] of driver.kind === 'posix-pty' ? frames.filter(frame => !arg('--leg') || frame[2] === arg('--leg')) : []) {
    const config = scenario('resume-2turn', cols, rows)
    appendFileSync(join(projects, `${SID}.jsonl`), encodeFixtureTranscript([{ type: 'swarm-switch', sessionId: SID, on: true }], SID))
    const tag = `crew-chat-${cols}x${rows}${leg === 'timeline' ? '' : `-${leg}`}`
    const gridPath = join(captures, `${tag}.grid.json`)
    const sends: Record<string, unknown>[] = [then('Type a prompt', '/swarm on'), then('/swarm on', '\r'), then('Swarm on for new crewmates', '/swarm'), then('/swarm', '\r')]
    if (leg === 'team') sends.push(then('open thread', '\u001b[C'))
    if (leg === 'thread') sends.push(then('open thread', '\u001b[A'), { atTick: 999, awaitText: 'correction', requireAwait: true, minTick: 5, awaitSettleTicks: 2, data: '\r' }, { ...then('[view] [answer', ''), mark: 'top' }, ...Array.from({ length: 8 }, () => then('[view] [answer', '\u001b[B')))
    if (leg === 'history') sends.push(then('open thread', '\r'), then('Count revision 1.', '\u001b[A'))
    if (leg === 'scroll') sends.push({ ...then('open thread', ''), mark: 'bottom' }, then('open thread', '\u001b[A'), then('open thread', '\u001b[A'))
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
      const child = spawn(driver.kind === 'posix-pty' ? driver.python : 'python3', [join(import.meta.dir, '../ui/vshot.py'), configPath], { env: { ...process.env, VSHOT_TEE: tee }, timeout: vshotBudgetMs(120000), stdio: ['ignore', 'ignore', 'pipe'] })
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
    if (leg === 'timeline' || leg === 'team') {
      const rendered = grid.grid.map((cells: { c: string; fg: string; bold: boolean }[], y: number) => {
        const words = cells.map(cell => cell.c || ' ').join('')
        const match = words.match(/(\d{2}:\d{2}(?::\d{2})?)\s+\[([^\]]+)\]\s+(?:\[traffic\]\s+)?\[([^\]]+)\]:/)
        return match ? { cells, y, words, at: match[1]!, name: match[2]!, kind: match[3]!, timeColumn: match.index!, kindColumn: words.indexOf(`[${match[3]}]`, match.index! + match[1]!.length) } : null
      }).filter(Boolean)
      assert(rendered.length > 0, text)
      assert.equal(new Set(rendered.map((row: any) => row.kindColumn - row.timeColumn)).size, 1, 'padded name and traffic columns align the kind tags')
      for (const row of rendered) {
        const event = corpus.events.find(event => (event.authorName ?? event.author.agentId) === row.name && event.createdAt.slice(11, 16) === row.at.slice(0, 5))
        if (event) assert.equal(row.at.length, corpus.duplicateMinutes?.includes(event.createdAt.slice(0, 16)) ? 8 : 5, 'seconds appear only when posts share a minute')
        const nameCell = row.cells[row.words.indexOf(`[${row.name}]`) + 1]
        assert(nameCell.fg !== 'default' && nameCell.bold, 'agent tags use the theme palette')
        assert(row.cells[row.kindColumn + 1].fg !== 'default', 'kind tags use the theme palette')
        const trafficColumn = row.words.indexOf('[traffic]')
        if (trafficColumn >= 0) assert.equal(row.cells[trafficColumn + 1].fg, row.cells[row.timeColumn].fg, 'time and traffic share the muted theme ink')
      }
      const nameColors = new Map<string, string>()
      for (const row of rendered) {
        const color = row.cells[row.words.indexOf(`[${row.name}]`) + 1].fg
        if (nameColors.has(row.name)) assert.equal(color, nameColors.get(row.name), 'an agent keeps its tag colour across posts')
        nameColors.set(row.name, color)
      }
      if (nameColors.has('main')) for (const [name, color] of nameColors) if (name !== 'main') assert.notEqual(color, nameColors.get('main'), 'the lead keeps its own colour')
      if (!fixture && leg === 'timeline') {
        assert(text.includes('└') && text.includes('[traffic]') && text.includes('[ask]:'), text)
        assert(rendered.some((row: any, i: number) => i > 0 && row.y - rendered[i - 1].y > 1), 'threads have a blank separator')
      }
    }
    if (!fixture && leg === 'timeline') assert(grid.grid.flat().some((cell: { c: string; bold: boolean }) => cell.c === '@' && cell.bold), 'mentions are highlighted in the rendered cells')
    if (leg === 'team') assert(text.includes('[Alpha]') && !text.includes('[Beta]') && !text.includes('Four rows.'), text)
    const lines = text.split('\n')
    const trimmed = (line: string): string => line.replace(/^[\s│]+|[\s│]+$/g, '')
    if (!fixture && leg === 'timeline') {
      const threeAt = lines.findIndex(line => line.includes('Three lines:'))
      assert(threeAt >= 0 && lines[threeAt + 1]!.includes('the header row,') && lines[threeAt + 2]!.includes('the footer row.') && !lines[threeAt + 2]!.includes('…'), 'a post of exactly three lines paints whole, without an ellipsis')
      const longAt = lines.findIndex(line => line.includes('The parser keeps every row'))
      assert(longAt >= 0 && !/\d{2}:\d{2}/.test(lines[longAt + 1]!) && !/\d{2}:\d{2}/.test(lines[longAt + 2]!) && /…\s*│?\s*$/.test(lines[longAt + 2]!) && !text.includes(LONG_TAIL), 'a longer post paints three lines and the third ends with an ellipsis')
      const column = lines[longAt]!.indexOf('The parser keeps')
      assert(trimmed(lines[longAt + 1]!.slice(0, column)) === '' && lines[longAt + 1]!.length > column && lines[longAt + 1]![column] !== ' ', 'continuation lines sit under the body column')
    }
    if (leg === 'thread') {
      const top = (grid.marks as Array<{ label: string; grid: { c: string }[][] }> | undefined)?.find(mark => mark.label === 'top')?.grid.map(line => line.map(cell => cell.c || ' ').join('')).join('\n') ?? ''
      assert(top.includes('Four rows.') && top.includes('five rows including the footer.'), top)
      assert(lines.map(trimmed).join(' ').replace(/\s+/g, ' ').includes(LONG_TAIL), 'the thread view keeps the whole post')
    }
    if (leg === 'scroll') {
      const panelOf = (rows: string[]): string[] => rows.slice(rows.findIndex(line => line.includes('General')), rows.findIndex(line => line.includes('↑↓ move')))
      const opensOnARow = (rows: string[]): boolean => /^(›\s*)?(└\s+)?\d{2}:\d{2}(?::\d{2})?\s+\[/.test(trimmed(rows[1] ?? ''))
      const bottom = panelOf(((grid.marks as Array<{ label: string; grid: { c: string }[][] }> | undefined)?.find(mark => mark.label === 'bottom')?.grid ?? []).map(line => line.map(cell => cell.c || ' ').join('')))
      assert(bottom.length > 2 && !bottom.join('\n').includes('The shared message.') && bottom.join('\n').includes('…'), 'the opening window is scrolled: the first rows are off the top and the long post is at the bottom')
      assert(opensOnARow(bottom), `the scrolled window opens on a row's first line, with its time and name: ${trimmed(bottom[1] ?? '')}`)
      const panel = panelOf(lines)
      const marked = panel.findIndex(line => trimmed(line).startsWith('›'))
      assert(marked >= 0 && panel[marked]!.includes('[correction]:') && panel[marked + 1]!.includes('the footer.'), 'two rows up from the end selects the correction and keeps both of its lines on screen')
      assert(panel.join('\n').includes('The shared message.') && !panel.join('\n').includes('…'), 'the window follows the selection by row height: the top rows return and the long post below leaves the frame')
      assert(opensOnARow(panel), `after scrolling up the window still opens on a row's first line: ${trimmed(panel[1] ?? '')}`)
    }
    if (leg === 'tail') assert(appended && text.includes(arrival), text)
    if (leg === 'history') assert(text.includes('Four rows.') && text.includes('does the parser include the footer?'), text)
    if (leg === 'timeline' && cols === 80) assert(text.includes('…'), 'long messages end in an ellipsis')
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
