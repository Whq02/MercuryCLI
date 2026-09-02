#!/usr/bin/env bun
// ============================================================================
//  prove-parity2-render-economy — frontier-sweep #2, the rendering
//  and cache/perf/economy tiers, mechanism-pinned:
//
//   1. The quiet update notice (item 81): first boot lists and notifies;
//      a same-day boot notifies from the cache with NO listing; a current
//      install caches and says nothing; every failure is silent; a
//      newly-installed version invalidates the cached answer; the check is
//      bounded by the inactivity deadline; the flag disables it entirely.
//   2. Long paths middle-truncate in the file tools' summary lines so the
//      filename survives (packet 3).
//   3. Tight lists stack, nest and hang their source continuations; a
//      horizontal rule ends its own line (packets 8 + 11 — the S32 rewrite
//      dropped the item newline; captured before/after in the receipt).
//   4. Every spinner frame set is stable-width (packet 16).
//   5. The skill listing's per-entry cap and budget (S3 D33, already-differs).
//   6. The sync-output gate upgrades from the live DECRQM probe, not a
//      terminal table (packet 80, already-differs).
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'parity2-render-'))
const home = join(SCRATCH, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.MERCURY_HOME

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// —— 1. the quiet update notice ————————————————————————————————————————
{
  const { runQuietUpdateCheck, decideQuietCheck, updateNoticeText, readUpdateNoticeCache, writeUpdateNoticeCache, updateNoticeCachePath, UPDATE_NOTICE_DAILY_MS, scheduleQuietUpdateNotice } =
    await import('../../src/services/privateChannel/quietUpdateNotice.ts')
  const { flagEnabled } = await import('../../src/substrate/flagRegistry.ts')
  const cachePath = updateNoticeCachePath(home)
  let listings = 0
  const notices: string[] = []
  const mk = (outcome: unknown, now: number, running = '1.0.0-beta.1') => ({
    check: async () => {
      listings++
      return outcome as never
    },
    readCache: () => readUpdateNoticeCache(cachePath),
    writeCache: (c: Parameters<typeof writeUpdateNoticeCache>[0]) => writeUpdateNoticeCache(c, cachePath),
    notify: (text: string) => notices.push(text),
    now: () => now,
    runningVersion: running,
  })
  const available = { state: 'update-available', installed: '1.0.0-beta.1', tag: 'v1.0.0-beta.2', version: '1.0.0-beta.2', assetName: 'x', channelRepo: 'r' }
  const day0 = 1_700_000_000_000
  t('first boot: lists once and notifies the calm line', (await runQuietUpdateCheck(mk(available, day0))) === 'notified' && listings === 1 && notices[0] === updateNoticeText('1.0.0-beta.2'))
  t('the line is the one calm sentence', notices[0] === 'v1.0.0-beta.2 available — mercury update')
  t('same-day boot: notifies from the cache with NO listing', (await runQuietUpdateCheck(mk(available, day0 + 3_600_000))) === 'notified-from-cache' && listings === 1 && notices.length === 2)
  t('next-day boot: lists again', (await runQuietUpdateCheck(mk(available, day0 + UPDATE_NOTICE_DAILY_MS + 1))) === 'notified' && listings === 2)
  t('the update was installed: a new running version invalidates the cache and the current answer says nothing',
    (await runQuietUpdateCheck(mk({ state: 'current', installed: '1.0.0-beta.2', channelRepo: 'r' }, day0 + UPDATE_NOTICE_DAILY_MS + 2, '1.0.0-beta.2'))) === 'current' && listings === 3 && notices.length === 3)
  t('a current install within the day skips silently', (await runQuietUpdateCheck(mk(available, day0 + UPDATE_NOTICE_DAILY_MS + 3, '1.0.0-beta.2'))) === 'skipped' && listings === 3)
  rmSync(cachePath, { force: true })
  t('access unavailable: silent, uncached', (await runQuietUpdateCheck(mk({ state: 'access-unavailable', access: { state: 'gh-missing', note: 'n', remedy: 'r' } }, day0))) === 'failed' && notices.length === 3 && readUpdateNoticeCache(cachePath) === null)
  t('a throwing listing is silent', (await runQuietUpdateCheck({ ...mk(available, day0), check: async () => { throw new Error('offline') } })) === 'failed' && notices.length === 3)
  const hung = await runQuietUpdateCheck({ ...mk(available, day0), check: () => new Promise<never>(() => {}), limitMs: 40 })
  t('a hung gh is abandoned silently by the inactivity deadline', hung === 'failed')
  t('decision table: no cache ⇒ check', decideQuietCheck(null, day0, 'x').action === 'check')
  t('decision table: stale cache ⇒ check', decideQuietCheck({ schema: 1, checkedAtMs: day0 - UPDATE_NOTICE_DAILY_MS - 1, runningVersion: 'x' }, day0, 'x').action === 'check')
  t('the registered flag is on by default', flagEnabled('MERCURY_UPDATE_NOTICE'))
  process.env.MERCURY_UPDATE_NOTICE = '0'
  let armed = false
  const disarm = scheduleQuietUpdateNotice(() => {
    armed = true
  }, { delayMs: 1 })
  await new Promise(r => setTimeout(r, 30))
  disarm()
  t('MERCURY_UPDATE_NOTICE=0 never arms the check', !armed)
  delete process.env.MERCURY_UPDATE_NOTICE
  const repl = readFileSync('src/screens/REPL.tsx', 'utf8')
  t('the REPL arms the notice after mount with the existing notice surface (structural)', /scheduleQuietUpdateNotice\(text =>\s*addNotification\(\{ key: UPDATE_NOTICE_KEY/.test(repl))
  // The shipped terminal-runtime doc is the one that states what the notice
  // sends and how it is disabled (the developer guide left the repository).
  const doc = readFileSync('docs/TERMINAL-RUNTIME.md', 'utf8')
  t('the runtime doc states exactly what the check sends', /sends nothing about the machine or the\s+operator/.test(doc) && /MERCURY_UPDATE_NOTICE=0/.test(doc))
}

// —— 2. middle-truncated paths ———————————————————————————————————————————
{
  const { truncatePathMiddle } = await import('../../src/utils/truncate.ts')
  const long = 'src/components/permissions/FilePermissionDialog/useFilePermissionDialog.ts'
  const shown = truncatePathMiddle(long, 50)
  t('a long path keeps its filename and its root', shown.endsWith('/useFilePermissionDialog.ts') && shown.startsWith('src/') && shown.includes('…'), shown)
  for (const file of ['src/tools/FileReadTool/UI.tsx', 'src/tools/FileEditTool/UI.tsx', 'src/tools/FileWriteTool/UI.tsx']) {
    const source = readFileSync(file, 'utf8')
    t(`${file} summarizes its path by middle truncation`, source.includes('truncatePathMiddle(getDisplayPath(input.file_path), TOOL_SUMMARY_MAX_LENGTH)'))
  }
}

// —— 3. lists and rules ————————————————————————————————————————————————
{
  const { applyMarkdown } = await import('../../src/utils/markdown.ts')
  const render = (src: string) => applyMarkdown(src, 'dark', null, 60)
  t('a tight list stacks one item per line', render('- one\n- two\n- three') === '- one\n- two\n- three')
  t('a nested tight list indents its children', render('- one\n  - nested a\n  - nested b\n- two') === '- one\n  - nested a\n  - nested b\n- two')
  t('a source continuation line hangs under the item text', render('1. first\n   continuation\n2. second') === '1. first\n   continuation\n2. second')
  t('a rule never collides with the following paragraph', render('above\n\n---\nbelow') === 'above\n\n---\nbelow')
  t('a rule directly before a list still ends its line', render('---\n- item') === '---\n- item')
  t('a loose list keeps its paragraph form', render('- one\n\n- two').split('\n').filter(l => l.startsWith('- ')).length === 2)
}

// —— 3b. content caps land on grapheme boundaries (packet 77) ————————————
{
  const { sliceHeadAtGrapheme, sliceTailAtGrapheme } = await import('../../src/utils/intl.ts')
  const emoji = '🎉' // two code units
  const text = `ab${emoji}cd`
  t('a head cut that would split a surrogate pair snaps before it', sliceHeadAtGrapheme(text, 3) === 'ab')
  t('a head cut after the pair keeps it whole', sliceHeadAtGrapheme(text, 4) === `ab${emoji}`)
  t('a tail cut that would split the pair snaps after it', sliceTailAtGrapheme(text, 3) === 'cd')
  const flag = '🇯🇵' // two regional indicators, four code units, one grapheme
  t('a multi-code-point cluster is never split (head)', sliceHeadAtGrapheme(`x${flag}y`, 3) === 'x')
  t('a multi-code-point cluster is never split (tail)', sliceTailAtGrapheme(`x${flag}y`, 3) === 'y')
  t('text within the cap is untouched', sliceHeadAtGrapheme('short', 100) === 'short' && sliceTailAtGrapheme('short', 100) === 'short')
  const { generatePreview } = await import('../../src/utils/toolResultStorage.ts')
  const big = `${'a'.repeat(2_000)}${emoji}${'b'.repeat(2_000)}`
  const preview = generatePreview(big, 2_003).preview
  t('a tool-result preview never carries a lone surrogate', !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(preview))
  const { boundHookContext } = await import('../../src/utils/hooks/contextBound.ts')
  const hooked = boundHookContext(`${'h'.repeat(16_800)}${emoji}${'t'.repeat(8_000)}`, 'grapheme-probe', 24_000)
  t('the hook-context bound never carries a lone surrogate', !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(hooked.text))
}

// —— 4. spinner frames are stable-width ——————————————————————————————————
{
  const { stringWidth } = await import('../../src/ink/stringWidth.ts')
  const { BRIDGE_SPINNER_FRAMES } = await import('../../src/constants/figures.ts')
  const { getDefaultCharacters } = await import('../../src/components/Spinner/utils.ts')
  const sets: Array<[string, readonly string[]]> = [
    ['bridge', BRIDGE_SPINNER_FRAMES as readonly string[]],
    ['default', getDefaultCharacters() as readonly string[]],
    ['star', ['✶', '✸', '✹', '✺', '✹', '✷']],
  ]
  for (const [name, frames] of sets) {
    const widths = new Set(frames.map(f => stringWidth(f)))
    t(`spinner set "${name}" is stable-width`, widths.size === 1, `${[...widths].join(',')} over ${frames.length} frames`)
  }
}

// —— 5. skill listing cap (D33, already-differs) ———————————————————————
{
  const { formatCommandsWithinBudget } = await import('../../src/tools/SkillTool/prompt.ts')
  const huge = 'x'.repeat(5_000)
  const line = formatCommandsWithinBudget([{ name: 'big-skill', description: huge } as never], 1_000_000)
  t('an oversized skill description is hard-capped per entry', line.length < 300 && line.endsWith('…'), `${line.length} chars`)
}

// —— 6. sync-output capability truth (packet 80, already-differs) ————————
{
  const caps = readFileSync('src/ink/session/capabilities.ts', 'utf8')
  // Capability is split from emission: the probe upgrade RECORDS even
  // under the MERCURY_NO_SYNC_OUTPUT hatch (the requirement card's
  // self-clearing rescue depends on it) and the hatch keeps gating emission
  // at every read — the old early-return under the hatch was the defect.
  t('the sync-output latch upgrades from the live DECRQM 2026 probe (structural)', /export function upgradeSyncOutputSupport\(\): void \{[\s\S]{0,400}?syncOutputSupported = true\s*\n\s*syncUpgradedByProbe = true/.test(caps) && !/upgradeSyncOutputSupport\(\): void \{\s*if \(isSyncOutputForcedOff\(\)\) return/.test(caps))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? '\nFAILURES' : '\nALL GREEN')
process.exit(failures)
