import type { TensorFoldEngine, TensorFoldFit, TensorFoldFitParts, TensorFoldHost, TensorFoldLastReply, TensorFoldMachine, TensorFoldModelRow, TensorFoldServed } from '../../services/tensorfold/contracts.js'
import { tensorFoldWillRun } from '../../services/tensorfold/serve.js'
import { bytesWords } from '../../services/host/bank.js'
import { gibWords, tokensWords } from '../../services/localServer/localServerMemory.js'
import { displayWidth } from '../mercury-ui/glyphs.js'
import type { ProviderHeading } from '../../utils/model/modelPickerGroups.js'
import type { ModelChoice } from '../MercuryModelPicker.js'

export const TENSORFOLD_MODEL_GROUP = 'Mercury — TensorFold models'
export const TENSORFOLD_HOST_GROUP = 'Mercury — TensorFold host models'
export const TENSORFOLD_GROUPS: readonly string[] = [TENSORFOLD_MODEL_GROUP, TENSORFOLD_HOST_GROUP]
const TENSORFOLD_AGENT_FLOOR = 32_768

export type TensorFoldTone = 'faint' | 'ivory' | 'teal' | 'amber' | 'info' | 'failure' | 'secondary' | 'accent' | 'sand'
type TensorFoldSeg = { text: string; tone: TensorFoldTone; bold?: boolean }
export type TensorFoldCardLine = readonly TensorFoldSeg[]
type TensorFoldCell = { text: string; tone: TensorFoldTone }

export type TensorFoldRowAct =
  | { phase: 'pulling'; percent?: number }
  | { phase: 'starting'; seconds?: number }
  | { phase: 'refused'; line: string; window?: number; strip?: string; limit?: { command: string; cost: string } }
  | { phase: 'exited'; line: string }

type TensorFoldInstallFacts = { road: 'brew' | 'archive'; state?: 'installing' | 'unavailable'; commands: readonly string[]; progress?: string }
type TensorFoldPortNote = { port: number; taken: number; by: string; keyed?: boolean }
type TensorFoldRentFacts = { pod?: string; serves?: string; title?: string }
type TensorFoldPodRow = { hostName: string; id: string; provider?: string; words: string; bills: boolean }
export type TensorFoldAnnouncedHost = { name: string; host: string; pairPort: number; enginePort?: number; serving?: string; window?: number; version?: string; chip?: string; keyed: boolean; pairing?: boolean; refused?: string }

export type TensorFoldPickerFacts = {
  platform: NodeJS.Platform
  engine?: TensorFoldEngine | null
  machine?: TensorFoldMachine
  rows: readonly TensorFoldModelRow[]
  best?: string
  served?: readonly TensorFoldServed[]
  hosts?: readonly TensorFoldHost[]
  helper?: string
  acts?: Readonly<Record<string, TensorFoldRowAct>>
  install?: TensorFoldInstallFacts
  keyed?: string
  port?: TensorFoldPortNote
  app?: { serving: string }
  other?: { refused?: string; read?: TensorFoldModelRow }
  disk?: { into: string; freeBytes?: number }
  rent?: TensorFoldRentFacts
  pods?: readonly TensorFoldPodRow[]
  announced?: readonly TensorFoldAnnouncedHost[]
}

export type TensorFoldAct =
  | { kind: 'serve'; row: TensorFoldModelRow; window: number }
  | { kind: 'switch'; id: string }
  | { kind: 'stop'; row: TensorFoldModelRow }
  | { kind: 'stop-pod'; id: string; name: string }
  | { kind: 'support'; row?: TensorFoldModelRow; host?: TensorFoldHost; window?: number }
  | { kind: 'limit'; row: TensorFoldModelRow; line: string }
  | { kind: 'install' }
  | { kind: 'read'; repo: string }
  | { kind: 'address'; address: string }
  | { kind: 'pair'; host: TensorFoldAnnouncedHost; code: string }
  | { kind: 'rent' }
  | { kind: 'app'; serving: string }
  | { kind: 'share'; row: TensorFoldModelRow }
  | { kind: 'unshare'; row: TensorFoldModelRow }

type TensorFoldInput = 'repo' | 'address' | 'code'
export type TensorFoldTyping = { key: string; input: TensorFoldInput; text: string }

