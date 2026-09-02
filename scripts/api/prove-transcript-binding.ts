#!/usr/bin/env bun
// ============================================================================
//  scripts/api/prove-transcript-binding.ts — the preserved-thinking contract
//  (Claude Fable 5.1 binds every thinking block to the prefix that produced
//  it): Mercury's setting, its reading of what the API dropped, the
//  client-side strips that keep a request valid by construction, and the
//  consecutive-request prefix identity of the real product on the wire.
//
//    §1 the setting table — MERCURY_THINKING_BINDING resolves to drop_block
//       (unset, not explicit), error, drop_block (explicit spellings), off,
//       and junk rides drop_block.
//    §2 applyThinkingBinding — the field and the controls header ride
//       together; identity without thinking; unset is first-party only; an
//       explicit value rides every host; off is identity; the caller's
//       thinking object is never mutated; the header is admitted once.
//    §3 the reading — inputTransformationsOf tolerates every absent or
//       malformed shape; describeInputTransformations names count, path and
//       reason class, and stays silent on an empty list.
//    §4 the strips — stripThinkingFromIndex keeps the blocks before the edit
//       and strips the run after it (text and tool_use stay; identity when
//       nothing changes); the media ceiling strip does the same from the
//       first edited message.
//    §5 the wire — the built dist runs a tool round, then two resumed turns,
//       against the fixture API (signed thinking on every scripted turn,
//       MERCURY_THINKING_BINDING=error asserted on the fixture host): every
//       request carries the header and the field; the assistant turns
//       replay byte-identical with their thinking; for every pair of
//       consecutive requests, system, tools and the shared messages prefix
//       are byte-identical (cache_control markers aside, which the check
//       exempts) — the docs' step-1 capture, printed per pair; a scripted
//       drop list rides the minted assistant envelope to the stream-json
//       record and paints the operator's notice exactly once.
//
//  Requires the prebuilt dist for §5. Run:
//    ~/.bun/bin/bun run scripts/api/prove-transcript-binding.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

// Hermetic pins BEFORE any src import: the config-read gate opens under
// NODE_ENV=test, the credential presence check wants a key, and the config
// home must never be the operator's.
process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'transcript-binding-pure-'))
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
delete process.env.MERCURY_THINKING_BINDING
delete process.env.ANTHROPIC_BASE_URL

import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — transcript-binding proofs exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const binding = await import('../../src/services/providers/anthropic/thinkingBinding.ts')
const { THINKING_BINDING_CONTROLS_BETA_HEADER } = await import('../../src/constants/betas.ts')
const { stripThinkingFromIndex, stripSignatureBlocks } = await import('../../src/utils/messages/apiFilters.ts')
const { stripExcessMediaItems } = await import('../../src/services/providers/anthropic/media.ts')

// ============================================================================
section('§1 the setting table')
// ============================================================================
{
  const r = binding.resolveThinkingBindingSetting
  const eq = (a: unknown, b: unknown): boolean => j(a) === j(b)
  check('unset ⇒ drop_block, not explicit', eq(r(undefined), { behavior: 'drop_block', explicit: false }))
  check('empty ⇒ drop_block, not explicit', eq(r(''), { behavior: 'drop_block', explicit: false }) && eq(r('   '), { behavior: 'drop_block', explicit: false }))
  check("'error' ⇒ error, explicit (case-insensitive)", eq(r('error'), { behavior: 'error', explicit: true }) && eq(r(' ERROR '), { behavior: 'error', explicit: true }))
  for (const spelling of ['drop_block', 'drop', '1', 'true']) {
    check(`'${spelling}' ⇒ drop_block, explicit`, eq(r(spelling), { behavior: 'drop_block', explicit: true }))
  }
  for (const spelling of ['0', 'off', 'false', 'none']) {
    check(`'${spelling}' ⇒ off, explicit`, eq(r(spelling), { behavior: null, explicit: true }))
  }
  check('junk rides drop_block, explicit', eq(r('sometimes'), { behavior: 'drop_block', explicit: true }))
  check('resolveThinkingBindingBehavior is the behavior half', binding.resolveThinkingBindingBehavior('error') === 'error' && binding.resolveThinkingBindingBehavior('off') === null && binding.resolveThinkingBindingBehavior(undefined) === 'drop_block')
}

