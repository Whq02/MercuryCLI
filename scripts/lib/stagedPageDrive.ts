import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs, vshotBudgetScale } from './captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from './firstRunSeed.ts'
import { removeScratch } from './removeScratch.ts'
import { stageInstall } from './stagedInstall.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
type Grid = Array<Array<{ c?: string }>>
const textOf = (grid: Grid | undefined): string => (grid ?? []).map(row => row.map(cell => cell.c ?? ' ').join('').trimEnd()).join('\n')

export const key = (awaitText: string, data: string, mark?: string) => ({ awaitText, requireAwait: true, awaitSettleTicks: 4, data, ...(mark === undefined ? {} : { mark }) })

type Staged = { home: string; bin: string; cwd: string }
type StagedScene = {
  name: string
  sends: Array<ReturnType<typeof key>>
  readyText: string | string[]
  resizes?: Array<{ afterMark: string; cols: number; rows: number }>
  linked?: boolean
  env?: Record<string, string>
  stage?: (staged: Staged) => void
  after?: (staged: Staged) => boolean
}

export function stagedPageDrive(opts: { name: string; page: string; framesDir: string | undefined; fixtureUrl: string; check: (label: string, ok: boolean, fix: string) => void }) {
  const driver = resolveCaptureDriver()
  if (!existsSync(join(ROOT, 'dist', 'mercury.mjs'))) throw new Error(`Build the product before running the ${opts.name} drive`)
  if (driver.kind === 'unavailable') throw new Error(driver.reason + ': ' + driver.remedy)
  if (driver.kind !== 'posix-pty') return null
  const python = driver.python
  const engine = captureEngineEntry(driver, ROOT)
  return async (cols: number, rows: number, scene: StagedScene): Promise<{ frame: (label: string) => string; home: string; bin: string; after: boolean }> => {
    const userHome = realpathSync(mkdtempSync(join(tmpdir(), `${opts.name}-home-`)))
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), `${opts.name}-project-`)))
    const install = stageInstall('source', userHome)
    const staged = { home: install.home, bin: install.bin, cwd }
    seedFirstRun(install.home, [cwd])
    scene.stage?.(staged)
    const linkDir = join(userHome, 'linked')
    if (scene.linked) {
      mkdirSync(linkDir)
      symlinkSync(install.command, join(linkDir, 'mercury'))
    }
    const output = join(userHome, 'capture.json')
    const config = join(userHome, 'capture-config.json')
    writeFileSync(config, JSON.stringify({ argv: [scene.linked ? join(linkDir, 'mercury') : install.command], cwd, cols, rows, out: output, total: 600, sends: scene.sends, resizes: scene.resizes ?? [], readyText: scene.readyText }))
    const env = {
      ...install.env,
      ...(scene.linked ? { PATH: `${linkDir}${(install.env.PATH ?? '').slice(install.bin.length)}` } : {}),
      TERM: 'xterm-256color',
      MERCURY_VSHOT_BUDGET_SCALE: String(vshotBudgetScale()),
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      ANTHROPIC_BASE_URL: opts.fixtureUrl,
      ...scene.env,
    }
    const result = await new Promise<{ code: number | null; text: string }>(resolveRun => {
      const child = spawn(python, [engine, config], { cwd: ROOT, env })
      let text = ''
      child.stdout.on('data', value => { text += value })
      child.stderr.on('data', value => { text += value })
      const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(150000))
      child.on('close', code => { clearTimeout(deadline); resolveRun({ code, text }) })
    })
    spawnSync(install.command, ['daemon', 'stop'], { env, timeout: 10000, stdio: 'pipe' })
    opts.check(`${cols}x${rows} ${scene.name}: the drive ran to its end`, result.code === 0 && existsSync(output), `an awaited text in the sends list of this drive never painted; compare the last awaited text with the output tail and the words in ${opts.page}. ${result.text.trim().slice(-700)}`)
    const capture = (existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : {}) as { grid?: Grid; marks?: Array<{ label: string; grid: Grid }>; sendReceipts?: unknown[] }
    const after = scene.after?.(staged) ?? false
    for (const dir of [userHome, cwd]) removeScratch(dir)
    const marks = new Map([...(capture.marks ?? []).map(mark => [mark.label, textOf(mark.grid)] as const), [scene.name, textOf(capture.grid)] as const])
    if (opts.framesDir !== undefined) {
      mkdirSync(opts.framesDir, { recursive: true })
      for (const [label, text] of marks) writeFileSync(join(opts.framesDir, `${label}-${cols}x${rows}.txt`), text + '\n')
    }
    opts.check(`${cols}x${rows} ${scene.name}: every key reached its screen`, capture.sendReceipts?.length === scene.sends.length, `only ${String(capture.sendReceipts?.length)} of ${scene.sends.length} sends were delivered; the first send whose awaited text never painted names the screen that stopped`)
    return { frame: label => marks.get(label) ?? '', home: install.home, bin: install.bin, after }
  }
}
