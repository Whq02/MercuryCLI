#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-extui-surface-')))
const TEMPLATE = join(SCRATCH, 'home-template')
const CWD = join(SCRATCH, 'project')
const CWD_FRESH = join(SCRATCH, 'project-fresh')
mkdirSync(TEMPLATE, { recursive: true })
mkdirSync(CWD, { recursive: true })
mkdirSync(CWD_FRESH, { recursive: true })
process.env.MERCURY_CONFIG_DIR = TEMPLATE
process.env.MERCURY_RENDER_CWD = CWD
delete process.env.NODE_ENV
delete process.env.CI

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const CAPTURE_DIR = process.env.MERCURY_EXTUI_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const scenarios = await import('../ui/renderScenarios.ts')
const { sanitizePath } = await import('../../src/utils/sessionStoragePortable.ts')
const core = {
  sources: await import('../../src/extensions/sources.ts'),
  install: await import('../../src/extensions/install.ts'),
  blocklist: await import('../../src/extensions/blocklist.ts'),
  records: await import('../../src/extensions/records.ts'),
  paths: await import('../../src/extensions/paths.ts'),
  card: await import('../../src/extensions/card.ts'),
  manifest: await import('../../src/extensions/manifest.ts'),
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const SRC = join(SCRATCH, 'src-team-tools')
const ESC = '\u001b'
const DOWN = `${ESC}[B`

type Manifest = Record<string, unknown>
function writeExtension(root: string, manifest: Manifest): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'mercury-extension.json'), JSON.stringify(manifest, null, 2))
}

const REVIEW_12: Manifest = {
  name: 'review-tools',
  version: '1.2.0',
  description: 'code review hooks for the team',
  contributes: {
    hooks: { PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'true', timeout: 30 }] }] },
  },
  needs: { binaries: ['node'] },
}
const REVIEW_13: Manifest = {
  ...REVIEW_12,
  version: '1.3.0',
  contributes: {
    hooks: {
      PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'true', timeout: 30 }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'true', timeout: 60 }] }],
    },
  },
}
const SPARE: Manifest = {
  name: 'spare-tool',
  version: '0.3.0',
  description: 'a spare tool nobody installed yet',
  contributes: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true', timeout: 10 }] }] } },
  needs: { env: ['SPARE_TOKEN'] },
}

function catalogueJson(reviewVersion: string): string {
  return JSON.stringify(
    {
      name: 'team-tools',
      description: 'the surface prover source',
      extensions: [
        { name: 'review-tools', version: reviewVersion, description: 'code review hooks for the team', path: './review-tools' },
        { name: 'deploy-kit', version: '0.4.1', description: 'deploy runbooks for the platform team', path: './deploy-kit' },
        { name: 'notes-sync', version: '2.0.0', description: 'sync your notes folder', path: './notes-sync' },
        { name: 'quiet-notes', version: '1.0.0', description: 'quiet notes in the corner', path: './quiet-notes' },
        { name: 'docs-lint', version: '0.9.2', description: 'a prose linter', path: './docs-lint' },
        { name: 'sketchy', version: '1.0.0', description: 'a sketchy one for the blocklist', path: './sketchy' },
        { name: 'spare-tool', version: '0.3.0', description: 'a spare tool nobody installed yet', path: './spare-tool' },
      ],
    },
    null,
    2,
  )
}

