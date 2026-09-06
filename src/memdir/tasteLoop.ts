
import { flagEnv } from '../substrate/flagRegistry.js'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import * as lockfile from '../utils/lockfile.js'
import { redactSecrets } from '../utils/secrets/secretScanner.js'
import type { Message } from '../types/message.js'
import { durableAtomicPublish } from '../substrate/durablePublish.js'


export const TASTE_LOOP_ENV_FLAG = 'MERCURY_TASTE_LOOP'

export function tasteLoopEnabled(): boolean {
  return flagEnv(TASTE_LOOP_ENV_FLAG) === '1'
}


export const MAX_EPISODES = 50
export const MAX_TURNS = 6
export const MAX_TURN_CHARS = 400
export const MAX_TOOLS = 12
export const MAX_TEXT_CHARS = 600
export const MAX_EPISODE_BYTES = 4096
export const PROMOTE_THRESHOLD = 3
export const RECALL_MAX_LESSONS = 3
export const RECALL_THROTTLE_TURNS = 8
export const RECALL_RELEVANCE_WINDOW = 2

const TASTE_DIRNAME = 'taste'
const EPISODES_FILENAME = 'episodes.jsonl'
const TASTE_MD_FILENAME = 'TASTE.md'


export type TasteKind = 'meh' | 'good'

export const MEH_CLASSES = [
  'too_passive',
  'too_verbose',
  'did_not_inspect_code',
  'wrong_tool_choice',
  'over_orchestrated',
  'under_orchestrated',
  'missing_memory',
  'no_concrete_artifact',
  'no_test_or_verification',
  'got_stuck_without_escalating',
  'ui_noise',
  'other',
] as const
export type MehClass = (typeof MEH_CLASSES)[number]

export const GOOD_CLASSES = [
  'inspected_code_first',
  'concise_answer',
  'produced_diff',
  'verified_with_test',
  'asked_good_question',
  'avoided_overbuild',
  'remembered_context',
  'other',
] as const
export type GoodClass = (typeof GOOD_CLASSES)[number]

export type TasteSnapshot = {
  sessionId: string
  cwd: string
  project: string
  modes: string[]
  turns: { role: 'user' | 'assistant'; text: string }[]
  tools: { name: string; outcome: 'ok' | 'error' | 'pending' }[]
}

export type TasteEpisode = {
  v: 1
  id: string
  ts: string
  kind: TasteKind
  cls: string
  signals: string[]
  text: string
  snapshot: TasteSnapshot
}

export type ClassifyResult = {
  cls: string
  score: number
  signals: string[]
}

export type PromotedLesson = {
  kind: TasteKind
  cls: string
  count: number
  lesson: string
}


function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

export function redactAndClip(text: string, n: number): string {
  return clip(redactSecrets(text ?? ''), n)
}


const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
const ORCHESTRATION_TOOLS = new Set(['Agent', 'TaskCreate', 'Workflow'])

type ContentBlock = { type?: string; text?: string; name?: string; id?: string }

function textBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as ContentBlock[])
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n')
}

function hasToolResult(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    (content as ContentBlock[]).some(b => b && b.type === 'tool_result')
  )
}

