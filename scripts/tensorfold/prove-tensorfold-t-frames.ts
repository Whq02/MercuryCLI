#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}
const FRAMES = argAfter('--frames')
const PNG = process.argv.includes('--png')
const ONLY = argAfter('--only')
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })
const home = pinScratchHome('tensorfold-t-frames')

const React = await import('react')
const h = React.createElement
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { Box } = await import('../../src/ink.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.tsx')
const { pickerFactsOf } = await import('../../src/commands/tensorfold/pickerFacts.ts')
const { gridToPng } = await import('../ui/gridToPng.ts')
const { tStates } = await import('./fixtures/tstates.ts')
type Facts = import('./fixtures/tstates.ts').Facts
type TState = import('./fixtures/tstates.ts').TState

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}

const SIZES: Array<[number, number]> = [[160, 48], [110, 34], [96, 30]]
type Run = { m: Mounted; selected: string[]; acts: unknown[]; columns: number; rows: number }

async function open(facts: Facts, columns: number, rows: number): Promise<Run> {
  const selected: string[] = []
  const acts: unknown[] = []
  const picker = h(MercuryModelPicker as never, {
    view: 'tensorfold',
    live: facts.live,
    models: [],
    current: facts.current ?? '',
    ctxPct: null,
    tensorfold: pickerFactsOf(facts),
    onTensorFold: (act: unknown) => { acts.push(act) },
    onSelect: (id: string) => { selected.push(id) },
    onClose: () => undefined,
  } as never)
  const shell = h(AppStateProvider as never, {} as never, h(ThemeProvider as never, {} as never, h(Box, { flexDirection: 'column', width: columns, height: rows, justifyContent: 'center' }, picker)))
  const m = await mountOffscreen(shell, columns, rows)
  await waitFor(() => m.screen().includes('Mercury · tensorfold'), 8000)
  await settle(200)
  return { m, selected, acts, columns, rows }
}

async function press(run: Run, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    run.m.push(key)
    await settle(120)
  }
  await settle(140)
}

