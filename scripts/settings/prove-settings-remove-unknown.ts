#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stringWidth from 'string-width'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

if (existsSync('/private/tmp/mw')) process.env.TMPDIR = '/private/tmp/mw'
const pinnedHome = pinScratchHome('settings-remove-unknown')
const home = realpathSync(pinnedHome)
const project = realpathSync(mkdtempSync(join(tmpdir(), 'settings-remove-unknown-project-')))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const name of ['MERCURY_HOME', 'MERCURY_SETTINGS', 'NODE_ENV']) delete process.env[name]
const launchDir = process.cwd()
process.chdir(project)

const framesAt = process.argv.indexOf('--frames')
const framesDir = framesAt < 0 ? undefined : process.argv[framesAt + 1]
if (framesDir) mkdirSync(framesDir, { recursive: true })
const frames: string[] = []
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok || !detail ? '' : ` — ${detail}`}`)
}
const section = (title: string): void => console.log(`\n${title}`)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { getSettingsWithErrors, getInitialSettings } = await import('../../src/utils/settings/settings.js')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const { settingsSchemaLocalPath } = await import('../../src/utils/settings/localSchema.js')
const { launchInvalidSettingsDialog } = await import('../../src/dialogLaunchers.js')
const removal = await import('../../src/utils/settings/unknownKeyRemoval.ts').catch(() => null)

const userFile = join(home, 'settings.json')
const projectFile = join(project, '.mercury', 'settings.json')
const REMOVE = 'Remove these fields and continue'
const CONTINUE = 'Continue without these settings'
const EXIT = 'Exit and fix manually'
const REMOVE_WORDS = 'Removing deletes the unrecognized fields from the file where they sit and keeps every other setting.'

const ONE = 'zzFirstUnknownKey'
const TWO = 'zzSecondUnknownKey'
const twoUnknownFile = (): string =>
  [
    '{',
    `  "$schema": ${JSON.stringify(settingsSchemaLocalPath())},`,
    `  "${ONE}": "first",`,
    `  "${TWO}": "second",`,
    '  "engine": {',
    '    "effort": "high"',
    '  },',
    '  "view": {',
    '    "reducedMotion": true',
    '  }',
    '}',
    '',
  ].join('\n')
const withoutUnknown = (text: string): string => text.split('\n').filter(line => !line.startsWith(`  "${ONE}": `) && !line.startsWith(`  "${TWO}": `)).join('\n')

const seed = (user: string, projectText?: string): void => {
  writeFileSync(userFile, user)
  mkdirSync(join(project, '.mercury'), { recursive: true })
  rmSync(projectFile, { force: true })
  if (projectText !== undefined) writeFileSync(projectFile, projectText)
  resetSettingsCache()
}
const loadErrors = () => getSettingsWithErrors().errors.filter(error => error.mcpErrorMetadata === undefined)

type Dialog = { m: Mounted; outcome: Promise<'continued' | 'exited'>; exits: () => number }
const open = async (errors: ReturnType<typeof loadErrors>, cols: number, rows: number, title: string): Promise<Dialog> => {
  let settleMount: (m: Mounted) => void = () => {}
  const mounted = new Promise<Mounted>(resolve => {
    settleMount = resolve
  })
  let exits = 0
  const root = { render: (element: unknown) => void mountOffscreen(element, cols, rows).then(settleMount) }
  let settleExit: () => void = () => {}
  const exited = new Promise<'exited'>(resolve => {
    settleExit = () => resolve('exited')
  })
  const continued = launchInvalidSettingsDialog(root as never, {
    settingsErrors: errors,
    onExit: () => {
      exits++
      settleExit()
    },
  }).then(() => 'continued' as const)
  const m = await mounted
  check(`the dialog paints its title (${title})`, await waitFor(() => m.screen().includes(title), 4000), m.screen().slice(0, 400))
  await settle(450)
  return { m, outcome: Promise.race([continued, exited]), exits: () => exits }
}
const body = (line: string): string => line.replace(/^\s*│\s?/, '').replace(/\s?│\s*$/, '').trimEnd()
const optionRows = (m: Mounted): string[] => m.lines().map(body).filter(line => /^\s*(?:[❯›>]\s*)?\d\.\s/.test(line.trim()) || /\d\.\s(Remove|Continue|Exit|Fix)/.test(line))
const labelsOf = (rows: string[]): string[] => rows.map(row => row.replace(/^.*?\d\.\s+/, '').trim())
const focusedOf = (rows: string[]): string | undefined => labelsOf(rows.filter(row => /[❯›>]/.test(row.split(/\d\./)[0] ?? '')))[0]
const keep = (name: string, m: Mounted, cols: number, rows: number): void => {
  const lines = m.lines()
  check(`${name}: fits ${cols}x${rows} with no render error`, lines.length <= rows && lines.every(line => stringWidth(line) <= cols) && !m.screen().includes('RENDER ERROR'), `${lines.length} lines · widest ${Math.max(...lines.map(line => stringWidth(line)))}`)
  frames.push(`${name}.txt`)
  if (framesDir) writeFileSync(join(framesDir, `${name}.txt`), lines.join('\n') + '\n')
}
const settledOutcome = async (dialog: Dialog): Promise<string> => Promise.race([dialog.outcome, settle(4000).then(() => 'still open' as const)])

try {
  section('§1 two unknown top-level keys beside valid ones load as one warning that names its keys and can be removed from the user file')
  seed(twoUnknownFile())
  const errors = loadErrors()
  const unknown = errors.find(error => error.path === '' && /^Unrecognized fields: /.test(error.message))
  check('one root warning lists the two keys', errors.length === 1 && unknown?.severity === 'warning' && unknown.message === `Unrecognized fields: ${ONE}, ${TWO}`, JSON.stringify(errors))
  check('the warning carries the key names as data, not only as words', JSON.stringify(unknown?.unknownKeys) === JSON.stringify([ONE, TWO]), JSON.stringify(unknown))
  check('the removal module names the user file and exactly the two keys', removal !== null && JSON.stringify(removal.removableUnknownKeys(errors)) === JSON.stringify([{ source: 'userSettings', file: userFile, keys: [ONE, TWO] }]), removal === null ? 'module absent' : JSON.stringify(removal.removableUnknownKeys(errors)))

  section('§2 the first screen: remove leads the list with Enter on it, continue and exit follow; Enter removes the two keys and the session continues')
  for (const [cols, rows] of [[100, 32], [80, 24]] as const) {
    const tag = `${cols}x${rows}`
    seed(twoUnknownFile())
    const before = readFileSync(userFile, 'utf8')
    const dialog = await open(loadErrors(), cols, rows, 'Settings Warning')
    const rowsSeen = optionRows(dialog.m)
    check(`${tag}: the list reads remove, continue, exit — in that order, nothing else`, JSON.stringify(labelsOf(rowsSeen)) === JSON.stringify([REMOVE, CONTINUE, EXIT]), JSON.stringify(rowsSeen))
    check(`${tag}: the focus sits on the remove row`, focusedOf(rowsSeen) === REMOVE, JSON.stringify(rowsSeen))
    check(`${tag}: the list names the file and its two unrecognized fields`, dialog.m.screen().includes(`Unrecognized fields: ${ONE}, ${TWO}`) && dialog.m.screen().includes('settings.json'))
    check(`${tag}: the footer says once what removing does`, dialog.m.lines().map(body).join(' ').replace(/\s+/g, ' ').includes(REMOVE_WORDS) && dialog.m.screen().split('Removing deletes').length === 2)
    keep(`first-screen-${tag}`, dialog.m, cols, rows)
    dialog.m.push(KEY.enter)
    const outcome = await settledOutcome(dialog)
    check(`${tag}: Enter continues the session without exiting`, outcome === 'continued' && dialog.exits() === 0, outcome)
    const after = readFileSync(userFile, 'utf8')
    check(`${tag}: the two keys are gone and every other byte stays (indent, order, trailing newline)`, after === withoutUnknown(before), JSON.stringify({ before, after }))
    resetSettingsCache()
    const reloaded = getSettingsWithErrors()
    check(`${tag}: the file now loads clean and its other settings apply`, reloaded.errors.length === 0 && getInitialSettings().engine?.effort === 'high' && getInitialSettings().view?.reducedMotion === true, JSON.stringify(reloaded.errors))
    dialog.m.unmount()
  }

  section('§3 esc keeps its law: on a warning it continues and the file is untouched')
  {
    seed(twoUnknownFile())
    const before = readFileSync(userFile, 'utf8')
    const dialog = await open(loadErrors(), 100, 32, 'Settings Warning')
    dialog.m.push(KEY.esc)
    const outcome = await settledOutcome(dialog)
    check('esc continues', outcome === 'continued' && dialog.exits() === 0, outcome)
    check('the file keeps every byte', readFileSync(userFile, 'utf8') === before)
    dialog.m.unmount()
  }

  section('§4 not offered: an invalid value with no unknown key keeps the three choices, continue first')
  {
    seed(`${JSON.stringify({ $schema: settingsSchemaLocalPath(), records: { retentionDays: '30' }, view: { reducedMotion: true } }, null, 2)}\n`)
    const errors = loadErrors()
    check('the invalid value is one warning with no key list', errors.length === 1 && errors[0]?.severity === 'warning' && errors[0]?.unknownKeys === undefined, JSON.stringify(errors))
    check('the removal module offers nothing', removal !== null && removal.removableUnknownKeys(errors).length === 0)
    const dialog = await open(errors, 100, 32, 'Settings Warning')
    const rowsSeen = optionRows(dialog.m)
    check('the list reads continue, exit — today\'s shape', JSON.stringify(labelsOf(rowsSeen)) === JSON.stringify([CONTINUE, EXIT]) && focusedOf(rowsSeen) === CONTINUE, JSON.stringify(rowsSeen))
    check('the footer does not speak of removing', !dialog.m.screen().includes('Removing deletes'))
    keep('invalid-value-only-100x32', dialog.m, 100, 32)
    dialog.m.push(KEY.esc)
    check('esc continues here too', (await settledOutcome(dialog)) === 'continued')
    dialog.m.unmount()
  }

  section('§5 a field inside a group is offered like a root key and removed where it sits: its siblings and the rest of the file keep every byte')
  {
    const NESTED = 'zzNestedUnknownKey'
    const nestedFile = [
      '{',
      `  "$schema": ${JSON.stringify(settingsSchemaLocalPath())},`,
      '  "view": {',
      `    "${NESTED}": true,`,
      '    "reducedMotion": true',
      '  },',
      '  "engine": {',
      '    "effort": "high"',
      '  }',
      '}',
      '',
    ].join('\n')
    seed(nestedFile)
    const nested = loadErrors()
    check('the nested unknown key is one warning at its group path', nested.length === 1 && nested[0]?.severity === 'warning' && nested[0]?.path === 'view' && JSON.stringify(nested[0]?.unknownKeys) === JSON.stringify([NESTED]), JSON.stringify(nested))
    check('the removal module offers it under its group path', removal !== null && JSON.stringify(removal.removableUnknownKeys(nested)) === JSON.stringify([{ source: 'userSettings', file: userFile, keys: [`view.${NESTED}`] }]), removal === null ? 'module absent' : JSON.stringify(removal.removableUnknownKeys(nested)))
    const dialog = await open(nested, 100, 32, 'Settings Warning')
    const rowsSeen = optionRows(dialog.m)
    check('the list reads remove, continue, exit with the focus on remove', JSON.stringify(labelsOf(rowsSeen)) === JSON.stringify([REMOVE, CONTINUE, EXIT]) && focusedOf(rowsSeen) === REMOVE, JSON.stringify(rowsSeen))
    check('the footer says what removing does', dialog.m.lines().map(body).join(' ').replace(/\s+/g, ' ').includes(REMOVE_WORDS))
    keep('nested-key-100x32', dialog.m, 100, 32)
    dialog.m.push(KEY.enter)
    check('Enter continues the session without exiting', (await settledOutcome(dialog)) === 'continued' && dialog.exits() === 0)
    const after = readFileSync(userFile, 'utf8')
    check('exactly the nested field is gone; its sibling and every other byte stay (indent, order, trailing newline)', after === nestedFile.split('\n').filter(line => !line.startsWith(`    "${NESTED}": `)).join('\n'), JSON.stringify({ before: nestedFile, after }))
    resetSettingsCache()
    const reloaded = getSettingsWithErrors()
    check('the file now loads clean and its other settings apply', reloaded.errors.length === 0 && getInitialSettings().view?.reducedMotion === true && getInitialSettings().engine?.effort === 'high', JSON.stringify(reloaded.errors))
    dialog.m.unmount()

    seed(`${JSON.stringify({ $schema: settingsSchemaLocalPath(), [ONE]: 'x', engine: { modell: 'x', effort: 'high' } }, null, 2)}\n`)
    const mixed = loadErrors()
    check('a root key and a nested typo are offered together, each under its own path', removal !== null && JSON.stringify(removal.removableUnknownKeys(mixed).map(r => [...r.keys].sort())) === JSON.stringify([['engine.modell', ONE]]), JSON.stringify(mixed))
    const both = await open(mixed, 100, 32, 'Settings Warning')
    check('the list leads with remove', focusedOf(optionRows(both.m)) === REMOVE)
    both.m.push(KEY.enter)
    check('Enter continues', (await settledOutcome(both)) === 'continued')
    const afterBoth = JSON.parse(readFileSync(userFile, 'utf8')) as Record<string, unknown>
    check('the root key and engine.modell are gone; engine.effort stays as written', afterBoth[ONE] === undefined && JSON.stringify(afterBoth.engine) === JSON.stringify({ effort: 'high' }), readFileSync(userFile, 'utf8'))
    both.m.unmount()

    seed(`${JSON.stringify({ $schema: settingsSchemaLocalPath(), view: { [NESTED]: true }, engine: { effort: 'high' } }, null, 2)}\n`)
    const only = loadErrors()
    check('a group holding only the unknown field is offered the same way', removal !== null && JSON.stringify(removal.removableUnknownKeys(only).map(r => r.keys)) === JSON.stringify([[`view.${NESTED}`]]))
    check('removing it writes clean', removal !== null && removal.removeUnknownKeys(removal.removableUnknownKeys(only)) === null)
    const afterOnly = JSON.parse(readFileSync(userFile, 'utf8')) as Record<string, unknown>
    check('the field is gone and the emptied group leaves with it; engine stays as written', afterOnly.view === undefined && JSON.stringify(afterOnly.engine) === JSON.stringify({ effort: 'high' }), readFileSync(userFile, 'utf8'))

    const arrayPath = [{ file: userFile, path: 'hooks.PreToolUse.0', message: 'Unrecognized field: extra', unknownKeys: ['extra'], severity: 'warning' as const }]
    check('a field under an array element is not offered (the writer replaces arrays whole)', removal !== null && removal.removableUnknownKeys(arrayPath).length === 0)
  }

  section('§6 a hard error elsewhere: recovery still leads and esc exits; remove is offered for the file that only warns and leaves the broken file alone')
  {
    seed(twoUnknownFile(), '{nope')
    const errors = loadErrors()
    check('the user file warns and the project file fails whole', errors.some(error => error.file === userFile && error.severity === 'warning') && errors.some(error => error.file === projectFile && error.severity !== 'warning'), JSON.stringify(errors.map(error => [error.file, error.severity ?? 'hard'])))
    check('the offer names the user file only', removal !== null && JSON.stringify(removal.removableUnknownKeys(errors).map(r => [r.source, r.keys])) === JSON.stringify([['userSettings', [ONE, TWO]]]))
    const dialog = await open(errors, 100, 32, 'Settings Error')
    const rowsSeen = optionRows(dialog.m)
    check('the list reads exit, remove, continue — recovery first, Enter on exit', JSON.stringify(labelsOf(rowsSeen)) === JSON.stringify([EXIT, REMOVE, CONTINUE]) && focusedOf(rowsSeen) === EXIT, JSON.stringify(rowsSeen))
    keep('hard-error-beside-100x32', dialog.m, 100, 32)
    dialog.m.push(KEY.down)
    await settle(80)
    check('one step down reaches remove', focusedOf(optionRows(dialog.m)) === REMOVE, JSON.stringify(optionRows(dialog.m)))
    dialog.m.push(KEY.enter)
    check('Enter on remove continues', (await settledOutcome(dialog)) === 'continued' && dialog.exits() === 0)
    check('the user file lost exactly the two keys', readFileSync(userFile, 'utf8') === withoutUnknown(twoUnknownFile()), readFileSync(userFile, 'utf8'))
    check('the broken project file keeps its bytes', readFileSync(projectFile, 'utf8') === '{nope')
    dialog.m.unmount()

    seed(twoUnknownFile(), '{nope')
    const again = await open(loadErrors(), 100, 32, 'Settings Error')
    again.m.push(KEY.esc)
    check('esc on the hard-error dialog exits', (await settledOutcome(again)) === 'exited' && again.exits() === 1)
    check('and nothing was written', readFileSync(userFile, 'utf8') === twoUnknownFile())
    again.m.unmount()
  }
} finally {
  if (framesDir) writeFileSync(join(framesDir, 'index.txt'), ['Source renders of the settings dialog (no PTY): the warning for two unknown top-level keys with remove first, the invalid-value-only dialog that offers no removal, a field inside a group offered the same way, and the hard-error dialog beside a file that only warns.', ...frames].join('\n') + '\n')
  process.chdir(launchDir)
  await releaseScratchHome(pinnedHome)
  rmSync(project, { recursive: true, force: true })
}
console.log(`\nprove-settings-remove-unknown: ${frames.length} frames; ${failures ? `${failures} FAILED` : 'ALL PASS'}`)
process.exit(failures ? 1 : 0)