type TensorFoldPickerUi = {
  view: 'model' | 'tensorfold'
  current?: string
  windows?: Readonly<Record<string, number>>
  typing?: TensorFoldTyping
  confirmStop?: string
}

type TensorFoldKeys = {
  enter?: { words: string; act?: TensorFoldAct; input?: TensorFoldInput }
  window?: { rungs: readonly number[]; at: number; repo: string }
  stop?: { words: string; act: TensorFoldAct; confirm: boolean }
  limit?: TensorFoldAct
  support?: TensorFoldAct
  share?: { words: string; act: TensorFoldAct }
  legend?: readonly string[]
  typed?: (text: string) => TensorFoldAct
}

export type TensorFoldChoice = {
  words?: string
  state?: TensorFoldCell
  memory?: TensorFoldCell
  card: (width: number) => TensorFoldCardLine[]
  keys: TensorFoldKeys
}

const KEY = 10
const GIB = 1024 ** 3
const STOP_WORDS = 's stops'
const HOST_NONE = 'no host · a server on your network or a rented GPU pod'
const LAN_WORDS = 'plain HTTP on your home or office network, not across the internet'

const seg = (text: string, tone: TensorFoldTone = 'faint', bold = false): TensorFoldSeg => (bold ? { text, tone, bold } : { text, tone })
const pad = (key: string): string => key.padEnd(KEY)
const tok = (window: number): string => tokensWords(window)
const gib = (value: number): string => gibWords(value * GIB)
const one = (value: number): string => value.toFixed(1).replace(/\.0$/, '')

function wrapCells(text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  const words = text.split(' ').flatMap(word => {
    const parts: string[] = []
    let rest = word
    while (displayWidth(rest) > width) {
      parts.push(rest.slice(0, width))
      rest = rest.slice(width)
    }
    return [...parts, rest]
  })
  for (const word of words) {
    const next = line === '' ? word : `${line} ${word}`
    if (displayWidth(next) <= width || line === '') line = next
    else {
      out.push(line)
      line = word
    }
  }
  if (line !== '') out.push(line)
  return out
}

function kv(key: string, value: string, width: number, tone: TensorFoldTone = 'faint'): TensorFoldCardLine[] {
  return wrapCells(value, Math.max(10, width - KEY)).map((text, at) => [seg(at === 0 ? pad(key) : ' '.repeat(KEY)), seg(text, tone)])
}

function willRun(lines: readonly string[], width: number, glyph?: string): TensorFoldCardLine[] {
  const out: TensorFoldCardLine[] = []
  lines.forEach((line, index) => {
    const body = glyph !== undefined && index === 0 ? `${glyph} ${line}` : line
    wrapCells(body, Math.max(10, width - KEY - 2)).forEach((text, at) => {
      out.push([seg(index === 0 && at === 0 ? pad('will run') : at === 0 ? ' '.repeat(KEY) : ' '.repeat(KEY + 2)), seg(text, 'info')])
    })
  })
  return out
}

function willRunOf(facts: TensorFoldPickerFacts, row: TensorFoldModelRow, window: number): string[] {
  const stops = (facts.served ?? []).filter(served => served.repo !== row.repo || served.window !== window).map(served => `stop ${served.name} on 127.0.0.1:${served.port}`)
  try {
    return [...stops, ...tensorFoldWillRun(row, window)]
  } catch {
    return stops
  }
}

function fitAt(row: TensorFoldModelRow, window: number): TensorFoldFit | undefined {
  return row.ladder?.find(rung => rung.window === window)?.fit ?? (window === row.window ? row.fit : undefined)
}

function rungsOf(row: TensorFoldModelRow): number[] {
  const rungs = row.ladder?.map(rung => rung.window) ?? []
  return rungs.length > 0 ? rungs : [row.window]
}

function strip(row: TensorFoldModelRow, at: number, tail: string, tailTone: TensorFoldTone = 'faint'): TensorFoldCardLine {
  return [
    seg(pad('window')),
    ...rungsOf(row).map(window => {
      const fit = fitAt(row, window)
      const short = fit !== undefined && fit.verdict !== 'fits'
      return window === at ? seg(`[${tok(window)}] `, short ? 'amber' : 'accent', true) : seg(`${tok(window)} `, short ? 'amber' : 'faint')
    }),
    seg(`· ${tail}`, tailTone),
  ]
}

