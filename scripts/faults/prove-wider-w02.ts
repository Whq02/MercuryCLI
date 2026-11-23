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
    const snap = await import(${JSON.stringify(join(SRC, 'screen/concourse-model/concourseSnapshot.ts'))})
    const paths = await import(${JSON.stringify(join(SRC, 'sessions/transcripts/paths.ts'))})
    const dispatches = await import(${JSON.stringify(join(SRC, 'daemon/concourse-workers/concourseDispatch.ts'))})
    const collisions = await import(${JSON.stringify(join(SRC, 'daemon/concourse-workers/collisions.ts'))})

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
      const { listPaneOf } = await import(${JSON.stringify(join(SRC, 'screen/concourse/layout/listPane.tsx'))})
      const { resolveMercuryTokens } = await import(${JSON.stringify(join(SRC, 'screen/theme/mercuryTokens.ts'))})
      const { getTheme } = await import(${JSON.stringify(join(SRC, 'screen/theme/theme.ts'))})
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

      const React = await import('react')
      const { ThemeProvider } = await import(${JSON.stringify(join(SRC, 'screen/theme/ThemeProvider.tsx'))})
      const { switchboardGeometry } = await import(${JSON.stringify(join(SRC, 'screen/concourse/ConcourseLayout.tsx'))})
      const { mountOffscreen, waitFor } = await import(${JSON.stringify(join(HERE, '../lib/settingsPopupHarness.ts'))})
      const geo120 = switchboardGeometry(120, 36, 0, 0, 0, 1)
      const rightWidth = geo120.rightCols[1] - geo120.rightCols[0] + 1
      const listRows = geo120.listBand[1] - geo120.listBand[0] + 1
      const pane120 = listPaneOf({
        wide: true,
        rightWidth,
        listRows,
        geo: geo120,
        managerFocused: true,
        t: resolveMercuryTokens('dark', '#DD4444'),
        filtering: false,
        filterText: '',
        filterCaret: 0,
        interior: geo120.interior,
        sessionRows: [],
        win: { start: 0, end: 0, above: 0, below: 0 },
        boardSelectedId: null,
        region: 'list',
        wiring: { selectSession: () => {}, enterSession: () => {}, selectObligation: () => {}, answerObligation: () => {}, openObligation: () => {} },
        newSessionNote: undefined,
        colProject: 10,
        colAge: 5,
        nowWidth: 12,
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
        snapshot: { ...broken, sectionNotices: (broken.sectionNotices ?? []).filter(n => n.startsWith('Parked sessions')) },
        railIndex: 0,
        listInner: Math.max(8, rightWidth - 4),
      })
      const mounted = await mountOffscreen(React.createElement(ThemeProvider, { initialState: 'dark' }, pane120), 120, 36)
      await waitFor(() => mounted.screen().includes('Parked sessions'), 1500)
      out.pane120 = mounted.screen()
      out.pane120RightWidth = rightWidth
      mounted.unmount()
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
      'parked sessions unreadable dir emits notice with advice before error',
      notices.some(n => n.startsWith('Parked sessions could not be read — refresh or check transcript folder permissions (') && n.endsWith(').')),
      JSON.stringify(notices),
    )
    const pane120 = String(r.out.pane120 ?? '')
    const paneJoined = pane120
      .split('\n')
      .map(line => line.replace(/[┃┏┓┗┛━│╭╮╰╯─]/g, '').trim())
      .filter(Boolean)
      .join(' ')
    check(
      'concourse right pane at 120x36 paints parked-sessions advice and error without cutting them off',
      paneJoined.includes('Parked sessions could not be read — refresh or check transcript folder permissions') && paneJoined.includes('EACCES'),
      `rightWidth=${String(r.out.pane120RightWidth)} pane=${paneJoined.slice(0, 300)}`,
    )
  }
  check(
    'listPaneOf renders sectionNotices text',
    rendered.includes('Queued sessions could not be read (') && rendered.includes('Ready-to-review forks could not be read ('),
    rendered.slice(0, 200),
  )
}