async function seedTemplate(): Promise<void> {
  mkdirSync(SRC, { recursive: true })
  writeExtension(join(SRC, 'review-tools'), REVIEW_12)
  writeExtension(join(SRC, 'deploy-kit'), {
    name: 'deploy-kit',
    version: '0.4.1',
    description: 'deploy runbooks for the platform team',
    needs: { binaries: ['missing-bin-fx'] },
  })
  writeExtension(join(SRC, 'notes-sync'), { name: 'notes-sync', version: '2.0.0', description: 'sync your notes folder' })
  writeExtension(join(SRC, 'quiet-notes'), { name: 'quiet-notes', version: '1.0.0', description: 'quiet notes in the corner' })
  writeExtension(join(SRC, 'docs-lint'), { name: 'docs-lint', version: '0.9.2', description: 'a prose linter' })
  writeExtension(join(SRC, 'sketchy'), { name: 'sketchy', version: '1.0.0', description: 'a sketchy one for the blocklist' })
  writeExtension(join(SRC, 'spare-tool'), SPARE)
  writeFileSync(join(SRC, 'mercury-extensions.json'), catalogueJson('1.2.0'))

  const added = await core.sources.addSource(SRC)
  if (!added.ok) throw new Error(`fixture addSource failed: ${added.reason}`)
  const label = added.label
  for (const name of ['review-tools', 'deploy-kit', 'notes-sync', 'quiet-notes', 'docs-lint', 'sketchy']) {
    const installed = await core.install.installFromSource(label, name)
    if (!installed.ok) throw new Error(`fixture install ${name} failed: ${installed.reason}`)
  }
  for (const name of ['review-tools', 'deploy-kit', 'notes-sync', 'quiet-notes', 'sketchy']) {
    const approved = core.install.approve(`${name}@${label}`)
    if (!approved.ok) throw new Error(`fixture approve ${name} failed: ${approved.reason}`)
  }
  const blocked = core.blocklist.block(`sketchy@${label}`)
  if (!blocked.ok) throw new Error(`fixture block failed: ${blocked.error}`)
  const notesRecord = core.records.installedOrEmpty()[`notes-sync@${label}`]
  if (!notesRecord) throw new Error('fixture: notes-sync record missing')
  appendFileSync(join(notesRecord.path, 'mercury-extension.json'), '\n')
  writeExtension(join(SRC, 'review-tools'), REVIEW_13)
  writeFileSync(join(SRC, 'mercury-extensions.json'), catalogueJson('1.3.0'))

  const eightDays = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()
  const oneDay = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const smallCatalogue = (name: string): string =>
    JSON.stringify({ name, extensions: [{ name: `${name}-tool`, version: '1.0.0', description: 'from the cache', git: 'https://git.example.org/x/y.git' }] })
  for (const [label2, record] of [
    ['ada-notes', { kind: 'git', where: 'https://git.example.org/ada/notes.git', ref: null, addedAt: eightDays, checkedAt: eightDays, commit: 'aaaaaaa', lastError: null }],
    ['ghost-tools', { kind: 'git', where: 'https://git.example.org/ghost/tools.git', ref: null, addedAt: oneDay, checkedAt: oneDay, commit: 'bbbbbbb', lastError: 'host unreachable' }],
    ['fresh-tools', { kind: 'archive', where: join(SCRATCH, 'fresh-tools.zip'), ref: null, addedAt: oneDay, checkedAt: null, commit: null, lastError: null }],
  ] as const) {
    const cache = core.paths.getSourceCacheDir(label2)
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, 'mercury-extensions.json'), smallCatalogue(label2))
    const current = core.records.sourcesOrEmpty()
    core.records.writeSources({ ...current, [label2]: record as never })
  }

  writeExtension(join(CWD, '.mercury', 'extensions', 'scratch-tools'), {
    name: 'scratch-tools',
    version: '0.1.0',
    description: 'the project folder extension',
  })
  writeFileSync(
    join(CWD, '.mercury', 'settings.json'),
    JSON.stringify({ extensions: { wanted: [{ name: 'wanted-tool', source: 'https://git.example.org/eve/wanted-tool.git' }] } }, null, 2),
  )

  seedFirstRun(TEMPLATE, [CWD])
  scenarios.writeSyntheticSession('short')
}

type Send = Record<string, unknown>
type Drive = {
  id: string
  cols: number
  rows: number
  theme?: 'light'
  freshHome?: boolean
  prepare?: (home: string) => void
  sends: Send[]
  ready: string
  total?: number
  assert: (text: string, lines: string[]) => void
}

function g(needle: string, data: string, extra: Send = {}): Send {
  return { requireAwait: true, awaitText: needle, awaitSettleTicks: 2, data, ...extra }
}

