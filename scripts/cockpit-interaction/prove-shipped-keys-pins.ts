#!/usr/bin/env bun
// gate-watch: src/keybindings/defaultBindings.ts
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const TABLE = join(ROOT, 'src', 'keybindings', 'defaultBindings.ts')
const BASE = 'd4ebc4880b50efc69a20fc7ba7753f0d79492449'

type Block = { context: string; bindings: Record<string, string | null> }

if (process.argv[2] === '--variant') {
  const [platform, runtime, version, table = TABLE] = process.argv.slice(3) as [string, string, string, string?]
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  const versions: Record<string, string | undefined> = { ...process.versions }
  if (runtime === 'bun') versions.bun = version
  else {
    delete versions.bun
    versions.node = version
  }
  Object.defineProperty(process, 'versions', { value: versions, configurable: true })
  const loaded = (await import(table)) as { DEFAULT_BINDINGS: Block[] }
  const shipped = loaded.DEFAULT_BINDINGS
  const first = JSON.stringify(shipped)
  Object.defineProperty(process, 'platform', { value: platform === 'darwin' ? 'win32' : 'darwin', configurable: true })
  const reread = ((await import(table)) as { DEFAULT_BINDINGS: Block[] }).DEFAULT_BINDINGS
  process.stdout.write(
    JSON.stringify({
      exports: Object.keys(loaded).sort(),
      isArray: Array.isArray(shipped),
      blockKeys: shipped.map(block => Object.keys(block)),
      frozen: Object.isFrozen(shipped) || shipped.some(block => Object.isFrozen(block) || Object.isFrozen(block.bindings)),
      distinct: new Set(shipped).size === shipped.length && new Set(shipped.map(block => block.bindings)).size === shipped.length,
      settled: reread === shipped && JSON.stringify(reread) === first,
      table: shipped,
    }),
  )
  process.exit(0)
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

type Form = 'mac' | 'posix' | 'winVt' | 'winLegacy'
const VARIANTS: Array<[platform: string, runtime: 'bun' | 'node', version: string, form: Form]> = [
  ['darwin', 'bun', '1.3.11', 'mac'],
  ['darwin', 'node', '24.20.0', 'mac'],
  ['linux', 'bun', '1.3.11', 'posix'],
  ['linux', 'node', '20.0.0', 'posix'],
  ['freebsd', 'node', '24.20.0', 'posix'],
  ['win32', 'bun', '1.2.22', 'winLegacy'],
  ['win32', 'bun', '1.2.23', 'winVt'],
  ['win32', 'node', '22.16.0', 'winLegacy'],
  ['win32', 'node', '22.17.0', 'winVt'],
  ['win32', 'node', '23.11.0', 'winLegacy'],
  ['win32', 'node', '24.1.0', 'winLegacy'],
  ['win32', 'node', '24.2.0', 'winVt'],
  ['win32', 'node', '24.20.0', 'winVt'],
  ['win32', 'node', '24.2.0-pre', 'winLegacy'],
]
const SUMS: Record<Form, string> = {
  mac: 'da29d29d096aca7ebcb9f2263bfb0d23624eb415a2a8f495c817f854406e1759',
  posix: 'd18c936de40fed61c677d60f4bd512357dda13b1b49cf54ccf27bd241df14e03',
  winVt: 'ccf7a3bb1c34b71a7fa069d43c35a66aea73abbd2dd40627e9cf02046f760f4e',
  winLegacy: 'f8d09fd2ee0f933ebb18707c01fd2b0dbd8209ba5713f6db8df491b85172889f',
}
const CONTEXTS = ['Global', 'Chat', 'Autocomplete', 'Settings', 'Confirmation', 'Tabs', 'Transcript', 'HistorySearch', 'Task', 'ThemePicker', 'Scroll', 'Help', 'Attachments', 'Footer', 'MessageSelector', 'MessageActions', 'DiffDialog', 'Select', 'Extensions', 'Atlas']
const ROWS = [17, 13, 4, 13, 12, 4, 4, 5, 1, 1, 8, 1, 6, 8, 16, 15, 17, 12, 11, 2]
const CHORDS: Record<Form, { modeCycle: string; imagePaste: string; macCopy: boolean }> = {
  mac: { modeCycle: 'shift+tab', imagePaste: 'ctrl+v', macCopy: true },
  posix: { modeCycle: 'shift+tab', imagePaste: 'ctrl+v', macCopy: false },
  winVt: { modeCycle: 'shift+tab', imagePaste: 'alt+v', macCopy: false },
  winLegacy: { modeCycle: 'meta+m', imagePaste: 'alt+v', macCopy: false },
}
const SHOWN = [
  'Chat chat:undo ctrl+shift+-',
  'Settings select:previous ctrl+p',
  'Settings select:next ctrl+n',
  'Confirmation confirm:yes enter',
  'Confirmation confirm:no escape',
  'Tabs tabs:next right',
  'Tabs tabs:previous left',
  'Transcript transcript:exit q',
  'HistorySearch historySearch:accept tab',
  'Scroll scroll:bottom alt+down',
  'Attachments attachments:remove delete',
  'Attachments attachments:exit escape',
  'Footer footer:up ctrl+p',
  'Footer footer:down ctrl+n',
  'MessageSelector messageSelector:up ctrl+p',
  'MessageSelector messageSelector:down ctrl+n',
  'MessageSelector messageSelector:top shift+k',
  'MessageSelector messageSelector:bottom shift+j',
  'MessageActions messageActions:prev k',
  'MessageActions messageActions:next j',
  'MessageActions messageActions:top super+up',
  'MessageActions messageActions:bottom super+down',
  'Select select:previous ctrl+p',
  'Select select:next ctrl+n',
]

type Reading = { exports: string[]; isArray: boolean; blockKeys: string[][]; frozen: boolean; distinct: boolean; settled: boolean; table: Block[] }
const read = (platform: string, runtime: string, version: string, table = TABLE): { reading: Reading | null; error: string } => {
  const run = spawnSync(process.execPath, [import.meta.path, '--variant', platform, runtime, version, table], { encoding: 'utf8', timeout: 60_000 })
  try {
    return { reading: JSON.parse(run.stdout) as Reading, error: '' }
  } catch {
    return { reading: null, error: `rc ${run.status} ${(run.stderr ?? '').trim().split('\n').slice(-2).join(' ')}` }
  }
}
const sum = (table: Block[]): string => createHash('sha256').update(JSON.stringify(table)).digest('hex')
const shown = (table: Block[]): string[] => {
  const rows: string[] = []
  for (const block of table) {
    const counts = new Map<string, number>()
    const last = new Map<string, string>()
    for (const [chord, action] of Object.entries(block.bindings)) {
      counts.set(String(action), (counts.get(String(action)) ?? 0) + 1)
      last.set(String(action), chord)
    }
    for (const [action, n] of counts) if (n > 1) rows.push(`${block.context} ${action} ${last.get(action)}`)
  }
  return rows
}

const readings = new Map<string, Reading>()
section('§1 every platform form of the shipped scheme, read at module load (14 platform and version variants)')
for (const [platform, runtime, version, form] of VARIANTS) {
  const tag = `${platform} ${runtime} ${version}`
  const { reading, error } = read(platform, runtime, version)
  if (!reading) {
    check(`${tag}: the table loads`, false, error)
    continue
  }
  readings.set(tag, reading)
  const table = reading.table
  const chords = CHORDS[form]
  const rows = ROWS.map((n, i) => (CONTEXTS[i] === 'Scroll' && chords.macCopy ? n + 1 : n))
  const chat = Object.entries(table.find(block => block.context === 'Chat')?.bindings ?? {})
  const scroll = Object.entries(table.find(block => block.context === 'Scroll')?.bindings ?? {})
  const expectedShown = chords.macCopy ? [...SHOWN.slice(0, 10), 'Scroll selection:copy cmd+c', ...SHOWN.slice(10)] : SHOWN
  check(
    `${tag} (${form}): the module exports DEFAULT_BINDINGS alone, an array of ${CONTEXTS.length} fresh {context, bindings} blocks in the shipped context order`,
    JSON.stringify(reading.exports) === JSON.stringify(['DEFAULT_BINDINGS']) &&
      reading.isArray &&
      reading.distinct &&
      reading.blockKeys.every(keys => JSON.stringify(keys) === JSON.stringify(['context', 'bindings'])) &&
      JSON.stringify(table.map(block => block.context)) === JSON.stringify(CONTEXTS),
    table.map(block => block.context).join(' '),
  )
  check(`${tag} (${form}): the rows per context`, JSON.stringify(table.map(block => Object.keys(block.bindings).length)) === JSON.stringify(rows), table.map(block => Object.keys(block.bindings).length).join(' '))
  check(
    `${tag} (${form}): mode cycle ${chords.modeCycle} on Chat's 4th row, image paste ${chords.imagePaste} on its 12th, ${chords.macCopy ? 'cmd+c copy last in Scroll' : 'no cmd+c row'}`,
    chat[3]?.[0] === chords.modeCycle &&
      chat[3]?.[1] === 'chat:cycleMode' &&
      chat[11]?.[0] === chords.imagePaste &&
      chat[11]?.[1] === 'chat:imagePaste' &&
      (chords.macCopy ? scroll.at(-1)?.[0] === 'cmd+c' && scroll.at(-1)?.[1] === 'selection:copy' && scroll.at(-2)?.[0] === 'ctrl+shift+c' : !scroll.some(([chord]) => chord === 'cmd+c')),
    JSON.stringify([chat[3], chat[11], scroll.at(-1)]),
  )
  check(`${tag} (${form}): the chord each hint shows (the last one bound per action) for all ${expectedShown.length} multi-chord actions`, JSON.stringify(shown(table)) === JSON.stringify(expectedShown), shown(table).filter(row => !expectedShown.includes(row)).join(' · '))
  check(`${tag} (${form}): mutable as shipped, read once at load (a later platform change moves nothing)`, !reading.frozen && reading.settled)
  check(`${tag} (${form}): byte-equal to the pinned ${form} form`, sum(table) === SUMS[form], sum(table))
}

section('§2 one form per platform class: variants of the same class are byte-equal; the four classes differ')
{
  const byForm = new Map<Form, Set<string>>()
  for (const [platform, runtime, version, form] of VARIANTS) {
    const reading = readings.get(`${platform} ${runtime} ${version}`)
    if (!reading) continue
    const set = byForm.get(form) ?? new Set<string>()
    set.add(JSON.stringify(reading.table))
    byForm.set(form, set)
  }
  check('each class reads one table', [...byForm.values()].every(set => set.size === 1), [...byForm.entries()].map(([form, set]) => `${form}:${set.size}`).join(' '))
  check('the four classes are four different tables', new Set([...byForm.values()].map(set => [...set][0])).size === 4)
}

section(`§3 the differential: the table at ${BASE.slice(0, 10)} and this tree's table read the same on every variant`)
{
  const present = spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${BASE}:src/keybindings/defaultBindings.ts`]).status === 0
  if (!present) {
    console.log(`  [BASE ABSENT] ${BASE.slice(0, 10)} is not in this repository; the pinned sums above stand in for the differential`)
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'shipped-keys-base-'))
    try {
      mkdirSync(join(dir, 'src', 'keybindings'), { recursive: true })
      symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'))
      const baseTable = join(dir, 'src', 'keybindings', 'defaultBindings.ts')
      writeFileSync(baseTable, spawnSync('git', ['-C', ROOT, 'show', `${BASE}:src/keybindings/defaultBindings.ts`], { encoding: 'utf8' }).stdout)
      const drift: string[] = []
      for (const [platform, runtime, version] of VARIANTS) {
        const tag = `${platform} ${runtime} ${version}`
        const base = read(platform, runtime, version, baseTable).reading
        const now = readings.get(tag)
        if (!base || !now || JSON.stringify(base.table) !== JSON.stringify(now.table)) {
          const at = base && now ? base.table.findIndex((block, i) => JSON.stringify(block) !== JSON.stringify(now.table[i])) : -1
          drift.push(`${tag}${at >= 0 ? ` first differs at ${base?.table[at]?.context}` : ''}`)
        }
      }
      check(`every variant reads byte-equal to the ${BASE.slice(0, 10)} table`, drift.length === 0, drift.join(' · '))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

console.log(failures === 0 ? '\nprove-shipped-keys-pins: ALL PASS' : `\nprove-shipped-keys-pins: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