console.log('\nw02-2 — olderChatsCensus reports unreadable transcript folder alongside zero total')
{
  const r = runSubprocess(`
    const fs = await import('node:fs')
    const snap = await import(${JSON.stringify(join(SRC, 'screen/concourse-model/concourseSnapshot.ts'))})
    const paths = await import(${JSON.stringify(join(SRC, 'sessions/transcripts/paths.ts'))})

    const missing = snap.olderChatsCensus(PROJECT, new Set(), 1_700_000_000_000)
    out.missingTotal = missing.total
    out.missingErr = missing.readError ?? null

    const storeDir = paths.getProjectDir(PROJECT)
    fs.mkdirSync(storeDir, { recursive: true })
    const canChmod = ${JSON.stringify(POSIX_MODES)}
    if (canChmod) fs.chmodSync(storeDir, 0o000)
    try {
      const unread = snap.olderChatsCensus(PROJECT, new Set(), 1_700_000_000_000)
      out.unreadTotal = unread.total
      out.unreadEntries = unread.entries.length
      out.unreadErr = unread.readError ?? null
    } finally {
      if (canChmod) fs.chmodSync(storeDir, 0o755)
    }
  `)
  check('olderChatsCensus absent dir returns 0 and no readError', r.out.missingTotal === 0 && r.out.missingErr === null, JSON.stringify(r.out))
  if (!POSIX_MODES) skip('olderChatsCensus unreadable dir', 'chmod 0000 needs non-root POSIX')
  else {
    check(
      'olderChatsCensus unreadable dir keeps 0 total/entries and sets readError',
      r.out.unreadTotal === 0 && r.out.unreadEntries === 0 && typeof r.out.unreadErr === 'string' && (r.out.unreadErr as string).length > 0,
      JSON.stringify(r.out),
    )
  }
}