function memoryPartsWords(parts: TensorFoldFitParts): string {
  const items = [
    `weights ${one(parts.weightsGib)}`,
    ...(parts.drafterGib !== undefined ? [`drafter ${one(parts.drafterGib)}`] : []),
    `cache ${one(parts.cacheGib)}`,
    ...(parts.promptCacheGib !== undefined ? [`prompt cache ${one(parts.promptCacheGib)}`] : []),
    `runtime ${one(parts.runtimeGib)}`,
  ]
  const cap = parts.promptCacheGib === undefined && parts.promptCacheCapGib !== undefined ? ` · prompt cache ≤${one(parts.promptCacheCapGib)} GiB` : ''
  return `${items.join(' + ')} GiB${cap}`
}

function memoryLine(fit: TensorFoldFit | undefined, width: number): TensorFoldCardLine[] {
  if (fit === undefined) return []
  return kv('memory', fit.parts !== undefined ? memoryPartsWords(fit.parts) : `${gib(fit.neededGib)} · an estimate`, width)
}

function speedWords(reply: TensorFoldLastReply | undefined): string[] {
  if (reply === undefined) return []
  return [
    ...(reply.firstTokenMs !== undefined ? [`first reply in ${Math.round(reply.firstTokenMs)} ms`] : []),
    ...(reply.tokensPerSecond !== undefined ? [`~${Math.round(reply.tokensPerSecond)} tok/s`] : []),
  ]
}

function addressOf(baseUrl: string): string {
  return baseUrl.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')
}

function pulledPercent(row: TensorFoldModelRow, act: TensorFoldRowAct | undefined): number | undefined {
  if (act?.phase === 'pulling' && act.percent !== undefined) return act.percent
  if (row.bytesOnDisk === undefined || row.downloadBytes === undefined || row.downloadBytes <= 0) return undefined
  return Math.min(99, Math.floor((row.bytesOnDisk / row.downloadBytes) * 100))
}

function isServed(row: TensorFoldModelRow): boolean {
  return row.state === 'serving' || row.state === 'loading'
}

function startedByMercury(facts: TensorFoldPickerFacts, row: TensorFoldModelRow): boolean {
  if (row.startedBy !== undefined) return row.startedBy === 'mercury'
  return (facts.served ?? []).some(served => served.name === row.shortName)
}

