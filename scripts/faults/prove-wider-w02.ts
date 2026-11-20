#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runSubprocess(
  body: string,
  opts?: { allowNonZero?: boolean },
): { status: number | null; stdout: string; stderr: string; out: Record<string, unknown> } {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-wider-w02-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n__OUT__' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
    })
    if (!opts?.allowNonZero && res.status !== 0) {
      throw new Error(`scenario exited ${res.status}: ${res.stderr.slice(-1200)}`)
    }
    const marker = res.stdout.lastIndexOf('__OUT__')
    const out = marker >= 0 ? (JSON.parse(res.stdout.slice(marker + 7).trim()) as Record<string, unknown>) : {}
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, out }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\nw02-1 — Concourse snapshot reports unreadable parked, queued, and ready-to-review sources')
{
  const r = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const snap = await import(${JSON.stringify(join(SRC, 'services/concourse/concourseSnapshot.ts'))})
    const paths = await import(${JSON.stringify(join(SRC, 'utils/sessionStorage/paths.ts'))})
    const dispatches = await import(${JSON.stringify(join(SRC, 'daemon/concourseDispatch.ts'))})
    const collisions = await import(${JSON.stringify(join(SRC, 'daemon/concourseWorkers/collisions.ts'))})

    const recordsDir = path.join(HOME, 'daemon')
    const crewDir = path.join(HOME, 'crew')
    const draftDir = path.join(HOME, 'drafts')
    fs.mkdirSync(recordsDir, { recursive: true })
    fs.mkdirSync(crewDir, { recursive: true })
    fs.mkdirSync(draftDir, { recursive: true })

    const clean = await snap.buildConcourseSnapshot({ recordsDir, crewDir, draftDir, nowMs: 1_700_000_000_000 })
    out.cleanNotices = clean.sectionNotices ?? null

    fs.writeFileSync(dispatches.concourseDispatchesPath(recordsDir), '{not json')
    fs.writeFileSync(collisions.concourseCollisionsPath(recordsDir), '{not json')
    const storeDir = paths.getProjectDir(PROJECT)
    fs.mkdirSync(storeDir, { recursive: true })
    const canChmod = ${JSON.stringify(POSIX_MODES)}
    if (canChmod) fs.chmodSync(storeDir, 0o000)
    try {
      const broken = await snap.buildConcourseSnapshot({ recordsDir, crewDir, draftDir, nowMs: 1_700_000_000_000 })
      out.brokenNotices = broken.sectionNotices ?? null
      const { listPaneOf } = await import(${JSON.stringify(join(SRC, 'components/concourse/layout/listPane.tsx'))})
      const { resolveMercuryTokens } = await import(${JSON.stringify(join(SRC, 'utils/mercuryTokens.ts'))})
      const { getTheme } = await import(${JSON.stringify(join(SRC, 'utils/theme.ts'))})
      const node = listPaneOf({
        wide: true,
        rightWidth: 100,
        listRows: 24,
        geo: { constrained: false, peekRows: 0, railWindowRows: 0 },
        managerFocused: true,
        t: resolveMercuryTokens(getTheme('dark'), 'dark'),
        filtering: false,
        filterText: '',
        filterCaret: 0,
        interior: 96,
        sessionRows: [],
        win: { start: 0, end: 0, above: 0, below: 0 },
        boardSelectedId: null,
        region: 'list',
        wiring: { selectSession: () => {}, enterSession: () => {}, selectObligation: () => {}, answerObligation: () => {}, openObligation: () => {} },
        newSessionNote: undefined,
        colProject: 14,
        colAge: 5,
        nowWidth: 20,
        door: undefined,
        lineShown: false,
        lineSelected: false,
        boardGroups: [],
        showHeadings: true,
        groupRole: () => 'white',
        askBySession: new Map(),
        stateCellShown: false,
        markedIds: undefined,
        rowPeekNode: undefined,
        snapshot: broken,
        railIndex: 0,
        listInner: 96,
      })
      const texts = []
      const walk = el => {
        if (el == null) return
        if (typeof el === 'string') { texts.push(el); return }
        if (Array.isArray(el)) { el.forEach(walk); return }
        if (typeof el === 'object' && el.props && 'children' in el.props) walk(el.props.children)
      }
      walk(node)
      out.renderedText = texts.join('\\n')
    } finally {
      if (canChmod) fs.chmodSync(storeDir, 0o755)
    }
  `)
  check('clean snapshot omits sectionNotices on ENOENT', r.out.cleanNotices === null, JSON.stringify(r.out.cleanNotices))
  const notices = Array.isArray(r.out.brokenNotices) ? (r.out.brokenNotices as string[]) : []
  const rendered = String(r.out.renderedText ?? '')
  check(
    'queued dispatches read failure emits notice',
    notices.some(n => n.startsWith('Queued sessions could not be read (') && n.includes('waiting work may be hidden; refresh to retry.')),
    JSON.stringify(notices),
  )
  check(
    'ready-to-review collisions read failure emits notice',
    notices.some(n => n.startsWith('Ready-to-review forks could not be read (') && n.includes('finished work may be hidden; refresh to retry.')),
    JSON.stringify(notices),
  )
  if (!POSIX_MODES) skip('parked sessions unreadable dir notice', 'chmod 0000 needs non-root POSIX')
  else {
    check(
      'parked sessions unreadable dir emits notice',
      notices.some(n => n.startsWith('Parked sessions could not be read (') && n.includes('refresh or check transcript folder permissions.')),
      JSON.stringify(notices),
    )
  }
  check(
    'listPaneOf renders sectionNotices text',
    rendered.includes('Queued sessions could not be read (') && rendered.includes('Ready-to-review forks could not be read ('),
    rendered.slice(0, 200),
  )
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