console.log('\nw02-3 — unreadable .git stat surfaces git-check error note without refusing birth')
if (!POSIX_MODES) skip('workspaceKindOf EACCES', 'chmod 0644 needs non-root POSIX')
else {
  const r = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const wt = await import(${JSON.stringify(join(SRC, 'daemon/concourse-workers/concourseWorktrees.ts'))})
    const adm = await import(${JSON.stringify(join(SRC, 'daemon/concourse-workers/admission.ts'))})
    const warm = await import(${JSON.stringify(join(SRC, 'daemon/concourse-workers/admitWarm.ts'))})

    const plainDir = path.join(PROJECT, 'plain-dir')
    const gitDir = path.join(PROJECT, 'git-dir')
    const lockedDir = path.join(PROJECT, 'locked-git-dir')
    fs.mkdirSync(plainDir, { recursive: true })
    fs.mkdirSync(path.join(gitDir, '.git'), { recursive: true })
    fs.mkdirSync(path.join(lockedDir, '.git'), { recursive: true })

    out.hasInspect = typeof wt.inspectWorkspaceKind === 'function'
    if (out.hasInspect) {
      out.plain = wt.inspectWorkspaceKind(plainDir)
      out.git = wt.inspectWorkspaceKind(gitDir)
    }

    fs.chmodSync(lockedDir, 0o644)
    try {
      out.lockedKind = wt.workspaceKindOf(lockedDir)
      if (out.hasInspect) out.lockedInspect = wt.inspectWorkspaceKind(lockedDir)
      out.collisionRes = adm.resolveDefaultedAdmission(
        [{ workspaceId: lockedDir, isolation: 'exclusive' }],
        { workspaceId: lockedDir },
        4,
      )
      const daemonDir = path.join(HOME, 'daemon-w02-3')
      fs.mkdirSync(daemonDir, { recursive: true })
      const warmRes = warm.warmSeatAnswer({
        req: { workspaceDir: lockedDir, by: 'operator' },
        deps: { dir: daemonDir, roster: () => null },
        records: {},
        workspaceId: lockedDir,
        effectiveIsolation: 'exclusive',
        kind: 'oculus',
        modelKey: 'test-model',
        modelDisplayName: 'Test',
        keyless: false,
        kit: { schema: 1, workspaceId: lockedDir, mcp: { disabled: [], enabled: [] } },
        preset: undefined,
        retainedNote: undefined,
        carryBuildNotices: () => {},
        runnerId: 'w-1',
        claimSessionId: 's-w02-3',
        claimEffort: 'high',
        claimPosture: 'default',
        snapshot: { profileRevision: 0, entries: [] },
        pidFields: {},
        claimed: { claimed: true, short: 'w-1', pid: process.pid, spec: {} },
      })
      out.warmOk = warmRes.ok
      out.warmNote = warmRes.ok ? (warmRes.note ?? null) : null
    } finally {
      fs.chmodSync(lockedDir, 0o755)
    }
  `)
  const lockedInspect = r.out.lockedInspect as { kind?: string; gitCheckError?: string } | undefined
  const plain = r.out.plain as { kind?: string; gitCheckError?: string } | undefined
  const git = r.out.git as { kind?: string; gitCheckError?: string } | undefined
  check(
    'inspectWorkspaceKind distinguishes git, plain-folder (ENOENT), and EACCES',
    r.out.hasInspect === true &&
      git?.kind === 'git' &&
      plain?.kind === 'plain-folder' &&
      plain.gitCheckError === undefined &&
      lockedInspect?.kind === 'plain-folder' &&
      typeof lockedInspect.gitCheckError === 'string' &&
      lockedInspect.gitCheckError.length > 0,
    JSON.stringify({ plain, git, lockedInspect }),
  )
  const col = r.out.collisionRes as { kind?: string; decision?: { reason?: string }; gitCheckError?: string } | undefined
  check(
    'resolveDefaultedAdmission does not offer fake git-init when .git stat fails with EACCES',
    col?.kind === 'decision' &&
      typeof col.decision?.reason === 'string' &&
      col.decision.reason.includes('could not be checked for git (') &&
      col.decision.reason.includes('so this session works in the folder itself, not in a worktree'),
    JSON.stringify(col),
  )
  check(
    'warmSeatAnswer births session (ok:true) and attaches git-check note on EACCES',
    r.out.warmOk === true &&
      typeof r.out.warmNote === 'string' &&
      (r.out.warmNote as string).includes('could not be checked for git (') &&
      (r.out.warmNote as string).includes('so this session works in the folder itself, not in a worktree'),
    JSON.stringify({ warmOk: r.out.warmOk, warmNote: r.out.warmNote }),
  )
}

console.log('\nw02-4 — BootSettingsScreen applyOverrideRows reports read error instead of no established sessions')
{
  const r = runSubprocess(`
    const { settingsMenuModel } = await import(${JSON.stringify(join(SRC, 'screen/boot-face/settings/menuModel.ts'))})
    const baseArgs = {
      backgroundLaunchOn: false,
      changed: 0,
      chatBoot: false,
      concourseLive: false,
      dirTail: '',
      effectiveByEnv: new Map(),
      isBackgroundLaunchRow: () => false,
      isJevRow: () => false,
      isMotionRow: () => false,
      isSeatsRow: () => false,
      jevDetailLines: [],
      jevSettings: { enabled: false },
      lastReceipt: null,
      list: { selectedIndex: 0, note: null },
      liveCount: 0,
      mainModel: 'test-model',
      menuRows: [],
      motionSetting: 'auto',
      plainWorld: false,
      profile: null,
      saved: {},
      seatFacts: null,
      wordGlow: 0,
    }
    const emptyModel = settingsMenuModel({ ...baseArgs, apply: { phase: 'ready', workers: [] } })
    const errModel = settingsMenuModel({ ...baseArgs, apply: { phase: 'ready', workers: [], error: 'EACCES: permission denied' } })
    out.emptyLines = emptyModel.detailOverride ?? null
    out.errLines = errModel.detailOverride ?? null
  `)
  const emptyLines = Array.isArray(r.out.emptyLines) ? (r.out.emptyLines as string[]) : []
  const errLines = Array.isArray(r.out.errLines) ? (r.out.errLines as string[]) : []
  check(
    'empty workers without error still says no established sessions',
    emptyLines.some(l => l.includes('no established sessions')),
    JSON.stringify(emptyLines),
  )
  check(
    'ApplyState with read error shows established sessions could not be read (<error>) instead of no established sessions',
    errLines.some(l => l === 'established sessions could not be read (EACCES: permission denied)') &&
      !errLines.some(l => l.includes('no established sessions')),
    JSON.stringify(errLines),
  )
}

console.log('\nw02-5 — unreadable/corrupt boot-env.json surfaces could not be read in strict reads, BootSettings, /caching, and Concourse')
{
  const r = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const sm = await import(${JSON.stringify(join(SRC, 'platform/substrate/startupMenu.ts'))})
    const { settingsMenuModel } = await import(${JSON.stringify(join(SRC, 'screen/boot-face/settings/menuModel.ts'))})
    const snap = await import(${JSON.stringify(join(SRC, 'screen/concourse-model/concourseSnapshot.ts'))})
    const { renderToString } = await import(${JSON.stringify(join(SRC, 'screen/renderer/staticRender.tsx'))})
    const caching = await import(${JSON.stringify(join(SRC, 'commands/caching/caching.tsx'))})
    const { ThemeProvider } = await import(${JSON.stringify(join(SRC, 'screen/theme/ThemeProvider.tsx'))})
    const React = await import('react')

    const bootPath = sm.bootEnvPath()
    fs.mkdirSync(path.dirname(bootPath), { recursive: true })
    out.hasStrictProfile = typeof sm.readBootDefaultsProfileStrict === 'function'
    out.hasStrictEnv = typeof sm.readBootEnvChoicesStrict === 'function'
    if (out.hasStrictProfile) out.absentProfile = sm.readBootDefaultsProfileStrict(bootPath)
    if (out.hasStrictEnv) out.absentEnv = sm.readBootEnvChoicesStrict(bootPath)

    const corrupt = '{not valid json'
    fs.writeFileSync(bootPath, corrupt, 'utf8')
    if (out.hasStrictProfile) out.corruptProfile = sm.readBootDefaultsProfileStrict(bootPath)
    if (out.hasStrictEnv) out.corruptEnv = sm.readBootEnvChoicesStrict(bootPath)
    out.writeRefused = sm.writeBootEnvChoice('MERCURY_CACHE_TTL', '1h', bootPath)
    out.saveRefused = sm.saveBootDefaultsProfile({ MERCURY_CACHE_TTL: '1h' }, bootPath)
    out.preserved = fs.readFileSync(bootPath, 'utf8') === corrupt

    const menuM = settingsMenuModel({
      apply: { phase: 'closed' },
      backgroundLaunchOn: false,
      changed: 0,
      chatBoot: false,
      concourseLive: false,
      dirTail: '',
      effectiveByEnv: new Map(),
      isBackgroundLaunchRow: () => false,
      isJevRow: () => false,
      isMotionRow: () => false,
      isSeatsRow: () => false,
      jevDetailLines: [],
      jevSettings: { enabled: false },
      lastReceipt: null,
      list: { selectedIndex: 0, note: null },
      liveCount: 0,
      mainModel: 'test-model',
      menuRows: [],
      motionSetting: 'auto',
      plainWorld: false,
      profile: null,
      profileReadError: 'Unexpected token n',
      saved: {},
      seatFacts: null,
      wordGlow: 0,
    })
    out.menuProfile = menuM.summary.profile
    out.menuStatus = menuM.statusRight

    const recordsDir = path.join(HOME, 'daemon-w02-5')
    const crewDir = path.join(HOME, 'crew-w02-5')
    const draftDir = path.join(HOME, 'draft-w02-5')
    fs.mkdirSync(recordsDir, { recursive: true })
    fs.mkdirSync(crewDir, { recursive: true })
    fs.mkdirSync(draftDir, { recursive: true })
    fs.writeFileSync(
      path.join(recordsDir, 'concourse-workers.json'),
      JSON.stringify({
        version: 1,
        workers: {
          'w-1': {
            schema: 1,
            runnerId: 'w-1',
            sessionId: 's-w02-5',
            workspaceId: PROJECT,
            isolation: 'exclusive',
            modelKey: 'fable',
            spawnedAt: 1_700_000_000_000,
            lastLiveAt: 1_700_000_000_000,
            attachedAt: 1_700_000_000_000,
            settingsSnapshot: { profileRevision: 2, rows: [] },
          },
        },
      }),
    )
    const csnap = await snap.buildConcourseSnapshot({ recordsDir, crewDir, draftDir, peekSessionId: 's-w02-5', nowMs: 1_700_000_000_000 })
    out.concourseNotices = csnap.sectionNotices ?? null
    out.peekSettings = csnap.peek?.settings ?? null

    const el = await caching.call(() => {}, {})
    out.cachingText = await renderToString(React.createElement(ThemeProvider, null, el), 100)
  `)
  const absentProfile = r.out.absentProfile as { ok?: boolean; profile?: unknown } | undefined
  const corruptProfile = r.out.corruptProfile as { ok?: boolean; reason?: string } | undefined
  const corruptEnv = r.out.corruptEnv as { ok?: boolean; reason?: string } | undefined
  const writeRefused = r.out.writeRefused as { ok?: boolean; reason?: string } | undefined
  const saveRefused = r.out.saveRefused as { ok?: boolean; reason?: string } | undefined
  check(
    'strict boot-env readers exported and distinguish absent from corrupt',
    r.out.hasStrictProfile === true &&
      r.out.hasStrictEnv === true &&
      absentProfile?.ok === true &&
      absentProfile.profile === null &&
      corruptProfile?.ok === false &&
      corruptEnv?.ok === false,
    JSON.stringify({ absentProfile, corruptProfile, corruptEnv }),
  )
  check(
    'writeBootEnvChoice and saveBootDefaultsProfile refuse corrupt file with could not be read and preserve bytes',
    writeRefused?.ok === false &&
      typeof writeRefused.reason === 'string' &&
      writeRefused.reason.includes('could not be read (') &&
      saveRefused?.ok === false &&
      typeof saveRefused.reason === 'string' &&
      saveRefused.reason.includes('could not be read (') &&
      r.out.preserved === true,
    JSON.stringify({ writeRefused, saveRefused, preserved: r.out.preserved }),
  )
  check(
    'BootSettings menuModel shows could not be read (<error>) instead of default when profileReadError is set',
    r.out.menuProfile === 'could not be read (Unexpected token n)' &&
      r.out.menuStatus === 'could not be read (Unexpected token n)',
    JSON.stringify({ menuProfile: r.out.menuProfile, menuStatus: r.out.menuStatus }),
  )
  const concourseNotices = Array.isArray(r.out.concourseNotices) ? (r.out.concourseNotices as string[]) : []
  check(
    'Concourse snapshot surfaces boot-env read failure in sectionNotices and omits false peek.settings',
    concourseNotices.some(n => n.includes('could not be read (')) && r.out.peekSettings === null,
    JSON.stringify({ concourseNotices, peekSettings: r.out.peekSettings }),
  )
  const cachingText = String(r.out.cachingText ?? '')
  check(
    '/caching shows could not be read (<error>) when boot-env.json is corrupt',
    cachingText.includes('could not be read ('),
    cachingText.slice(0, 300),
  )
}