function modelChoice(facts: TensorFoldPickerFacts, ui: TensorFoldPickerUi, row: TensorFoldModelRow, rest: boolean): ModelChoice {
  const id = `local/${row.shortName}`
  const act = facts.acts?.[row.repo]
  const unqualified = !row.qualified && row.state === 'on-disk' && act === undefined
  const note = (width: number): TensorFoldCardLine[] => (unqualified ? kv('note', 'unqualified by TensorFold', width) : [])
  const chosen = ui.windows?.[row.repo]
  const at = chosen ?? (act?.phase === 'refused' && act.window !== undefined ? act.window : row.window)
  const fit = fitAt(row, at)
  const current = row.state === 'serving' && ui.current === id
  const mercury = startedByMercury(facts, row)
  const support: TensorFoldAct = { kind: 'support', row, window: at }
  const window = { rungs: rungsOf(row), at, repo: row.repo }
  const base = { id, name: row.label ?? row.shortName, tag: '', ctx: at > 0 ? `${tok(at)} ctx` : '', group: TENSORFOLD_MODEL_GROUP, rest }
  const projected = (tone: TensorFoldTone = fit === undefined || fit.verdict === 'fits' ? 'faint' : 'amber'): TensorFoldCell => (unqualified ? { text: 'unqualified', tone: 'faint' } : { text: fit === undefined || fit.neededGib <= 0 ? '' : gib(fit.neededGib), tone })
  const portLines = (width: number): TensorFoldCardLine[] => (facts.port === undefined ? [] : kv('port', `${facts.port.port} · ${facts.port.taken} ${facts.port.keyed === true ? 'is the keyed TensorFold server' : `answers as ${facts.port.by}`} · Mercury remembers it`, width))
  if (act?.phase === 'pulling' || row.state === 'pulling') {
    const percent = pulledPercent(row, act)
    return {
      ...base,
      tensorfold: {
        state: { text: percent === undefined ? 'pulling' : `pulling ${percent}%`, tone: 'info' },
        memory: projected(),
        card: width => {
          const cells = 22
          const filled = Math.round(((percent ?? 0) / 100) * cells)
          return [
            [seg(pad('pull')), seg('█'.repeat(filled), 'info'), seg('░'.repeat(cells - filled)), seg(`  then serves at ${tok(at)} and switches`, 'secondary')],
            ...willRun(willRunOf(facts, row, at), width, '◐'),
          ]
        },
        keys: { stop: { words: 's stops, the download resumes next time', act: { kind: 'stop', row }, confirm: false }, legend: ['s stops, the download resumes next time', 'esc closes, it keeps pulling'] },
      },
    }
  }
  if (act?.phase === 'starting' || row.state === 'loading') {
    return {
      ...base,
      tensorfold: {
        state: { text: 'starting', tone: 'info' },
        memory: projected(),
        card: width => willRun(willRunOf(facts, row, at).slice(-1), width, '◐'),
        keys: { stop: { words: STOP_WORDS, act: { kind: 'stop', row }, confirm: false }, legend: [STOP_WORDS, 'esc closes, it keeps starting'] },
      },
    }
  }
  if (act?.phase === 'refused') {
    const limit = act.limit
    return {
      ...base,
      tensorfold: {
        state: { text: 'refused', tone: 'failure' },
        memory: projected('faint'),
        card: width => [
          ...kv('refused', act.line, width, 'failure'),
          strip(row, at, act.strip ?? '←→ changes it'),
          ...(limit !== undefined ? [...willRun([limit.command], width), ...kv('cost', limit.cost, width)] : willRun(willRunOf(facts, row, at), width)),
        ],
        keys: {
          ...(limit === undefined ? { enter: { words: `↵ serve at ${tok(at)} and switch`, act: { kind: 'serve', row, window: at } } } : {}),
          ...(limit !== undefined ? { limit: { kind: 'limit', row, line: limit.command } } : {}),
          window,
          support,
        },
      },
    }
  }
  if (act?.phase === 'exited') {
    return {
      ...base,
      tensorfold: {
        state: { text: 'exited', tone: 'failure' },
        memory: projected('faint'),
        card: width => [...kv('exited', act.line, width, 'failure'), strip(row, at, '←→ changes it'), ...willRun(willRunOf(facts, row, at), width)],
        keys: { enter: { words: '↵ start it again and switch', act: { kind: 'serve', row, window: at } }, window, support },
      },
    }
  }
  if (row.state === 'serving') {
    const restart = mercury && at !== row.window
    const confirming = ui.confirmStop === row.repo
    const promptCache = row.promptCacheGib ?? fit?.parts?.promptCacheGib
    const shared = (facts.served ?? []).some(served => served.name === row.shortName && served.keyFile !== undefined)
    return {
      ...base,
      tensorfold: {
        state: { text: current ? 'current' : 'serving', tone: 'teal' },
        memory: row.inUseBytes !== undefined ? { text: `${gibWords(row.inUseBytes)} in use`, tone: 'teal' } : projected(),
        card: width => [
          ...(ui.view === 'model' ? kv('serving', ['on 127.0.0.1' + (row.port !== undefined ? `:${row.port}` : ''), ...speedWords(row.lastReply)].join(' · '), width, 'secondary') : []),
          ...(!mercury
            ? kv('window', row.window < TENSORFOLD_AGENT_FLOOR ? `${tok(row.window)} · under the ${tok(TENSORFOLD_AGENT_FLOOR)} Mercury needs` : `${tok(row.window)} · set when it started outside Mercury, which does not stop or restart it`, width)
            : restart
              ? [strip(row, at, `↵ restarts it at ${tok(at)}`), ...memoryLine(fit, width), ...willRun(willRunOf(facts, row, at), width)]
              : [strip(row, at, '←→ restarts it at another window'), ...kv('service', `tensorfold · started by Mercury${promptCache !== undefined ? ` · prompt cache ${one(promptCache)} GiB` : ''}`, width)]),
          ...(mercury ? kv('network', shared ? 'shared · keyed · n stops sharing' : 'not shared · n shares it on this network', width) : []),
          ...(confirming ? kv('stop', 's again stops it · this session uses it', width, 'amber') : []),
        ],
        keys: {
          ...(restart ? { enter: { words: `↵ restart at ${tok(at)}`, act: { kind: 'serve', row, window: at } } } : current ? {} : { enter: { words: '↵ switch', act: { kind: 'switch', id } } }),
          ...(mercury ? { window, stop: { words: STOP_WORDS, act: { kind: 'stop', row }, confirm: current }, share: shared ? { words: 'n stops sharing', act: { kind: 'unshare', row } } : { words: 'n shares it', act: { kind: 'share', row } } } : {}),
          support,
          ...(confirming ? { legend: ['s again stops', 'esc keeps it'] } : {}),
        },
      },
    }
  }
  const pulled = row.state === 'on-disk'
  const state: TensorFoldCell = fit?.verdict === 'too-big'
    ? { text: 'does not fit', tone: 'amber' }
    : pulled
      ? { text: 'on disk', tone: 'faint' }
      : { text: row.downloadBytes !== undefined ? `↓ ${bytesWords(row.downloadBytes)}` : '', tone: 'faint' }
  if (fit?.verdict === 'too-big') {
    const room = [...rungsOf(row)].reverse().find(window => window < at && fitAt(row, window)?.verdict === 'fits')
    return {
      ...base,
      tensorfold: {
        state,
        memory: projected(),
        card: width => [
          ...note(width),
          strip(row, at, `${tok(at)} needs ${gib(fit.neededGib)}, ${gib(fit.availableGib)} usable · ${room !== undefined ? `← ${tok(room)} fits` : 'no window fits this machine'}`, 'amber'),
          ...memoryLine(fit, width),
        ],
        keys: { window, support },
      },
    }
  }
  const pullLines = (width: number): TensorFoldCardLine[] =>
    pulled || facts.disk === undefined ? [] : kv('pull', `into ${facts.disk.into}${facts.disk.freeBytes !== undefined ? ` · ${bytesWords(facts.disk.freeBytes)} free on this disk` : ''}`, width)
  if (fit?.verdict === 'needs-gpu-limit') {
    const [head = '', ...cost] = (fit.remedy ?? '').split(' · ')
    const command = /^sudo sysctl iogpu\.wired_limit_mb=\d+$/.test(head) ? head : undefined
    const verdict = command !== undefined ? 'needs the GPU limit raised · w · an estimate' : [fit.reason, fit.remedy, 'an estimate'].filter(part => part !== undefined && part !== '').join(' · ')
    return {
      ...base,
      tensorfold: {
        state,
        memory: projected(),
        card: width => [
          ...note(width),
          ...kv('fit', verdict, width, 'amber'),
          strip(row, at, '←→ changes it'),
          ...memoryLine(fit, width),
          ...(command !== undefined ? [...willRun([command], width), ...(cost.length > 0 ? kv('cost', cost.join(' · '), width) : [])] : []),
          ...pullLines(width),
        ],
        keys: { ...(command !== undefined ? { limit: { kind: 'limit', row, line: command } } : {}), window, support },
      },
    }
  }
  const enter = facts.engine === null ? '↵ install, pull, serve and switch' : pulled ? '↵ serve and switch' : '↵ pull, serve and switch'
  return {
    ...base,
    tensorfold: {
      state,
      memory: projected(),
      card: width => [...note(width), strip(row, at, '←→ changes it'), ...memoryLine(fit, width), ...pullLines(width), ...willRun(willRunOf(facts, row, at), width), ...portLines(width)],
      keys: { enter: { words: enter, act: { kind: 'serve', row, window: at } }, window, support },
    },
  }
}

