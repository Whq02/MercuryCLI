#!/usr/bin/env bun
// ============================================================================
//  scripts/tabula/prove-minerva.ts
//  PROOF: MINERVA — the notepad curator's mechanical rails (model: the
//  minerva sub-model container — the operator's /submodels pick, UNSET
//  until pinned; an unset curator spends nothing and answers the hint).
//
//  Locks (all API-free; the billed live pass is operator-armed):
//  prompt build (data tags · byte cap · done-first elision + honest notice) ·
//  output schema shape (strict additionalProperties:false, enum-bound pri) ·
//  the deterministic post-validator table (invented-id fraction refusal ·
//  single dangling ref dropped · bad enum refused · one-line refined cap ·
//  empty receipt refused · orderedIds filtered to live ids · valid plan
//  passes) · runMinervaOnce preconditions (disabled / no notes / journal
//  unchanged / force override) · boot-trigger guards (guest + daemon-worker
//  boots never reach the store) · the model is resolveSubModel('minerva')
//  at each call, dispatched through the routed queryWithModel seam ·
//  a failing API call lands in meta.lastError, never a throw · the CHAT rails
// ops-sandboxed schema (del/edit absent) ·
//  chat post-validator table · apply mints ids/baseHash + minerva provenance
//  + archive · run preconditions + call-site consent (no standing-flag read).
//
//  Run: ~/.bun/bin/bun run scripts/tabula/prove-minerva.ts
// ============================================================================
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }

// Scratch config home (the §7 family-law legs read the real config owner);
// the sub-model env pins must not leak in from the harness environment.
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'minerva-proof-config-'))
delete process.env.MERCURY_MINERVA_MODEL
delete process.env.MERCURY_CONSOLE_MODEL