const openBoard: Send[] = [
  { atTick: 140, awaitRaw: `${ESC}[?2004h`, minTick: 30, data: '/extensions' },
  { afterPrevTicks: 6, data: '\r' },
]

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(
    `prove-extensions-surface: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`,
  )
  process.exit(1)
}

function runDrive(drive: Drive): Promise<{ text: string; lines: string[]; status: number; tail: string }> {
  const home = join(SCRATCH, `home-${drive.id}`)
  if (drive.freshHome) {
    mkdirSync(home, { recursive: true })
    seedFirstRun(home, [CWD_FRESH])
    const from = join(TEMPLATE, 'projects', sanitizePath(CWD))
    const to = join(home, 'projects', sanitizePath(CWD_FRESH))
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from)) {
      const body = readFileSync(join(from, name), 'utf8')
      writeFileSync(join(to, name), body.split(JSON.stringify(CWD).slice(1, -1)).join(JSON.stringify(CWD_FRESH).slice(1, -1)))
    }
  } else {
    cpSync(TEMPLATE, home, { recursive: true })
  }
  drive.prepare?.(home)
  const cfgPath = join(SCRATCH, `cfg-${drive.id}.json`)
  const outPath = join(SCRATCH, `grid-${drive.id}.json`)
  const cfg = {
    argv: ['node', BIN, '--resume', scenarios.SID],
    cwd: drive.freshHome ? CWD_FRESH : CWD,
    cols: drive.cols,
    rows: drive.rows,
    sends: drive.sends,
    readyText: drive.ready,
    readySettleTicks: 2,
    total: drive.total ?? 480,
    out: outPath,
  }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  return new Promise(resolvePromise => {
    const child = spawn(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], {
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: home,
        MERCURY_LIVE_GLYPHS: '0',
        ...(drive.theme === 'light' ? { MERCURY_THEME_PIN: 'light' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let tail = ''
    child.stdout.on('data', d => (tail = (tail + String(d)).slice(-500)))
    child.stderr.on('data', d => (tail = (tail + String(d)).slice(-500)))
    child.on('close', status => {
      let text = ''
      let lines: string[] = []
      try {
        const grid = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Array<Array<{ c: string }>> }
        lines = grid.grid.map(row => row.map(cell => cell.c).join(''))
        text = lines.join('\n')
        if (CAPTURE_DIR) writeFileSync(join(CAPTURE_DIR, `${drive.id}.txt`), lines.map(l => l.replace(/\s+$/, '')).join('\n') + '\n')
      } catch {
      }
      resolvePromise({ text, lines, status: status ?? 1, tail })
    })
  })
}

async function runAll(all: Drive[], concurrency: number): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, all.length) }, async () => {
    while (next < all.length) {
      const drive = all[next]!
      next++
      const started = Date.now()
      const result = await runDrive(drive)
      const seconds = ((Date.now() - started) / 1000).toFixed(0)
      console.log(`\n── ${drive.id} (${drive.cols}x${drive.rows}${drive.theme ? ' · light' : ''}) ${seconds}s`)
      if (result.status !== 0 || result.text === '') {
        check(`${drive.id}: capture ran`, false, result.tail.slice(-260).replace(/\n/g, ' '))
        continue
      }
      const ready = result.text.includes(drive.ready)
      check(`${drive.id}: reached its end state`, ready, ready ? '' : `missing needle: ${drive.ready}`)
      if (ready) drive.assert(result.text, result.lines)
    }
  })
  await Promise.all(workers)
}

function has(id: string, text: string, needle: string): void {
  check(`${id}: paints '${needle.length > 64 ? needle.slice(0, 64) + '…' : needle}'`, text.includes(needle))
}
function hasNot(id: string, text: string, needle: string, why: string): void {
  check(`${id}: never paints '${needle}' (${why})`, !text.includes(needle))
}

const P_WORD = ['plug', 'in'].join('')
const M_WORD = ['market', 'place'].join('')

