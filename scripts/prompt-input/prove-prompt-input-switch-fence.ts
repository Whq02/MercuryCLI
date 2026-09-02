#!/usr/bin/env bun
// ============================================================================
//  prove-prompt-input-switch-fence — F1-S1 on the BUILT artifact.
//
//  Reproduced pre-fix:
//    · a second /sessiontab typed while the first staged rode the
//      screen-era immediate fast path (the retired handlePromptSubmit
//      stack's queryGuard.isActive branch — steer-removal removed that
//      stack whole), both resumes ran concurrently, and the LAST-COMPLETED
//      stage committed — final session B though the operator's LAST CHOICE
//      was C;
//    · keystrokes during the stage window visibly vanished at the commit
//      tail's draft restore.
//
//  The law proven here (the fence + typing-wins, driven end-to-end):
//    V0  serial switches stay sane (final = the last target, C);
//    V1  rapid B→C with B's stage slowed 6s: the SUPERSEDE fence aborts B's
//        commit — final = C, the last-chosen session;
//    V3  typing on the empty composer during a slow stage SURVIVES the
//        commit (post-decision input is the target's; the restore yields).
//
//  Determinism: the stage window is widened by a SessionStart hook (matcher
//  'resume') that sleeps 6s only for fixture B — operator-reachable
//  machinery, no internal seams. Hook fires are logged for ground truth.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const home = mkdtempSync(join(tmpdir(), 'kinetic-fence-'))
process.env.MERCURY_CONFIG_DIR = home

const { scenario, cleanupScenario, writeSyntheticSession, SID, SID_ERRORED } =
  await import('../ui/renderScenarios.ts')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const SID_C = `00000000-aaaa-bbbb-eeee-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`
const hookLog = join(home, 'hook-fires.log')
const hook = join(home, 'slow-start.sh')
writeFileSync(hook, `#!/bin/bash
in=$(cat)
sid=$(printf '%s' "$in" | /usr/bin/python3 -c 'import sys,json;print(json.load(sys.stdin).get("session_id","?"))' 2>/dev/null || echo parse-fail)
echo "$(date +%s%3N) start $sid" >> ${hookLog}
case "$sid" in ${SID_ERRORED}) sleep 6;; esac
exit 0
`)
chmodSync(hook, 0o755)
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({ hooks: { SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: hook, timeout: 30 }] }] } }),
)

const cfg = scenario('resume-2turn', 120, 40) // boots resumed into A ('short')

type Grid = { grid: { c: string }[][]; sendReceipts?: unknown }
const rowsOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))
const composerOf = (rows: string[]): string => {
  const idx = rows.map((r, i) => (r.includes('│❯') ? i : -1)).filter(i => i >= 0)
  return idx.length ? rows[idx[idx.length - 1]]! : ''
}

function capture(tag: string, sends: unknown[], total: number): { rows: string[]; receipts: unknown } {
  // Fresh fixtures per capture: writeSyntheticSession purges each sid's
  // draft, so a prior capture's typed text can never leak into this one.
  writeSyntheticSession('short', SID)
  writeSyntheticSession('errors', SID_ERRORED)
  writeSyntheticSession('tools', SID_C)
  const out = join(home, `${tag}.json`)
  const cfgPath = join(home, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, cwd: cfg.cwd, sends, total, cols: 120, rows: 40, out }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(200_000),
    env: { ...process.env, MERCURY_AWAY_SUMMARY: '0', MERCURY_CONFIG_DIR: home },
  })
  if (res.status !== 0) throw new Error(`vshot ${tag} failed: ${res.stderr?.slice(-500)}`)
  const g = JSON.parse(readFileSync(out, 'utf8')) as Grid
  return { rows: rowsOf(g), receipts: g.sendReceipts }
}

// Transcript-pane truth (col >24 skips the rails, which list other sessions).
const paneHas = (rows: string[], s: string): boolean => rows.some(r => r.slice(24).includes(s))
const ON_A = '❯ first task'
const ON_B = 'apply the manifest edit'
const ON_C = 'run the greeting and read the manifest'

try {
  // ── V0 serial sanity: B … (past B's 6s stage) … C → final C ──────────────
  const v0 = capture('v0', [
    { atTick: 40, data: `/sessiontab ${SID_ERRORED}`, minTick: 10, awaitRaw: '\u001b[?2004h' },
    { atTick: 44, data: '\r', afterPrevTicks: 3 },
    { atTick: 95, data: `/sessiontab ${SID_C}`, afterPrevTicks: 45 },
    { atTick: 100, data: '\r', afterPrevTicks: 3 },
  ], 135)
  t('V0 serial switches land on the last target (C)', paneHas(v0.rows, ON_C) && !paneHas(v0.rows, ON_B),
    `receipts=${JSON.stringify(v0.receipts)}`)

  // ── V1 rapid: C typed ~1s into B's 6s stage → the fence aborts B ─────────
  const v1 = capture('v1', [
    { atTick: 40, data: `/sessiontab ${SID_ERRORED}`, minTick: 10, awaitRaw: '\u001b[?2004h' },
    { atTick: 44, data: '\r', afterPrevTicks: 3 },
    { atTick: 50, data: `/sessiontab ${SID_C}`, afterPrevTicks: 5 },
    { atTick: 54, data: '\r', afterPrevTicks: 3 },
  ], 135)
  t('V1 rapid switches: the LAST-CHOSEN session (C) owns the commit', paneHas(v1.rows, ON_C) && !paneHas(v1.rows, ON_B),
    `receipts=${JSON.stringify(v1.receipts)}`)
  const fires = existsSync(hookLog) ? readFileSync(hookLog, 'utf8') : ''
  t('V1 ground truth: both resume stages actually ran (B and C hooks fired)',
    fires.includes(SID_ERRORED) && fires.includes(SID_C))

  // ── V3 typing-wins: keystrokes during B's stage survive the commit ───────
  const v3 = capture('v3', [
    { atTick: 40, data: `/sessiontab ${SID_ERRORED}`, minTick: 10, awaitRaw: '\u001b[?2004h' },
    { atTick: 44, data: '\r', afterPrevTicks: 3 },
    // Gated on the switch's OWN entry receipt — the `switching →` chip that
    // resume() posts synchronously before its first await (the typing-wins
    // snapshot is already taken). A tick offset raced the runner: on a slow
    // host the keystrokes landed BEFORE the submit's clear and were
    // (correctly) cleared as pre-decision text — the hosted red that passed
    // every local run. B's 6s hook window is the slack this gate rides in.
    { atTick: 70, data: 'hello mid switch', awaitText: 'opening', requireAwait: true },
  ], 130)
  t('V3 the switch to B committed', paneHas(v3.rows, ON_B))
  t('V3 typing during the stage survives in the composer (never rolled back)',
    composerOf(v3.rows).includes('hello mid switch'),
    `composer="${composerOf(v3.rows).trim().slice(0, 60)}"`)
} finally {
  cleanupScenario('resume-2turn')
}

console.log(failures === 0 ? '✅ kinetic switch-fence law holds' : '❌ kinetic switch-fence BROKEN')
process.exit(failures)
