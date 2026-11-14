#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withProofAccountHome } from '../lib/proofAccountHome.ts'
import { KEY, pinScratchHome, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { CARD_COLUMNS, CARD_ROWS, openPanelCard, type PanelCard } from './fixtures/panelCard.ts'
import { GIB, QWEN_2B_REPO } from './fixtures/world.ts'

withProofAccountHome('tensorfold-refusal-window-')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const FRAMES = argAfter('--frames')
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })
const home = pinScratchHome('tensorfold-refusal-window')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const fit = await import('../../src/services/tensorfold/fit.ts')
const starting = await import('../../src/services/tensorfold/starting.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const save = (name: string, p: PanelCard): void => {
  if (FRAMES === undefined) return
  writeFileSync(join(FRAMES, `${name}-${CARD_COLUMNS}x${CARD_ROWS}.txt`), p.lines().map(line => line.replace(/\s+$/, '')).join('\n') + '\n')
}
const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`

section('1 · the card the Windows machine showed (Mercury\'s engine, 16 GB, the 4B): refused at 128k, the window moved to 64k and to 32k')
{
  const free = 7.4 * GIB
  const REFUSAL = 'refused 9.6 GiB needed · 7.4 GiB free on this machine'
  const p = await openPanelCard({ road: 'adapter', label: 'Qwen3.5 4B', prefix: 'tf-refusal-adapter', free: () => free })
  const before = p.card()
  check('the 4B stands on disk at 128k, the largest window that fits 16 GB', before.row === 'Qwen3.5 4B local/qwen3.5-4b on disk 128k ctx 9.6 GiB' && before.strip.includes('[128k]') && before.legend.includes('↵ serve and switch'), before.all)
  await p.press(KEY.enter)
  await p.until(card => card.refused !== undefined, 10_000)
  const refused = p.card()
  save('adapter-refused-at-128k', p)
  check('↵ at 128k is refused: 9.6 GiB needed · 7.4 GiB free on this machine, beside 128k', refused.row === 'Qwen3.5 4B local/qwen3.5-4b refused 128k ctx 9.6 GiB' && refused.refused !== undefined && refused.refused.startsWith(REFUSAL) && refused.legend.includes('↵ serve at 128k and switch'), refused.all)
  await p.press(KEY.left)
  const at64 = p.card()
  save('adapter-moved-to-64k', p)
  check('← to 64k: the row reads on disk 64k ctx 7.6 GiB, where it read refused beside 64k', at64.row === 'Qwen3.5 4B local/qwen3.5-4b on disk 64k ctx 7.6 GiB' && at64.strip.includes('[64k]'), at64.all)
  check('no line of the card says refused or states what 128k needed', at64.refused === undefined && !at64.all.includes('refused') && !at64.all.includes('needed ·'), at64.all)
  check('↵ there serves and switches, and what it will run names 65536', at64.legend.includes('↵ serve and switch') && !at64.legend.includes('serve at') && at64.run.includes('--context 65536'), `${at64.run} | ${at64.legend}`)
  await p.press(KEY.left)
  const at32 = p.card()
  save('adapter-moved-to-32k', p)
  check('← again to 32k: on disk 32k ctx 6.6 GiB, no refusal, what it will run names 32768', at32.row === 'Qwen3.5 4B local/qwen3.5-4b on disk 32k ctx 6.6 GiB' && at32.refused === undefined && !at32.all.includes('needed ·') && at32.run.includes('--context 32768') && at32.legend.includes('↵ serve and switch'), at32.all)
  await p.press(KEY.right, 2)
  const back = p.card()
  save('adapter-back-at-128k', p)
  check('→ → back to 128k: the refusal stands again with its numbers', back.row === 'Qwen3.5 4B local/qwen3.5-4b refused 128k ctx 9.6 GiB' && back.refused !== undefined && back.refused.startsWith(REFUSAL) && back.legend.includes('↵ serve at 128k and switch'), back.all)
  await p.close()
}

const point = starting.startingPointOf(QWEN_2B_REPO)!
const need = (window: number): number => fit.tensorFoldProjectedBytes(point, window)

section('2 · the same on TensorFold\'s own engine (a Mac, the 2B): refused at 256k, moved to 128k and to 64k')
{
  const free = need(262_144) - 2.2 * GIB
  const REFUSAL = `refused ${gib(need(262_144))} needed · ${gib(free)} free on this Mac`
  const p = await openPanelCard({ road: 'tensorfold', label: 'Qwen3.5 2B', prefix: 'tf-refusal-window', free: () => free })
  const before = p.card()
  check('the 2B stands on disk at its largest window, 256k', before.row === 'Qwen3.5 2B local/qwen3.5-2b on disk 256k ctx 7.6 GiB' && before.strip.includes('[256k]') && before.legend.includes('↵ serve and switch'), before.all)
  await p.press(KEY.enter)
  await p.until(card => card.refused !== undefined, 10_000)
  const refused = p.card()
  save('refused-at-256k', p)
  check('↵ at 256k is refused: what that window needs and what is free, beside 256k', refused.row === 'Qwen3.5 2B local/qwen3.5-2b refused 256k ctx 7.6 GiB' && refused.refused !== undefined && refused.refused.startsWith(REFUSAL) && refused.strip.includes('[256k]') && refused.legend.includes('↵ serve at 256k and switch'), refused.all)
  await p.press(KEY.left)
  const at128 = p.card()
  save('moved-to-128k', p)
  check('← to 128k: on disk 128k ctx 6.1 GiB, no line says refused or states the first window\'s numbers, ↵ serves', at128.row === 'Qwen3.5 2B local/qwen3.5-2b on disk 128k ctx 6.1 GiB' && at128.refused === undefined && !at128.all.includes('refused') && !at128.all.includes('needed ·') && at128.run.includes('--context 131072') && at128.legend.includes('↵ serve and switch'), at128.all)
  await p.press(KEY.left)
  const at64 = p.card()
  save('moved-to-64k', p)
  check('← again to 64k: the same, with what 64k needs', at64.row === 'Qwen3.5 2B local/qwen3.5-2b on disk 64k ctx 5.4 GiB' && at64.refused === undefined && !at64.all.includes('needed ·') && at64.run.includes('--context 65536'), at64.all)
  await p.press(KEY.right, 2)
  const back = p.card()
  save('back-at-256k', p)
  check('→ → back to 256k: the refusal stands again', back.row === 'Qwen3.5 2B local/qwen3.5-2b refused 256k ctx 7.6 GiB' && back.refused !== undefined && back.refused.startsWith(REFUSAL) && back.legend.includes('↵ serve at 256k and switch'), back.all)
  await p.close()
}

section('3 · a refusal at a window the person chose, the panel closed and opened again: it stands at that window, not beside the model\'s largest')
{
  const free = need(131_072) - 2.2 * GIB
  const REFUSAL = `refused ${gib(need(131_072))} needed · ${gib(free)} free on this Mac`
  const p = await openPanelCard({ road: 'tensorfold', label: 'Qwen3.5 2B', prefix: 'tf-refusal-reopen', free: () => free })
  await p.press(KEY.left)
  await p.press(KEY.enter)
  await p.until(card => card.refused !== undefined, 10_000)
  const refused = p.card()
  check('← to 128k and ↵: refused at 128k with what 128k needs', refused.row === 'Qwen3.5 2B local/qwen3.5-2b refused 128k ctx 6.1 GiB' && refused.refused !== undefined && refused.refused.startsWith(REFUSAL), refused.all)
  await p.reopen()
  const again = p.card()
  save('reopened-refused-at-128k', p)
  check('opened again, the card stands at 128k with its refusal, where it read 256k and 7.6 GiB beside 128k\'s numbers', again.row === 'Qwen3.5 2B local/qwen3.5-2b refused 128k ctx 6.1 GiB' && again.refused !== undefined && again.refused.startsWith(REFUSAL) && again.strip.includes('[128k]'), again.all)
  await p.close()
}

section('4 · a refusal of the engine\'s own: it stands where the card landed and at the window it refused, and goes at any other')
{
  const p = await openPanelCard({ road: 'tensorfold', label: 'Qwen3.5 2B', prefix: 'tf-refusal-engine', free: () => 40 * GIB, serviceEnv: { FAKE_TENSORFOLD_SERVE: 'refuse-memory' } })
  await p.press(KEY.enter)
  await p.until(card => card.refused !== undefined, 20_000)
  const landed = p.card()
  save('engine-refused', p)
  const window = /\[(\d+k)\]/.exec(landed.strip)?.[1] ?? ''
  check('the engine refuses 256k in its own words and the card lands on the window that fits what is left', landed.row.includes(' refused ') && landed.refused !== undefined && landed.refused.includes('262144-token window') && window !== '' && window !== '256k' && landed.legend.includes(`↵ serve at ${window} and switch`), landed.all)
  await p.press(KEY.left)
  const moved = p.card()
  save('engine-refused-moved', p)
  check('← from there: the row is the model on disk at that window and no line says refused', moved.row.includes(' on disk ') && moved.refused === undefined && !moved.all.includes('refused') && !moved.strip.includes(`[${window}]`) && moved.legend.includes('↵ serve and switch'), moved.all)
  await p.press(KEY.right)
  const back = p.card()
  check('→ back: the engine\'s refusal stands again', back.row.includes(' refused ') && back.refused !== undefined && back.refused.includes('262144-token window') && back.strip.includes(`[${window}]`), back.all)
  await p.press(KEY.right, 3)
  const asked = p.card()
  save('engine-refused-at-256k', p)
  check('→ on to 256k, the window the engine refused: its refusal stands there too, and ↵ would ask for 256k again', asked.row === 'Qwen3.5 2B local/qwen3.5-2b refused 256k ctx 7.6 GiB' && asked.refused !== undefined && asked.refused.includes('262144-token window') && asked.strip.includes('[256k]') && asked.legend.includes('↵ serve at 256k and switch'), asked.all)
  await p.press(KEY.left, 3)
  const smallest = p.card()
  check('← ← ← to 32k, neither of the two: no line says refused', smallest.row === 'Qwen3.5 2B local/qwen3.5-2b on disk 32k ctx 5.0 GiB' && smallest.refused === undefined && !smallest.all.includes('refused'), smallest.all)
  await p.close()
}

await releaseScratchHome(home)
console.log(`\nprove-tensorfold-refusal-window: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