function noRetiredWords(id: string, text: string): void {
  const low = text.toLowerCase()
  check(`${id}: no retired vocabulary on the grid`, !low.includes(P_WORD) && !low.includes(M_WORD))
}

function installedColumnsAligned(id: string, lines: string[]): void {
  const header = lines.find(l => l.includes('state') && l.includes('name') && l.includes('ver') && l.includes('from'))
  check(`${id}: the installed column header row paints`, header !== undefined)
  if (!header) return
  const x = (word: string): number => header.indexOf(word)
  check(
    `${id}: columns sit at the spec widths (state→name 12 · name→ver 18 · ver→from 9)`,
    x('name') - x('state') === 12 && x('ver') - x('name') === 18 && x('from') - x('ver') === 9,
    `state@${x('state')} name@${x('name')} ver@${x('ver')} from@${x('from')}`,
  )
  const stateX = x('state')
  const aligned = lines.filter(l => l.search(/[●◑✕◐○◇◉]/) === stateX)
  check(`${id}: eight state glyphs open the state column`, aligned.length >= 8, `${aligned.length} aligned rows`)
}

const drives: Drive[] = []

for (const [cols, rows] of [
  [120, 40],
  [100, 30],
] as const) {
  const sz = `${cols}x${rows}`

  drives.push({
    id: `fresh-installed-${sz}`,
    cols,
    rows,
    freshHome: true,
    sends: [...openBoard],
    ready: 'no extensions yet',
    assert: text => {
      const id = `fresh-installed-${sz}`
      has(id, text, 'installed (0)')
      has(id, text, 'sources (0)')
      has(id, text, '○ no extensions yet')
      has(id, text, 'sources › a adds a git URL, a folder or an archive')
      has(id, text, 'docs/EXTENSIONS.md explains how to make one')
      has(id, text, cols >= 120 ? '0 extensions' : 'installed (0)')
      has(id, text, 'a source')
      has(id, text, 'esc close')
      hasNot(id, text, '↑↓ select', 'no rows to select')
      noRetiredWords(id, text)
    },
  })

  drives.push({
    id: `fresh-sources-${sz}`,
    cols,
    rows,
    freshHome: true,
    sends: [...openBoard, g('installed (0)', '\t')],
    ready: '○ no sources',
    assert: text => {
      const id = `fresh-sources-${sz}`
      has(id, text, '○ no sources')
      has(id, text, 'a adds a git URL, a folder or an archive')
      noRetiredWords(id, text)
    },
  })

  drives.push({
    id: `installed-seven-states-${sz}`,
    cols,
    rows,
    sends: [
      ...openBoard,
      g('installed (8)', DOWN),
      g('installed (8)', DOWN),
      g('installed (8)', ' '),
    ],
    ready: 'turned off · r reloads',
    assert: (text, lines) => {
      const id = `installed-seven-states-${sz}`
      has(id, text, 'installed (8)')
      has(id, text, 'sources (4)')
      has(id, text, '● on')
      has(id, text, '◑ partial')
      has(id, text, 'missing-bin-fx not on PATH')
      has(id, text, '✕ broken')
      has(id, text, 'changed since install')
      has(id, text, '◐ reload')
      has(id, text, 'turned off · r reloads')
      has(id, text, '○ off')
      has(id, text, 'not approved · i approves')
      has(id, text, '◇ found')
      has(id, text, cols >= 120 ? '.mercury/extensions · i i' : '.mercury/extensions · i installs')
      has(id, text, 'proposed · i fetches')
      has(id, text, '◉ blocked')
      has(id, text, 'b unblocks')
      has(id, text, '↑ 1.3.0 available')
      has(id, text, 'space on')
      has(id, text, 'x uninstall')
      has(id, text, 'r reload')
      installedColumnsAligned(id, lines)
      noRetiredWords(id, text)
    },
  })

  drives.push({
    id: `reload-settles-${sz}`,
    cols,
    rows,
    sends: [
      ...openBoard,
      g('installed (8)', DOWN),
      g('installed (8)', DOWN),
      g('installed (8)', ' '),
      g('turned off · r reloads', 'r'),
    ],
    ready: 'extensions: ',
    assert: text => {
      const id = `reload-settles-${sz}`
      hasNot(id, text, 'turned off · r reloads', 'the pending row settled')
      has(id, text, '○ off')
      check(`${id}: the reload counts line paints`, /extensions: \d+ on · \d+ partial · \d+ broken/.test(text))
      noRetiredWords(id, text)
    },
  })

  drives.push({
    id: `sources-four-states-${sz}`,
    cols,
    rows,
    sends: [...openBoard, g('installed (8)', '\t')],
    ready: '↻ stale',
    assert: (text, lines) => {
      const id = `sources-four-states-${sz}`
      has(id, text, '● ok')
      has(id, text, '↻ stale')
      has(id, text, '✕ unreach')
      has(id, text, '○ unchecked')
      has(id, text, 'host unreachable')
      has(id, text, 'team-tools')
      const header = lines.find(l => l.includes('source') && l.includes('kind') && l.includes('where'))
      check(`${id}: the sources column header paints`, header !== undefined)
      has(id, text, 'a add')
      has(id, text, 'u refresh')
      noRetiredWords(id, text)
    },
  })

  drives.push({
    id: `source-view-${sz}`,
    cols,
    rows,
    sends: [
      ...openBoard,
      g('installed (8)', '\t'),
      g('↻ stale', DOWN),
      g('↻ stale', DOWN),
      g('↻ stale', DOWN),
      g('↻ stale', '\r'),
      g('spare-tool', DOWN + DOWN + DOWN + DOWN + DOWN + DOWN),
    ],
    ready: 'spare-tool',
    assert: (text, lines) => {
      const id = `source-view-${sz}`
      has(id, text, '7 offered')
      has(id, text, 'review-tools')
      has(id, text, '1.3.0')
      has(id, text, 'a spare tool nobody installed yet')
      check(`${id}: the not-installed entry paints '—'`, lines.some(l => /—\s+spare-tool/.test(l)))
      has(id, text, 'esc back to sources')
      has(id, text, 'i install')
      hasNot(id, text, 'U update', 'the not-installed row has no update')
      noRetiredWords(id, text)
    },
  })

  drives.push({
    id: `extension-view-${sz}`,
    cols,
    rows,
    sends: [
      ...openBoard,
      g('installed (8)', DOWN),
      g('installed (8)', DOWN),
      g('installed (8)', DOWN),
      g('installed (8)', '\r'),
    ],
    ready: 'PostToolUse',
    assert: text => {
      const id = `extension-view-${sz}`
      has(id, text, 'review-tools 1.2.0')
      has(id, text, '● on')
      has(id, text, 'hooks')
      has(id, text, 'PostToolUse')
      has(id, text, '(30s)')
      has(id, text, 'node ✓')
      has(id, text, '↑ 1.3.0 available · U applies')
      has(id, text, 'esc back')
      has(id, text, 'space off')
      noRetiredWords(id, text)
    },
  })

  drives.push({
    id: `card-plain-${sz}`,
    cols,
    rows,
    sends: [
      ...openBoard,
      g('installed (8)', '\t'),
      g('↻ stale', DOWN),
      g('↻ stale', DOWN),
      g('↻ stale', DOWN),
      g('↻ stale', '\r'),
      g('spare-tool', DOWN),
      g('spare-tool', DOWN),
      g('spare-tool', DOWN),
      g('spare-tool', DOWN),
      g('spare-tool', DOWN),
      g('spare-tool', DOWN),
      g('spare-tool', 'i'),
    ],
    ready: 'nothing above runs until you approve',
    total: 520,
    assert: text => {
      const id = `card-plain-${sz}`
      const parsed = core.manifest.parseManifestValue(SPARE)
      check(`${id}: the fixture manifest parses`, parsed.ok)
      if (parsed.ok) {
        const expected = core.card.approvalCardLines({
          manifest: parsed.manifest,
          root: '/fixture-root',
          kind: 'install',
          from: { label: 'team-tools', where: SRC },
          optionSet: () => false,
        })
        const gridFlat = text.replace(/\s+/g, ' ')
        for (const line of expected.slice(1)) {
          if (line === '') continue
          if (line.startsWith('from ')) continue
          const flat = line.replace(/\s+/g, ' ').trim()
          check(`${id}: card line verbatim · '${flat.slice(0, 52)}'`, gridFlat.includes(flat))
        }
      }
      has(id, text, 'approve spare-tool 0.3.0')
      has(id, text, 'from')
      has(id, text, 'team-tools')
      has(id, text, 'runs on your machine')
      has(id, text, 'reaches the model')
      has(id, text, 'needs')
      has(id, text, 'SPARE_TOKEN ✕ unset')
      has(id, text, '↵ approve')
      has(id, text, 'p approve for this project only')
      has(id, text, 'k keep installed, off')
      has(id, text, 'esc back')
      noRetiredWords(id, text)
    },
  })

  drives.push({
    id: `card-diff-${sz}`,
    cols,
    rows,
    sends: [
      ...openBoard,
      g('installed (8)', DOWN),
      g('installed (8)', DOWN),
      g('installed (8)', DOWN),
      g('↑ 1.3.0 available', 'U'),
    ],
    ready: 'nothing above runs until you approve',
    total: 520,
    assert: text => {
      const id = `card-diff-${sz}`
      has(id, text, 'approve review-tools 1.2.0 → 1.3.0')
      has(id, text, 'changes')
      has(id, text, '+1 runs')
      has(id, text, '+ hook')
      has(id, text, 'Stop')
      has(id, text, '(60s)')
      has(id, text, '↵ approve')
      has(id, text, 'k keep 1.2.0 (removes the fetched 1.3.0)')
      has(id, text, 'esc back (same as k)')
      hasNot(id, text, 'p approve for this project only', 'an update carries the existing switch')
      noRetiredWords(id, text)
    },
  })

  drives.push({
    id: `uninstall-confirm-${sz}`,
    cols,
    rows,
    sends: [
      ...openBoard,
      g('installed (8)', DOWN),
      g('installed (8)', DOWN),
      g('installed (8)', DOWN),
      g('installed (8)', 'x'),
    ],
    ready: 'uninstall review-tools',
    assert: text => {
      const id = `uninstall-confirm-${sz}`
      has(id, text, 'uninstall review-tools 1.2.0 (team-tools)')
      has(id, text, 'esc cancel')
      check(
        `${id}: offers ↵ (no data folder) or the y/k data pair`,
        text.includes('↵ uninstall') || (text.includes('y delete data') && text.includes('k keep data')),
      )
      noRetiredWords(id, text)
    },
  })

  drives.push({
    id: `remove-source-confirm-${sz}`,
    cols,
    rows,
    sends: [...openBoard, g('installed (8)', '\t'), g('↻ stale', DOWN), g('↻ stale', DOWN), g('↻ stale', DOWN), g('↻ stale', 'x')],
    ready: 'remove team-tools?',
    assert: text => {
      const id = `remove-source-confirm-${sz}`
      has(id, text, 'remove team-tools?')
      has(id, text, 'installed from it')
      has(id, text, '↵ remove the source only')
      has(id, text, 'y also uninstall them')
      has(id, text, 'esc cancel')
      noRetiredWords(id, text)
    },
  })

  drives.push({
    id: `fetch-confirm-${sz}`,
    cols,
    rows,
    sends: [
      ...openBoard,
      g('installed (8)', DOWN + DOWN + DOWN + DOWN + DOWN + DOWN),
      g('installed (8)', 'i'),
    ],
    ready: 'fetch wanted-tool',
    assert: text => {
      const id = `fetch-confirm-${sz}`
      has(id, text, 'fetch wanted-tool from https://git.example.org/eve/wanted-tool.git to inspect?')
      has(id, text, '↵ fetch')
      has(id, text, 'esc not now')
      noRetiredWords(id, text)
    },
  })

  drives.push({
    id: `esc-cascade-${sz}`,
    cols,
    rows,
    sends: [
      ...openBoard,
      g('installed (8)', DOWN),
      g('installed (8)', DOWN),
      g('installed (8)', DOWN),
      g('installed (8)', '\r'),
      g('PostToolUse', ESC),
      g('installed (8)', ESC),
    ],
    ready: '❯',
    assert: text => {
      const id = `esc-cascade-${sz}`
      hasNot(id, text, 'installed (8)', 'the board closed back to the REPL')
      check(`${id}: the composer is home`, text.includes('❯'))
    },
  })
}