console.log('\nw02-6 — unreadable workspace config carries deltasReadError on derived/materialized kit and surfaces note without refusing')
{
  const cleanRun = runSubprocess(`
    delete process.env.NODE_ENV
    const cfg = await import(${JSON.stringify(join(SRC, 'platform/settings/config.ts'))})
    const sk = await import(${JSON.stringify(join(SRC, 'daemon/session-seat/sessionKit.ts'))})
    cfg.enableConfigs()
    out.cleanDerivedErr = sk.deriveSessionKitForWorkspace(PROJECT).deltasReadError ?? null
    out.cleanMatErr = sk.materializedKitForWorkspace(PROJECT).deltasReadError ?? null
  `)
  if (!POSIX_MODES) skip('unreadable .mercury.json kit deltas', 'chmod 0000 needs non-root POSIX')
  else {
    const brokenRun = runSubprocess(`
      const fs = await import('node:fs')
      const path = await import('node:path')
      delete process.env.NODE_ENV
      const cfgPath = path.join(HOME, '.mercury.json')
      fs.writeFileSync(cfgPath, '{}', 'utf8')
      const cfg = await import(${JSON.stringify(join(SRC, 'platform/settings/config.ts'))})
      const sk = await import(${JSON.stringify(join(SRC, 'daemon/session-seat/sessionKit.ts'))})
      const skOp = await import(${JSON.stringify(join(SRC, 'daemon/session-seat/sessionKitOp.ts'))})
      fs.chmodSync(cfgPath, 0o000)
      try {
        try { cfg.enableConfigs() } catch {}
        const brokenDerived = sk.deriveSessionKitForWorkspace(PROJECT)
        const brokenMat = sk.materializedKitForWorkspace(PROJECT)
        out.brokenDerivedErr = brokenDerived.deltasReadError ?? null
        out.brokenMatErr = brokenMat.deltasReadError ?? null

        const daemonDir = path.join(HOME, 'daemon-w02-6')
        fs.mkdirSync(daemonDir, { recursive: true })
        fs.writeFileSync(
          path.join(daemonDir, 'concourse-workers.json'),
          JSON.stringify({
            version: 1,
            workers: {
              'w-1': {
                schema: 1,
                runnerId: 'w-1',
                sessionId: 's-w02-6',
                workspaceId: PROJECT,
                isolation: 'exclusive',
                modelKey: 'fable',
                spawnedAt: 1_700_000_000_000,
                lastLiveAt: 1_700_000_000_000,
              },
            },
          }),
        )
        const opRes = skOp.applyConcourseKitOp('s-w02-6', { mcp: [{ name: 'demo', on: false }] }, 'operator', daemonDir)
        out.opOutcome = opRes.outcome
        out.opDetail = opRes.detail ?? null
      } finally {
        fs.chmodSync(cfgPath, 0o644)
      }
    `)
    check(
      'unreadable config sets deltasReadError on deriveSessionKitForWorkspace without throwing',
      typeof brokenRun.out.brokenDerivedErr === 'string' && (brokenRun.out.brokenDerivedErr as string).length > 0,
      JSON.stringify(brokenRun.out.brokenDerivedErr),
    )
    check(
      'unreadable config sets deltasReadError on materializedKitForWorkspace without throwing',
      typeof brokenRun.out.brokenMatErr === 'string' && (brokenRun.out.brokenMatErr as string).length > 0,
      JSON.stringify(brokenRun.out.brokenMatErr),
    )
    check(
      'applyConcourseKitOp still applies dial and includes the MCP deltas unread note',
      brokenRun.out.opOutcome === 'applied' &&
        typeof brokenRun.out.opDetail === 'string' &&
        (brokenRun.out.opDetail as string).includes("this repo's MCP servers could not be read (") &&
        (brokenRun.out.opDetail as string).includes('— its MCP deltas are not checked'),
      JSON.stringify({ opOutcome: brokenRun.out.opOutcome, opDetail: brokenRun.out.opDetail }),
    )
  }
  check(
    'clean config omits deltasReadError on derived and materialized kits',
    cleanRun.out.cleanDerivedErr === null && cleanRun.out.cleanMatErr === null,
    JSON.stringify(cleanRun.out),
  )
}

