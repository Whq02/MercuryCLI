#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { AppState } from '../../src/state/AppState.js'
import type { Message } from '../../src/types/message.js'
import { runWithCwdOverride } from '../../src/utils/cwd.js'
import {
  COMMIT_GATE_ID,
  disengageCommitGate,
  engageCommitGate,
} from '../../src/utils/hooks/commitGate.js'
import {
  getSessionFunctionHooks,
  type FunctionHookContext,
} from '../../src/utils/hooks/sessionHooks.js'
import { evaluateStop } from '../../src/services/run/completionEvaluator.js'
import {
  generatePreview,
  PREVIEW_MAX_LINE_CHARS,
} from '../../src/utils/toolResultStorage.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const PINNED = [
  'MERCURY_COMMIT_GATE',
  'MERCURY_COMMIT_GATE',
  'MERCURY_VERIFY_EVIDENCE',
  'MERCURY_VERIFY_EVIDENCE',
  'MERCURY_VERIFY_PATTERN',
  'MERCURY_VERIFY_PATTERN',
] as const
const saved = new Map<string, string | undefined>()
for (const k of PINNED) {
  saved.set(k, process.env[k])
  delete process.env[k]
}

const vs = await import('../../src/utils/verification/verificationState.js')
const scratch = mkdtempSync(join(tmpdir(), 'vigil-avs-'))

let state = { sessionHooks: new Map() } as unknown as AppState
const setAppState = (u: (p: AppState) => AppState): void => {
  state = u(state)
}
const SESSION = 'vigil-avs'
process.env.MERCURY_COMMIT_GATE = '1'
check('setup: the standalone commit gate engages', engageCommitGate(setAppState, SESSION) === true)
const hookById = (id: string) => {
  const matchers = getSessionFunctionHooks(state, SESSION, 'PreToolUse').get('PreToolUse') ?? []
  return matchers.flatMap(m => m.hooks).find(h => h.id === id)
}
const commitHook = hookById(COMMIT_GATE_ID)
check('setup: the commit gate registered', !!commitHook)

const mkAssistant = (blocks: unknown[]): Message =>
  ({ type: 'assistant', message: { content: blocks } }) as unknown as Message
const mkUser = (blocks: unknown[]): Message =>
  ({ type: 'user', message: { content: blocks } }) as unknown as Message
const preTool = (tool_name: string, tool_input: Record<string, unknown>): FunctionHookContext => ({
  hookInput: { hook_event_name: 'PreToolUse', tool_name, tool_input } as never,
})

console.log('\n=== A. the read-back demand is satisfiable through the ONE contract store (field L429→L434) ===')
{
  vs._resetVerificationStateForTesting()
  const docs = join(scratch, 'docs-ws')
  mkdirSync(docs, { recursive: true })
  const changed = join(docs, 'URBAN-P1-handoff.md')

  vs.observeCompletedToolCall('Write', { file_path: changed }, true, docs)
  check('workspace probes non-verifiable (docs folder)', vs.workspaceVerifiable(docs) === false)

  const verification = () => ({
    state: vs.verificationSummary(docs, { skipDigest: true }).state,
    mutationsSinceEvidence: vs.verificationSummary(docs, { skipDigest: true }).mutationsSinceEvidence,
    workspaceVerifiable: vs.workspaceVerifiable(docs),
    priorEvidenceDemands: vs.evidenceDemandCount(),
  })
  const lightweightDefaults = {
    snapshot: null,
    wordingUnfinished: false,
    continuationsThisTurn: 0,
    maxContinuationsPerTurn: 3,
    aborted: false,
    apiError: false,
    pendingIdeFeedback: false,
  }
  check(
    'the demanded paths surface through the ONE contract store',
    vs.demandedReadBackPaths(docs).has(resolve(changed)),
  )

  vs.observeCompletedToolCall('Read', { file_path: changed }, true, docs)
  const settled = vs.verificationSummary(docs, { skipDigest: true })
  check('the read-back minted the evidence row', settled.state === 'verified' && settled.lastEvidence?.scope === 'read-back', settled.detail)
  check('the contract store is paid (no demanded paths left)', vs.demandedReadBackPaths(docs).size === 0)

  const done = evaluateStop({ ...lightweightDefaults, verification: { ...verification() } })
  check('stop evaluation over the settled state completes', done.kind === 'complete')
}

