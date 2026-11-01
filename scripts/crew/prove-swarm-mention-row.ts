import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const suiteHome = process.env.MERCURY_CONFIG_DIR
assert(suiteHome, 'run with a scratch MERCURY_CONFIG_DIR')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(suiteHome, 'mention-row-'))
const { open } = await import('../../src/services/crewBoard/store.ts')
const { crewBoardNotice, isMutedNoticeBlock, noticeOfText, noticePlate } = await import('../../src/utils/messages/noticeRows.ts')
const { gridToPng } = await import('../ui/gridToPng.ts')
const { resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourseWorkers.ts')
const text = '@main Please check the proposed law: ' + 'the parser keeps every word. '.repeat(8)
const block = noticeOfText(crewBoardNotice('Poster', 'result', text), false)![0]!
assert.equal(block.kind, 'crew-board')
assert(isMutedNoticeBlock(block))
assert.equal(noticePlate(block), `[Crewboard] Poster · result · ${text.trimEnd()}`)
assert.equal(noticeOfText('<crew-board>not JSON</crew-board>', false), null)
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const captures = arg('--captures') ?? join(process.env.MERCURY_CONFIG_DIR, 'captures')
mkdirSync(captures, { recursive: true })
const { CONFIG_HOME, RUNTIME_CWD, SID, scenario, cleanupScenario } = await import('../ui/renderScenarios.ts')
const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.ts')
const path = join(getProjectDir(RUNTIME_CWD), SID, 'boards', 'wave', 'board.sqlite')
writeFileSync(join(CONFIG_HOME, 'settings.json'), JSON.stringify({ swarm: { enabled: true } }))
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') console.log(`SKIP the live notice frame: it needs the POSIX PTY capture driver; this host has ${driver.kind}`)
try {
  for (const cols of driver.kind === 'posix-pty' ? [Number(arg('--cols') ?? 120)] : []) {
    const config = scenario('resume-2turn', cols, 44)
    const gridPath = join(captures, `crewboard-${cols}.grid.json`)
    const configPath = join(captures, `crewboard-${cols}.json`)
    writeFileSync(configPath, JSON.stringify({ ...config, total: 170, out: gridPath, readyText: ['[Crewboard] Poster', '@main Please'], readySettleTicks: 3, sends: [
      { atTick: 999, awaitText: 'Type a prompt', requireAwait: true, minTick: 5, awaitSettleTicks: 2, data: '/swarm on' },
      { atTick: 999, awaitText: '/swarm on', requireAwait: true, minTick: 5, awaitSettleTicks: 2, data: '\r' },
    ] }))
    const tee = join(captures, `crewboard-${cols}.tee.bin`)
    writeFileSync(tee, '')
    let posted = false
    const observer = watch(tee, () => {
      if (posted || !readFileSync(tee).includes(Buffer.from('Swarm on for new crewmates'))) return
      posted = true
      const board = open(path, SID)
      const sender = { author: { sessionId: SID, agentId: `poster-${cols}`, executionId: 'run' }, name: 'Poster' }
      try {
        board.enroll(sender)
        assert(board.post(sender, { clientOpId: 'row', kind: 'result', text }).ok)
      } finally { board.close() }
    })
    let stderr = ''
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(driver.kind === 'posix-pty' ? driver.python : 'python3', [fileURLToPath(new URL('../ui/vshot.py', import.meta.url)), configPath], { env: { ...process.env, VSHOT_TEE: tee }, timeout: vshotBudgetMs(120000), stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('exit', resolve)
    }).finally(() => observer.close())
    assert(posted, 'the fixture never observed the board switch')
    assert.equal(code, 0, stderr)
    const grid = JSON.parse(readFileSync(gridPath, 'utf8'))
    const lines: string[] = grid.grid.map((cells: { c: string }[]) => cells.map(cell => cell.c || ' ').join(''))
    const rows = lines.filter(line => line.includes('[Crewboard]'))
    assert.equal(rows.length, 1, lines.join('\n'))
    assert(/\d{2}:\d{2}:\d{2} \[Crewboard\] Poster · result · @main Please/.test(rows[0]!), rows[0])
    assert(!rows[0]!.includes('●') && !rows[0]!.includes('lines') && !rows[0]!.includes('<crew-board>'), rows[0])
    assert(rows[0]!.includes('…'), 'long board text is cut at the terminal width')
    writeFileSync(join(captures, `crewboard-${cols}.txt`), lines.join('\n'))
    await gridToPng(gridPath, join(captures, `crewboard-${cols}.png`))
    console.log(`PASS one muted Crewboard row at ${cols} columns: time, author, kind and truncated words; result paints while the lead remains idle`)
  }
} finally {
  const dir = process.env.MERCURY_DAEMON_DIR
  if (dir?.endsWith(`mercury-render-daemon-${process.pid}`)) {
    for (const worker of Object.values(readSessionWorkers(dir))) if (worker.pid && worker.endedAt === undefined) { try { process.kill(worker.pid, 'SIGTERM') } catch {} }
    try { const pid = Number(readFileSync(join(dir, 'daemon.pid'), 'utf8').trim()); if (pid > 1) process.kill(pid, 'SIGTERM') } catch {}
  }
  cleanupScenario('resume-2turn')
}
