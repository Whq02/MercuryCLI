#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const ok = (cond: boolean, label: string, detail = ''): void => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
console.log('── mo5 census ratchet + artifact survival')

{
  const src = read('src/substrate/durablePublish.ts')
  ok(
    src.includes('WIN32_RENAME_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200]'),
    '§1 the one schedule lives at the owner',
  )
  ok(
    src.includes('export function renameRetryDelayMs') &&
      src.includes('export async function renameWithWin32Retry') &&
      src.includes('export function renameWithWin32RetrySync'),
    '§1 the pure decision + both shared helpers are exported',
  )
  ok(
    src.includes('DurablePublishReport') && src.includes('tempCleanup') && src.includes('elapsedMs'),
    '§1 the typed result reports attempts/elapsed/temp-cleanup',
  )
}

{
  const rows: Array<[string, string | RegExp, RegExp]> = [
    ['src/keybindings/writeBindings.ts', "durablePublish.js'", /await rename\(tmp, path\)/],
    ['src/utils/realmRegistry.ts', "durablePublish.js'", /renameSync\(tmp, path\)/],
    ['src/utils/router/postures.ts', "durablePublish.js'", /renameSync\(tmp, routerPosturePath\(\)\)/],
    ['src/utils/sessionStorage/resumeSnapshot.ts', "durablePublish.js'", /renameSync\(temp, target\)/],
    ['src/utils/verification/verificationState.ts', "durablePublish.js'", /renameSync\(tmp, file\)/],
    ['src/services/interview/decisionRecord.ts', "durablePublish.js'", /renameSync\(tmp, path\)/],
    ['src/utils/scratchLeases.ts', "durablePublish.js'", /renameSync\(tmp, target\)/],
    ['src/utils/observability/invocationTrace.ts', "durablePublish.js'", /await rename\(tmp, path\)/],
    ['src/utils/cockpit/presenceLive.ts', 'durableTempName', /Math\.random\(\)\.toString\(36\)\.slice\(2\)\}\.tmp/],
    ['src/services/changeTransaction/changeSetCommit.ts', 'renameWithWin32Retry', /await rename\(staged\[i\]!\.tmp/],
    ['src/utils/debug.ts', 'renameWithWin32Retry', /await rename\(path, rotated\)/],
    ['src/daemon/ownedDaemon.ts', 'renameWithWin32RetrySync', /renameSync\(logPath/],
    ['src/services/vulcan/addonInstaller.ts', 'renameWithWin32RetrySync', /renameSync\(tmp, file\)/],
    ['src/memdir/mnemeConsolidate.ts', 'renameWithWin32RetrySync', /renameSync\(current, consuming\)/],
    ['src/memdir/scribePromote.ts', 'renameWithWin32Retry', /await rename\(src, dest\)/],
    ['src/tools/LSPTool/mercuryOps.ts', 'renameWithWin32Retry', /await rename\(absolutePath, newAbs\)/],
    ['src/utils/file.ts', 'renameWithWin32RetrySync', /fs\.renameSync\(tempPath, targetPath\)/],
    ['src/services/privateChannel/installLayout.ts', 'WIN32_RENAME_RETRY_DELAYS_MS', /RENAME_RETRY_DELAYS_MS = \[50, 100, 200\]/],
    ['src/utils/healthReport.ts', 'if (moved) movedCount++', /\.catch\(\(\) => \{\}\)\n\s*movedCount\+\+/],
  ]
  let clean = true
  for (const [rel, marker, oldPrint] of rows) {
    const src = read(rel)
    const has = typeof marker === 'string' ? src.includes(marker) : marker.test(src)
    const gone = !oldPrint.test(src)
    if (!has || !gone) {
      clean = false
      console.log(`     ${rel}: marker=${has} oldGone=${gone}`)
    }
  }
  ok(clean, `§2 all ${rows.length} census rows hold (marker present, old fingerprint gone)`)
}

{
  const src = read('src/utils/errors/classifyToolError.ts')
  const win32Hint = src.match(/'file in use[^']+'/)?.[0] ?? ''
  ok(win32Hint.length > 0, '§3 the win32 file-in-use hint exists')
  ok(
    /antivirus/.test(win32Hint) && /search indexer/.test(win32Hint) && /retried/.test(win32Hint),
    '§3 the win32 hint names the real actors and the retry',
  )
  ok(!/modes\/ownership/.test(win32Hint), '§3 the win32 hint never sends the operator to chmod')
  ok(src.includes("'permission denied — check file modes/ownership'"), '§3 the POSIX arm keeps the unix guidance')
  ok(src.includes('platform: NodeJS.Platform = process.platform'), '§3 the classifier takes a pinnable platform')
}

{
  const wf = read('.github/workflows/windows-functional.yml')
  ok(wf.includes('scripts/task-durability/run-all.sh'), '§4 windows-functional runs the task-durability suite (win32-native arms)')
}

{
  const distPath = join(ROOT, 'dist', 'mercury.mjs')
  if (!existsSync(distPath)) {
    console.log('  ⚠ §5 SKIPPED — dist/mercury.mjs absent (no build on this leg; the gate dist job + local builds carry the survival proof)')
  }
  if (existsSync(distPath)) {
    const dist = readFileSync(distPath, 'utf8')
    ok(dist.includes(' persisted through '), '§5 the typed-failure accounting message is in the bundle')
    ok(
      dist.includes('exclude the folder from real-time scanning'),
      '§5 the win32 file-in-use guidance is in the bundle',
    )
    ok(dist.includes('[50,100,200]') || dist.includes('[50, 100, 200]'), '§5 the retry schedule is in the bundle')
  }
}

console.log(failures === 0 ? '\nPASS prove-mo5-census-and-artifact' : `\nFAIL prove-mo5-census-and-artifact (${failures})`)
process.exit(failures === 0 ? 0 : 1)