console.log('\n=== B. commit-gate fresh receipts (field L357) ===')
{
  vs._resetVerificationStateForTesting()
  const repo = join(scratch, 'avs-repo')
  mkdirSync(repo, { recursive: true })
  const git = (cmd: string) =>
    execSync(cmd, {
      cwd: repo,
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@x' },
    })
  git('git init -q')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0', validate: 'node -e 0' } }))
  git('git add -A && git commit -qm seed')

  vs.observeCompletedToolCall('Bash', { command: 'npm --prefix tools/azgaar-avs run validate' }, true, repo)
  vs.observeCompletedToolCall('Bash', { command: 'npm test' }, true, repo)
  check('the green runs minted receipts (verified, digest-bound)', vs.verificationSummary(repo).state === 'verified')

  const commitCmd = 'git add -A _meta && git commit -m "docs(meta): reconcile the ledgers"'
  const fresh = await runWithCwdOverride(repo, () =>
    Promise.resolve(commitHook!.callback([], undefined, preTool('Bash', { command: commitCmd }))),
  )
  check('fresh current-tree receipt passes the commit gate (no rerun)', fresh === true, String(fresh))

  vs.observeCompletedToolCall('Edit', { file_path: join(repo, 'canon.md') }, true, repo)
  const stale = await runWithCwdOverride(repo, () =>
    Promise.resolve(commitHook!.callback([], undefined, preTool('Bash', { command: commitCmd }))),
  )
  check('a post-receipt mutation re-denies (stale receipts refuse)', stale !== true)

  const piped = await runWithCwdOverride(repo, () =>
    Promise.resolve(
      commitHook!.callback([], undefined, preTool('Bash', {
        command: 'set -o pipefail && npm test 2>&1 | tail -40 && git commit -m "x"',
      })),
    ),
  )
  check('pipefail|tail verify→commit form passes (readable AND gated)', piped === true, String(piped))

  const noVerify = await runWithCwdOverride(repo, () =>
    Promise.resolve(commitHook!.callback([], undefined, preTool('Bash', { command: 'git commit --no-verify -m "x"' }))),
  )
  check('--no-verify stays denied even with receipts', noVerify !== true)
}

console.log('\n=== C. preview truth: the 181.5 KB chain + the base64 line ===')
{
  const warnings = Array.from({ length: 1615 }, (_, i) => `WARN canon/urban/settlement-${i}.md: soft-link target missing`).join('\n')
  const tailTruth = '[main 6cdd57a] docs(meta): reconcile the ledgers with the 07-08..11 arc\n 11 files changed, 214 insertions(+)'
  const chain = `${warnings}\n> avs validate: 1615 warnings, 0 errors\n68 passing\n${tailTruth}`
  const p1 = generatePreview(chain, 2000)
  check('the preview now CARRIES the commit result (tail visible)', p1.preview.includes('[main 6cdd57a]'))
  check('the skip marker names persisted fullness', p1.preview.includes('skipped — full output persisted'))
  check('head still present (first warnings visible)', p1.preview.includes('settlement-0'))

  const monster = 'src/fonts.css:@font-face{src:url(data:font/woff2;base64,' + 'A'.repeat(76_000) + ')}'
  const grep = `docs/canon/a.md:economy: barley\n${monster}\ndocs/canon/b.md:economy: fish`
  const p2 = generatePreview(grep, 2000)
  const lines = p2.preview.split('\n').filter(l => !l.startsWith('…'))
  check(
    'every preview line is clamped (no line eats the budget)',
    lines.every(l => l.length <= PREVIEW_MAX_LINE_CHARS + 40),
    `max=${Math.max(...lines.map(l => l.length))}`,
  )
  check('the clamp marker names the original length', p2.preview.includes('…[line clamped:'))
}

disengageCommitGate(setAppState, SESSION)
vs._resetVerificationStateForTesting()
rmSync(scratch, { recursive: true, force: true })
for (const [k, v] of saved) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

console.log(`\n${failures === 0 ? '✅ ALL PASS — the AVS field bars hold' : `❌ ${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