export function captureSnapshot(
  messages: readonly Message[],
  identity: { sessionId: string; cwd: string; project: string; modes: string[] },
): TasteSnapshot {
  const turns: { role: 'user' | 'assistant'; text: string }[] = []
  const toolUseOrder: { id: string; name: string }[] = []
  const resultErrorById = new Map<string, boolean>()

  for (const m of messages ?? []) {
    if (!m || typeof m !== 'object') continue
    if (m.type === 'assistant') {
      const content = (m as { message?: { content?: unknown } }).message?.content
      const t = textBlocks(content)
      if (t.trim()) turns.push({ role: 'assistant', text: t })
      if (Array.isArray(content)) {
        for (const b of content as ContentBlock[]) {
          if (b && b.type === 'tool_use' && b.name) {
            toolUseOrder.push({ id: String(b.id ?? ''), name: String(b.name) })
          }
        }
      }
    } else if (m.type === 'user') {
      const um = m as {
        isMeta?: boolean
        toolUseResult?: unknown
        message?: { content?: unknown }
      }
      const content = um.message?.content
      if (Array.isArray(content)) {
        for (const b of content as Array<ContentBlock & { tool_use_id?: string; is_error?: boolean }>) {
          if (b && b.type === 'tool_result' && b.tool_use_id) {
            resultErrorById.set(String(b.tool_use_id), b.is_error === true)
          }
        }
      }
      if (um.isMeta || um.toolUseResult !== undefined) continue
      const t = textBlocks(content)
      if (t.trim()) turns.push({ role: 'user', text: t })
    }
  }

  const tools = toolUseOrder
    .slice(-MAX_TOOLS)
    .map(t => ({
      name: redactAndClip(t.name, 60),
      outcome:
        t.id !== '' && resultErrorById.has(t.id)
          ? resultErrorById.get(t.id)
            ? ('error' as const)
            : ('ok' as const)
          : ('pending' as const),
    }))

  const recentTurns = turns
    .slice(-MAX_TURNS)
    .map(t => ({ role: t.role, text: redactAndClip(t.text, MAX_TURN_CHARS) }))

  return {
    sessionId: identity.sessionId,
    cwd: identity.cwd,
    project: identity.project,
    modes: identity.modes.slice(0, 12),
    turns: recentTurns,
    tools,
  }
}


type SnapshotStats = {
  hadEdit: boolean
  hadRead: boolean
  editBeforeRead: boolean
  hadBash: boolean
  orchestrationCount: number
  failedTools: number
  avgAssistantChars: number
}

function snapshotStats(snap: TasteSnapshot): SnapshotStats {
  const names = snap.tools.map(t => t.name)
  let firstEdit = -1
  let firstRead = -1
  let orchestrationCount = 0
  let failedTools = 0
  let hadBash = false
  names.forEach((n, i) => {
    if (EDIT_TOOLS.has(n) && firstEdit === -1) firstEdit = i
    if (READ_TOOLS.has(n) && firstRead === -1) firstRead = i
    if (ORCHESTRATION_TOOLS.has(n)) orchestrationCount++
    if (n === 'Bash') hadBash = true
  })
  snap.tools.forEach(t => {
    if (t.outcome === 'error') failedTools++
  })
  const assistantTurns = snap.turns.filter(t => t.role === 'assistant')
  const avgAssistantChars = assistantTurns.length
    ? Math.round(
        assistantTurns.reduce((a, t) => a + t.text.length, 0) /
          assistantTurns.length,
      )
    : 0
  return {
    hadEdit: firstEdit !== -1,
    hadRead: firstRead !== -1,
    editBeforeRead: firstEdit !== -1 && (firstRead === -1 || firstEdit < firstRead),
    hadBash,
    orchestrationCount,
    failedTools,
    avgAssistantChars,
  }
}

function dominantMehSignal(
  stats: SnapshotStats,
  snap: TasteSnapshot,
): { cls: MehClass; why: string } | null {
  if (stats.failedTools >= 3) return { cls: 'got_stuck_without_escalating', why: `${stats.failedTools} failed tool calls` }
  if (stats.orchestrationCount >= 4) return { cls: 'over_orchestrated', why: `${stats.orchestrationCount} agent/workflow spawns` }
  if (stats.hadEdit && !stats.hadRead) return { cls: 'did_not_inspect_code', why: 'edited with no Read/Grep this window' }
  if (stats.editBeforeRead) return { cls: 'did_not_inspect_code', why: 'edited before reading' }
  if (snap.tools.length > 0 && !stats.hadEdit) return { cls: 'no_concrete_artifact', why: 'tools ran but no edit/write' }
  if (stats.avgAssistantChars > MAX_TURN_CHARS * 0.9) return { cls: 'too_verbose', why: 'assistant turns consistently near the length cap' }
  if (stats.hadEdit && !stats.hadBash) return { cls: 'no_test_or_verification', why: 'edited with no Bash run' }
  return null
}

