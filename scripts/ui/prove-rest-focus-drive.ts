#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs, vshotBudgetScale } from '../lib/captureDriver.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { gridToPng } from './gridToPng.ts'

const root = resolve(import.meta.dir, '..', '..')
const dist = join(root, 'dist', 'mercury.mjs')
const driver = resolveCaptureDriver()
if (!existsSync(dist)) throw new Error('Build the product before running the motion journey')
if (driver.kind === 'unavailable') throw new Error(driver.reason + ': ' + driver.remedy)
if (driver.kind !== 'posix-pty') {
  console.log('The raw terminal-byte motion journey requires the POSIX capture driver; deterministic motion checks cover all platforms.')
  process.exit(0)
}
const vendoredNode = join(root, 'dist', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const node = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'
const settings = process.argv.length > 2 ? process.argv.slice(2) : ['auto', 'reduced', 'full', 'off']
if (settings.some(value => !['auto', 'reduced', 'full', 'off'].includes(value))) throw new Error('Expected a Motion setting: auto, reduced, full or off')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ': ' + detail : ''}`)
}
function countWrites(frames: ReadonlyArray<{ tick: number; cells: number }>, ticks: Record<string, number>, from: string, to: string, grace: number): number {
  const start = ticks[from] + grace
  const end = ticks[to]
  let count = 0
  for (const frame of frames) {
    if (frame.tick <= start || frame.tick >= end || frame.cells === 0) continue
    count++
  }
  return count
}
function countAnimationFrames(cellFrames: ReadonlyArray<{ tick: number; cells: number }>, ticks: Record<string, number>, from: string, to: string, grace: number): number {
  const start = ticks[from] + grace
  const end = ticks[to]
  return cellFrames.filter(frame => frame.tick > start && frame.tick < end && frame.cells >= 1 && frame.cells <= 60).length
}
for (const moving of [true, false]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'redraw-observation-')))
  const output = join(home, 'capture.json')
  const config = join(home, 'config.json')
  const script = String.raw`
    process.stdout.write('\x1b[31mX')
    setTimeout(() => {
      let count = 0
      const timer = setInterval(() => {
        count++
        process.stdout.write('\r\x1b[' + (${moving} ? 31 + count % 6 : 31) + 'mX')
        if (count === 12) clearInterval(timer)
      }, 300)
    }, 1200)
    setTimeout(() => {}, 10000)
  `
  writeFileSync(config, JSON.stringify({
    argv: [node, '-e', script], cwd: home, cols: 20, rows: 5, out: output, total: 35,
    sends: [
      { awaitText: 'X', requireAwait: true, data: '', mark: 'initial' },
      { awaitRedraws: 3, afterPrevTicks: 1, requireAwait: true, data: '', mark: 'changed' },
    ],
    readyText: moving ? 'X' : undefined,
  }))
  const result = await new Promise<{ code: number | null; text: string }>(resolveRun => {
    const child = spawn(driver.python, [captureEngineEntry(driver, root), config], {
      env: { HOME: home, PATH: `${dirname(node)}:/usr/bin:/bin`, TERM: 'xterm-256color', MERCURY_VSHOT_BUDGET_SCALE: String(vshotBudgetScale()) },
    })
    let text = ''
    child.stdout.on('data', value => { text += value })
    child.stderr.on('data', value => { text += value })
    const timeout = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(15000))
    child.on('close', code => { clearTimeout(timeout); resolveRun({ code, text }) })
  })
  check(moving ? 'delayed color-only redraws satisfy the observed gate' : 'repeated identical writes never satisfy the observed gate', result.code === (moving ? 0 : 4), result.text.trim().slice(-300))
  if (existsSync(output)) {
    const marks = JSON.parse(readFileSync(output, 'utf8')).marks ?? []
    const observed = marks.find((mark: any) => mark.label === 'changed')
    check(moving ? 'the redraw mark follows actual delayed changes' : 'the unchanged fixture has no redraw mark', moving ? observed?.atMs >= 1800 : observed === undefined)
  } else check('the redraw fixture retains its capture', false)
}
const fixture = await startFixtureApi([{ kind: 'text', text: 'Ready.', model: 'claude-fable-5-1' }])
try {
  for (const setting of settings) for (const cols of [80, 120]) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'motion-journey-home-')))
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'motion-journey-project-')))
    console.log(`capture ${cols} ${setting}: ${home}`)
    const output = join(home, 'capture.json')
    const tee = join(home, 'capture.tee')
    const config = join(home, 'capture-config.json')
    const key = 'motion-journey-fixture-key'
    writeFileSync(join(cwd, 'README.md'), '# Motion fixture\n')
    writeFileSync(join(home, '.mercury.json'), JSON.stringify({ theme: 'dark', motion: setting, hasCompletedOnboarding: true, lastOnboardingVersion: '99.0.0', numStartups: 10, projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } }, customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] }, switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 5 } }))
    check(`${cols} ${setting}: the fixture stores the requested Motion setting`, JSON.parse(readFileSync(join(home, '.mercury.json'), 'utf8')).motion === setting)
    writeFileSync(config, JSON.stringify({
      argv: [node, dist, '--model', 'claude-fable-5-1'], cwd, cols, rows: 40, out: output, total: 240,
      sends: [
        { awaitText: 'New Session', requireAwait: true, awaitSettleTicks: 4, atTick: 100, data: '\r' },
        { awaitText: 'type a prompt, or / for commands', requireAwait: true, atTick: 150, data: '', mark: 'ready' },
        { afterPrevTicks: 4, data: 'z', mark: 'awake' },
        { afterPrevTicks: 8, ...(setting === 'off' ? {} : { awaitRedraws: 2 }), data: '\u001b[O', mark: 'awake-blur' },
        { afterPrevTicks: 35, data: '\u001b[I', mark: 'awake-focus' },
        { afterPrevTicks: 6, ...(setting === 'off' ? {} : { awaitRedraws: 3 }), data: '\u0015', mark: 'awake-clear' },
        { afterPrevTicks: 40, data: '', mark: 'quiet' },
        { afterPrevTicks: setting === 'full' ? 2 : 15, ...(setting === 'full' ? { awaitRedraws: 4 } : {}), data: '\u001b[O', mark: 'blur' },
        { afterPrevTicks: setting === 'full' ? 2 : 25, ...(setting === 'full' ? { awaitRedraws: 4 } : {}), data: '\u001b[I', mark: 'focus' },
        { afterPrevTicks: setting === 'off' ? 10 : 1, ...(setting !== 'off' ? { awaitRedraws: 4 } : {}), data: 'a', mark: 'typed' },
        { afterPrevTicks: 3, data: '\u0015', mark: 'clear' },
        { afterPrevTicks: 3, signal: 'SIGTERM', data: '', mark: 'exit' },
      ],
    }))
    const env = {
      HOME: home, PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`, TERM: 'xterm-256color',
      MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_VSHOT_BUDGET_SCALE: String(vshotBudgetScale()), MERCURY_DECK_COMPANION: '0',
      MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: fixture.url, VSHOT_TEE: tee,
    }
    try {
      const result = await new Promise<{ code: number | null; text: string }>(resolveRun => {
        const child = spawn(driver.python, [captureEngineEntry(driver, root), config], { cwd: root, env })
        let text = ''
        child.stdout.on('data', value => { text += value })
        child.stderr.on('data', value => { text += value })
        const timeout = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(65000))
        child.on('close', code => { clearTimeout(timeout); resolveRun({ code, text }) })
      })
      check(`${cols} ${setting}: the complete terminal journey ran`, result.code === 0, result.text.trim().slice(-700))
      check(`${cols} ${setting}: the requested Motion setting survives the journey`, JSON.parse(readFileSync(join(home, '.mercury.json'), 'utf8')).motion === setting)
      check(`${cols} ${setting}: terminal capture artifacts exist`, existsSync(output) && existsSync(tee))
      if (!existsSync(output) || !existsSync(tee)) continue
      const capture = JSON.parse(readFileSync(output, 'utf8'))
      const marks = new Map<string, any>((capture.marks ?? []).map((mark: any) => [mark.label, mark]))
      const complete = ['ready', 'awake', 'awake-blur', 'awake-focus', 'awake-clear', 'quiet', 'blur', 'focus', 'typed', 'clear', 'exit'].every(name => marks.has(name))
      check(`${cols} ${setting}: every required transition was captured`, complete)
      if (!complete) continue
      const raw = readFileSync(tee)
      const frames: Array<{ tick: number; data: Buffer }> = []
      for (let offset = 0; offset + 8 <= raw.length;) {
        const tick = raw.readUInt32BE(offset)
        const size = raw.readUInt32BE(offset + 4)
        if (offset + 8 + size > raw.length) throw new Error('Truncated terminal capture')
        frames.push({ tick, data: raw.subarray(offset + 8, offset + 8 + size) })
        offset += 8 + size
      }
      const ticks: Record<string, number> = Object.fromEntries([...marks].map(([name, mark]) => [name, Number(mark.atTick)]))
      const replay = spawnSync(driver.python, [join(root, 'scripts', 'ui', 'tee-frames.py'), tee, String(cols), '40'], { encoding: 'utf8', env: { ...process.env, HOME: process.env.HOME ?? home } })
      check(`${cols} ${setting}: the terminal capture replays through the emulator`, replay.status === 0, (replay.stderr ?? '').slice(-300))
      if (replay.status !== 0) continue
      const cellFrames: Array<{ tick: number; bytes: number; cells: number }> = JSON.parse(replay.stdout)
      const writes = (from: string, to: string, grace = 2) => countWrites(cellFrames, ticks, from, to, grace)
      check(`${cols} ${setting}: empty and reversed observation intervals count no writes`, writes('blur', 'blur') === 0 && writes('focus', 'blur') === 0)
      const animationFrames = (from: string, to: string, grace = 2) => countAnimationFrames(cellFrames, ticks, from, to, grace)
      const observation = { ticks, frameTicks: frames.map(frame => frame.tick), quiet: writes('quiet', 'blur'), blurred: writes('blur', 'focus'), refocused: writes('focus', 'typed', 0), awakeBlurred: animationFrames('awake-blur', 'awake-focus', 8), awakeRefocused: animationFrames('awake-focus', 'awake-clear', 0), cellFrames }
      writeFileSync(join(home, 'observed-counts.json'), JSON.stringify(observation))
      writeFileSync(join(home, 'observed.tee'), raw)
      console.log(`observed ${cols} ${setting}: ${JSON.stringify({ ticks, quiet: observation.quiet, blurred: observation.blurred, refocused: observation.refocused, awakeBlurred: observation.awakeBlurred, awakeRefocused: observation.awakeRefocused })}`)
      check(`${cols} ${setting}: the awake blur is sent before the quiet rest engages`, Number(ticks['awake-blur']) - Number(ticks['awake']) < 40, String(Number(ticks['awake-blur']) - Number(ticks['awake'])))
      if (setting === 'full') check(`${cols} ${setting}: full motion keeps animating through a blur while awake`, observation.awakeBlurred >= 3, String(observation.awakeBlurred))
      else if (setting === 'off') check(`${cols} ${setting}: off motion stays still through a blur while awake`, observation.awakeBlurred === 0, String(observation.awakeBlurred))
      else check(`${cols} ${setting}: a blur while awake stops the animation frames`, observation.awakeBlurred === 0, String(observation.awakeBlurred))
      if (setting !== 'off') check(`${cols} ${setting}: focus regained while awake resumes the animation`, observation.awakeRefocused >= 3, String(observation.awakeRefocused))
      if (setting === 'full') {
        check(`${cols} ${setting}: full motion continues through quiet`, writes('quiet', 'blur') >= 3, String(writes('quiet', 'blur')))
        check(`${cols} ${setting}: full motion continues through blur`, writes('blur', 'focus') >= 3, String(writes('blur', 'focus')))
      } else {
        check(`${cols} ${setting}: quiet motion produces no repeated redraws`, writes('quiet', 'blur') <= 1, String(writes('quiet', 'blur')))
        check(`${cols} ${setting}: blur stops repeated redraws`, writes('blur', 'focus') <= 1, String(writes('blur', 'focus')))
      }
      check(`${cols} ${setting}: focus preserves the selected animation policy`, setting === 'off' ? writes('focus', 'typed', 0) <= 1 : writes('focus', 'typed', 0) >= 3, String(writes('focus', 'typed', 0)))
      const bytes = Buffer.concat(frames.map(frame => frame.data)).toString('utf8')
      check(`${cols} ${setting}: focus reporting is armed and disarmed`, bytes.includes('\u001b[?1004h') && bytes.includes('\u001b[?1004l'))
      const populated = marks.get('clear').grid.map((row: any[]) => row.map(cell => cell.c).join('')).join('\n')
      check(`${cols} ${setting}: keyboard input still reaches the composer`, /❯\s*a/.test(populated))
      for (const label of ['quiet', 'clear']) {
        const grid = join(home, `${label}.json`)
        writeFileSync(grid, JSON.stringify(marks.get(label)))
        const image = join(home, `${label}.png`)
        await gridToPng(grid, image)
        console.log(`frame ${cols} ${label}: ${image}`)
      }
    } finally {
      spawnSync(node, [dist, 'daemon', 'stop'], { env, timeout: 10000, stdio: 'pipe' })
    }
  }
} finally {
  await fixture.close()
}
process.exit(failures === 0 ? 0 : 1)
