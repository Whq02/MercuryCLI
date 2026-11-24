#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { idCellPattern, showsId } from '../lib/pickerCells.ts'
import { resolveProofHome } from '../lib/proofHome.ts'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')
const FIXTURE = join(import.meta.dir, 'openrouter-catalogue-fixture-server.ts')

const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-live-catalogue-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-dummy0000000000'
const OPENROUTER_KEY = 'sk-or-v1-fixture0000000000000000'
const OPENROUTER_KEY_TAIL = OPENROUTER_KEY.slice(-4)
process.env.OPENROUTER_API_KEY = OPENROUTER_KEY
process.env.MERCURY_OPENROUTER_API_BASE = 'http://127.0.0.1:9/api/v1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' /model — live catalogue rows land in place')
console.log('============================================================')

section('the epoch store: one signal, heard once per settle')
const { bumpCatalogueEpoch, catalogueEpoch, subscribeCatalogueEpoch } = await import(
  '../../src/models/roads/catalogueEpoch.ts'
)
{
  let heard = 0
  const off = subscribeCatalogueEpoch(() => {
    heard++
  })
  const e0 = catalogueEpoch()
  bumpCatalogueEpoch()
  check('a bump advances the epoch by one', catalogueEpoch() === e0 + 1, 'bumpCatalogueEpoch in src/models/roads/catalogueEpoch.ts must add exactly one to the epoch')
  check('a subscriber hears one bump once', heard === 1, `heard ${heard}; bumpCatalogueEpoch in src/models/roads/catalogueEpoch.ts must call each subscribed listener once per bump`)
  off()
  bumpCatalogueEpoch()
  check('an unsubscribed listener hears nothing more', heard === 1, `heard ${heard}; the function subscribeCatalogueEpoch returns in src/models/roads/catalogueEpoch.ts must remove the listener`)
}

