#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const SRC = join(ROOT, 'src')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}


function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) yield p
  }
}

const GETTER_RE = /\bget(?:DefaultSonnetModel|DefaultOpusModel|DefaultHaikuModel|SmallFastModel)\s*\(/
const MODEL_PROP_RE = /\bmodel:\s*['"](?:claude-(?:opus|sonnet|haiku|fable|mythos|3|4|5)|gpt-\d)[a-z0-9.[\]\-]*['"]/
const ASSIGN_PIN_RE = /(?<![=!<>])=\s*['"](?:claude-(?:opus|sonnet|haiku|fable|mythos|3|4|5)|gpt-\d)[a-z0-9.[\]\-]*['"]/
const LIST_PIN_RE = /^\s*['"](?:claude-(?:opus|sonnet|haiku|fable|mythos|3|4|5)|gpt-\d)[a-z0-9.[\]\-]*['"],?\s*$/m

const ALLOW: ReadonlyArray<{ path: string; reason: string }> = [
  { path: 'utils/model/', reason: 'THE model-truth estate — tier getters, catalogues, capability/floor/cost tables, the ratified seat slots (stale-pin alarmed)' },
  { path: 'services/providers/', reason: 'the family runtimes and their pin/catalogue owners' },
  { path: 'utils/router/providers/', reason: 'the router registry descriptions per family' },
  { path: 'utils/router/modelRegistry.ts', reason: 'the router model registry — family rows are its content' },
  { path: 'migrations/', reason: 'id rewrites are the whole job' },
  { path: 'constants/', reason: 'documentation constants (model-currency notes, betas) — no dispatch' },
  { path: 'utils/modelCost.ts', reason: 'pricing tables keyed by family id' },
  { path: 'services/claudeAiLimits.ts', reason: 'family-CORRECT: the quota probe reads the ANTHROPIC window — the ping must ride the Anthropic wire' },
  { path: 'utils/autopilot/tierState.ts', reason: 'the autopilot rails are ratified Anthropic-tier mechanics (opus/sonnet only by default — the boot-menu row says so)' },
  { path: 'services/providers/anthropic/', reason: 'the Anthropic engine core — the small-fast tier getter is projected here for the anthropic lane; the engine itself is the anthropic route' },
  { path: 'services/tokenEstimation.ts', reason: "family-CORRECT: the count-tokens endpoint and the create-probe are Anthropic-wire capabilities (the in-file 1P WARNING; no other family runtime records a counting endpoint) — counting a non-Anthropic conversation through Anthropic's tokenizer would be the wrong truth even when credentialed; callers already degrade to the rough estimator" },
]

const DEBT: ReadonlyArray<{ path: string; carries: string; owner: string }> = [
  { path: 'utils/permissions/yoloClassifier.ts', carries: 'CLASSIFIER_FALLBACK_MODELS (sonnet-5/opus-5)', owner: 'permissions estate — the classifier fallback chain' },
]

const allowFor = (rel: string): { path: string; reason: string } | undefined =>
  ALLOW.find(a => (a.path.endsWith('/') ? rel.startsWith(a.path) : rel === a.path))
const debtFor = (rel: string): boolean => DEBT.some(d => d.path === rel)

interface Hit {
  rel: string
  line: number
  text: string
}

const hits: Hit[] = []
for (const file of walk(SRC)) {
  const rel = relative(SRC, file)
  const src = readFileSync(file, 'utf8')
  if (!GETTER_RE.test(src) && !MODEL_PROP_RE.test(src) && !ASSIGN_PIN_RE.test(src) && !LIST_PIN_RE.test(src)) continue
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/^\s*(\/\/|\*).*$/, '')
    if (GETTER_RE.test(code) || MODEL_PROP_RE.test(code) || ASSIGN_PIN_RE.test(code) || LIST_PIN_RE.test(code)) {
      hits.push({ rel, line: i + 1, text: line.trim().slice(0, 120) })
    }
  })
}

const hires = hits.filter(
  h => !(h.rel === 'utils/model/model.ts'),
)

section('§A adjudicated owners — every allowlisted path is REAL and reasoned')
{
  for (const a of ALLOW) {
    const live = a.path.endsWith('/')
      ? hires.some(h => h.rel.startsWith(a.path)) || statSyncSafe(join(SRC, a.path))
      : statSyncSafe(join(SRC, a.path))
    check(`allow ${a.path} exists (${a.reason.slice(0, 56)}…)`, live, a.path)
  }
}

function statSyncSafe(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

section('§B no unadjudicated family-pinned hire in src')
{
  const strays = hires.filter(h => allowFor(h.rel) === undefined && !debtFor(h.rel))
  check(
    'every family-pinned hire is an adjudicated owner or NAMED debt',
    strays.length === 0,
    strays.map(s => `${s.rel}:${s.line} ${s.text}`).join(' | '),
  )
}

section('§C the debt registry stays honest — every named row still matches')
{
  for (const d of DEBT) {
    const still = hires.some(h => h.rel === d.path)
    check(`debt ${d.path} still carries ${d.carries} → ${d.owner.split('—')[0]?.trim()}`, still, 'paid down? strike the row in the same change')
  }
}

section('§D the Godot/VULCAN estate hires no model (CP-A row 5)')
{
  const estate: string[] = []
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file)
    if (!/godot|vulcan/i.test(rel)) continue
    estate.push(rel)
    const src = readFileSync(file, 'utf8')
    check(
      `${rel}: no model hire of any family`,
      !GETTER_RE.test(src) &&
        !MODEL_PROP_RE.test(src) &&
        !/\b(?:queryWithModel|queryModelWith(?:out)?Streaming|routedCallModel|querySmallFast)\b/.test(src),
    )
  }
  check('the estate was actually swept (lanes + VULCAN + gates present)', estate.length >= 5, String(estate.length))
}

console.log(
  failures === 0
    ? '\n ✅ MODEL-PIN CENSUS — every family-pinned hire adjudicated or named debt; Godot/VULCAN model-free'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
