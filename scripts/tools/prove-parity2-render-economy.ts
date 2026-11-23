#!/usr/bin/env bun
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
let failHint = ''
const t = (name: string, ok: boolean, detail = ''): void => {
  const shown = ok ? detail : [detail, failHint].filter(Boolean).join(' | ')
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${shown ? ` — ${shown}` : ''}`)
  if (!ok) failures = 1
}

{
  failHint = 'change the quiet update check in src/platform/update-channel/quietUpdateNotice.ts (runQuietUpdateCheck, decideQuietCheck, updateNoticeText, scheduleQuietUpdateNotice) or the MERCURY_UPDATE_NOTICE flag in the flag registry (FLAG_REGISTRY)'
  const { runQuietUpdateCheck, decideQuietCheck, updateNoticeText, readUpdateNoticeCache, writeUpdateNoticeCache, updateNoticeCachePath, UPDATE_NOTICE_DAILY_MS, scheduleQuietUpdateNotice } =
    await import('../../src/platform/update-channel/quietUpdateNotice.ts')
  const { flagEnabled } = await import('../../src/platform/substrate/flagRegistry.ts')
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
  failHint = 'edit docs/TERMINAL-RUNTIME.md so it says the update check sends nothing about the machine or the operator and names MERCURY_UPDATE_NOTICE=0'
  const doc = readFileSync('docs/TERMINAL-RUNTIME.md', 'utf8')
  t('the runtime doc states exactly what the check sends', /sends nothing about the machine or the\s+operator/.test(doc) && /MERCURY_UPDATE_NOTICE=0/.test(doc))
}

{
  failHint = 'fix truncatePathMiddle in src/platform/text/truncate.ts so a long path keeps its root and filename and puts the ellipsis in the middle'
  const { truncatePathMiddle } = await import('../../src/platform/text/truncate.ts')
  const long = 'src/permissions/cards/file-dialog/useFilePermissionDialog.ts'
  const shown = truncatePathMiddle(long, 50)
  t('a long path keeps its filename and its root', shown.endsWith('/useFilePermissionDialog.ts') && shown.startsWith('src/') && shown.includes('…'), shown)
}

{
  failHint = 'fix the list and rule spacing in applyMarkdown in src/screen/messages/markdownText.ts'
  const { applyMarkdown } = await import('../../src/screen/messages/markdownText.ts')
  const render = (src: string) => applyMarkdown(src, 'dark', null, 60)
  t('a tight list stacks one item per line', render('- one\n- two\n- three') === '- one\n- two\n- three')
  t('a nested tight list indents its children', render('- one\n  - nested a\n  - nested b\n- two') === '- one\n  - nested a\n  - nested b\n- two')
  t('a source continuation line hangs under the item text', render('1. first\n   continuation\n2. second') === '1. first\n   continuation\n2. second')
  t('a rule never collides with the following paragraph', render('above\n\n---\nbelow') === 'above\n\n---\nbelow')
  t('a rule directly before a list still ends its line', render('---\n- item') === '---\n- item')
  t('a loose list keeps its paragraph form', render('- one\n\n- two').split('\n').filter(l => l.startsWith('- ')).length === 2)
}

{
  failHint = 'cut at grapheme boundaries in src/platform/text/textSegments.ts (sliceHeadAtGrapheme, sliceTailAtGrapheme), and make generatePreview in src/engine/tool-dispatch/toolResultStorage.ts and boundHookContext in src/integrations/event-hooks/contextBound.ts use them'
  const { sliceHeadAtGrapheme, sliceTailAtGrapheme } = await import('../../src/platform/text/textSegments.ts')
  const emoji = '🎉'
  const text = `ab${emoji}cd`
  t('a head cut that would split a surrogate pair snaps before it', sliceHeadAtGrapheme(text, 3) === 'ab')
  t('a head cut after the pair keeps it whole', sliceHeadAtGrapheme(text, 4) === `ab${emoji}`)
  t('a tail cut that would split the pair snaps after it', sliceTailAtGrapheme(text, 3) === 'cd')
  const flag = '🇯🇵'
  t('a multi-code-point cluster is never split (head)', sliceHeadAtGrapheme(`x${flag}y`, 3) === 'x')
  t('a multi-code-point cluster is never split (tail)', sliceTailAtGrapheme(`x${flag}y`, 3) === 'y')
  t('text within the cap is untouched', sliceHeadAtGrapheme('short', 100) === 'short' && sliceTailAtGrapheme('short', 100) === 'short')
  const { generatePreview } = await import('../../src/engine/tool-dispatch/toolResultStorage.ts')
  const big = `${'a'.repeat(2_000)}${emoji}${'b'.repeat(2_000)}`
  const preview = generatePreview(big, 2_003).preview
  t('a tool-result preview never carries a lone surrogate', !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(preview))
  const { boundHookContext } = await import('../../src/integrations/event-hooks/contextBound.ts')
  const hooked = boundHookContext(`${'h'.repeat(16_800)}${emoji}${'t'.repeat(8_000)}`, 'grapheme-probe', 24_000)
  t('the hook-context bound never carries a lone surrogate', !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(hooked.text))
}

{
  failHint = 'make every frame of the failing spinner set one terminal width: BRIDGE_SPINNER_FRAMES in src/screen/theme/rowGlyphs.ts or getDefaultCharacters in src/screen/spinner/glyphsAndColors.ts'
  const { stringWidth } = await import('../../src/screen/renderer/stringWidth.ts')
  const { BRIDGE_SPINNER_FRAMES } = await import('../../src/screen/theme/rowGlyphs.ts')
  const { getDefaultCharacters } = await import('../../src/screen/spinner/glyphsAndColors.ts')
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

{
  failHint = 'cap each skill description in formatCommandsWithinBudget in src/engine/attachments/skillListingFormat.ts (the entry must end with an ellipsis and stay under 300 chars)'
  const { formatCommandsWithinBudget } = await import('../../src/engine/attachments/skillListingFormat.ts')
  const huge = 'x'.repeat(5_000)
  const line = formatCommandsWithinBudget([{ name: 'big-skill', description: huge } as never], 1_000_000)
  t('an oversized skill description is hard-capped per entry', line.length < 300 && line.endsWith('…'), `${line.length} chars`)
}


rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? '\nFAILURES' : '\nALL GREEN')
process.exit(failures)