for (const anchor of ['installed-seven-states', 'card-plain'] as const) {
  const base = drives.find(d => d.id === `${anchor}-120x40`)!
  drives.push({ ...base, id: `${anchor}-120x40-light`, theme: 'light' })
}

drives.push({
  id: 'rebind-single-120x40',
  cols: 120,
  rows: 40,
  prepare: home =>
    writeFileSync(
      join(home, 'keybindings.json'),
      JSON.stringify({ bindings: [{ context: 'Extensions', bindings: { t: 'extensions:toggle' } }] }),
    ),
  sends: [...openBoard, g('installed (8)', DOWN), g('installed (8)', DOWN), g('installed (8)', 't')],
  ready: 'turned off · r reloads',
  assert: text => {
    const id = 'rebind-single-120x40'
    has(id, text, '◐ reload')
    has(id, text, 'turned off · r reloads')
    has(id, text, 't on')
  },
})

drives.push({
  id: 'rebind-chord-declined-120x40',
  cols: 120,
  rows: 40,
  prepare: home =>
    writeFileSync(
      join(home, 'keybindings.json'),
      JSON.stringify({ bindings: [{ context: 'Extensions', bindings: { 'ctrl+x t': 'extensions:toggle' } }] }),
    ),
  sends: [
    ...openBoard,
    g('installed (8)', DOWN),
    g('installed (8)', DOWN),
    g('installed (8)', ' '),
  ],
  ready: 'single keys',
  assert: text => {
    const id = 'rebind-chord-declined-120x40'
    has(id, text, "extensions:toggle is bound to 'ctrl+x t'")
    has(id, text, 'single keys')
    has(id, text, 'keybindings.json')
    hasNot(id, text, '◐ reload', 'the declined action never fires on its default')
    hasNot(id, text, 'space off', 'a declined action is never advertised')
  },
})