section('the OpenRouter refresh bumps on success and on failure')
{
  const { refreshOpenrouterCatalogue } = await import(
    '../../src/models/roads/openrouter/openrouterCatalogue.ts'
  )
  const { resolveOpenrouterRequestAuth } = await import(
    '../../src/models/roads/openrouter/openrouterAccounts.ts'
  )
  const auth = resolveOpenrouterRequestAuth()
  check('the env key resolves an OpenRouter credential', auth !== undefined, 'resolveOpenrouterRequestAuth in src/models/roads/openrouter/openrouterAccounts.ts returned nothing for OPENROUTER_API_KEY')
  if (auth) {
    const page = {
      data: [{ id: 'anthropic/claude-opus-5', name: 'Anthropic: Claude Opus 5', context_length: 1_000_000 }],
      total_count: 1,
      links: { next: null },
    }
    const okFetch = (async () =>
      new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const before = catalogueEpoch()
    const landed = await refreshOpenrouterCatalogue(auth.account.keySource, { force: true, fetchImpl: okFetch })
    check('a landed fetch settles the snapshot with its rows', (landed?.models.length ?? 0) === 1, (landed?.lastError ?? 'models ' + landed?.models.length) + '; refreshOpenrouterCatalogue in src/models/roads/openrouter/openrouterCatalogue.ts must store the fetched rows in the snapshot it returns')
    check('…and bumps the epoch', catalogueEpoch() === before + 1, `${before} → ${catalogueEpoch()}; the finally block of refreshOpenrouterCatalogue in src/models/roads/openrouter/openrouterCatalogue.ts must call bumpCatalogueEpoch when the rows change`)
    const failFetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const before2 = catalogueEpoch()
    const failed = await refreshOpenrouterCatalogue(auth.account.keySource, { force: true, fetchImpl: failFetch })
    check('a failed fetch settles stale-but-labelled', failed?.lastError !== undefined, 'the catch block of refreshOpenrouterCatalogue in src/models/roads/openrouter/openrouterCatalogue.ts must set lastError on the snapshot')
    check('…and bumps the epoch too (the screen must reflect the failure)', catalogueEpoch() === before2 + 1, 'the finally block of refreshOpenrouterCatalogue in src/models/roads/openrouter/openrouterCatalogue.ts must bump the epoch when only lastError changes')
  }
}

section('THE SCREEN: one /model open paints connecting… then the rows (120x40)')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`  no POSIX pty capture driver on this host (${driver.kind}) — the screen leg cannot run here`)
  failures++
} else if (!existsSync(BIN)) {
  console.error(`  dist/mercury.mjs missing — bun run build.ts first`)
  failures++
} else {
  const PENDING_HOLD_MS = Math.min(vshotBudgetMs(10_000), 12_000)
  const FIXTURE_ROWS = (readFileSync(FIXTURE, 'utf8').match(/^\s+\{ id: '/gm) ?? []).length
  const { enableConfigs } = await import('../../src/platform/settings/config.ts')
  enableConfigs()
  const { getModelOptions } = await import('../../src/models/catalogue/modelOptions.ts')
  const { OPENROUTER_MODEL_GROUP } = await import('../../src/models/roads/openrouter/openrouterCatalogue.ts')
  const { ANTHROPIC_MODEL_GROUP, isProviderActionRow } = await import('../../src/models/catalogue/modelOptions.ts')
  const picker = await import('../../src/models/facts/modelPickerGroups.ts')
  const pickerRows = getModelOptions().map(row => ({
    id: row.value,
    name: row.label,
    tag: row.description,
    group: row.group ?? ANTHROPIC_MODEL_GROUP,
    ...(isProviderActionRow(row.value) ? { action: true } : {}),
    ...(row.unavailable !== undefined ? { gated: true } : {}),
    ...(row.catalogueDoor ? { expand: { group: row.group ?? ANTHROPIC_MODEL_GROUP, family: row.catalogueDoor.family, total: row.catalogueDoor.total } } : {}),
  }))
  const pickerGroups = picker.orderPickerGroups(picker.groupPickerRows(pickerRows), { top: ANTHROPIC_MODEL_GROUP })
  const stops = picker.composePickerLines(pickerGroups, picker.initialPickerFolds(pickerGroups, ANTHROPIC_MODEL_GROUP), '', () => undefined).filter(line => picker.isCursorStop(line))
  const openrouterIndex = stops.findIndex(line => line.kind === 'row' && line.row.group === OPENROUTER_MODEL_GROUP)
  if (openrouterIndex < 0) throw new Error('OpenRouter is absent from the catalogue')
  const PICKER_REGION = [24, 0, 96, 40]
  const fixture = spawn(process.execPath, ['run', FIXTURE, String(PENDING_HOLD_MS)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let port = 0
  try {
    port = await new Promise<number>((resolve, reject) => {
      const killer = setTimeout(() => reject(new Error('fixture server never printed PORT')), 15_000)
      fixture.stdout.on('data', (chunk: Buffer) => {
        const m = /PORT (\d+)/.exec(chunk.toString())
        if (m) {
          clearTimeout(killer)
          resolve(Number(m[1]))
        }
      })
      fixture.on('exit', code => reject(new Error(`fixture server exited early (${code})`)))
    })
  } catch (e) {
    check('the loopback catalogue fixture started', false, String(e))
  }
  if (port > 0) {
    const home = resolveProofHome([REPO])
    const grid = join(SCRATCH, 'live-catalogue-120x40.json')
    const cfgPath = join(SCRATCH, 'vshot.json')
    writeFileSync(
      cfgPath,
      JSON.stringify({
        argv: ['node', BIN],
        sends: [
          { atTick: 40, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, minTick: 3, requireAwait: true, awaitSettleTicks: 2, data: '\r' },
          { atTick: 60, data: '/model', awaitText: 'Type a prompt', minTick: 5, requireAwait: true, awaitSettleTicks: 2 },
          { afterPrevTicks: 3, data: '\r' },
          { requireAwait: true, awaitText: '│ │ Opus 5.5 ', awaitSettleTicks: 2, data: '\u001b[H' + '\u001b[B'.repeat(openrouterIndex) },
          { requireAwait: true, awaitText: '│ │ OpenRouter — connecting…', awaitStableTicks: 3, awaitStableRegion: PICKER_REGION, mark: 'pending', data: '' },
          { requireAwait: true, awaitText: `OPENROUTER · API key · …${OPENROUTER_KEY_TAIL} · ${FIXTURE_ROWS} live`, awaitStableTicks: 3, awaitStableRegion: PICKER_REGION, mark: 'landed', data: '' },
          { afterPrevTicks: 3, data: '\u001b' },
        ],
        total: 150,
        cols: 120,
        rows: 40,
        out: grid,
        title: 'live catalogue @120x40',
      }),
    )
    const res = spawnSync(driver.python, [VSHOT, cfgPath], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: home,
        MERCURY_CRITTER_IDLE: '0',    MERCURY_CRITTER_GAZE: '0',
        MERCURY_CRITTER_SLEEP: '0',   MERCURY_LIVE_CLOCK: '0',
        MERCURY_LIVE_GLYPHS: '0',
        MERCURY_OPENROUTER_API_BASE: `http://127.0.0.1:${port}/api/v1`,
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      },
      timeout: vshotBudgetMs(90_000),
    })
    check('the drive delivered every send (exit 0)', res.status === 0, `exit ${res.status}: ${(res.stderr ?? '').trim().slice(-300)}`)
    if (res.status !== 0) {
      const frame = (res.stdout ?? '').split('\n').filter(l => l.includes('│ │') || /OPENROUTER|more\s*$/.test(l))
      console.log('  final frame (header · focus box · fold markers):\n' + frame.map(l => `    ${l.trimEnd()}`).join('\n'))
    }
    if (existsSync(grid)) {
      const payload = JSON.parse(readFileSync(grid, 'utf8')) as {
        marks?: Array<{ label: string; atTick: number; grid: Array<Array<{ c: string }>> }>
      }
      const text = (g: Array<Array<{ c: string }>>): string => g.map(row => row.map(c => c.c).join('')).join('\n')
      const pending = payload.marks?.find(m => m.label === 'pending')
      const landed = payload.marks?.find(m => m.label === 'landed')
      check('the pending moment was observed', pending !== undefined, 'the pending mark needs the picker to paint OpenRouter — connecting… (openrouterCatalogue.ts in src/models/roads/openrouter) while the fixture holds its reply')
      check('the landed moment was observed', landed !== undefined, 'the landed mark needs the OPENROUTER heading to show the live row count once the fixture answers; look at the frame the drive printed or at the grid JSON in the scratch folder')
      if (pending && landed) {
        const p = text(pending.grid)
        const l = text(landed.grid)
        check('pending: the OpenRouter group paints its connecting row, no rows yet', p.includes('OpenRouter — connecting…') && !showsId(p, 'openrouter/anthropic/claude-opus-5'), 'while the fetch is pending the OpenRouter group in src/models/roads/openrouter/openrouterCatalogue.ts must offer only the connecting row')
        check('landed: the catalogue rows replaced the connecting row (each id in its cell, cut to the column with …)', showsId(l, 'openrouter/anthropic/claude-opus-5') && showsId(l, 'openrouter/google/gemini-3.1-pro') && !l.includes('OpenRouter — connecting…'), `${l.split('\n').filter(line => line.includes('openrouter/')).map(line => line.trim()).join(' | ')}; the OpenRouter group in src/models/roads/openrouter/openrouterCatalogue.ts must replace the connecting row with the fetched rows`)
        check('both moments belong to ONE open (the picker never closed between them)', landed.atTick > pending.atTick && l.includes('Mercury · model') && p.includes('Mercury · model'), 'the picker closed or reopened between the two marks; the live catalogue must update the open /model picker in place (catalogueEpoch in src/models/roads/catalogueEpoch.ts)')
        const openrouterHeading = (t: string): string => (t.match(/[▾▸❯] OPENROUTER · [^│\n]+/)?.[0] ?? '').trim()
        check(`the OpenRouter heading counts the landed rows (${FIXTURE_ROWS} live, the fixture's lineup)`, openrouterHeading(l).endsWith(`· ${FIXTURE_ROWS} live`) && !/\d+ live/.test(openrouterHeading(p)), `${openrouterHeading(p)} → ${openrouterHeading(l)}; the group heading in src/models/facts/modelPickerGroups.ts must show the live row count once the rows land`)
        check('the rows landed under the cursor (the focus box holds the first live row)', new RegExp(`│ │ \\S.*${idCellPattern('openrouter/anthropic/claude-opus-5')}`).test(l), l.split('\n').filter(line => line.includes('│ │ ')).map(line => line.trim()).join(' | '))
      }
    } else {
      check('the capture wrote its grid', false, 'scripts/ui/vshot.py wrote no grid file; read its stderr from the drive and rebuild with bun run build.ts')
    }
  }
  fixture.kill('SIGTERM')
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ live catalogue rows land in place' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