function dominantGoodSignal(
  stats: SnapshotStats,
): { cls: GoodClass; why: string } | null {
  if (stats.hadEdit && stats.hadBash) return { cls: 'verified_with_test', why: 'edited and ran Bash this window' }
  if (stats.hadEdit) return { cls: 'produced_diff', why: 'shipped an edit this window' }
  if (stats.hadRead && !stats.editBeforeRead) return { cls: 'inspected_code_first', why: 'read before editing this window' }
  if (stats.avgAssistantChars > 0 && stats.avgAssistantChars < 400) return { cls: 'concise_answer', why: 'short assistant turns' }
  return null
}


const MEH_KEYWORDS: Record<Exclude<MehClass, 'other'>, RegExp[]> = {
  too_passive: [/\bpassive\b/i, /ask(?:ed|ing)?\s+permission/i, /didn.?t\s+act/i, /too\s+cautious/i, /hesitan|timid/i, /kept\s+asking/i, /just\s+do\s+it/i, /stop\s+asking/i],
  too_verbose: [/\bverbose\b/i, /too\s+long/i, /wall\s+of\s+text/i, /rambl/i, /\bwordy\b/i, /too\s+much\s+(?:explanation|talk|prose)/i, /\btl;?dr\b/i, /get\s+to\s+the\s+point/i, /less\s+talk/i],
  did_not_inspect_code: [/didn.?t\s+(?:read|look|check|inspect)/i, /did\s+not\s+(?:read|look|inspect)/i, /\bguess(?:ed|ing)?\b/i, /without\s+(?:reading|checking|looking)/i, /assumed\s+the\s+code/i, /read\s+the\s+(?:code|source)/i],
  wrong_tool_choice: [/wrong\s+tool/i, /should\s+have\s+used\s+(?!agents|parallel|sub|a\s+workflow|fan)/i, /used\s+the\s+wrong/i, /why\s+(?:bash|grep|sed)/i, /use\s+the\s+\w+\s+tool/i],
  over_orchestrated: [/too\s+many\s+(?:agents|subagents)/i, /overkill/i, /didn.?t\s+need\s+(?:a\s+)?(?:workflow|agents)/i, /over[-\s]?orchestrat/i, /fanned?\s+out\s+too/i],
  under_orchestrated: [/should\s+have\s+(?:parallel|fanned|used\s+agents)/i, /too\s+slow/i, /one\s+at\s+a\s+time/i, /\bsequential(?:ly)?\b/i, /in\s+parallel/i],
  missing_memory: [/should\s+have\s+remembered/i, /\bforgot\b/i, /didn.?t\s+recall/i, /you\s+(?:knew|know)\s+this/i, /already\s+told\s+you/i, /missing\s+memory/i, /no\s+memory\s+of/i],
  no_concrete_artifact: [/no\s+(?:diff|file|change|artifact|code)/i, /nothing\s+(?:shipped|changed|produced)/i, /just\s+talk/i, /all\s+talk/i, /where.?s\s+the\s+code/i],
  no_test_or_verification: [/no\s+test/i, /didn.?t\s+(?:verify|test|run|prove)/i, /\bunverified\b/i, /no\s+(?:proof|verification)/i, /prove\s+it/i, /did\s+you\s+(?:test|verify)/i],
  got_stuck_without_escalating: [/\bstuck\b/i, /\bspun\b|spinning/i, /\blooped?\b|in\s+a\s+loop/i, /gave\s+up/i, /kept\s+failing/i, /didn.?t\s+escalat/i, /ask\s+for\s+help/i],
  ui_noise: [/too\s+noisy/i, /cluttered/i, /ui\s+noise/i, /too\s+much\s+output/i, /\bspam(?:my)?\b/i, /distracting/i, /clean\s+up\s+the\s+output/i],
}