function actionChoice(group: string, key: string, name: string, words: string, choice: TensorFoldChoice, rest = false): ModelChoice {
  return { id: `tensorfold:${key}`, name, tag: '', ctx: '', group, action: true, rest, tensorfold: { ...choice, words } }
}

function installChoice(install: TensorFoldInstallFacts): ModelChoice {
  const words = install.road === 'archive' ? 'release archive · checksum verified' : install.state === 'unavailable' ? 'needs Homebrew' : 'Homebrew · ashhart/tensorfold'
  const installing = install.state === 'installing'
  return actionChoice(TENSORFOLD_MODEL_GROUP, 'install', 'install TensorFold', words, {
    ...(installing ? { state: { text: '◐ installing', tone: 'info' } } : install.state === 'unavailable' ? { state: { text: 'unavailable', tone: 'sand' } } : {}),
    card: width =>
      install.state === 'unavailable'
        ? kv('needs', 'Homebrew · brew.sh installs it, then /tensorfold again', width, 'secondary')
        : [...willRun(install.commands, width, installing ? '◐' : undefined), ...(installing && install.progress !== undefined ? kv(install.road === 'brew' ? 'brew' : 'curl', install.progress, width, 'secondary') : [])],
    keys: installing ? { legend: ['esc closes, it keeps installing'] } : install.state === 'unavailable' ? {} : { enter: { words: '↵ install', act: { kind: 'install' } } },
  })
}