console.log('\nw02-7 — BootSaturnScreen box remove and pause/resume catch box-file read errors and show schedule refused notice')
{
  const r = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const saturn = await import(${JSON.stringify(join(SRC, 'screen/boot-face/BootSaturnScreen.tsx'))})
    const box = await import(${JSON.stringify(join(SRC, 'daemon/saturn/saturnBoxSchedules.ts'))})

    const dir = path.join(HOME, 'daemon-w02-7')
    fs.mkdirSync(dir, { recursive: true })
    const boxPath = box.saturnBoxSchedulesPath(dir)
    const corrupt = '{not json'
    fs.writeFileSync(boxPath, corrupt, 'utf8')

    out.hasRemove = typeof saturn.runBoxRemoveNote === 'function'
    out.hasPause = typeof saturn.runBoxPauseResumeNote === 'function'
    if (out.hasRemove) out.removeNote = saturn.runBoxRemoveNote('sched-1', dir)
    if (out.hasPause) out.pauseNote = saturn.runBoxPauseResumeNote('sched-1', true, dir)
    out.preserved = fs.readFileSync(boxPath, 'utf8') === corrupt
  `)
  check(
    'BootSaturnScreen boxRemove catches corrupt box file and returns schedule refused notice without overwriting',
    r.out.hasRemove === true &&
      typeof r.out.removeNote === 'string' &&
      (r.out.removeNote as string).startsWith('schedule refused — ') &&
      r.out.preserved === true,
    JSON.stringify(r.out),
  )
  check(
    'BootSaturnScreen boxPauseResume catches corrupt box file and returns schedule refused notice without overwriting',
    r.out.hasPause === true &&
      typeof r.out.pauseNote === 'string' &&
      (r.out.pauseNote as string).startsWith('schedule refused — ') &&
      r.out.preserved === true,
    JSON.stringify(r.out),
  )
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