const GOOD_KEYWORDS: Record<Exclude<GoodClass, 'other'>, RegExp[]> = {
  inspected_code_first: [/read\s+the\s+(?:code|source)/i, /inspected/i, /looked\s+(?:first|at\s+the)/i, /checked\s+the\s+source/i, /\bgrounded\b/i, /\brecon\b/i, /traced\s+the/i],
  concise_answer: [/\bconcise\b/i, /\bterse\b/i, /to\s+the\s+point/i, /\bshort\b/i, /\bbrief\b/i, /no\s+fluff/i, /tight/i],
  produced_diff: [/\bdiff\b/i, /\bshipped\b/i, /the\s+(?:change|patch|code)/i, /\bconcrete\b/i, /\bimplemented\b/i, /actually\s+(?:built|wrote)/i],
  verified_with_test: [/\bverified\b/i, /\btested\b/i, /ran\s+the\s+(?:test|gate|build)/i, /\bproof\b/i, /\bgreen\b/i, /\bpassed\b/i, /the\s+gate/i],
  asked_good_question: [/good\s+question/i, /right\s+question/i, /asked\s+the\s+right/i, /clarif/i, /sharp\s+question/i],
  avoided_overbuild: [/didn.?t\s+overbuild/i, /\bminimal\b/i, /kept\s+it\s+simple/i, /no\s+overengineer/i, /\brestraint\b/i, /just\s+enough/i, /kept\s+it\s+small/i],
  remembered_context: [/remembered/i, /\brecalled\b/i, /you\s+knew/i, /good\s+memory/i, /picked\s+up\s+where/i, /kept\s+the\s+context/i],
}

function scoreKeywords(text: string, patterns: RegExp[]): string[] {
  const hits: string[] = []
  for (const re of patterns) {
    const m = text.match(re)
    if (m) hits.push(m[0].toLowerCase().replace(/\s+/g, ' ').trim())
  }
  return hits
}

export function classifyMeh(text: string, snap: TasteSnapshot): ClassifyResult {
  const stats = snapshotStats(snap)
  const scores = new Map<string, number>()
  const reasons = new Map<string, string[]>()
  const bump = (cls: string, by: number, why: string) => {
    scores.set(cls, (scores.get(cls) ?? 0) + by)
    const r = reasons.get(cls) ?? []
    r.push(why)
    reasons.set(cls, r)
  }

  for (const cls of Object.keys(MEH_KEYWORDS) as Array<Exclude<MehClass, 'other'>>) {
    for (const hit of scoreKeywords(text, MEH_KEYWORDS[cls])) bump(cls, 2, `said "${hit}"`)
  }
  const sig = dominantMehSignal(stats, snap)
  if (sig) bump(sig.cls, 2, sig.why)

  return pickWinner(scores, reasons)
}

export function classifyGood(text: string, snap: TasteSnapshot): ClassifyResult {
  const stats = snapshotStats(snap)
  const scores = new Map<string, number>()
  const reasons = new Map<string, string[]>()
  const bump = (cls: string, by: number, why: string) => {
    scores.set(cls, (scores.get(cls) ?? 0) + by)
    const r = reasons.get(cls) ?? []
    r.push(why)
    reasons.set(cls, r)
  }

  for (const cls of Object.keys(GOOD_KEYWORDS) as Array<Exclude<GoodClass, 'other'>>) {
    for (const hit of scoreKeywords(text, GOOD_KEYWORDS[cls])) bump(cls, 2, `said "${hit}"`)
  }
  const sig = dominantGoodSignal(stats)
  if (sig) bump(sig.cls, 2, sig.why)

  return pickWinner(scores, reasons)
}

function pickWinner(
  scores: Map<string, number>,
  reasons: Map<string, string[]>,
): ClassifyResult {
  let bestCls = 'other'
  let bestScore = 0
  for (const [cls, score] of scores) {
    if (score > bestScore) {
      bestScore = score
      bestCls = cls
    }
  }
  return { cls: bestCls, score: bestScore, signals: reasons.get(bestCls) ?? [] }
}


const MEH_ADJUSTMENT: Record<MehClass, string> = {
  too_passive: 'Act through tools on reversible work; don\'t ask permission — report after.',
  too_verbose: 'Cut the prose — one short worklog line, then tools; save the summary for the end.',
  did_not_inspect_code: 'Read the real code / types / call-sites before editing — recon to ground truth first.',
  wrong_tool_choice: 'Pick the dedicated tool for the job (Read/Grep/Edit over raw shell).',
  over_orchestrated: 'Hand-code small or off-distribution work; reserve fan-out for genuinely independent breadth.',
  under_orchestrated: 'Parallelize independent work — batch reads / fan out agents when breadth warrants.',
  missing_memory: 'Recall the relevant lesson — and bank it with /remember so it sticks next time.',
  no_concrete_artifact: 'Produce a concrete artifact — a diff / file / command — not just discussion.',
  no_test_or_verification: 'Verify by running the test/build/gate; assert state from output, not vibes.',
  got_stuck_without_escalating: 'When stuck after ~2 tries, change approach or escalate — surface the blocker, don\'t spin.',
  ui_noise: 'Reduce UI noise — terse status, no decorative output.',
  other: 'Note the friction and adjust deliberately next time.',
}