function otherChoice(facts: TensorFoldPickerFacts, ui: TensorFoldPickerUi): ModelChoice {
  const key = 'tensorfold:other'
  const typing = ui.typing?.key === key ? ui.typing : undefined
  return actionChoice(TENSORFOLD_MODEL_GROUP, 'other', 'other checkpoint', 'a Hugging Face repository id', {
    card: width => [
      ...(typing !== undefined ? [[seg(pad('repo')), seg(typing.text, 'ivory'), seg('▌', 'accent')]] : []),
      ...(facts.other?.refused !== undefined ? kv('refused', facts.other.refused, width, 'amber') : kv('reads', 'Hugging Face · MLX, NVFP4 or EXL3 checkpoints, not GGUF', width)),
    ],
    keys: typing !== undefined ? { legend: ['type a repository id', '↵ read it', 'esc back'], typed: text => ({ kind: 'read', repo: text }) } : { enter: { words: '↵ type a repository id', input: 'repo' } },
  }, true)
}

function appChoice(app: { serving: string }): ModelChoice {
  return actionChoice(TENSORFOLD_MODEL_GROUP, 'app', `the app is serving ${app.serving}`, 'paste from its API tab', {
    card: width => kv('instead', "s serves it with Mercury · quit the app first — two copies won't fit", width),
    keys: { stop: { words: 's serve with Mercury instead', act: { kind: 'app', serving: app.serving }, confirm: false } },
  })
}

