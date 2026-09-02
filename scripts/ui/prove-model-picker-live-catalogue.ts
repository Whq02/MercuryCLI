#!/usr/bin/env bun
// ============================================================================
//  prove-model-picker-live-catalogue — live catalogue rows land IN PLACE.
//
//  The /model picker reads the provider catalogues sync-over-cache: an
//  unfetched lane paints its "connecting…" action row and kicks a refresh.
//  The refresh settling changed nothing on screen — the rows were seen only
//  on a SECOND /model open. The laws proved here:
//    · ONE epoch store: every catalogue settle (rows · labelled failure ·
//      account-unavailable) bumps it; a subscriber hears each bump once.
//    · The OpenRouter refresh bumps on success AND on failure (the real
//      module, an injected fetch).
//    · The wrapper subscribes (useCatalogueEpoch) and the action rows retry
//      in place through the notice slot — no "reopen /model" copy survives.
//    · A group's detail line wraps by whole ' · ' segments (packLines) and
//      the picker budgets exactly those rows.
//    · THE SCREEN: the built binary, driven in a PTY against a delayed
//      loopback catalogue, paints "OpenRouter — connecting…" and then the
//      catalogue rows inside ONE /model open (vshot marks = two moments of
//      one run, the second gated on the rows' own text). The fetch is in
//      flight before the open — the chat's mount warms every credentialed
//      catalogue at birth — so the fixture's hold outlasts birth → open and
//      stays under the product's catalogue deadline (the screen leg's note).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-model-picker-live-catalogue.ts
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { resolveProofHome } from '../lib/proofHome.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(import.meta.dir, 'vshot.py')
const FIXTURE = join(import.meta.dir, 'openrouter-catalogue-fixture-server.ts')

// The scratch home is pinned BEFORE any src import: the account resolver
// reads stored auth from the config home, and a proof never reads the
// operator's. The env key is the credential every unit leg resolves.
const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-live-catalogue-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-dummy0000000000'
process.env.OPENROUTER_API_KEY = 'sk-or-v1-fixture0000000000000000'
process.env.MERCURY_OPENROUTER_API_BASE = 'http://127.0.0.1:9/api/v1'
// The product user-agent reads the build-time MACRO define; a bun-run proof
// supplies it (the openrouter wire-id prover's idiom).
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
  '../../src/services/providers/catalogueEpoch.ts'
)
{
  let heard = 0
  const off = subscribeCatalogueEpoch(() => {
    heard++
  })
  const e0 = catalogueEpoch()
  bumpCatalogueEpoch()
  check('a bump advances the epoch by one', catalogueEpoch() === e0 + 1)
  check('a subscriber hears one bump once', heard === 1, `heard ${heard}`)
  off()
  bumpCatalogueEpoch()
  check('an unsubscribed listener hears nothing more', heard === 1, `heard ${heard}`)
}

section('the OpenRouter refresh bumps on success and on failure')
{
  const { refreshOpenrouterCatalogue } = await import(
    '../../src/services/providers/openrouter/openrouterCatalogue.ts'
  )
  const { resolveOpenrouterRequestAuth } = await import(
    '../../src/services/providers/openrouter/openrouterAccounts.ts'
  )
  const auth = resolveOpenrouterRequestAuth()
  check('the env key resolves an OpenRouter credential', auth !== undefined)
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
    check('a landed fetch settles the snapshot with its rows', (landed?.models.length ?? 0) === 1, landed?.lastError ?? `models ${landed?.models.length}`)
    check('…and bumps the epoch', catalogueEpoch() === before + 1, `${before} → ${catalogueEpoch()}`)
    const failFetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const before2 = catalogueEpoch()
    const failed = await refreshOpenrouterCatalogue(auth.account.keySource, { force: true, fetchImpl: failFetch })
    check('a failed fetch settles stale-but-labelled', failed?.lastError !== undefined)
    check('…and bumps the epoch too (the screen must reflect the failure)', catalogueEpoch() === before2 + 1)
  }
}

section('group detail lines wrap by whole segments')
{
  const { packLines } = await import('../../src/components/mercury-ui/geometry.ts')
  const detail = 'frontier: GPT-5.6 Sol · 2026-07-21 · no OpenAI account — /logins'
  const lines = packLines(detail.split(' · '), 58)
  check(
    'a 66-wide detail packs into two whole-segment lines at the 62-panel interior (58)',
    lines.length === 2 && lines[0] === 'frontier: GPT-5.6 Sol · 2026-07-21' && lines[1] === 'no OpenAI account — /logins',
    JSON.stringify(lines),
  )
  check(
    'a fitting detail stays one line',
    packLines('frontier: Fable 5 · Anthropic API key · credential present'.split(' · '), 58).length === 1,
  )
  check('an over-wide single segment stands alone (the renderer truncates it)', packLines(['x'.repeat(80)], 58).length === 1)
  check('nothing is dropped: every segment survives the wrap', lines.join(' · ') === detail)
}