const GOOD_REINFORCE: Record<GoodClass, string> = {
  inspected_code_first: 'Grounding in the real code before editing paid off — keep recon-first.',
  concise_answer: 'Concise, to-the-point answers land well — keep the prose tight.',
  produced_diff: 'Shipping a concrete diff is what helps — keep producing artifacts.',
  verified_with_test: 'Verifying with a test/gate built trust — keep proving changes.',
  asked_good_question: 'A sharp, option-bearing question at the right moment helped — keep them structured and rare.',
  avoided_overbuild: 'Restraint — a minimal complete solution — was right; keep avoiding overbuild.',
  remembered_context: 'Recalling prior context helped — keep surfacing relevant memory.',
  other: 'Whatever worked here, keep doing it.',
}

export function lessonFor(kind: TasteKind, cls: string): string {
  return kind === 'meh'
    ? MEH_ADJUSTMENT[(cls as MehClass) in MEH_ADJUSTMENT ? (cls as MehClass) : 'other']
    : GOOD_REINFORCE[(cls as GoodClass) in GOOD_REINFORCE ? (cls as GoodClass) : 'other']
}


function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 8)
}

export function buildEpisode(
  kind: TasteKind,
  rawText: string,
  snapshot: TasteSnapshot,
  nowIso: string,
): TasteEpisode {
  const text = redactAndClip(rawText, MAX_TEXT_CHARS)
  const result =
    kind === 'meh' ? classifyMeh(text, snapshot) : classifyGood(text, snapshot)
  const episode: TasteEpisode = {
    v: 1,
    id: shortHash(nowIso + '|' + text),
    ts: nowIso,
    kind,
    cls: result.cls,
    signals: result.signals,
    text,
    snapshot,
  }
  return capEpisodeSize(episode)
}

export function capEpisodeSize(ep: TasteEpisode): TasteEpisode {
  let out = ep
  let guard = 0
  while (JSON.stringify(out).length > MAX_EPISODE_BYTES && guard++ < 200) {
    const turns = out.snapshot.turns
    let idx = -1
    let longest = 0
    turns.forEach((t, i) => {
      if (t.text.length > longest) {
        longest = t.text.length
        idx = i
      }
    })
    if (idx !== -1 && longest > 16) {
      out = {
        ...out,
        snapshot: {
          ...out.snapshot,
          turns: turns.map((t, i) =>
            i === idx ? { ...t, text: clip(t.text, Math.max(16, Math.floor(longest / 2))) } : t,
          ),
        },
      }
      continue
    }
    if (turns.length > 0) {
      out = { ...out, snapshot: { ...out.snapshot, turns: turns.slice(1) } }
      continue
    }
    const tools = out.snapshot.tools
    const longTool = tools.findIndex(t => t.name.length > 24)
    if (longTool !== -1) {
      out = {
        ...out,
        snapshot: {
          ...out.snapshot,
          tools: tools.map((t, i) => (i === longTool ? { ...t, name: clip(t.name, 24) } : t)),
        },
      }
      continue
    }
    if (tools.length > 0) {
      out = { ...out, snapshot: { ...out.snapshot, tools: tools.slice(0, -1) } }
      continue
    }
    if (out.text.length > 24) {
      out = { ...out, text: clip(out.text, Math.max(24, Math.floor(out.text.length / 2))) }
      continue
    }
    if (out.signals.length > 0) {
      out = { ...out, signals: out.signals.slice(0, -1) }
      continue
    }
    const sn = out.snapshot
    if (sn.cwd.length > 64 || sn.project.length > 64 || sn.sessionId.length > 64 || sn.modes.length > 0) {
      out = {
        ...out,
        snapshot: {
          ...sn,
          cwd: clip(sn.cwd, 64),
          project: clip(sn.project, 64),
          sessionId: clip(sn.sessionId, 64),
          modes: [],
        },
      }
      continue
    }
    break
  }
  if (JSON.stringify(out).length > MAX_EPISODE_BYTES) {
    out = {
      ...out,
      id: clip(out.id, 32),
      ts: clip(out.ts, 32),
      cls: clip(out.cls, 64),
      text: clip(out.text, 200),
      signals: out.signals.slice(0, 3).map(s => clip(s, 80)),
      snapshot: {
        sessionId: clip(out.snapshot.sessionId, 64),
        cwd: clip(out.snapshot.cwd, 64),
        project: clip(out.snapshot.project, 64),
        modes: [],
        turns: [],
        tools: [],
      },
    }
  }
  return out
}