function hostChoices(facts: TensorFoldPickerFacts, ui: TensorFoldPickerUi): ModelChoice[] {
  const labels = new Map(facts.rows.filter(row => row.label !== undefined).map(row => [row.shortName, row.label!] as const))
  const hosts = (facts.hosts ?? []).filter(host => host.origin !== 'app')
  const out: ModelChoice[] = hosts.map(host => {
    const network = host.origin === 'lan-paired' || host.origin === 'typed'
    if (host.serving === undefined) {
      return actionChoice(TENSORFOLD_HOST_GROUP, `host:${host.name}`, host.name, 'nothing served', {
        card: width => [...kv('host', [addressOf(host.baseUrl), host.chip, host.version !== undefined ? `TensorFold ${host.version}` : undefined, host.keyRef !== undefined ? 'keyed' : undefined].filter(part => part !== undefined).join(' · '), width), ...(network ? kv('network', LAN_WORDS, width) : [])],
        keys: {},
      })
    }
    const pod = host.origin === 'pod' ? (facts.pods ?? []).find(candidate => candidate.hostName === host.name) : undefined
    const id = host.origin === 'pod' ? `compat/${pod?.provider ?? host.name}/${host.serving}` : `local/${host.serving}`
    const current = ui.current === id
    return {
      id,
      key: `host:${host.name}`,
      name: labels.get(host.serving) ?? host.serving,
      tag: '',
      ctx: host.window !== undefined ? `${tok(host.window)} ctx` : '',
      group: TENSORFOLD_HOST_GROUP,
      rest: false,
      tensorfold: {
        state: { text: current ? 'current' : 'serving', tone: 'teal' },
        memory: { text: host.name, tone: 'faint' },
        card: width => [
          ...kv('host', [addressOf(host.baseUrl), host.chip, host.version !== undefined ? `TensorFold ${host.version}` : undefined, host.keyRef !== undefined ? 'keyed' : undefined].filter(part => part !== undefined).join(' · '), width),
          ...(pod !== undefined ? kv('pod', pod.words, width) : []),
          ...(host.lastReply?.tokensPerSecond !== undefined ? kv('serving', `~${Math.round(host.lastReply.tokensPerSecond)} tok/s on its last reply`, width, 'secondary') : []),
          ...(host.window !== undefined ? kv('window', `${tok(host.window)} · set when it started outside Mercury, which does not stop or restart it`, width) : []),
          ...(network ? kv('network', LAN_WORDS, width) : []),
        ],
        keys: {
          ...(current ? {} : { enter: { words: '↵ switch', act: { kind: 'switch', id } } }),
          ...(pod !== undefined && pod.bills ? { stop: { words: 's stops the pod', act: { kind: 'stop-pod', id: pod.id, name: host.name }, confirm: false } } : {}),
          support: { kind: 'support', host },
        },
      },
    }
  })
  for (const announced of facts.announced ?? []) out.push(announcedChoice(announced, labels, ui))
  out.push(actionChoice(TENSORFOLD_HOST_GROUP, 'rent', 'rent a GPU pod', 'Runpod, through /llmhost', {
    card: width => [
      ...(facts.rent?.pod !== undefined ? kv('pod', facts.rent.pod, width) : []),
      ...(facts.rent?.serves !== undefined ? kv('serves', facts.rent.serves, width) : []),
      ...kv('through', '/llmhost rents it, installs TensorFold, pulls, serves, then this session switches · s stops the pod and its billing', width),
    ],
    keys: { enter: { words: '↵ rent and switch', act: { kind: 'rent' } } },
  }))
  const typing = ui.typing?.key === 'tensorfold:address' ? ui.typing : undefined
  out.push(actionChoice(TENSORFOLD_HOST_GROUP, 'address', 'a server on your network', 'its address', {
    card: width => [
      ...(typing !== undefined ? [[seg(pad('address')), seg(typing.text, 'ivory'), seg('▌', 'accent')]] : kv('address', 'type host:port, e.g. studio.local:8080', width)),
      ...kv('network', LAN_WORDS, width),
    ],
    keys: typing !== undefined ? { legend: ['type host:port', '↵ add it', 'esc back'], typed: text => ({ kind: 'address', address: text }) } : { enter: { words: '↵ type its address', input: 'address' } },
  }))
  return out.map(choice => ({ ...choice, rest: false }))
}

function announcedChoice(host: TensorFoldAnnouncedHost, labels: ReadonlyMap<string, string>, ui: TensorFoldPickerUi): ModelChoice {
  const key = `announced:${host.name}`
  const typing = ui.typing?.key === key ? ui.typing : undefined
  const address = [`${host.host}${host.enginePort !== undefined ? `:${host.enginePort}` : ''}`, host.chip, host.version !== undefined ? `TensorFold ${host.version}` : undefined, host.keyed ? 'keyed' : undefined].filter(part => part !== undefined).join(' · ')
  return {
    id: host.serving !== undefined ? `local/${host.serving}` : `tensorfold:${key}`,
    key,
    name: host.serving !== undefined ? (labels.get(host.serving) ?? host.serving) : host.name,
    tag: '',
    ctx: host.window !== undefined ? `${tok(host.window)} ctx` : '',
    group: TENSORFOLD_HOST_GROUP,
    rest: false,
    tensorfold: {
      state: host.pairing === true ? { text: 'pairing', tone: 'info' } : { text: 'not paired', tone: 'faint' },
      memory: { text: host.name, tone: 'faint' },
      card: width => [
        ...kv('host', address, width),
        ...(typing !== undefined
          ? [[seg(pad('code')), seg(typing.text, 'ivory'), seg('▌', 'accent')]]
          : host.refused !== undefined && host.pairing !== true
            ? kv('refused', host.refused, width, 'amber')
            : kv('pair', host.pairing === true ? `sending the code to ${host.name}` : `↵ asks once for the pairing code shown on ${host.name}`, width)),
        ...kv('network', LAN_WORDS, width),
      ],
      keys:
        typing !== undefined
          ? { legend: ['type the pairing code', '↵ pair', 'esc back'], typed: code => ({ kind: 'pair', host, code }) }
          : host.pairing === true
            ? {}
            : { enter: { words: '↵ pair with its code', input: 'code' } },
    },
  }
}