const inner = (line: string): string => line.replace(/^\s*│ ?/, '').replace(/\s*│\s*$/, '')
const flat = (run: Run): string[] => run.m.lines().map(line => inner(inner(line)).replace(/\s+$/, ''))
const joined = (run: Run): string => flat(run).map(line => line.replace(/[╭╮╰╯─]/g, ' ').trim()).join(' ').replace(/\s+/g, ' ')
const has = (run: Run, words: string): boolean => flat(run).some(line => line.includes(words))
const hasRun = (run: Run, words: string): boolean => joined(run).includes(words)
const cells = (run: Run, ...parts: string[]): boolean => flat(run).some(line => new RegExp(parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s{2,}')).test(line))
const legend = (run: Run): string => flat(run).find(line => line.includes('↑↓ select') || line.includes('esc closes') || line.includes('esc back') || line.includes('esc keeps')) ?? ''
const framedRow = (run: Run): string => {
  const lines = flat(run)
  const top = lines.findIndex(line => line.startsWith('╭'))
  return top < 0 ? '' : (lines[top + 1] ?? '')
}
const card = (run: Run): string[] => {
  const lines = flat(run)
  const top = lines.findIndex(line => line.startsWith('╭'))
  const bottom = lines.findIndex((line, at) => at > top && line.startsWith('╰'))
  return top < 0 || bottom < 0 ? [] : lines.slice(top + 2, bottom)
}

async function landOn(run: Run, words: string): Promise<boolean> {
  for (const key of [KEY.down, KEY.up]) {
    for (let step = 0; step < 12; step++) {
      if (framedRow(run).includes(words)) return true
      await press(run, [key])
    }
  }
  return framedRow(run).includes(words)
}

async function unfoldHost(run: Run): Promise<void> {
  for (let step = 0; step < 12; step++) {
    const heading = flat(run).find(line => line.includes('TENSORFOLD HOST'))
    if (heading !== undefined && heading.trimStart().startsWith('❯')) break
    await press(run, [KEY.down])
  }
  await press(run, [KEY.right])
}

const NAMED: Record<string, string> = { '30': 'black', '31': 'red', '32': 'green', '33': 'yellow', '34': 'blue', '35': 'magenta', '36': 'cyan', '37': 'white', '90': 'brightblack', '91': 'brightred', '92': 'brightgreen', '93': 'brightyellow', '94': 'brightblue', '95': 'brightmagenta', '96': 'brightcyan', '97': 'brightwhite' }
const hex2 = (n: number): string => n.toString(16).padStart(2, '0')
function colourOf(sgr: string | undefined): string {
  if (sgr === undefined || sgr === 'default' || sgr === '') return 'default'
  const rgb = /^(?:38|48);2;(\d+);(\d+);(\d+)$/.exec(sgr)
  if (rgb) return hex2(Number(rgb[1])) + hex2(Number(rgb[2])) + hex2(Number(rgb[3]))
  const n = Number(sgr)
  const base = n >= 100 ? String(n - 10) : n >= 90 ? String(n) : n >= 40 ? String(n - 10) : String(n)
  return NAMED[base] ?? 'default'
}

async function save(name: string, run: Run): Promise<void> {
  if (FRAMES === undefined) return
  const file = `${name}-${run.columns}x${run.rows}`
  const lines = run.m.lines().map(line => line.replace(/\s+$/, ''))
  writeFileSync(join(FRAMES, `${file}.txt`), lines.join('\n') + '\n')
  if (!PNG) return
  const raw = run.m.lines()
  const grid = Array.from({ length: run.rows }, (_, y) => {
    const text = [...(raw[y] ?? '')]
    return Array.from({ length: run.columns }, (_, x) => {
      const style = text[x] !== undefined && text[x] !== ' ' ? run.m.styleAt(x, y) : null
      return { c: text[x] ?? ' ', fg: colourOf(style?.fg), bg: colourOf(style?.bg), bold: style?.bold === true, rev: style?.inverse === true }
    })
  })
  const gridPath = join(FRAMES, `.${file}.json`)
  writeFileSync(gridPath, JSON.stringify({ cols: run.columns, rows: run.rows, grid }))
  await gridToPng(gridPath, join(FRAMES, `${file}.png`))
}

type Expect = (run: Run, wide: boolean) => Array<[string, boolean, string?]>
const SERVE_27B = 'tensorfold serve TensorFold/Qwen3.8-27B-MLX-4bit --drafter z-lab/Qwen3.8-27B-DFlash2 --name qwen3.8-27b --context'
const SERVE_2B = 'tensorfold serve mlx-community/Qwen3.5-2B-MLX-4bit --name qwen3.5-2b --context 262144 --prompt-cache-gib 1 --port 8080'
const MEMORY_27B = 'memory    weights 15 + drafter 3.6 + cache 8 + runtime 2 GiB · prompt cache ≤16 GiB'
const MEMORY_2B = 'memory    weights 1.6 + cache 3 + prompt cache 1 + runtime 2 GiB'
const LIGHTNING_REPO = 'TensorFold/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit'
const SERVE_LIGHTNING = `tensorfold serve ${LIGHTNING_REPO} --name nemotron-lightning --context 262144 --port`
const MEMORY_LIGHTNING = 'memory    weights 17.3 + cache 1.5 + runtime 2 GiB · prompt cache ≤16 GiB'
const LIGHTNING_CELLS = ['Nemotron Lightning', 'local/nemotron-lightning', '↓ 19 GB', '256k ctx', '20.8 GiB']
const QWEN_27B_CELLS = ['Qwen3.8 27B', 'local/qwen3.8-27b', '↓ 20 GB', '128k ctx', '28.5 GiB']

const EXPECT: Record<string, Expect> = {
  't01-not-installed-macos': run => [
    ['heading not installed · Apple M5 Pro · 36.0 GiB usable, unfolded', has(run, '▾ TENSORFOLD · not installed · Apple M5 Pro · 36.0 GiB usable'), flat(run).filter(l => l.includes('TENSORFOLD')).join(' | ')],
    ['the install row: install TensorFold — Homebrew · ashhart/tensorfold', has(run, 'install TensorFold — Homebrew · ashhart/tensorfold')],
    ['landed on Lightning, the default starting point on a 48 GB Mac: ↓ 19 GB · 256k ctx · 20.8 GiB; the 27B second', framedRow(run).includes('Nemotron Lightning') && cells(run, ...LIGHTNING_CELLS) && cells(run, ...QWEN_27B_CELLS) && flat(run).findIndex(l => l.includes('Nemotron Lightning')) < flat(run).findIndex(l => l.includes('Qwen3.8 27B')), framedRow(run)],
    ['its card runs the install, then the pull, then the serve', hasRun(run, 'will run brew install ashhart/tensorfold') && hasRun(run, `tensorfold pull ${LIGHTNING_REPO}`) && hasRun(run, SERVE_LIGHTNING + ' 8080'), card(run).join(' / ')],
    ['the footer: not installed · Homebrew found at /opt/homebrew/bin/brew', has(run, 'not installed · Homebrew found at /opt/homebrew/bin/brew')],
    ['the legend: ↵ install, pull, serve and switch · ←→ window', legend(run).includes('↑↓ select · ↵ install, pull, serve and switch · ←→ window'), legend(run)],
  ],
  't02-installing-macos': run => [
    ['the install row reads ◐ installing', has(run, 'install TensorFold') && has(run, '◐ installing'), framedRow(run)],
    ['its card shows the brew line', hasRun(run, 'brew ==> Downloading https://github.com/ashhart/TensorFold/releases/download/v1.2.2/tensorfold-1.2.2-macos-arm64.tar.gz') || hasRun(run, 'brew ==> Downloading'), card(run).join(' / ')],
    ['the footer: installing TensorFold 1.2.2 with Homebrew', has(run, 'installing TensorFold 1.2.2 with Homebrew')],
    ['the legend: esc closes, it keeps installing', legend(run).includes('esc closes, it keeps installing'), legend(run)],
  ],
  't03-no-homebrew-macos': run => [
    ['the install row is unavailable', framedRow(run).includes('install TensorFold') && framedRow(run).includes('unavailable'), framedRow(run)],
    ['needs      Homebrew · brew.sh installs it, then /tensorfold again', has(run, 'needs     Homebrew · brew.sh installs it, then /tensorfold again'), card(run).join(' / ')],
    ['the same starting rows beneath', has(run, 'Qwen3.8 27B') && has(run, 'Nemotron Lightning') && has(run, 'Qwen3.5 2B')],
    ['the footer: not installed · Homebrew not found', has(run, 'not installed · Homebrew not found')],
    ['the legend offers no ↵ on the unavailable row', legend(run).includes('↑↓ select') && !legend(run).includes('↵ install'), legend(run)],
  ],
  't04-not-installed-linux': (run, wide) => [
    ['heading not installed · NVIDIA GeForce RTX 4090 · 23.0 GiB usable', has(run, '▾ TENSORFOLD · not installed · NVIDIA GeForce RTX 4090 · 23.0 GiB usable'), flat(run).filter(l => l.includes('TENSORFOLD')).join(' | ')],
    ['the install row framed: release archive · checksum verified', framedRow(run).includes('install TensorFold — release archive · checksum verified'), framedRow(run)],
    ['its card: cd into the runtime folder, both curl -fLO, sha256sum -c, tar --strip-components=1, rm', hasRun(run, 'cd ~/.local/share/mercury-host/runtime/tensorfold') && joined(run).split('curl -fLO').length === 3 && hasRun(run, 'sha256sum -c') && hasRun(run, '--strip-components=1') && hasRun(run, 'rm '), card(run).join(' / ')],
    ['the CUDA rows: Lightning 256k 20.8 GiB (best fit) first, the 27B 32k 22.5 GiB, the 2B', cells(run, 'Nemotron Lightning', 'local/nemotron-lightning', '↓ 19 GB', '256k ctx', '20.8 GiB') && cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', '↓ 20 GB', '32k ctx', '22.5 GiB') && cells(run, 'Qwen3.5 2B', 'local/qwen3.5-2b', '↓ 1.7 GB', '256k ctx') && flat(run).findIndex(l => l.includes('Nemotron Lightning')) < flat(run).findIndex(l => l.includes('Qwen3.8 27B')), flat(run).filter(l => /Qwen|Nemotron/.test(l)).join(' | ')],
    ['the footer: not installed · NVIDIA driver 580.95 (CUDA 13)', has(run, 'not installed · NVIDIA driver 580.95 (CUDA 13)')],
    ['the legend: ↵ install', legend(run).includes('↑↓ select · ↵ install'), legend(run)],
    ...(wide ? [['the archive lines name the 1.2.2 Linux archive and its .sha256 sidecar', hasRun(run, 'sha256sum -c tensorfold-1.2.2-linux-') && hasRun(run, '.tar.gz.sha256'), card(run).join(' / ')] as [string, boolean, string]] : []),
  ],
  't05-windows': run => [
    ["heading ▾ TENSORFOLD · served by Mercury's engine until TensorFold ships for Windows, whole at every width, unfolded", has(run, "▾ TENSORFOLD · served by Mercury's engine until TensorFold ships for Windows"), flat(run).filter(l => l.includes('TENSORFOLD')).join(' | ')],
    ['landed on the 4B (the best fit on 16 GiB): ↓ 2.7 GB · 128k ctx · 9.6 GiB; the 2B on disk at 256k · 7.2 GiB beneath; no 27B, no Lightning, no other checkpoint', framedRow(run).includes('Qwen3.5 4B') && cells(run, 'Qwen3.5 4B', 'local/qwen3.5-4b', '↓ 2.7 GB', '128k ctx', '9.6 GiB') && cells(run, 'Qwen3.5 2B', 'local/qwen3.5-2b', 'on disk', '256k ctx', '7.2 GiB') && !has(run, 'Qwen3.8 27B') && !has(run, 'Nemotron Lightning') && !has(run, 'other checkpoint'), flat(run).filter(l => /Qwen|Nemotron|other/.test(l)).join(' | ')],
    ["its card: the note, the GGUF memory parts, engine with the full sentence, weights naming the GGUF, the adapter's pull and serve lines", hasRun(run, "note qualified by Mercury on its own engine · not one of TensorFold's starting points") && has(run, 'memory    weights 2.6 + cache 4 + prompt cache 1 + runtime 2 GiB') && hasRun(run, "engine served by Mercury's engine on this machine until TensorFold ships for Windows") && has(run, 'weights   unsloth/Qwen3.5-4B-GGUF · Qwen3.5-4B-Q4_K_M.gguf (Q4_K_M)') && hasRun(run, 'will run mercury --tensorfold-adapter pull mlx-community/Qwen3.5-4B-MLX-4bit mercury --tensorfold-adapter serve mlx-community/Qwen3.5-4B-MLX-4bit --name qwen3.5-4b --context 131072 --prompt-cache-gib 1 --port 8080'), card(run).join(' / ')],
    ['▸ TENSORFOLD HOST folded beneath, as on every platform with an engine', has(run, '▸ TENSORFOLD HOST · no host · a server on your network or a rented GPU pod')],
    ['the footer: nothing served · CPU · the chip · 11.2 GiB usable', has(run, 'nothing served · CPU · Intel Core i7 · 11.2 GiB usable')],
    ['the legend: ↵ pull, serve and switch · ←→ window, no n', legend(run).includes('↑↓ select · ↵ pull, serve and switch · ←→ window') && !legend(run).includes('n shares'), legend(run)],
  ],
  't05b-windows-no-llamacpp': run => [
    ['the install row framed: install llama.cpp — llama.cpp release b11829 · checksum verified', framedRow(run).includes('install llama.cpp — llama.cpp release b11829 · checksum verified'), framedRow(run)],
    ['its card: the adapter install verb, then the zip, its size, its digest and the runtime folder', hasRun(run, 'will run mercury --tensorfold-adapter install fetches llama-b11829-bin-win-cpu-x64.zip (24 MB) from github.com/ggml-org/llama.cpp · sha256 c534f35ce9c8… · into ~\\.local\\share\\mercury-host\\runtime\\llama.cpp\\build\\bin'), card(run).join(' / ')],
    ['the 4B and the 2B beneath, both to pull', cells(run, 'Qwen3.5 4B', 'local/qwen3.5-4b', '↓ 2.7 GB', '128k ctx', '9.6 GiB') && cells(run, 'Qwen3.5 2B', 'local/qwen3.5-2b', '↓ 1.3 GB', '256k ctx', '7.2 GiB'), flat(run).filter(l => /Qwen/.test(l)).join(' | ')],
    ['the footer: llama.cpp not installed · release b11829 (24 MB) · ↵ installs it', has(run, 'llama.cpp not installed · release b11829 (24 MB) · ↵ installs it')],
    ['the legend: ↵ install', legend(run).includes('↑↓ select · ↵ install'), legend(run)],
  ],
  't05c-windows-his-engine': run => [
    ['his own engine on Windows (no served_by): his heading, never the adapter sentence', has(run, '▾ TENSORFOLD · 1.2.2 · Intel Core i7 · 11.2 GiB usable · nothing served') && !joined(run).includes("Mercury's engine"), flat(run).filter(l => l.includes('TENSORFOLD')).join(' | ')],
    ['his rows: the 2B on disk at his MLX weight (7.6 GiB), the 27B and Lightning do not fit on 16 GiB, other checkpoint offered', cells(run, 'Qwen3.5 2B', 'local/qwen3.5-2b', 'on disk', '256k ctx', '7.6 GiB') && cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', 'does not fit', '32k ctx', '22.5 GiB') && has(run, 'other checkpoint — a Hugging Face repository id'), flat(run).filter(l => /Qwen|other/.test(l)).join(' | ')],
    ['the serve line is his tensorfold command', hasRun(run, SERVE_2B), card(run).join(' / ')],
  ],
  't05d-windows-served': run => [
    ['heading: the sentence alone; the served 4B first, current · 128k ctx · 3.0 GiB in use', has(run, "▾ TENSORFOLD · served by Mercury's engine until TensorFold ships for Windows") && framedRow(run).includes('Qwen3.5 4B') && cells(run, 'Qwen3.5 4B', 'local/qwen3.5-4b', 'current', '128k ctx', '3.0 GiB in use'), framedRow(run)],
    ["the card: service TensorFold adapter · llama.cpp b11829 · started by Mercury · prompt cache 1 GiB; engine with the full sentence; weights; network not shared · sharing from Mercury's engine comes later", hasRun(run, 'service TensorFold adapter · llama.cpp b11829 · started by Mercury · prompt cache 1 GiB') && hasRun(run, "engine served by Mercury's engine on this machine until TensorFold ships for Windows") && has(run, 'weights   unsloth/Qwen3.5-4B-GGUF · Qwen3.5-4B-Q4_K_M.gguf (Q4_K_M)') && hasRun(run, "network not shared · sharing from Mercury's engine comes later"), card(run).join(' / ')],
    ['the footer: serving qwen3.5-4b on 127.0.0.1:8080 · first reply in 2100 ms · ~12 tok/s', has(run, 'serving qwen3.5-4b on 127.0.0.1:8080 · first reply in 2100 ms · ~12 tok/s')],
    ['the legend: s stops · ←→ window · c copies the support line, no n', legend(run).includes('↑↓ select · s stops · ←→ window · c copies the support line') && !legend(run).includes('n shares'), legend(run)],
  ],
  't05e-windows-no-adapter': run => [
    ['▸ TENSORFOLD · no Windows release yet, folded', has(run, '▸ TENSORFOLD · no Windows release yet')],
    ['▾ TENSORFOLD HOST unfolded with the rent row framed', has(run, '▾ TENSORFOLD HOST · no host · a server on your network or a rented GPU pod') && framedRow(run).includes('rent a GPU pod — Runpod, through /llmhost'), framedRow(run)],
    ['the rent card: pod · serves · through', hasRun(run, 'pod RTX 5090 32 GB on Runpod · the price shows in /llmhost · billing starts when it boots') && has(run, 'serves    Qwen3.8 27B at 128k with TensorFold 1.2.2 for CUDA') && hasRun(run, 'through /llmhost rents it, installs TensorFold, pulls, serves, then this session switches · s stops the pod and its billing'), card(run).join(' / ')],
    ['the address row', has(run, 'a server on your network — its address')],
    ['the footer: nothing served here · TensorFold runs on a host', has(run, 'nothing served here · TensorFold runs on a host')],
    ['the legend: ↵ rent and switch', legend(run).includes('↑↓ select · ↵ rent and switch'), legend(run)],
  ],
  't06-opened': run => [
    ['heading 1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served', has(run, '▾ TENSORFOLD · 1.2.2 · Apple M5 Pro · 36.0 GiB usable · nothing served')],
    ['landed on Lightning at 256k (the 48 GB default); the 27B at 128k second; the 2B on disk; other checkpoint; HOST folded beneath', framedRow(run).includes('Nemotron Lightning') && cells(run, ...LIGHTNING_CELLS) && cells(run, ...QWEN_27B_CELLS) && flat(run).findIndex(l => l.includes('Nemotron Lightning')) < flat(run).findIndex(l => l.includes('Qwen3.8 27B')) && cells(run, 'Qwen3.5 2B', 'local/qwen3.5-2b', 'on disk', '256k ctx', '7.6 GiB') && has(run, 'other checkpoint — a Hugging Face repository id') && has(run, '▸ TENSORFOLD HOST · no host · a server on your network or a rented GPU pod'), flat(run).filter(l => /Qwen|Nemotron|other|HOST/.test(l)).join(' | ')],
    ['the card: window strip, memory, pull into ~/.cache/huggingface/hub (the words the same under any TMPDIR), will run', has(run, 'window    32k 64k 128k [256k] · ←→ changes it') && has(run, MEMORY_LIGHTNING) && has(run, 'pull      into ~/.cache/huggingface/hub · 38 GB free on this disk') && hasRun(run, `will run tensorfold pull ${LIGHTNING_REPO}`) && hasRun(run, SERVE_LIGHTNING + ' 8080'), card(run).join(' / ')],
    ['the footer: nothing served · Metal', has(run, 'nothing served · Metal')],
    ['the legend: ↵ pull, serve and switch · ←→ window', legend(run).includes('↑↓ select · ↵ pull, serve and switch · ←→ window'), legend(run)],
  ],
  't08-window-past-fit': run => [
    ['→ past what fits on the 48 GiB Mac: the 27B at 256k needs 36.5 GiB of 36.0 usable, which a raised GPU limit would cover (the corrected wired-limit decision), so the row keeps its download cell with the memory cell amber and the card says needs the GPU limit raised · w · an estimate', cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', '↓ 20 GB', '256k ctx', '36.5 GiB') && has(run, 'fit       needs the GPU limit raised · w · an estimate'), `${framedRow(run)} / ${card(run).join(' / ')}`],
    ['the strip lands on [256k]; the memory line counts the 16 GiB cache', has(run, 'window    32k 64k 128k [256k] · ←→ changes it') && has(run, 'memory    weights 15 + drafter 3.6 + cache 16 + runtime 2 GiB · prompt cache ≤16 GiB'), card(run).join(' / ')],
    ['↵ leaves the legend; w raises the limit', !legend(run).includes('↵') && legend(run).includes('↑↓ select · w raise the limit · ←→ window'), legend(run)],
  ],
  't09-on-disk': run => [
    ['the 2B on disk framed', framedRow(run).includes('Qwen3.5 2B') && cells(run, 'Qwen3.5 2B', 'local/qwen3.5-2b', 'on disk', '256k ctx', '7.6 GiB'), framedRow(run)],
    ['window 32k 64k 128k [256k]; memory weights 1.6 + cache 3 + prompt cache 1 + runtime 2 GiB; no pull line; the serve with --prompt-cache-gib 1', has(run, 'window    32k 64k 128k [256k] · ←→ changes it') && has(run, MEMORY_2B) && !card(run).some(l => l.startsWith('pull')) && hasRun(run, SERVE_2B), card(run).join(' / ')],
    ['the legend: ↵ serve and switch', legend(run).includes('↑↓ select · ↵ serve and switch'), legend(run)],
  ],
  't10-other-typing': run => [
    ['↵ on other checkpoint opens the repo line; the typed id with its cursor', has(run, 'repo      mlx-community/Qwen3.5-9B-MLX-4bit▌'), card(run).join(' / ')],
    ['reads     Hugging Face · MLX, NVFP4 or EXL3 checkpoints, not GGUF', has(run, 'reads     Hugging Face · MLX, NVFP4 or EXL3 checkpoints, not GGUF'), card(run).join(' / ')],
    ['the legend: type a repository id · ↵ read it · esc back', legend(run).includes('type a repository id · ↵ read it · esc back') || flat(run).some(l => l.includes('type a repository id · ↵ read it · esc back')), flat(run).slice(-4).join(' | ')],
  ],
  't10b-other-read': run => [
    ['the read checkpoint: Qwen3.5 9B · ↓ 6 GB · 256k ctx · 16.5 GiB', cells(run, 'Qwen3.5 9B', 'local/qwen3.5-9b', '↓ 6 GB', '256k ctx', '16.5 GiB'), framedRow(run)],
    ['its card: the memory line, the pull then the serve', has(run, 'memory    weights 5.5 + cache 8 + prompt cache 1 + runtime 2 GiB') && hasRun(run, 'will run tensorfold pull mlx-community/Qwen3.5-9B-MLX-4bit') && hasRun(run, 'tensorfold serve mlx-community/Qwen3.5-9B-MLX-4bit --name qwen3.5-9b --context 262144 --prompt-cache-gib 1 --port 8080'), card(run).join(' / ')],
  ],
  't11-other-refused': run => [
    ['other checkpoint framed with the refusal', framedRow(run).includes('other checkpoint') && has(run, "refused   GGUF is llama.cpp's format · /localsetup serves it"), card(run).join(' / ')],
  ],
  't12-pulling': run => [
    ['the 27B: pulling 30% · 128k ctx', cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', 'pulling 30%', '128k ctx'), framedRow(run)],
    ['pull      ██████░░░…  then serves at 128k and switches', flat(run).some(l => /^pull\s+█+░+\s+then serves at 128k and switches$/.test(l)), card(run).join(' / ')],
    ['the footer: pulling Qwen3.8 27B · 6.1 GB of 20 GB · 41 MB/s · about 6 min', has(run, 'pulling Qwen3.8 27B · 6.1 GB of 20 GB · 41 MB/s · about 6 min')],
    ['the legend: s stops, the download resumes next time · esc closes, it keeps pulling', legend(run).includes('s stops, the download resumes next time · esc closes, it keeps pulling'), legend(run)],
  ],
  't13-starting': run => [
    ['heading … · 1 starting; the 27B starting', has(run, '▾ TENSORFOLD · 1.2.2 · Apple M5 Pro · 36.0 GiB usable · 1 starting') && cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', 'starting', '128k ctx'), flat(run).filter(l => /TENSORFOLD|Qwen3.8/.test(l)).join(' | ')],
    ['its card: ◐ the serve', hasRun(run, 'will run ◐ ' + SERVE_27B), card(run).join(' / ')],
    ['the footer: starting qwen3.8-27b on 127.0.0.1:8080 · loading · 41 s', has(run, 'starting qwen3.8-27b on 127.0.0.1:8080 · loading · 41 s')],
    ['the legend: s stops · esc closes, it keeps starting', legend(run).includes('s stops · esc closes, it keeps starting'), legend(run)],
  ],
  't14-current': run => [
    ['heading … · 1 serving; the served 2B first, current, 256k', has(run, '· 1 serving') && framedRow(run).includes('Qwen3.5 2B') && cells(run, 'Qwen3.5 2B', 'local/qwen3.5-2b', 'current', '256k ctx'), framedRow(run)],
    ['the card: ←→ restarts it at another window; service tensorfold · started by Mercury · prompt cache 1 GiB; the network line; no serving line in /tensorfold (the footer carries it)', has(run, 'window    32k 64k 128k [256k] · ←→ restarts it at another window') && has(run, 'service   tensorfold · started by Mercury · prompt cache 1 GiB') && has(run, 'network   not shared · n shares it on this network') && !card(run).some(l => l.startsWith('serving')), card(run).join(' / ')],
    ['the served row measures: 2.8 GiB in use', cells(run, 'Qwen3.5 2B', 'local/qwen3.5-2b', 'current', '256k ctx', '2.8 GiB in use'), framedRow(run)],
    ['the footer: serving qwen3.5-2b on 127.0.0.1:8080 · first reply in 40 ms · ~110 tok/s', has(run, 'serving qwen3.5-2b on 127.0.0.1:8080 · first reply in 40 ms · ~110 tok/s'), flat(run).filter(l => l.includes('serving')).join(' | ')],
    ['the legend: s stops · ←→ window · n shares it · c copies the support line', legend(run).includes('↑↓ select · s stops · ←→ window · n shares it · c copies the support line'), legend(run)],
  ],
  't14b-restart-window': run => [
    ['the strip: [128k] · ↵ restarts it at 128k', has(run, 'window    32k 64k [128k] 256k · ↵ restarts it at 128k'), card(run).join(' / ')],
    ['memory at 128k; will run stop qwen3.5-2b on 127.0.0.1:8080 then the serve at 131072', has(run, 'memory    weights 1.6 + cache 1.5 + prompt cache 1 + runtime 2 GiB') && hasRun(run, 'will run stop qwen3.5-2b on 127.0.0.1:8080 tensorfold serve mlx-community/Qwen3.5-2B-MLX-4bit --name qwen3.5-2b --context 131072 --prompt-cache-gib 1 --port 8080'), card(run).join(' / ')],
    ['the legend: ↵ restart at 128k · ←→ window · s stops', legend(run).includes('↑↓ select · ↵ restart at 128k · ←→ window · s stops'), legend(run)],
  ],
  't15-switch': run => [
    ['Lightning framed while the 2B serves', framedRow(run).includes('Nemotron Lightning'), framedRow(run)],
    ['its will run starts with stop qwen3.5-2b on 127.0.0.1:8080', hasRun(run, 'will run stop qwen3.5-2b on 127.0.0.1:8080 tensorfold pull TensorFold/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-MLX-4bit'), card(run).join(' / ')],
    ['the legend: ↵ pull, serve and switch', legend(run).includes('↑↓ select · ↵ pull, serve and switch'), legend(run)],
  ],
  't15b-stop-confirm': run => [
    ["s on this session's model: stop      s again stops it · this session uses it", has(run, 'stop      s again stops it · this session uses it'), card(run).join(' / ')],
    ['the legend: s again stops · esc keeps it', legend(run).includes('s again stops · esc keeps it'), legend(run)],
  ],
  't16-serving-outside': run => [
    ['heading 33.2 of 36.0 GiB usable left · 1 serving', has(run, '▾ TENSORFOLD · 1.2.2 · Apple M5 Pro · 33.2 of 36.0 GiB usable left · 1 serving'), flat(run).filter(l => l.includes('TENSORFOLD')).join(' | ')],
    ['the outside server lands: serving · 32k ctx · 2.8 GiB in use', framedRow(run).includes('qwen3.5-2b') && cells(run, 'qwen3.5-2b', 'local/qwen3.5-2b', 'serving', '32k ctx', '2.8 GiB in use'), framedRow(run)],
    ['window    32k · set when it started outside Mercury, which does not stop or restart it', hasRun(run, 'window 32k · set when it started outside Mercury, which does not stop or restart it'), card(run).join(' / ')],
    ['the footer: serving qwen3.5-2b on 127.0.0.1:8087 · idle', has(run, 'serving qwen3.5-2b on 127.0.0.1:8087 · idle')],
    ['the legend: ↵ switch, no s', legend(run).includes('↑↓ select · ↵ switch') && !legend(run).includes('s stops'), legend(run)],
  ],
  't16b-pod-tunnel': run => [
    ['heading 33.2 of 36.0 GiB usable left · 1 serving: the hand-started 8087 server is the one outside row', has(run, '▾ TENSORFOLD · 1.2.2 · Apple M5 Pro · 33.2 of 36.0 GiB usable left · 1 serving'), flat(run).filter(l => l.includes('TENSORFOLD')).join(' | ')],
    ["the pod's tunnel is never an outside row under TENSORFOLD: one qwen3.8-27b row, under TENSORFOLD HOST", flat(run).filter(l => /qwen3\.8-27b|Qwen3\.8 27B/.test(l) && !l.includes('↓ 20 GB')).length === 1, flat(run).filter(l => /qwen3\.8-27b|Qwen3\.8 27B/.test(l)).join(' | ')],
    ['▾ TENSORFOLD HOST · pod-rtx-5090 · 1 serving with the pod row serving · 128k ctx', has(run, '▾ TENSORFOLD HOST · pod-rtx-5090 · 1 serving') && flat(run).some(line => /Qwen3\.8 27B\s{2,}compat\/pod-rtx-5090\/\S*\s{2,}serving\s{2,}128k ctx\s{2,}pod-rtx-5090/.test(line)), flat(run).filter(l => l.includes('pod-rtx-5090')).join(' | ')],
  ],
  't17-refused-memory': run => [
    ['the 27B: refused · 64k ctx · 24.5 GiB', cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', 'refused', '64k ctx', '24.5 GiB'), framedRow(run)],
    ["refused   one stream's 131072-token window of KV pages (8.00 GiB) does not fit …", hasRun(run, "refused one stream's 131072-token window of KV pages (8.00 GiB) does not fit the 5.12 GiB left under the load limit; lower --context"), card(run).join(' / ')],
    ['the strip: [64k] · 64k takes 4.0 GiB of cache · 5.12 GiB left; the serve at 65536', has(run, 'window    32k [64k] 128k 256k · 64k takes 4.0 GiB of cache · 5.12 GiB left') && hasRun(run, SERVE_27B + ' 65536 --port 8080'), card(run).join(' / ')],
    ['the legend: ↵ serve at 64k and switch · ←→ window', legend(run).includes('↑↓ select · ↵ serve at 64k and switch · ←→ window'), legend(run)],
  ],
  't17b-wired-limit': run => [
    ['heading 1.2.2 · Apple M1 Max · 21.3 GiB usable · nothing served; the refused 27B leads (the row with the act), refused · 32k ctx; Lightning (the best fit) beneath it', has(run, '▾ TENSORFOLD · 1.2.2 · Apple M1 Max · 21.3 GiB usable · nothing served') && flat(run).findIndex(l => l.includes('Qwen3.8 27B')) < flat(run).findIndex(l => l.includes('Nemotron Lightning')) && cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', 'refused', '32k ctx', '22.5 GiB') && cells(run, 'Nemotron Lightning', 'local/nemotron-lightning', '↓ 19 GB', '256k ctx', '20.8 GiB'), flat(run).filter(l => /TENSORFOLD|Qwen|Nemotron/.test(l)).join(' | ')],
    ["refused   TensorFold refused qwen3.8-27b at 32k · macOS lets the GPU wire 21.3 of 32.0 GiB (iogpu.wired_limit_mb 0) · it needs 22.5 GiB", hasRun(run, 'refused TensorFold refused qwen3.8-27b at 32k · macOS lets the GPU wire 21.3 of 32.0 GiB (iogpu.wired_limit_mb 0) · it needs 22.5 GiB'), card(run).join(' / ')],
    ['the strip: already the smallest window', has(run, 'window    [32k] 64k 128k 256k · already the smallest window'), card(run).join(' / ')],
    ['will run  sudo sysctl iogpu.wired_limit_mb=27174; cost …', has(run, 'will run  sudo sysctl iogpu.wired_limit_mb=27174') && hasRun(run, 'cost asks for your password (sudo) · leaves 5.5 GiB for macOS · resets at reboot; restart the engine after it · tight — quit other apps first'), card(run).join(' / ')],
    ['the legend: w raise the limit · ←→ window, no ↵', legend(run).includes('↑↓ select · w raise the limit · ←→ window') && !legend(run).includes('↵'), legend(run)],
  ],
  't18-keyed-server': run => [
    ['heading 1.2.2 · 127.0.0.1:8080 asks for a key', has(run, '▾ TENSORFOLD · 1.2.2 · 127.0.0.1:8080 asks for a key'), flat(run).filter(l => l.includes('TENSORFOLD')).join(' | ')],
    ['the footer: 127.0.0.1:8080 answers with a key · /health shows status only', has(run, '127.0.0.1:8080 answers with a key · /health shows status only')],
    ['the rows as t06', framedRow(run).includes('Nemotron Lightning') && cells(run, ...QWEN_27B_CELLS)],
    ['the next serve on 8081: port      8081 · 8080 is the keyed TensorFold server · Mercury remembers it', has(run, 'port      8081 · 8080 is the keyed TensorFold server · Mercury remembers it') && hasRun(run, SERVE_LIGHTNING + ' 8081'), card(run).join(' / ')],
  ],
  't19-port-busy': run => [
    ['port      8081 · 8080 answers as llama.cpp · Mercury remembers it; the serve on 8081', has(run, 'port      8081 · 8080 answers as llama.cpp · Mercury remembers it') && hasRun(run, '--prompt-cache-gib 1 --port 8081'), card(run).join(' / ')],
  ],
  't20-exited': run => [
    ['the 2B: exited', cells(run, 'Qwen3.5 2B', 'local/qwen3.5-2b', 'exited', '256k ctx'), framedRow(run)],
    ['exited    signal 9 (killed) · its log: Service logs tensorfold; the serve again', has(run, 'exited    signal 9 (killed) · its log: Service logs tensorfold') && hasRun(run, SERVE_2B), card(run).join(' / ')],
    ['the legend: ↵ start it again and switch', legend(run).includes('↑↓ select · ↵ start it again and switch'), legend(run)],
  ],
  't21-small-mac': run => [
    ['heading 1.2.2 · Apple M4 · 12.0 GiB usable · nothing served', has(run, '▾ TENSORFOLD · 1.2.2 · Apple M4 · 12.0 GiB usable · nothing served')],
    ['the 2B lands (best fit); the 27B and Lightning do not fit at 32k', framedRow(run).includes('Qwen3.5 2B') && cells(run, 'Qwen3.5 2B', 'local/qwen3.5-2b', 'on disk', '256k ctx', '7.6 GiB') && cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', 'does not fit', '32k ctx', '22.5 GiB') && cells(run, 'Nemotron Lightning', 'local/nemotron-lightning', 'does not fit', '32k ctx', '19.4 GiB'), flat(run).filter(l => /Qwen|Nemotron/.test(l)).join(' | ')],
    ['the legend: ↵ serve and switch on the row that fits', legend(run).includes('↑↓ select · ↵ serve and switch'), legend(run)],
  ],
  't22-host-server': run => [
    ['▾ TENSORFOLD HOST · studio.local · 1 serving with its server framed: Qwen3.8 27B · serving · 128k ctx · studio.local', has(run, '▾ TENSORFOLD HOST · studio.local · 1 serving') && cells(run, 'Qwen3.8 27B', 'local/qwen3.8-27b', 'serving', '128k ctx', 'studio.local') && framedRow(run).includes('Qwen3.8 27B'), framedRow(run)],
    ['host      studio.local:8080 · Apple M3 Ultra · TensorFold 1.2.2 · keyed; serving ~38 tok/s; the window set outside; plain HTTP', has(run, 'host      studio.local:8080 · Apple M3 Ultra · TensorFold 1.2.2 · keyed') && has(run, 'serving   ~38 tok/s on its last reply') && hasRun(run, 'window 128k · set when it started outside Mercury, which does not stop or restart it') && hasRun(run, 'network plain HTTP on your home or office network, not across the internet'), card(run).join(' / ')],
    ['the footer names the host: nothing served here · studio.local serves qwen3.8-27b', has(run, 'nothing served here · studio.local serves qwen3.8-27b')],
    ['the legend: ↵ switch', legend(run).includes('↑↓ select · ↵ switch'), legend(run)],
  ],
  't23-host-rent': run => [
    ['the rent row framed: rent a GPU pod — Runpod, through /llmhost', framedRow(run).includes('rent a GPU pod — Runpod, through /llmhost'), framedRow(run)],
    ['pod       RTX 5090 32 GB on Runpod · the price shows in /llmhost · billing starts when it boots', hasRun(run, 'pod RTX 5090 32 GB on Runpod · the price shows in /llmhost · billing starts when it boots'), card(run).join(' / ')],
    ['serves    Qwen3.8 27B at 128k with TensorFold 1.2.2 for CUDA', has(run, 'serves    Qwen3.8 27B at 128k with TensorFold 1.2.2 for CUDA'), card(run).join(' / ')],
    ['through   /llmhost rents it, installs TensorFold, pulls, serves, then this session switches · s stops the pod and its billing', hasRun(run, 'through /llmhost rents it, installs TensorFold, pulls, serves, then this session switches · s stops the pod and its billing'), card(run).join(' / ')],
    ['the legend: ↵ rent and switch', legend(run).includes('↑↓ select · ↵ rent and switch'), legend(run)],
  ],
}

console.log('the t-states through the one builder in the tensorfold view, at 160×48, 110×34 and 96×30, against DESIGN §2–§3 and the frames')
const states: TState[] = (await tStates()).filter(state => ONLY === undefined || state.frame.startsWith(ONLY))
for (const state of states) {
  const expect = EXPECT[state.frame]
  check(`${state.frame}: words are pinned for this state`, expect !== undefined)
  for (const [columns, rows] of SIZES) {
    const run = await open(state.facts, columns, rows)
    if (state.unfoldHost) await unfoldHost(run)
    if (state.land !== undefined) check(`${state.frame} ${columns}×${rows}: the cursor reaches ${state.land}`, await landOn(run, state.land), framedRow(run))
    if (state.keys !== undefined) await press(run, state.keys)
    await save(state.frame, run)
    const scratch = [home, process.env.TMPDIR ?? '/tmp', '/private/tmp']
    check(`${state.frame} ${columns}×${rows}: no scratch path on screen (the fixture cache lives under the fixture home, so the frame is the same under any TMPDIR)`, !run.m.lines().some(line => scratch.some(path => line.includes(path))), run.m.lines().find(line => scratch.some(path => line.includes(path))) ?? '')
    check(`${state.frame} ${columns}×${rows}: the panel fits the width`, run.m.lines().every(line => [...line].length <= columns), String(run.m.lines().find(line => [...line].length > columns)))
    check(`${state.frame} ${columns}×${rows}: the box is Mercury · tensorfold with both groups`, has(run, 'Mercury · tensorfold') && has(run, 'TENSORFOLD HOST'), flat(run).slice(0, 6).join(' | '))
    for (const [label, cond, detail] of expect?.(run, columns === 160) ?? []) check(`${state.frame} ${columns}×${rows}: ${label}`, cond, detail ?? '')
    run.m.unmount()
    await settle(50)
  }
}

await releaseScratchHome(home)
console.log(failures === 0 ? '\nprove-tensorfold-t-frames: ALL GREEN' : `\nprove-tensorfold-t-frames: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