const gates = await import('../../src/utils/tabula/tabulaGates.ts')
const store = await import('../../src/utils/tabula/tabulaStore.ts')
const minerva = await import('../../src/utils/tabula/minerva.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' MINERVA — curator rails (API-free)')
console.log('============================================================')

const work = mkdtempSync(join(tmpdir(), 'minerva-proof-'))
const saved: Record<string, string | undefined> = {}
for (const k of ['MERCURY_TABULA', 'MERCURY_TABULA_MINERVA', 'MERCURY_TABULA_DIR', 'MERCURY_SESSION_ROOM', 'MERCURY_ROOM_TOKEN', 'MERCURY_WORKER_PARENT_PID']) {
  saved[k] = process.env[k]
  delete process.env[k]
}
process.env.MERCURY_TABULA_DIR = join(work, 'root')

try {
  // ── (1) prompt build ─────────────────────────────────────────────────────
  section('(1) prompt build: data tags · cap · elision')
  const mkNote = (id: string, text: string, done = false) => ({
    id, text, pri: 'next' as const, done, createdAt: 't', updatedAt: 't',
  })
  const small = minerva.buildMinervaUserPrompt([mkNote('aaa', 'ship it'), mkNote('bbb', 'done thing', true)])
  check('notes wrapped in <notes> tags', small.prompt.includes('<notes>') && small.prompt.includes('</notes>'))
  check('open + done shown, none elided', small.shownCount === 2 && small.elidedCount === 0)
  check('no elision notice when nothing elided', !small.prompt.includes('elided'))
  const big = minerva.buildMinervaUserPrompt(
    Array.from({ length: 400 }, (_, i) => mkNote(`id${i}`, 'x'.repeat(200), i >= 200)),
  )
  check('byte cap elides', big.elidedCount > 0)
  check('elision notice present + honest', big.prompt.includes(`${big.elidedCount} additional note(s) were elided`))
  // 200 open notes × ~230 bytes outrun the 24 KB cap by themselves: the
  // NEWEST open notes survive, the oldest open ones elide, every done note
  // elides, and what survives rides in the notepad's own order.
  check('open notes preferred over done under the cap', big.prompt.includes('"id199"') && !big.prompt.includes('"id399"'))
  check('the newest open notes win the budget (the oldest open ones elide)', big.prompt.includes('"id199"') && !big.prompt.includes('"id0"'))
  check('surviving notes keep the notepad order', big.prompt.indexOf('"id198"') !== -1 && big.prompt.indexOf('"id198"') < big.prompt.indexOf('"id199"'))

  // ── (2) output schema ────────────────────────────────────────────────────
  section('(2) output schema')
  const fmt = minerva.minervaOutputFormat() as any
  check('json_schema type', fmt.type === 'json_schema')
  check('strict objects (additionalProperties:false)', fmt.schema.additionalProperties === false && fmt.schema.properties.notes.items.additionalProperties === false)
  check('pri enum bound to the priority table', JSON.stringify(fmt.schema.properties.notes.items.properties.pri.enum) === JSON.stringify(['now', 'next', 'later']))

  // ── (3) post-validator table ─────────────────────────────────────────────
  section('(3) deterministic post-validator')
  const live = new Set(['aaa', 'bbb', 'ccc'])
  const v = (raw: unknown) => minerva.validateMinervaPlan(raw, live)
  check('valid plan passes', v({ notes: [{ id: 'aaa', pri: 'now', refinedText: 'Ship the relay v1' }], orderedIds: ['aaa', 'bbb'], receipt: '3 notes · 1 promoted' }).ok === true)
  const dangling = v({ notes: [{ id: 'aaa' }, { id: 'zzz' }, { id: 'bbb' }, { id: 'ccc' }], orderedIds: [], receipt: 'r' })
  check('single dangling ref dropped, plan kept', dangling.ok === true && (dangling as any).plan.notes.length === 3)
  const confab = v({ notes: [{ id: 'x1' }, { id: 'x2' }, { id: 'aaa' }], orderedIds: [], receipt: 'r' })
  check('mostly-invented ids ⇒ plan refused', confab.ok === false && (confab as any).reason.includes('unknown note ids'))
  check('bad pri refused', v({ notes: [{ id: 'aaa', pri: 'urgent' }], orderedIds: [], receipt: 'r' }).ok === false)
  // hardening (the "× refinedText exceeds the one-line cap" rail
  // error): one overflowed polish must never refuse the WHOLE plan — the
  // offending note's refinement is dropped (its text untouched), the plan
  // and every other refinement survive.
  const overlong = v({ notes: [{ id: 'aaa', refinedText: 'y'.repeat(300) }, { id: 'bbb', refinedText: 'Sharp one-liner' }], orderedIds: [], receipt: 'r' })
  check('over-long refinedText DROPPED per-note, plan kept', overlong.ok === true
    && (overlong as any).plan.notes.find((n: any) => n.id === 'aaa')?.refinedText === undefined
    && (overlong as any).plan.notes.find((n: any) => n.id === 'bbb')?.refinedText === 'Sharp one-liner')
  const multiline = v({ notes: [{ id: 'aaa', refinedText: 'a\nb' }], orderedIds: [], receipt: 'r' })
  check('multi-line refinedText whitespace-REPAIRED, plan kept', multiline.ok === true
    && (multiline as any).plan.notes.find((n: any) => n.id === 'aaa')?.refinedText === 'a b')
  check('non-string refinedText still refused (malformed, not overflowed)', v({ notes: [{ id: 'aaa', refinedText: 42 }], orderedIds: [], receipt: 'r' }).ok === false)
  check('empty receipt refused', v({ notes: [], orderedIds: [], receipt: '   ' }).ok === false)
  const filtered = v({ notes: [], orderedIds: ['zzz', 'bbb', 'aaa', 'qqq'], receipt: 'ordered' })
  check('orderedIds filtered to live ids, order kept', filtered.ok === true && JSON.stringify((filtered as any).plan.orderedIds) === JSON.stringify(['bbb', 'aaa']))
  check('non-object refused', v('nope').ok === false)

  // ── (4) runMinervaOnce preconditions ─────────────────────────────────────
  section('(4) run preconditions')
  const dir = gates.tabulaProjectDir('/Users/nobody/dev/minerva-proj')
  let r = await minerva.runMinervaOnce(dir, 'p')
  check('not armed ⇒ never runs', r.ran === false && (r as any).reason.includes('not armed'))
  process.env.MERCURY_TABULA_MINERVA = '1'
  r = await minerva.runMinervaOnce(dir, 'p')
  check('no notes ⇒ never runs', r.ran === false && (r as any).reason.includes('no open notes'))
  store.appendEvents(dir, [{ t: '2026-07-08T10:00:00Z', op: 'add', id: 'aaa111', text: 'a real note', pri: 'now' }])
  store.writeTabulaMeta(dir, { lastMinervaJournalBytes: store.readNotes(dir).journalBytes })
  r = await minerva.runMinervaOnce(dir, 'p')
  check('journal unchanged ⇒ never runs', r.ran === false && (r as any).reason.includes('unchanged'))

  // ── (4b) UNSET container ⇒ the boot pass skips with the hint, spends nothing ─
  section('(4b) UNSET minerva: the pass skips with the hint · zero wire · meta untouched')
  store.appendEvents(dir, [{ t: '2026-07-08T10:01:00Z', op: 'add', id: 'bbb222', text: 'another note' }])
  {
    const { enableConfigs } = await import('../../src/utils/config.ts')
    enableConfigs() // resolveSubModel reads the real config owner (scratch home, nothing saved)
    const { SUB_MODEL_UNSET_HINT } = await import('../../src/utils/model/subModelSlots.ts')
    const realFetch = globalThis.fetch
    let wireCalls = 0
    globalThis.fetch = (async () => {
      wireCalls++
      throw new Error('an unset minerva must never reach the wire')
    }) as unknown as typeof fetch
    const metaBefore = JSON.stringify(store.readTabulaMeta(dir))
    r = await minerva.runMinervaOnce(dir, 'p')
    globalThis.fetch = realFetch
    check('unset ⇒ the pass does not run', r.ran === false, JSON.stringify(r))
    check('…and the skip reason IS the hint, verbatim', r.ran === false && r.reason === SUB_MODEL_UNSET_HINT, JSON.stringify(r))
    check('zero wire requests', wireCalls === 0, String(wireCalls))
    check('meta untouched (no lastError, no stamp)', JSON.stringify(store.readTabulaMeta(dir)) === metaBefore)
  }

  // ── (5) API failure path (hermetic: a pinned model, the call has no auth) ─
  section('(5) failing call lands in meta, never throws')
  // The pass needs a PINNED model to dispatch at all (unset never spends):
  // the env pin is the deterministic pin (no catalogue validation), and the
  // credential-less home makes the call fail honestly.
  process.env.MERCURY_MINERVA_MODEL = 'claude-sonnet-5'
  r = await minerva.runMinervaOnce(dir, 'p', { signal: AbortSignal.timeout(4000) })
  delete process.env.MERCURY_MINERVA_MODEL
  check('run attempted + failed gracefully', r.ran === true && (r as any).ok === false, JSON.stringify(r).slice(0, 90))
  const meta = store.readTabulaMeta(dir)
  check('failure recorded in meta.lastError', typeof meta.lastError === 'string' && meta.lastError.length > 0)

  // ── (6) boot-trigger guards ──────────────────────────────────────────────
  section('(6) boot guards (guest + worker never reach the store)')
  const guestCwd = '/Users/nobody/dev/guest-proj'
  const guestDir = gates.tabulaProjectDir(guestCwd)
  store.appendEvents(guestDir, [{ t: '2026-07-08T10:00:00Z', op: 'add', id: 'g1', text: 'host note' }])
  const metaPathG = join(guestDir, 'meta.json')
  process.env.MERCURY_SESSION_ROOM = 'room-1'
  process.env.MERCURY_ROOM_TOKEN = 'tok'
  minerva.maybeRunMinervaOnBoot(guestCwd)
  await new Promise(res => setTimeout(res, 300))
  check('guest boot: no meta ever written', !existsSync(metaPathG))
  delete process.env.MERCURY_SESSION_ROOM
  delete process.env.MERCURY_ROOM_TOKEN
  process.env.MERCURY_WORKER_PARENT_PID = '1234'
  minerva.maybeRunMinervaOnBoot(guestCwd)
  await new Promise(res => setTimeout(res, 300))
  check('daemon-worker boot: no meta ever written', !existsSync(metaPathG))
  delete process.env.MERCURY_WORKER_PARENT_PID

  // ── (7) model resolution ─────────────────────────────────────────────────
  section('(7) model resolution — the one sub-model container owner')
  const src = readFileSync(join(import.meta.dir, '../../src/utils/tabula/minerva.ts'), 'utf8')
  check("resolves through resolveSubModel('minerva')", src.includes(`resolveSubModel('minerva')`))
  check('no ad-hoc model resolution beside the owner', !src.includes('getMainLoopModel') && !src.includes('getSmallFastModel'))
  check('both runners ride the one resolution (two call sites)', (src.match(/model: slot\.model/g) ?? []).length === 2)
  check('both runners stamp the identity line from the same resolution (two call sites)', (src.match(/minervaIdentityLine\(slot\)/g) ?? []).length === 2)
  check('both runners answer UNSET before dispatch (two short-circuits)', (src.match(/if \(slot\.origin === 'unset'\)/g) ?? []).length === 2)
  check('no family-pinned model literal in the curator', !/['"](claude|gpt)-/.test(src))
  check('no tier owner beside the container owner', !src.includes('providerFrontier') && !src.includes('providerLightFact'))
  check(
    'dispatch rides the routed one-shot seam (queryWithModel), never a bare Anthropic call',
    (src.match(/queryWithModel\(/g) ?? []).length === 2 && !src.includes('queryModelWithStreaming'),
  )
  // THE UNSET LAW (the operator's word): whatever the main model's family,
  // an unpinned curator resolves UNSET with the hint — no family default,
  // no tier. The full ladder (env > saved > unset, the persisted pick
  // surviving a restart, the catalogue equality) lives in
  // scripts/model-registry/prove-submodels.ts.
  {
    const slots = await import('../../src/utils/model/subModelSlots.ts')
    const { enableConfigs } = await import('../../src/utils/config.ts')
    enableConfigs() // resolveSubModel reads the real config owner (armed harness, scratch home)
    const priorModel = process.env.ANTHROPIC_MODEL
    for (const main of ['gpt-5.6-sol', 'gemini-2.5-pro', 'claude-fable-5', 'openrouter/nvidia/nemotron-3.5-lightning:free']) {
      process.env.ANTHROPIC_MODEL = main
      const r7 = slots.resolveSubModel('minerva')
      check(
        `main ${main}: the curator resolves UNSET with the hint (no family default)`,
        r7.origin === 'unset' && r7.hint === slots.SUB_MODEL_UNSET_HINT,
        JSON.stringify(r7),
      )
    }
    process.env.MERCURY_MINERVA_MODEL = 'openrouter/fixture-vendor/ox-alpha'
    const pinned = slots.resolveSubModel('minerva')
    check(
      'an env pin on a carrier id resolves on the openrouter route with its own id',
      pinned.origin === 'env' && pinned.route === 'openrouter' && pinned.model === 'openrouter/fixture-vendor/ox-alpha',
      JSON.stringify(pinned),
    )
    if (pinned.origin !== 'unset') {
      const line = minerva.minervaIdentityLine(pinned)
      check(
        'the identity line for that pin names the id and the OpenRouter wire',
        line.includes('model id "openrouter/fixture-vendor/ox-alpha"') && line.includes('via the OpenRouter wire') && line.includes('you are Minerva'),
        line,
      )
    }
    delete process.env.MERCURY_MINERVA_MODEL
    if (priorModel === undefined) delete process.env.ANTHROPIC_MODEL
    else process.env.ANTHROPIC_MODEL = priorModel
  }

  // ── (8) chat: schema sandbox ─────────────────────────────────────────────
  section('(8) chat schema — the ops sandbox')
  const cfmt = minerva.minervaChatOutputFormat() as any
  check('json_schema type', cfmt.type === 'json_schema')
  check('strict objects', cfmt.schema.additionalProperties === false && cfmt.schema.properties.ops.items.additionalProperties === false)
  const opEnum = cfmt.schema.properties.ops.items.properties.op.enum as string[]
  check('op vocabulary is add/done/pri/refine', JSON.stringify([...opEnum].sort()) === JSON.stringify(['add', 'done', 'pri', 'refine']))
  check("`del` and `edit` structurally absent", !opEnum.includes('del') && !opEnum.includes('edit'))
  // The prompts take the harness-stamped identity line (a required
  // argument — a runner cannot forget the stamp). A fixture pin stands in.
  const fixturePin = { origin: 'saved', model: 'openrouter/fixture-vendor/ox-alpha', route: 'openrouter' } as const
  const identityLine = minerva.minervaIdentityLine(fixturePin)
  check('system prompt pins the data rail + no-delete law', (() => {
    const sys = minerva.minervaChatSystemPrompt(identityLine).join('\n')
    return sys.includes('USER DATA') && sys.includes('cannot delete') && sys.includes('never invent ids')
  })())
  // Refinement is prompt CONSTRUCTION, not rewording (operator:
  // "basic ass refinement ... not enforcing actual prompting methods").
  check('refine contract enforces prompt construction in BOTH prompts', (() => {
    const boot = minerva.minervaSystemPrompt(identityLine).join('\n')
    const chat = minerva.minervaChatSystemPrompt(identityLine).join('\n')
    const rules = ['directly fireable prompt', 'imperative verb', 'done-criterion', 'invent scope']
    const exemplar = '→ "Investigate the prompt-cache behavior'
    return (
      rules.every(n => boot.includes(n)) && boot.includes(exemplar) &&
      rules.every(n => chat.includes(n)) && chat.includes(exemplar)
    )
  })())
  check('chat add composes fireable prompts on a craft ask', minerva.minervaChatSystemPrompt(identityLine).join('\n').includes('compose the note text as a directly fireable prompt'))
  // THE IDENTITY STAMP + THE ROLE (the operator's word): both prompts carry
  // the engine line for the resolved pin verbatim and Minerva's role — the
  // notepad and nothing else, never the main agent, no tools — and the chat
  // prompt tells the model to answer "who/what model/what job" from those
  // facts with no ops.
  {
    const boot = minerva.minervaSystemPrompt(identityLine).join('\n')
    const chat = minerva.minervaChatSystemPrompt(identityLine).join('\n')
    check('the identity line rides BOTH prompts verbatim', boot.includes(identityLine) && chat.includes(identityLine))
    check(
      'the identity line names the resolved id (quoted) and the wire, as a harness-stamped fact',
      identityLine.includes('model id "openrouter/fixture-vendor/ox-alpha"') && identityLine.includes('via the OpenRouter wire') && identityLine.includes('stamped by the Mercury harness'),
      identityLine,
    )
    check('the ROLE rides both prompts verbatim', boot.includes(minerva.MINERVA_ROLE) && chat.includes(minerva.MINERVA_ROLE))
    check(
      'the role: the notepad and nothing else · not the main agent · no tools · states itself when asked',
      minerva.MINERVA_ROLE.includes('curate this project notepad and nothing else') &&
        minerva.MINERVA_ROLE.includes("not Mercury's main agent") &&
        minerva.MINERVA_ROLE.includes('you have no tools') &&
        minerva.MINERVA_ROLE.includes('you are Minerva, the notepad curator'),
    )
    check(
      'the chat prompt answers identity/job questions in reply with NO ops',
      chat.includes('asks who you are, what model you are, or what your job is, emit no ops and answer in reply'),
    )
    check(
      'both prompts spell the exact JSON shape (a schema-less wire answers the same shape)',
      boot.includes('Output format — exactly this JSON object') && boot.includes('"orderedIds":[') &&
        chat.includes('Output format — exactly this JSON object') && chat.includes('"ops":['),
    )
    check(
      'nothing in either prompt invites the model to speak as the main agent (both open as Minerva, both deny the main agent, neither says "You are Mercury")',
      boot.startsWith('You are Minerva') && chat.startsWith('You are Minerva') &&
        boot.includes("not Mercury's main agent") && chat.includes("not Mercury's main agent") &&
        !/you are mercury\b/i.test(boot) && !/you are mercury\b/i.test(chat),
    )
  }

  // ── (9) chat: prompt build ───────────────────────────────────────────────
  section('(9) chat prompt build')
  const chatPrompt = minerva.buildMinervaChatUserPrompt(
    [mkNote('aaa', 'ship it'), mkNote('bbb', 'done thing', true)],
    'mark the ship note done',
  )
  check('open notes as <notes> data', chatPrompt.includes('<notes>') && chatPrompt.includes('"aaa"'))
  check('done notes excluded from chat context', !chatPrompt.includes('"bbb"'))
  check('operator message in its own tags', chatPrompt.includes('<operator_message>\nmark the ship note done\n</operator_message>'))

  // ── (10) chat: post-validator table ──────────────────────────────────────
  section('(10) chat post-validator')
  const clive = new Set(['aaa', 'bbb', 'ccc'])
  const cv = (raw: unknown) => minerva.validateMinervaChatPlan(raw, clive)
  const good = cv({
    ops: [
      { op: 'add', text: 'benchmark the gate', pri: 'now' },
      { op: 'done', id: 'aaa' },
      { op: 'pri', id: 'bbb', pri: 'later' },
      { op: 'refine', id: 'ccc', refinedText: 'Sharper phrasing' },
    ],
    reply: 'added 1 · closed 1 · re-prioritized 1 · refined 1',
  })
  check('valid mixed plan passes', good.ok === true && (good as any).plan.ops.length === 4)
  check('op cap refuses', cv({ ops: Array.from({ length: 9 }, () => ({ op: 'add', text: 'x' })), reply: 'r' }).ok === false)
  check('unknown op refused (validator law, not just schema)', cv({ ops: [{ op: 'del', id: 'aaa' }], reply: 'r' }).ok === false)
  // One law for every text-bearing op (the refine precedent): a multi-line
  // add is whitespace-repaired and kept; an overlong add drops ALONE and is
  // REPORTED, never a whole-turn refusal — the operator asked for a
  // fireable prompt and gets told exactly why it did not land.
  const aMulti = cv({ ops: [{ op: 'add', text: 'a\nb' }], reply: 'r' })
  check('multi-line add whitespace-REPAIRED, kept', aMulti.ok === true && (aMulti as any).plan.ops[0]?.text === 'a b')
  const aLong = cv({ ops: [{ op: 'add', text: 'y'.repeat(300) }, { op: 'done', id: 'aaa' }], reply: 'added 1 · closed 1' })
  check('over-long add DROPPED per-op, plan kept', aLong.ok === true && (aLong as any).plan.ops.length === 1 && (aLong as any).plan.ops[0].op === 'done')
  check('…and the drop is REPORTED', aLong.ok === true && (aLong as any).dropped.length === 1 && (aLong as any).dropped[0].includes('over the 200-char cap'))
  check(
    'the reply the operator reads carries the drop',
    minerva.minervaChatReplyLine('added 1 · closed 1', (aLong as any).dropped) === 'added 1 · closed 1 · dropped: add over the 200-char cap (300)',
  )
  check('a clean plan reports nothing dropped', good.ok === true && (good as any).dropped.length === 0 && minerva.minervaChatReplyLine('ok', []) === 'ok')
  check('bad pri refused', cv({ ops: [{ op: 'pri', id: 'aaa', pri: 'urgent' }], reply: 'r' }).ok === false)
  const dangling1 = cv({ ops: [{ op: 'done', id: 'zzz' }, { op: 'done', id: 'aaa' }, { op: 'pri', id: 'bbb', pri: 'now' }, { op: 'refine', id: 'ccc', refinedText: 'ok' }], reply: 'r' })
  check('single dangling ref (1/4 ≤ the fraction cap) dropped, plan kept', dangling1.ok === true && (dangling1 as any).plan.ops.length === 3)
  check('…and the dangling ref is reported', dangling1.ok === true && (dangling1 as any).dropped.length === 1 && (dangling1 as any).dropped[0] === 'done on an unknown id')
  const confab2 = cv({ ops: [{ op: 'done', id: 'x1' }, { op: 'done', id: 'x2' }, { op: 'done', id: 'aaa' }], reply: 'r' })
  check('mostly-invented ids ⇒ refused', confab2.ok === false)
  check('empty reply refused', cv({ ops: [], reply: '  ' }).ok === false)
  // hardening: an overflowed refine op is dropped alone (the
  // note's text is untouched); a multi-line one is whitespace-repaired.
  const cOverlong = cv({ ops: [{ op: 'refine', id: 'aaa', refinedText: 'y'.repeat(600) }, { op: 'done', id: 'bbb' }], reply: 'r' })
  check('over-long chat refine DROPPED per-op, plan kept', cOverlong.ok === true && (cOverlong as any).plan.ops.length === 1 && (cOverlong as any).plan.ops[0].op === 'done')
  const cMulti = cv({ ops: [{ op: 'refine', id: 'aaa', refinedText: 'a\nb' }], reply: 'r' })
  check('multi-line chat refine whitespace-REPAIRED, kept', cMulti.ok === true && (cMulti as any).plan.ops[0]?.refinedText === 'a b')
  check('empty add text dropped as no-op', (() => {
    const p = cv({ ops: [{ op: 'add', text: '   ' }], reply: 'noted' })
    return p.ok === true && (p as any).plan.ops.length === 0
  })())

  // ── (11) chat: apply lands as guarded journal events ─────────────────────
  section('(11) chat apply')
  const cdir = gates.tabulaProjectDir('/Users/nobody/dev/chat-proj')
  store.appendEvents(cdir, [
    { t: '2026-07-09T08:00:00Z', op: 'add', id: 'note01', text: 'old wording here' },
    { t: '2026-07-09T08:00:01Z', op: 'add', id: 'note02', text: 'the finished thing' },
  ])
  // Real surfaces materialize on every mutation — mirror that so the apply
  // has a prior notepad.md to archive (archiveNotepad skips when none).
  store.materializeNotepad(cdir, 'chat-proj')
  const capplied = minerva.applyMinervaChatPlan(cdir, 'chat-proj', {
    ops: [
      { op: 'add', text: 'benchmark the pooled gate', pri: 'now' },
      { op: 'done', id: 'note02' },
      { op: 'refine', id: 'note01', refinedText: 'Old wording, sharpened' },
    ],
    reply: 'added 1 · closed 1 · refined 1',
  })
  check('apply ok + honest counts', capplied.ok === true && (capplied as any).added === 1 && (capplied as any).closed === 1 && (capplied as any).refined === 1)
  const cr = store.readNotes(cdir)
  check('add minted a real id + landed with pri', cr.notes.some(n => n.text === 'benchmark the pooled gate' && n.pri === 'now'))
  check('done landed with minerva provenance', cr.notes.find(n => n.id === 'note02')?.doneVia === 'minerva')
  check('refine landed BESIDE the original (baseHash fresh)', cr.notes.find(n => n.id === 'note01')?.refinedText === 'Old wording, sharpened' && cr.notes.find(n => n.id === 'note01')?.text === 'old wording here')
  check('history archived on chat apply', readdirSync(join(cdir, 'history')).length >= 1)
  const emptyApply = minerva.applyMinervaChatPlan(cdir, 'chat-proj', { ops: [], reply: 'nothing to do' })
  check('zero-event apply archives nothing new', emptyApply.ok === true && readdirSync(join(cdir, 'history')).length === 1)

  // ── (12) chat: run preconditions (API-free) ──────────────────────────────
  section('(12) chat run preconditions')
  let cres = await minerva.runMinervaMessage(cdir, 'chat-proj', '   ')
  check('empty message never runs', cres.ran === false)
  cres = await minerva.runMinervaMessage(cdir, 'chat-proj', 'x'.repeat(2100))
  check('over-long message never runs', cres.ran === false && (cres as any).reason.includes('exceeds'))
  process.env.MERCURY_TABULA = '0'
  cres = await minerva.runMinervaMessage(cdir, 'chat-proj', 'add a thing')
  check('tabula kill refuses chat', cres.ran === false)
  delete process.env.MERCURY_TABULA
  // UNSET minerva ⇒ the hint IS the reply (a completed exchange with zero
  // ops), zero wire requests, no meta stamp, the journal untouched — the
  // board's chip, the rail's receipt row, and the /minerva line all paint
  // this reply where the answer goes.
  {
    const { SUB_MODEL_UNSET_HINT } = await import('../../src/utils/model/subModelSlots.ts')
    delete process.env.MERCURY_MINERVA_MODEL
    const realFetch = globalThis.fetch
    let wireCalls = 0
    globalThis.fetch = (async () => {
      wireCalls++
      throw new Error('an unset minerva must never reach the wire')
    }) as unknown as typeof fetch
    const journalBefore = store.readNotes(cdir).journalBytes
    const metaBefore = JSON.stringify(store.readTabulaMeta(cdir))
    const unset = await minerva.runMinervaMessage(cdir, 'chat-proj', 'what model are you?')
    globalThis.fetch = realFetch
    check('unset ⇒ the exchange completes ok', unset.ran === true && (unset as any).ok === true, JSON.stringify(unset))
    check('…with the hint AS THE REPLY, verbatim', (unset as any).reply === SUB_MODEL_UNSET_HINT, JSON.stringify(unset))
    check('…and zero ops counted', (unset as any).added === 0 && (unset as any).closed === 0 && (unset as any).refined === 0 && (unset as any).repri === 0)
    check('zero wire requests', wireCalls === 0, String(wireCalls))
    check('the journal is untouched', store.readNotes(cdir).journalBytes === journalBefore)
    check('meta is untouched (no lastChatAt, no lastReceipt for a hint)', JSON.stringify(store.readTabulaMeta(cdir)) === metaBefore)
  }
  // NOTE deliberately absent: no standing-flag check — the typed message is
  // the consent (board `m` precedent); runMinervaMessage must NOT consult
  // isMinervaEnabled. Locked structurally:
  check('chat runner ignores the standing arm flag (call-site consent)', (() => {
    const fnSrc = src.slice(src.indexOf('export async function runMinervaMessage'))
    return !fnSrc.slice(0, fnSrc.indexOf('}\n\n')).includes('isMinervaEnabled')
  })())

  // ── (13) TICK-OFF ─
  section('(13) tick-off — evidence in, done out, confined to open notes')
  {
    const withEv = minerva.buildMinervaUserPrompt(
      [mkNote('aaa', 'ship it')],
      ['completed task: ship it end to end', 'completed task: unrelated thing'],
    )
    check('completed-work evidence renders as a labeled data section',
      withEv.prompt.includes('<completed-work>') && withEv.prompt.includes('completed task: ship it end to end'))
    const noEv = minerva.buildMinervaUserPrompt([mkNote('aaa', 'ship it')])
    check('no evidence ⇒ no section (absence is honest)', !noEv.prompt.includes('<completed-work>'))
    const longEv = minerva.buildMinervaUserPrompt(
      [mkNote('aaa', 'ship it')],
      Array.from({ length: 60 }, (_, i) => `completed task: t${i} ` + 'y'.repeat(400)),
    )
    check('evidence is bounded (rows capped, lines clipped)',
      (longEv.prompt.match(/completed task:/g) ?? []).length <= 20 && !longEv.prompt.includes('y'.repeat(200)))
    // Validation: doneIds live∧open only; junk drops without refusing the plan.
    const openOnly = new Set(['aaa'])
    const vt = minerva.validateMinervaPlan(
      { notes: [], orderedIds: [], receipt: 'r', doneIds: ['aaa', 'aaa', 'bbb', 'zzz', 7] },
      new Set(['aaa', 'bbb']),
      openOnly,
    )
    check('doneIds confined to live∧OPEN, deduped; junk drops, plan stands',
      vt.ok && JSON.stringify((vt as any).plan.doneIds) === JSON.stringify(['aaa']))
    const vNone = minerva.validateMinervaPlan(
      { notes: [], orderedIds: [], receipt: 'r' },
      new Set(['aaa']),
      openOnly,
    )
    check('absent doneIds ⇒ absent on the plan (no phantom key)', vNone.ok && !('doneIds' in (vNone as any).plan))
    // The prompt actually teaches the law + the schema carries the field.
    check('the organize prompt carries the TICK OFF law (evidence-only, conservative)',
      minerva.minervaSystemPrompt(identityLine).join('\n').includes('TICK OFF') &&
        minerva.minervaSystemPrompt(identityLine).join('\n').includes('when in doubt, leave it open'))
    check('the output schema offers doneIds',
      JSON.stringify(minerva.minervaOutputFormat()).includes('doneIds'))
    // Apply: a validated tick lands as done:true via:'minerva' (reversible).
    const tickSrc = readFileSync(join(import.meta.dir, '../../src/utils/tabula/tabulaStore.ts'), 'utf8')
    check("apply writes op:'done' with via:'minerva' for plan.doneIds",
      /plan\.doneIds \?\? \[\]/.test(tickSrc) && /op: 'done', id, done: true, via: 'minerva'/.test(tickSrc))
    // The evidence source: the session task ledger's completed subjects.
    check('runMinervaOnce feeds the completed task ledger as evidence',
      /listTasks\(getTaskListId\(\)\)/.test(src) && /status === 'completed'/.test(src))
  }
} finally {
  for (const [k, v2] of Object.entries(saved)) {
    if (v2 === undefined) delete process.env[k]
    else process.env[k] = v2
  }
  rmSync(work, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ' ✅ MINERVA PASS' : ` ❌ MINERVA — ${failures} failure(s)`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