export function tasteDir(memoryDir: string): string {
  return join(memoryDir, TASTE_DIRNAME)
}
export function episodesPath(memoryDir: string): string {
  return join(tasteDir(memoryDir), EPISODES_FILENAME)
}
export function tasteMdPath(memoryDir: string): string {
  return join(tasteDir(memoryDir), TASTE_MD_FILENAME)
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  await durableAtomicPublish(path, content)
}

async function withTasteLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await writeFile(path, '', { flag: 'wx' }).catch(() => {})
  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(path, {
      retries: { retries: 100, minTimeout: 10, maxTimeout: 250 },
    })
  } catch {
    release = undefined
  }
  try {
    return await fn()
  } finally {
    if (release) await release().catch(() => {})
  }
}


export async function writeEpisode(
  memoryDir: string,
  episode: TasteEpisode,
): Promise<string> {
  const dir = tasteDir(memoryDir)
  await mkdir(dir, { recursive: true })
  const path = episodesPath(memoryDir)
  await withTasteLock(path, async () => {
    let lines: string[] = []
    try {
      const raw = await readFile(path, 'utf-8')
      lines = raw.split('\n').filter(Boolean)
    } catch {
      lines = []
    }
    lines.push(JSON.stringify(episode))
    if (lines.length > MAX_EPISODES) lines = lines.slice(lines.length - MAX_EPISODES)
    await atomicWriteFile(path, lines.join('\n') + '\n')
  })
  return path
}

export async function readEpisodes(memoryDir: string): Promise<TasteEpisode[]> {
  let raw: string
  try {
    raw = await readFile(episodesPath(memoryDir), 'utf-8')
  } catch {
    return []
  }
  const out: TasteEpisode[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const ep = JSON.parse(line) as TasteEpisode
      if (ep && ep.v === 1 && (ep.kind === 'meh' || ep.kind === 'good')) out.push(ep)
    } catch {
    }
  }
  return out
}


export function derivePromoted(
  episodes: readonly TasteEpisode[],
  threshold: number = PROMOTE_THRESHOLD,
): PromotedLesson[] {
  const counts = new Map<string, PromotedLesson>()
  for (const e of episodes) {
    if (!e || e.cls === 'other' || (e.kind !== 'meh' && e.kind !== 'good')) continue
    const key = `${e.kind}:${e.cls}`
    const cur = counts.get(key) ?? {
      kind: e.kind,
      cls: e.cls,
      count: 0,
      lesson: lessonFor(e.kind, e.cls),
    }
    cur.count++
    counts.set(key, cur)
  }
  return [...counts.values()]
    .filter(l => l.count >= threshold)
    .sort((a, b) => b.count - a.count)
}

export function renderTasteMd(promoted: readonly PromotedLesson[]): string {
  const meh = promoted.filter(l => l.kind === 'meh')
  const good = promoted.filter(l => l.kind === 'good')
  const line = (l: PromotedLesson) =>
    `- [${l.kind}:${l.cls} ×${l.count}, candidate] ${l.lesson}`
  const header = `# TASTE.md — operator-friction-derived taste lessons

<!-- Auto-maintained by the Taste Loop (/meh, /good). Each entry is a CANDIDATE
     lesson derived from >= ${PROMOTE_THRESHOLD} repeated operator signals — NOT
     universal truth. Treat as a soft preference for this project, not an order. -->
`
  const friction = meh.length
    ? `\n## Friction — avoid\n${meh.map(line).join('\n')}\n`
    : ''
  const worked = good.length
    ? `\n## What worked — keep\n${good.map(line).join('\n')}\n`
    : ''
  const empty = !meh.length && !good.length
    ? '\n_(No pattern has repeated enough to promote yet.)_\n'
    : ''
  return header + friction + worked + empty
}