// ============================================================================
section('§2 applyThinkingBinding — the field and the header ride together')
// ============================================================================
{
  const apply = binding.applyThinkingBinding
  const H = THINKING_BINDING_CONTROLS_BETA_HEADER
  {
    const betas: string[] = ['x-beta']
    const out = apply(undefined, betas, { env: undefined, firstParty: () => true })
    check('no thinking ⇒ identity, betas untouched', out === undefined && j(betas) === j(['x-beta']))
  }
  {
    const thinking = { type: 'adaptive' }
    const betas: string[] = []
    const out = apply(thinking, betas, { env: undefined, firstParty: () => true })
    check('unset on the first-party host ⇒ drop_block stamped', j(out) === j({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } }), j(out))
    check('…and the controls header admitted', betas.includes(H), j(betas))
    check("…the caller's thinking object is never mutated", !('block_binding' in thinking))
    apply(thinking, betas, { env: undefined, firstParty: () => true })
    check('…the header is admitted once across attempts', betas.filter(b => b === H).length === 1, j(betas))
  }
  {
    const thinking = { type: 'adaptive' }
    const betas: string[] = []
    const out = apply(thinking, betas, { env: undefined, firstParty: () => false })
    check('unset off the first-party host ⇒ identity (a gateway may refuse the beta)', out === thinking && betas.length === 0)
  }
  {
    const thinking = { type: 'adaptive' }
    const betas: string[] = []
    const out = apply(thinking, betas, { env: 'error', firstParty: () => false })
    check("explicit 'error' rides every host (the operator's assertion)", j(out) === j({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'error' } }) && betas.includes(H), `${j(out)} ${j(betas)}`)
  }
  {
    const thinking = { type: 'enabled', budget_tokens: 1024 }
    const betas: string[] = []
    const out = apply(thinking, betas, { env: 'off', firstParty: () => true })
    check("explicit 'off' ⇒ identity, no header, on the first-party host", out === thinking && betas.length === 0)
  }
  {
    const thinking = { type: 'enabled', budget_tokens: 1024 }
    const betas: string[] = ['other']
    const out = apply(thinking, betas, { env: 'drop_block', firstParty: () => true })
    check('the budget shape keeps its fields beside the binding', j(out) === j({ type: 'enabled', budget_tokens: 1024, block_binding: { prefix_mismatch_behavior: 'drop_block' } }) && j(betas) === j(['other', H]), j(out))
  }
}