function modelGroupChoices(facts: TensorFoldPickerFacts, ui: TensorFoldPickerUi): ModelChoice[] {
  if (facts.platform === 'win32') return []
  const families = new Set((facts.engine?.families ?? []).map(family => family.id))
  const offered = facts.rows.filter(row => row.qualified || isServed(row) || (row.state === 'on-disk' && families.has(row.family)))
  const served = offered.filter(isServed)
  const best = offered.find(row => row.repo === facts.best && !isServed(row))
  const rest = offered.filter(row => !isServed(row) && row !== best)
  const out: ModelChoice[] = []
  if (facts.engine === null && facts.install !== undefined) out.push(installChoice(facts.install))
  if (facts.app !== undefined) out.push(appChoice(facts.app))
  for (const row of [...served, ...(best !== undefined ? [best] : [])]) out.push(modelChoice(facts, ui, row, false))
  for (const row of rest) out.push(modelChoice(facts, ui, row, row.state !== 'on-disk' && row.state !== 'pulling' && facts.acts?.[row.repo] === undefined))
  if (facts.other?.read !== undefined) out.push(modelChoice(facts, ui, facts.other.read, false))
  out.push(otherChoice(facts, ui))
  return out
}

function servingWords(rows: readonly TensorFoldModelRow[]): string {
  const serving = rows.filter(row => row.state === 'serving').length
  const starting = rows.filter(row => row.state === 'loading').length
  if (serving > 0) return `${serving} serving`
  if (starting > 0) return `${starting} starting`
  return 'nothing served'
}

function tensorFoldStatus(facts: TensorFoldPickerFacts): string {
  if (facts.platform === 'win32') return 'no Windows release yet'
  const chip = facts.machine?.chip ?? facts.engine?.chip
  const usableGib = facts.machine?.usableGib ?? facts.rows.find(row => row.fit.availableGib > 0)?.fit.availableGib
  if (facts.engine === null) return ['not installed', chip, usableGib !== undefined ? `${gib(usableGib)} usable` : undefined].filter(part => part !== undefined).join(' · ')
  if (facts.engine === undefined) return [chip, facts.rows.some(isServed) ? servingWords(facts.rows) : undefined].filter(part => part !== undefined).join(' · ')
  if (facts.keyed !== undefined) return `${facts.engine.version} · ${facts.keyed} asks for a key`
  const held = facts.rows.filter(row => row.state === 'serving' && !startedByMercury(facts, row)).reduce((sum, row) => sum + (row.inUseBytes ?? 0), 0) / GIB
  const usable = usableGib === undefined ? undefined : held > 0 ? `${one(Math.max(0, usableGib - held))} of ${gib(usableGib)} usable left` : `${gib(usableGib)} usable`
  const words = [facts.engine.version, chip, usable, servingWords(facts.rows)].filter(part => part !== undefined).join(' · ')
  return facts.helper === undefined ? words : `${words} ${facts.helper}`
}

function tensorFoldHostStatus(facts: TensorFoldPickerFacts): string {
  const hosts = [...(facts.hosts ?? []).filter(host => host.origin !== 'app'), ...(facts.announced ?? [])]
  if (hosts.length === 0) return HOST_NONE
  const serving = hosts.filter(host => host.serving !== undefined).length
  return `${hosts.map(host => host.name).join(' · ')} · ${serving > 0 ? `${serving} serving` : 'nothing served'}`
}

export function tensorFoldPickerRows(facts: TensorFoldPickerFacts, ui: TensorFoldPickerUi): { rows: ModelChoice[]; headings: Record<string, ProviderHeading> } {
  return {
    rows: [...modelGroupChoices(facts, ui), ...hostChoices(facts, ui)],
    headings: {
      [TENSORFOLD_MODEL_GROUP]: { name: 'TENSORFOLD', doors: [], status: tensorFoldStatus(facts) },
      [TENSORFOLD_HOST_GROUP]: { name: 'TENSORFOLD HOST', doors: [], status: tensorFoldHostStatus(facts) },
    },
  }
}

export function tensorFoldFoldedOnOpen(facts: TensorFoldPickerFacts, view: 'model' | 'tensorfold'): string[] {
  if (facts.platform === 'win32') return [TENSORFOLD_MODEL_GROUP]
  return view === 'tensorfold' ? [TENSORFOLD_HOST_GROUP] : [TENSORFOLD_MODEL_GROUP, TENSORFOLD_HOST_GROUP]
}