section('mechanism pins: subscription · in-place retry · every catalogue bumps')
{
  const wrapper = readFileSync(join(REPO, 'src/commands/model/mercuryModel.tsx'), 'utf8')
  check('the /model wrapper subscribes to the catalogue epoch', wrapper.includes('useCatalogueEpoch()'))
  check('no action row closes the picker to "reopen /model"', !wrapper.includes('reopen /model'))
  check(
    'every catalogue retry settles through the notice slot (GPT · OpenRouter · Gemini · Hugging Face)',
    (wrapper.match(/refreshing the live catalogue/g) ?? []).length >= 4,
  )
  for (const rel of [
    'src/services/providers/openrouter/openrouterCatalogue.ts',
    'src/services/providers/openai/openaiCatalogue.ts',
    'src/services/providers/gemini/geminiCatalogue.ts',
    'src/services/providers/huggingface/huggingfaceCatalogue.ts',
  ]) {
    const src = readFileSync(join(REPO, rel), 'utf8')
    check(`${rel.split('/').pop()} bumps the epoch when its refresh settles (the finally block)`, /finally \{[^}]*bumpCatalogueEpoch\(\)/.test(src))
  }
  const picker = readFileSync(join(REPO, 'src/components/MercuryModelPicker.tsx'), 'utf8')
  check(
    'the picker wraps group details by whole segments and budgets those rows',
    picker.includes("packLines(detail.split(' · '), panelWidth - 4)") && picker.includes('detailLines.get(g)?.length'),
  )
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
  // THE PENDING WINDOW. The chat's mount warms every credentialed catalogue
  // one macrotask after birth (REPL → warmContextWindowSources; each source
  // is single-flight), so the OpenRouter fetch is in flight BEFORE the
  // picker opens and the open's own kick JOINS it: the rows land at the
  // WARM's request + the fixture's hold, never at the open + the hold. The
  // hold must outlast birth → composer → open → walk → the 3-tick stable
  // hold (~3s on a quiet box, ~9s seen under box contention) and must stay
  // under the product's own catalogue deadline (openrouterCatalogue.ts
  // CATALOGUE_FETCH_TIMEOUT_MS, 15s), past which the warm's fetch ends
  // "unreachable" and no rows ever land. 10s at scale 1; the hosted profile
  // stretches it with the movie but never past 12s (the deadline does not
  // scale). The old 4s hold was authored at the hairline of a quiet boot
  // and lost the race under any load (the red: 'pending' never
  // due — the rows were already on screen at the open).
  const PENDING_HOLD_MS = Math.min(vshotBudgetMs(10_000), 12_000)
  // The fixture's own lineup — the header count moves by exactly this many.
  const FIXTURE_ROWS = (readFileSync(FIXTURE, 'utf8').match(/^\s+\{ id: '/gm) ?? []).length
  // THE WALK: the picker opens on the current model's row — the last row of
  // the Anthropic group in a fresh API-key home — and the OpenRouter group
  // follows the signed-out OpenAI group's ONE connect row: two steps put the
  // cursor on the OpenRouter action row. The pending mark is gated on the
  // FOCUSED row (the focus box's '│ │ ' prefix), so a lineup whose order
  // moves this count reds here BY NAME instead of observing a silently
  // different frame (the old 13-step walk, cut for a longer lineup, scrolled
  // the group out of view and parked the cursor on a Moonshot row).
  const OPENROUTER_ACTION_ROW_STEPS = 2
  // Stability is scoped to the picker's columns: the cockpit's session clock
  // (top right) ticks once a second outside them.
  const PICKER_REGION = [0, 0, 64, 40]
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
    // The proof home seeds the project slice the product READS — the
    // canonical git root beside the boot cwd (firstRunSeed.ts) — so the
    // composer paints its idle placeholder in a lane worktree too, instead
    // of the first-run hint that never carries the entry needle.
    const home = resolveProofHome([REPO])
    const grid = join(SCRATCH, 'live-catalogue-120x40.json')
    const cfgPath = join(SCRATCH, 'vshot.json')
    writeFileSync(
      cfgPath,
      JSON.stringify({
        argv: ['node', BIN],
        sends: [
          // THE LANDING RULE (line 4, signed (b)): ↵ on the face's New Session
          // first — STRICT on the face's own hint: a blind deadline-fired ↵
          // into a face still booting (a loaded box paints it past tick 40)
          // was swallowed, and the journey died at the face with the
          // composer named as the stuck needle. Never entering exits 4 by
          // the face's name.
          { atTick: 40, awaitText: '↑↓ choose', minTick: 3, requireAwait: true, awaitSettleTicks: 2, data: '\r' },
          // STRICT entry gate: the birth's wall-clock seconds do not scale
          // with the movie, so a deadline-fired '/model' lands on the FACE
          // when the chat is late (probe-proven: the face swallowed the
          // chars and the picker never opened). The chat's own composer is
          // the gate; a world that never enters exits 4 honestly.
          { atTick: 60, data: '/model', awaitText: 'Type a prompt', minTick: 5, requireAwait: true, awaitSettleTicks: 2 },
          { afterPrevTicks: 3, data: '\r' },
          { afterPrevTicks: 4, data: '\u001b[B'.repeat(OPENROUTER_ACTION_ROW_STEPS) },
          // Two moments of ONE open: each mark snapshots the grid the instant
          // its own text is on screen; a moment that never comes is an
          // undelivered send (exit 4), never a silently different frame.
          { requireAwait: true, awaitText: '│ │ OpenRouter — connecting…', awaitStableTicks: 3, awaitStableRegion: PICKER_REGION, mark: 'pending', data: '' },
          { requireAwait: true, awaitText: 'Anthropic: Claude Opus 5', awaitStableTicks: 3, awaitStableRegion: PICKER_REGION, mark: 'landed', data: '' },
          { afterPrevTicks: 3, data: '\u001b' },
        ],
        // 150: the strict entry gate can spend authored ticks waiting out a
        // slow birth, and the tail still owes the pending hold (up to 60
        // ticks from the warm) plus stability before esc.
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
        MERCURY_OPENROUTER_API_BASE: `http://127.0.0.1:${port}/api/v1`,
        // No turn is ever sent; the Anthropic base points at a closed port so
        // nothing can leave the box.
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      },
      timeout: vshotBudgetMs(90_000),
    })
    check('the drive delivered every send (exit 0)', res.status === 0, `exit ${res.status}: ${(res.stderr ?? '').trim().slice(-300)}`)
    if (res.status !== 0) {
      // The final frame's picker facts — the header, the focus box, the
      // fold markers — so a stuck walk names the row it parked on.
      const frame = (res.stdout ?? '').split('\n').filter(l => l.includes('│ │') || /AVAILABLE|more\s*$/.test(l))
      console.log('  final frame (header · focus box · fold markers):\n' + frame.map(l => `    ${l.trimEnd()}`).join('\n'))
    }
    if (existsSync(grid)) {
      const payload = JSON.parse(readFileSync(grid, 'utf8')) as {
        marks?: Array<{ label: string; atTick: number; grid: Array<Array<{ c: string }>> }>
      }
      const text = (g: Array<Array<{ c: string }>>): string => g.map(row => row.map(c => c.c).join('')).join('\n')
      const pending = payload.marks?.find(m => m.label === 'pending')
      const landed = payload.marks?.find(m => m.label === 'landed')
      check('the pending moment was observed', pending !== undefined)
      check('the landed moment was observed', landed !== undefined)
      if (pending && landed) {
        const p = text(pending.grid)
        const l = text(landed.grid)
        check('pending: the OpenRouter group paints its connecting row, no rows yet', p.includes('OpenRouter — connecting…') && !p.includes('Anthropic: Claude Opus 5'))
        check('landed: the catalogue rows replaced the connecting row', l.includes('Anthropic: Claude Opus 5') && l.includes('Google: Gemini 3.1 Pro') && !l.includes('OpenRouter — connecting…'))
        check('both moments belong to ONE open (the picker never closed between them)', landed.atTick > pending.atTick && l.includes('CHOOSE A MODEL') && p.includes('CHOOSE A MODEL'))
        // The count itself is the lineup's business (it moved 13 → 12 under
        // this prover's feet); what the screen owes is the MOVE: exactly the
        // fixture's rows, on the same open.
        const countOf = (t: string): number => Number(/(\d+) AVAILABLE/.exec(t)?.[1] ?? NaN)
        check(`the header count moved with the rows (+${FIXTURE_ROWS}, the fixture's lineup)`, countOf(l) === countOf(p) + FIXTURE_ROWS, `${countOf(p)} → ${countOf(l)}`)
        // IN PLACE means under the cursor: the picker keeps the row index, so
        // the action row the cursor sat on becomes the first live row.
        check('the rows landed under the cursor (the focus box holds the first live row)', l.includes('│ │ Anthropic: Claude Opus 5'))
      }
    } else {
      check('the capture wrote its grid', false)
    }
  }
  fixture.kill('SIGTERM')
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ live catalogue rows land in place' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