export async function promoteLessons(
  memoryDir: string,
  threshold: number = PROMOTE_THRESHOLD,
): Promise<{ promoted: PromotedLesson[]; path: string }> {
  const episodes = await readEpisodes(memoryDir)
  const promoted = derivePromoted(episodes, threshold)
  await mkdir(tasteDir(memoryDir), { recursive: true })
  const path = tasteMdPath(memoryDir)
  await withTasteLock(path, () => atomicWriteFile(path, renderTasteMd(promoted)))
  return { promoted, path }
}


export function shouldEmitTasteRecall(messages: readonly Message[]): boolean {
  let humanTurns = 0
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i] as
      | { type?: string; isMeta?: boolean; toolUseResult?: unknown; attachment?: { type?: string }; message?: { content?: unknown } }
      | undefined
    if (!m) continue
    if (m.type === 'attachment' && m.attachment?.type === 'taste_recall') {
      return humanTurns >= RECALL_THROTTLE_TURNS
    }
    if (
      m.type === 'user' &&
      !m.isMeta &&
      m.toolUseResult === undefined &&
      !hasToolResult(m.message?.content)
    ) {
      humanTurns++
    }
  }
  return true
}

export function buildTasteRecallText(promoted: readonly PromotedLesson[]): string | null {
  if (!promoted.length) return null
  const top = promoted.slice(0, RECALL_MAX_LESSONS)
  const meh = top.filter(l => l.kind === 'meh')
  const good = top.filter(l => l.kind === 'good')
  const lines: string[] = []
  for (const l of meh) lines.push(`- Avoid: ${l.lesson}`)
  for (const l of good) lines.push(`- Keep: ${l.lesson}`)
  return (
    `Taste Loop — operator-tuned preferences for this project, learned from repeated /meh and /good signals and surfaced by relevance to what you're doing now. ` +
    `These are candidate soft-preferences (not absolute rules); honor them unless the task says otherwise. Never mention this reminder to the user.\n` +
    lines.join('\n')
  )
}

function recentUserText(messages: readonly Message[], n: number): string {
  const out: string[] = []
  for (let i = (messages?.length ?? 0) - 1; i >= 0 && out.length < n; i--) {
    const m = messages[i] as
      | { type?: string; isMeta?: boolean; toolUseResult?: unknown; message?: { content?: unknown } }
      | undefined
    if (
      m?.type === 'user' &&
      !m.isMeta &&
      m.toolUseResult === undefined &&
      !hasToolResult(m.message?.content)
    ) {
      const t = textBlocks(m.message?.content)
      if (t.trim()) out.push(t)
    }
  }
  return out.join(' ')
}

function lessonKeywords(kind: TasteKind, cls: string): RegExp[] {
  const table = kind === 'meh' ? MEH_KEYWORDS : GOOD_KEYWORDS
  return (table as Record<string, RegExp[]>)[cls] ?? []
}

export function rankByRelevance(
  promoted: readonly PromotedLesson[],
  recentText: string,
): PromotedLesson[] {
  const lc = (recentText ?? '').toLowerCase()
  if (!lc.trim()) return [...promoted]
  const matches = (l: PromotedLesson): number =>
    lessonKeywords(l.kind, l.cls).some(re => re.test(lc)) ? 1 : 0
  return [...promoted].sort((a, b) => matches(b) - matches(a) || b.count - a.count)
}

export async function getTasteRecallContent(
  memoryDir: string,
  messages: readonly Message[],
): Promise<string | null> {
  if (!tasteLoopEnabled()) return null
  if (!shouldEmitTasteRecall(messages)) return null
  const episodes = await readEpisodes(memoryDir)
  const promoted = rankByRelevance(
    derivePromoted(episodes),
    recentUserText(messages, RECALL_RELEVANCE_WINDOW),
  )
  return buildTasteRecallText(promoted)
}