console.log('============================================================')
console.log(' the /extensions surface — render-verified (prover 8)')
console.log('============================================================')
console.log(`scratch: ${SCRATCH}`)

await seedTemplate()

{
  const roster = await import('../../src/extensions/roster.ts')
  const { entries } = roster.computeRoster({ cwd: CWD })
  const states = new Set(entries.map(e => roster.trustStateOf(e)))
  check(
    'seed: the template roster carries on · off · found · blocked',
    states.has('on') && states.has('off') && states.has('found') && states.has('blocked'),
    [...states].join(','),
  )
  check('seed: seven entries in-process (the proposal joins in the drives)', entries.length === 7, String(entries.length))
}

const only = process.env.MERCURY_EXTUI_ONLY ?? ''
const selected = only ? drives.filter(d => d.id.includes(only)) : drives
if (only) console.log(`\n(partial matrix: ${selected.length}/${drives.length} drives match '${only}' — NOT a proof)`)
await runAll(selected, 3)

console.log('\n── the keybinding context (05 §2.3)')
{
  const { KEYBINDING_CONTEXTS } = await import('../../src/keybindings/schema.ts')
  const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
  check('the Extensions context is declared', (KEYBINDING_CONTEXTS as readonly string[]).includes('Extensions'))
  const block = (DEFAULT_BINDINGS as Array<{ context: string; bindings: Record<string, string> }>).find(b => b.context === 'Extensions')
  check('the Extensions default block exists', block !== undefined)
  if (block) {
    const wanted: Record<string, string> = {
      space: 'extensions:toggle',
      i: 'extensions:install',
      U: 'extensions:update',
      x: 'extensions:remove',
      b: 'extensions:block',
      o: 'extensions:options',
      a: 'extensions:add-source',
      u: 'extensions:refresh',
      r: 'extensions:reload',
      f: 'extensions:filter',
      P: 'extensions:previous',
    }
    for (const [chord, action] of Object.entries(wanted)) {
      check(`default '${chord}' → ${action}`, block.bindings[chord] === action)
    }
    const { resolveExtensionsBindings } = await import('../../src/components/extensions/bindings.ts')
    const resolved = resolveExtensionsBindings()
    for (const [chord, action] of Object.entries(wanted)) {
      const expected = chord === 'space' ? ' ' : chord
      check(`the resolver's default for ${action} is '${chord}'`, resolved.chars.get(action) === expected)
    }
    for (const [file, needle] of [
      ['src/components/extensions/ExtensionsBoard.tsx', 'resolveExtensionsBindings'],
      ['src/components/extensions/SourceView.tsx', 'resolveExtensionsBindings'],
      ['src/components/extensions/ExtensionView.tsx', 'resolveExtensionsBindings'],
    ] as const) {
      check(`${file.split('/').pop()} consumes the resolver`, readFileSync(join(REPO, file), 'utf8').includes(needle))
    }

    const { resolveExtensionsBindings: resolveKb } = await import('../../src/components/extensions/bindings.ts')
    const kbFile = join(TEMPLATE, 'keybindings.json')
    const withBindings = (bindings: Record<string, string | null>): ReturnType<typeof resolveKb> => {
      writeFileSync(kbFile, JSON.stringify({ bindings: [{ context: 'Extensions', bindings }] }))
      try {
        return resolveKb()
      } finally {
        rmSync(kbFile, { force: true })
      }
    }
    const upper = withBindings({ U: 'extensions:update' })
    check("a stored bare 'U' arms update on 'U' (case kept)", upper.chars.get('extensions:update') === 'U')
    check(
      "a stored bare 'U' leaves refresh on 'u' — no collision, nothing declined",
      upper.chars.get('extensions:refresh') === 'u' && upper.declined.length === 0,
      upper.declined.join(' | '),
    )
    const shifted = withBindings({ 'shift+u': 'extensions:update' })
    check("'shift+u' spells the same 'U'", shifted.chars.get('extensions:update') === 'U' && shifted.declined.length === 0)
    const lower = withBindings({ u: 'extensions:update' })
    check(
      "a stored bare 'u' displaces refresh loudly",
      lower.chars.get('extensions:update') === 'u' && !lower.chars.has('extensions:refresh') && lower.declined.some(l => l.startsWith('extensions:refresh lost')),
      lower.declined.join(' | '),
    )
    const unbound = withBindings({ u: null })
    check(
      "an unbind of 'u' takes refresh alone (update keeps 'U')",
      !unbound.chars.has('extensions:refresh') && unbound.chars.get('extensions:update') === 'U' && unbound.declined.length === 1,
      unbound.declined.join(' | '),
    )
  }
}

console.log('\n── the vocabulary law (07 §2 row 8)')
{
  const globby = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) globby(p, out)
      else if (/\.(ts|tsx|md)$/.test(name)) out.push(p)
    }
    return out
  }
  const files = [
    ...globby(join(REPO, 'src/components/extensions')),
    ...globby(join(REPO, 'src/commands/extensions')),
    ...globby(join(REPO, 'src/extensions')),
    join(REPO, 'docs/EXTENSIONS.md'),
  ].filter(p => existsSync(p))
  let dirty = 0
  for (const file of files) {
    const low = readFileSync(file, 'utf8').toLowerCase()
    if (low.includes(P_WORD) || low.includes(M_WORD)) {
      dirty++
      console.log(`    retired word in ${file}`)
    }
  }
  check('no retired vocabulary in the surface estate + core + maker doc', dirty === 0, `${files.length} files swept`)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅ EXTENSIONS SURFACE — GREEN' : `❌ ${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