// ============================================================================
section('§3 the reading — input_transformations off a response')
// ============================================================================
{
  const of = binding.inputTransformationsOf
  const describe = binding.describeInputTransformations
  check('absent ⇒ []', of(undefined).length === 0 && of(null).length === 0 && of({}).length === 0)
  check('null / non-array ⇒ []', of({ input_transformations: null }).length === 0 && of({ input_transformations: 'x' }).length === 0)
  const list = of({
    input_transformations: [
      { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'prefix_binding_mismatch' },
      'junk',
      { path: 'no-type' },
      { type: 'thinking_dropped', path: 'messages.5.content.0', reason: 'prefix_binding_mismatch' },
    ],
  })
  check('entries without a string type are dropped, the rest kept in order', list.length === 2 && list[0]!.path === 'messages.3.content.0' && list[1]!.path === 'messages.5.content.0', j(list))
  check('an empty list describes as null (nothing to paint)', describe([]) === null)
  const one = describe([{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }]) ?? ''
  check('one prefix mismatch: count, path and the client-side-edit reading', one.includes('dropped 1 thinking block —') && one.includes('messages.1.content.0') && one.includes('client-side edit'), one)
  const two = describe([
    { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'model_binding_mismatch' },
    { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'model_binding_mismatch' },
  ]) ?? ''
  check('two model mismatches: the plural and the switched-models reading', two.includes('dropped 2 thinking blocks') && two.includes('switched models'), two)
  const mixed = describe([
    { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
    { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'something_new' },
  ]) ?? ''
  check('a mixed or unknown reason names every reason and the first path', mixed.includes('prefix_binding_mismatch') && mixed.includes('something_new') && mixed.includes('first at messages.1.content.0'), mixed)
}

// ============================================================================
section('§4 the strips — from the first edited message onward')
// ============================================================================
type Block = Record<string, unknown>
const THINK = (text: string): Block => ({ type: 'thinking', thinking: text, signature: 'sig-' + text })
const TEXT = (text: string): Block => ({ type: 'text', text })
let seq = 0
function user(content: Block[] | string): Record<string, unknown> {
  seq++
  return {
    type: 'user',
    uuid: `00000000-0000-4000-8000-0000000000${String(seq).padStart(2, '0')}`,
    timestamp: '2026-09-01T00:00:00.000Z',
    message: { role: 'user', content },
  }
}
function assistant(content: Block[]): Record<string, unknown> {
  seq++
  return {
    type: 'assistant',
    uuid: `00000000-0000-4000-8000-0000000000${String(seq).padStart(2, '0')}`,
    timestamp: '2026-09-01T00:00:00.000Z',
    requestId: `req_${seq}`,
    message: {
      id: `msg_${seq}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-fable-5-1',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}
// String content (a plain user prompt) has no blocks: the strips pass such
// rows by reference and the walkers below must read them as empty.
const blocksOf = (m: unknown): Block[] => {
  const content = (m as { message?: { content?: unknown } } | undefined)?.message?.content
  return Array.isArray(content) ? (content as Block[]) : []
}
const hasThinking = (m: unknown): boolean => blocksOf(m).some(b => b.type === 'thinking' || b.type === 'redacted_thinking')
{
  const history = [
    user('first'),
    assistant([THINK('one'), TEXT('a')]),
    user('second'),
    assistant([THINK('two'), { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x' } }]),
    user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'bytes' }]),
    assistant([THINK('three'), TEXT('b')]),
  ]
  const out = stripThinkingFromIndex(history as never, 3) as unknown as Record<string, unknown>[]
  check('the blocks before the edit keep their thinking (index 1)', hasThinking(out[1]) && out[1] === history[1])
  check('the run from the edit onward loses its thinking (indices 3 and 5)', !hasThinking(out[3]) && !hasThinking(out[5]))
  check('text and tool_use stay in order', j(blocksOf(out[3]).map(b => b.type)) === j(['tool_use']) && j(blocksOf(out[5])) === j([TEXT('b')]))
  check('user messages pass by reference', out[0] === history[0] && out[2] === history[2] && out[4] === history[4])
  check('the input array is never mutated', hasThinking(history[3]) && hasThinking(history[5]))
  const same = stripThinkingFromIndex(history as never, 6)
  check('identity when nothing changes (fromIndex past every thinking block)', same === (history as never))
  const all = stripSignatureBlocks(history as never) as unknown as Record<string, unknown>[]
  check('stripSignatureBlocks is the from-zero case (the whole leading run)', !all.some(hasThinking))
}
{
  const img = (n: number): Block => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(n) } })
  const history = [
    user([TEXT('first')]),
    assistant([THINK('one'), TEXT('a')]),
    user([TEXT('shots'), img(1), img(2)]),
    assistant([THINK('two'), TEXT('b')]),
    user([TEXT('later'), img(3)]),
    assistant([THINK('three'), TEXT('c')]),
  ]
  const out = stripExcessMediaItems(history as never, 2) as unknown as Record<string, unknown>[]
  check('the media ceiling drops the oldest item (index 2 edited)', out[2] !== history[2] && blocksOf(out[2]).filter(b => b.type === 'image').length === 1)
  check('the assistant before the edited message keeps its thinking', out[1] === history[1] && hasThinking(out[1]))
  check('the assistants after it lose theirs; text stays', !hasThinking(out[3]) && !hasThinking(out[5]) && j(blocksOf(out[5])) === j([TEXT('c')]))
  const under = stripExcessMediaItems(history as never, 3)
  check('under the ceiling ⇒ identity (no strip)', under === (history as never))
}

// ============================================================================
section("§4b the prefix's own movers — the fingerprint source, the persisted rows, the user-context row")
// ============================================================================
{
  const { extractFirstMessageText, computeFingerprintFromMessages } = await import('../../src/utils/fingerprint.ts')
  const REMINDER = '<system-reminder>\nThe material below is available to you while you answer the user.\n\n# currentDate\nToday.\n</system-reminder>'
  const meta = (content: Block[] | string): Record<string, unknown> => ({ ...user(content), isMeta: true })
  const attachmentRow = (attachment: Record<string, unknown>): Record<string, unknown> => ({
    type: 'attachment',
    uuid: '00000000-0000-4000-8000-0000000000aa',
    timestamp: '2026-09-01T00:00:00.000Z',
    attachment,
  })
  check('the operator prompt as a string is the fingerprint text', extractFirstMessageText([user('read the note')] as never) === 'read the note')
  check('a meta reminder row ahead of the prompt is skipped', extractFirstMessageText([meta(REMINDER), user('read the note')] as never) === 'read the note')
  check('a reminder block coalesced in front of the prompt is skipped', extractFirstMessageText([user([TEXT(REMINDER), TEXT('read the note')])] as never) === 'read the note')
  check('attachment rows are skipped', extractFirstMessageText([attachmentRow({ type: 'date_change', newDate: '2026-09-02' }), user('read the note')] as never) === 'read the note')
  check('a tool_result-only row is not the prompt', extractFirstMessageText([user([{ type: 'tool_result', tool_use_id: 't', content: 'x' }]), user('later prompt')] as never) === 'later prompt')
  check('nothing operator-authored ⇒ empty (stable)', extractFirstMessageText([meta(REMINDER)] as never) === '')
  const fp1 = computeFingerprintFromMessages([meta('<system-reminder>\n# MCP Server Instructions\n</system-reminder>'), user('read the note')] as never)
  const fp2 = computeFingerprintFromMessages([meta(REMINDER), user('read the note'), assistant([TEXT('ok')])] as never)
  check('the fingerprint is the same whichever reminder rides in front (3 hex chars)', fp1 === fp2 && /^[0-9a-f]{3}$/.test(fp1), `${fp1} ${fp2}`)

  const { isLoggableMessage } = await import('../../src/utils/sessionStorage/chain.ts')
  check('an attachment row persists (a resumed request replays the turns it once sent)', isLoggableMessage(attachmentRow({ type: 'mcp_instructions_delta', addedNames: ['x'], addedBlocks: ['## x\nhi'], removedNames: [] }) as never) === true)
  check('a progress row still does not persist', isLoggableMessage({ type: 'progress', data: { type: 'hook_progress' } } as never) === false)
  // The reconciliation with the hooks law (FC-083): a row persists when the
  // REQUEST renders it or when it is a hook's failure report; a row that
  // renders nothing for the model stays out of the file.
  check('a quiet hook success (renders nothing) stays out', isLoggableMessage(attachmentRow({ type: 'hook_success', hookName: 'h', hookEvent: 'UserPromptSubmit', content: '' }) as never) === false)
  check('hook additional context WITH content persists (the request renders it)', isLoggableMessage(attachmentRow({ type: 'hook_additional_context', hookName: 'h', content: ['ctx'] }) as never) === true)
  check("a hook's failure report persists though the model never reads it (the operator's record)", isLoggableMessage(attachmentRow({ type: 'hook_non_blocking_error', hookName: 'h', hookEvent: 'UserPromptSubmit', stderr: 'x' }) as never) === true)
  check('a UI-only signal (context_efficiency) stays out', isLoggableMessage(attachmentRow({ type: 'context_efficiency' }) as never) === false)
  check('the user_context row persists (the request renders its body)', isLoggableMessage(attachmentRow({ type: 'user_context', body: REMINDER }) as never) === true)

  const { userContextReminderBody, USER_CONTEXT_REMINDER_OPEN } = await import('../../src/utils/userContextReminder.ts')
  const { getUserContextAttachment, latestUserContextBody } = await import('../../src/utils/attachments/userContext.ts')
  const ctx = { claudeMd: 'be brief', currentDate: "Today's date is 2026-09-01." }
  const body = userContextReminderBody(ctx)!
  check('the reminder body wears its envelope and every entry', body.startsWith(USER_CONTEXT_REMINDER_OPEN) && body.includes('# claudeMd\nbe brief') && body.includes('# currentDate') && body.endsWith('</system-reminder>'))
  check('an empty context renders nothing', userContextReminderBody({}) === null)
  const fresh = await getUserContextAttachment([user('hi')] as never, ctx)
  check('a history without the row ⇒ one user_context row carrying the body', fresh.length === 1 && fresh[0]!.type === 'user_context' && (fresh[0] as { body: string }).body === body)
  const carried = [user('hi'), attachmentRow({ type: 'user_context', body }), assistant([TEXT('ok')])]
  check('the newest copy already says it ⇒ nothing (append-only, no rewrite)', (await getUserContextAttachment(carried as never, ctx)).length === 0)
  const changed = await getUserContextAttachment(carried as never, { ...ctx, currentDate: "Today's date is 2026-09-02." })
  check('a changed body ⇒ one fresh copy for the tail (the earlier one stays)', changed.length === 1 && (changed[0] as { body: string }).body.includes('2026-09-02'))
  check('latestUserContextBody reads the newest copy', latestUserContextBody([...carried, attachmentRow({ type: 'user_context', body: 'newer' })] as never) === 'newer' && latestUserContextBody([user('hi')] as never) === null)
  check('an empty context emits nothing even on a bare history', (await getUserContextAttachment([] as never, {})).length === 0)

  // The tool_result wire spelling: one key order whatever road the row took
  // (the live runner id-first, the error factories type/content/is_error/id,
  // the resume loader's codec type-first) — the codec's order everywhere.
  const { userMessageToMessageParam } = await import('../../src/services/providers/anthropic/messageParams.ts')
  const keysOf = (row: unknown): string[] => Object.keys(((row as { content: Record<string, unknown>[] }).content)[0]!)
  const liveRow = user([{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'bytes' }])
  const errorRow = user([{ type: 'tool_result', content: 'boom', is_error: true, tool_use_id: 'toolu_2' }])
  const loadedRow = user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'bytes' }])
  check("the live runner's id-first block leaves in the codec's order", j(keysOf(userMessageToMessageParam(liveRow as never, false, false))) === j(['type', 'tool_use_id', 'content']))
  check("an error factory's block leaves in the codec's order too", j(keysOf(userMessageToMessageParam(errorRow as never, false, false))) === j(['type', 'tool_use_id', 'content', 'is_error']))
  check('a live row and its resumed twin serialize identically', j(userMessageToMessageParam(liveRow as never, false, false)) === j(userMessageToMessageParam(loadedRow as never, false, false)))
  check('the marker path spells it the same, marker last', j(keysOf(userMessageToMessageParam(liveRow as never, true, true))) === j(['type', 'tool_use_id', 'content', 'cache_control']))
  check('a text block passes through untouched', j(userMessageToMessageParam(user([TEXT('hi')]) as never, false, false).content) === j([TEXT('hi')]))
}

// ============================================================================
section('§5 the wire — the real product, consecutive requests, byte-identical prefixes')
// ============================================================================
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    interface RunResult { exit: number | null; stdout: string; stderr: string }
    interface Arena { home: string; cwd: string; env: Record<string, string> }
    function makeArena(fixture: FixtureApi): Arena {
      const home = mkdtempSync(join(tmpdir(), 'transcript-binding-home-'))
      const cwd = mkdtempSync(join(tmpdir(), 'transcript-binding-cwd-'))
      mkdirSync(join(home, '.claude'), { recursive: true })
      return {
        home,
        cwd,
        env: {
          HOME: home,
          PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
          TERM: 'dumb',
          MERCURY_CONFIG_DIR: join(home, '.claude'),
          ANTHROPIC_BASE_URL: fixture.url,
          ANTHROPIC_API_KEY: 'fixture-key-000',
          MERCURY_DAEMON_DIR: join(home, 'daemon'),
          MERCURY_TEAMS_DIR: join(home, 'teams'),
          // The fixture host is not first-party: the explicit value is what
          // puts the field and the header on this wire (§2's host rule).
          MERCURY_THINKING_BINDING: 'error',
        },
      }
    }
    function run(arena: Arena, args: string[]): Promise<RunResult> {
      return new Promise(resolvePromise => {
        const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', d => (stdout += d))
        child.stderr.on('data', d => (stderr += d))
        const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)
        child.on('close', exit => {
          clearTimeout(killer)
          resolvePromise({ exit, stdout, stderr })
        })
      })
    }
    /** The check exempts cache_control markers (added, moved, removed freely). */
    function withoutCacheControl(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(withoutCacheControl)
      if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (k === 'cache_control') continue
          out[k] = withoutCacheControl(v)
        }
        return out
      }
      return value
    }
    type Body = { system?: unknown; tools?: unknown; messages?: unknown[]; thinking?: { type?: string; block_binding?: { prefix_mismatch_behavior?: string } } }

    const SID = 'b1ad1e5e-0000-4000-8000-00000000b1ad'
    const DROP = { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }
    const turns: ScriptedTurn[] = [
      { kind: 'tool_use', name: 'Read', input: {}, thinking: 'plan: read the note first' },
      { kind: 'text', text: 'B-TURN-1-DONE', thinking: 'the note is read', inputTransformations: [] },
      { kind: 'text', text: 'B-TURN-2-DONE', thinking: 'second turn' },
      { kind: 'text', text: 'B-TURN-3-DONE', inputTransformations: [DROP] },
    ]
    const fixture = await startFixtureApi(turns)
    const arena = makeArena(fixture)
    const notePath = join(arena.cwd, 'note.txt')
    writeFileSync(notePath, 'hello-from-the-fixture-file\n')
    ;(turns[0] as Extract<ScriptedTurn, { kind: 'tool_use' }>).input = { file_path: notePath }
    // Every turn wears the SAME flags (only the prompt, the session verb and
    // the debug file differ): a flag that moved the system prompt or the
    // tools array between processes would be the harness's own edit, not
    // the product's. stream-json on every turn; the answer text is read
    // off the envelopes.
    const debugFile = (n: number): string => join(arena.home, `turn-${n}.debug.log`)
    const common = ['--model', 'claude-opus-4-8', '--allowedTools', 'Read', '--output-format', 'stream-json', '--verbose']
    const r1 = await run(arena, ['-p', 'read the note', ...common, '--session-id', SID, '--debug-file', debugFile(1)])
    check('turn 1 (a tool round) exit 0', r1.exit === 0, `exit=${r1.exit} stderr=${r1.stderr.slice(0, 300)}`)
    check('turn 1 answered with the post-tool text', r1.stdout.includes('B-TURN-1-DONE'), j(r1.stdout.slice(0, 200)))
    const r2 = await run(arena, ['-p', 'second prompt', ...common, '--resume', SID, '--debug-file', debugFile(2)])
    check('turn 2 (resumed) exit 0', r2.exit === 0, `exit=${r2.exit} stderr=${r2.stderr.slice(0, 300)}`)
    check('turn 2 answered', r2.stdout.includes('B-TURN-2-DONE'), j(r2.stdout.slice(0, 200)))
    const r3 = await run(arena, ['-p', 'third prompt', ...common, '--resume', SID, '--debug-file', debugFile(3)])
    check('turn 3 (resumed) exit 0', r3.exit === 0, `exit=${r3.exit} stderr=${r3.stderr.slice(0, 300)}`)
    check('turn 3 answered', r3.stdout.includes('B-TURN-3-DONE'), j(r3.stdout.slice(0, 200)))

    const reqs = fixture.messageRequests()
    check('four message requests: two for the tool round, one per resumed turn', reqs.length === 4, String(reqs.length))

    // The setting on every request.
    for (let i = 0; i < reqs.length; i++) {
      const body = reqs[i]!.body as Body
      const beta = reqs[i]!.headers['anthropic-beta'] ?? ''
      check(`request ${i + 1} carries the controls header`, beta.split(',').map(s => s.trim()).includes(THINKING_BINDING_CONTROLS_BETA_HEADER), beta)
      check(`request ${i + 1} carries thinking.block_binding.prefix_mismatch_behavior=error`, body.thinking?.block_binding?.prefix_mismatch_behavior === 'error', j(body.thinking))
    }

    // The assistant turns replay with their thinking, byte-identical.
    const msgs2 = ((reqs[1]?.body as Body)?.messages ?? []) as Array<{ role: string; content: unknown }>
    const a1 = msgs2.find(m => m.role === 'assistant')
    const a1Blocks = Array.isArray(a1?.content) ? (a1!.content as Block[]) : []
    check('request 2 replays the tool-round assistant turn with its signed thinking block first', a1Blocks[0]?.type === 'thinking' && a1Blocks[0]?.thinking === 'plan: read the note first' && a1Blocks[0]?.signature === 'fixture-signature', j(a1Blocks).slice(0, 300))
    check('…followed by the tool_use, nothing invented between', a1Blocks[1]?.type === 'tool_use' && a1Blocks.length === 2, j(a1Blocks.map(b => b.type)))
    const msgs4 = ((reqs[3]?.body as Body)?.messages ?? []) as Array<{ role: string; content: unknown }>
    const thinkingCount = msgs4.reduce((n, m) => n + (Array.isArray(m.content) ? (m.content as Block[]).filter(b => b.type === 'thinking').length : 0), 0)
    check('request 4 replays every earlier thinking block (three scripted)', thinkingCount === 3, String(thinkingCount))

    // The docs' step-1 capture: consecutive pairs, byte-identical up to the appended turns.
    for (let i = 1; i < reqs.length; i++) {
      const prev = reqs[i - 1]!.body as Body
      const cur = reqs[i]!.body as Body
      const systemSame = j(withoutCacheControl(prev.system)) === j(withoutCacheControl(cur.system))
      const toolsSame = j(withoutCacheControl(prev.tools)) === j(withoutCacheControl(cur.tools))
      const pm = (prev.messages ?? []) as unknown[]
      const cm = (cur.messages ?? []) as unknown[]
      let firstDiff = -1
      for (let k = 0; k < pm.length; k++) {
        if (j(withoutCacheControl(pm[k])) !== j(withoutCacheControl(cm[k]))) {
          firstDiff = k
          break
        }
      }
      const appended = cm.length > pm.length
      console.log(`    pair ${i}→${i + 1}: system ${systemSame ? 'same' : 'DIFFERS'} · tools ${toolsSame ? 'same' : 'DIFFERS'} · messages prefix ${firstDiff === -1 ? `same (${pm.length} → ${cm.length})` : `DIFFERS at index ${firstDiff}`}`)
      if (!systemSame) {
        const ps = Array.isArray(prev.system) ? (prev.system as Array<{ text?: string }>) : []
        const cs = Array.isArray(cur.system) ? (cur.system as Array<{ text?: string }>) : []
        for (let b = 0; b < Math.max(ps.length, cs.length); b++) {
          if ((ps[b]?.text ?? '') !== (cs[b]?.text ?? '')) {
            console.log(`      system block ${b} differs: ${j((ps[b]?.text ?? '').slice(0, 160))} vs ${j((cs[b]?.text ?? '').slice(0, 160))}`)
            break
          }
        }
      }
      if (firstDiff !== -1) {
        console.log(`      prev[${firstDiff}]: ${j(withoutCacheControl(pm[firstDiff])).slice(0, 600)}`)
        console.log(`      cur [${firstDiff}]: ${j(withoutCacheControl(cm[firstDiff])).slice(0, 600)}`)
        if (firstDiff > 0) {
          console.log(`      (row 0, identical): ${j(withoutCacheControl(cm[0])).slice(0, 300)}`)
        }
        console.log(`      prev rows: ${pm.map((m, k) => `${k}:${(m as { role?: string }).role}`).join(' ')} · cur rows: ${cm.map((m, k) => `${k}:${(m as { role?: string }).role}`).join(' ')}`)
      }
      check(`pair ${i}→${i + 1}: the top-level system is byte-identical`, systemSame)
      check(`pair ${i}→${i + 1}: the tools array is byte-identical`, toolsSame)
      check(`pair ${i}→${i + 1}: the shared messages prefix is byte-identical and the turn is appended`, firstDiff === -1 && appended, `firstDiff=${firstDiff} ${pm.length}→${cm.length}`)
    }

    // The drop list rides to the operator-visible record, and the notice paints once.
    const envelopes = r3.stdout.split('\n').filter(l => l.trim() !== '').map(l => { try { return JSON.parse(l) as Record<string, unknown> } catch { return null } }).filter((e): e is Record<string, unknown> => e !== null)
    const carried = envelopes.filter(e => e.type === 'assistant' && Array.isArray((e.message as { input_transformations?: unknown } | undefined)?.input_transformations))
    check('the scripted drop list rides the assistant envelope on stream-json stdout', carried.length > 0 && j((carried[0]!.message as { input_transformations: unknown }).input_transformations) === j([DROP]), j(carried[0]?.message ?? envelopes.map(e => e.type)).slice(0, 300))
    const noticeText = 'Preserved thinking: the API dropped 1 thinking block'
    const stdoutNotices = envelopes.filter(e => j(e).includes(noticeText)).length
    const debugLogOf = (n: number): string => { try { return readFileSync(debugFile(n), 'utf8') } catch { return '' } }
    const dropLine = 'preserved thinking: [{"type":"thinking_dropped"'
    const debugNotices = debugLogOf(3).split('\n').filter(l => l.includes(dropLine)).length
    check('the notice reaches the debug log exactly once (one envelope per block, one response id)', debugNotices === 1, `debug lines=${debugNotices} stdout notices=${stdoutNotices} log=${debugLogOf(3).length}B`)
    console.log(`    (stream-json system rows carrying the notice: ${stdoutNotices})`)
    const earlyNotices = (r1.stdout + r1.stderr + r2.stdout + r2.stderr + debugLogOf(1) + debugLogOf(2)).includes('reserved thinking')
    check('an empty or absent drop list never paints a notice (turns 1 and 2)', !earlyNotices)

    await fixture.close()
  }
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ TRANSCRIPT BINDING GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ${failures} TRANSCRIPT BINDING FAILURE(S) (${checks} checks)`)
process.exit(1)
