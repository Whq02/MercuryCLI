#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Message } from '../../src/engine/message-shapes/message.js'
import { runWithCwdOverride } from '../../src/platform/files/cwd.js'
import {
  COMMIT_GATE_ID,
  disengageCommitGate,
  engageCommitGate,
} from '../../src/permissions/guards/commitGate.js'
import { guardsEngaged, judgeToolCall } from '../../src/permissions/guards/guards.js'
import { evaluateStop } from '../../src/engine/run/completionEvaluator.js'
import {
  generatePreview,
  PREVIEW_MAX_LINE_CHARS,
} from '../../src/engine/tool-dispatch/toolResultStorage.js'

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

const vs = await import('../../src/platform/verification/verificationState.js')
const scratch = mkdtempSync(join(tmpdir(), 'vigil-avs-'))

const SESSION = 'vigil-avs'
process.env.MERCURY_COMMIT_GATE = '1'
check('setup: the standalone commit gate engages', engageCommitGate(SESSION) === true, 'engageCommitGate in src/permissions/guards/commitGate.ts returned false with MERCURY_COMMIT_GATE=1; check its engage conditions there')
check('setup: the commit gate registered', guardsEngaged(SESSION).tool.includes(COMMIT_GATE_ID), 'engageCommitGate (src/permissions/guards/commitGate.ts) should register COMMIT_GATE_ID with the tool guards read by guardsEngaged in src/permissions/guards/guards.ts')
const commitGateAllows = async (command: string): Promise<true | string> => {
  const verdict = await judgeToolCall(SESSION, { tool: 'Bash', input: { command }, callId: 'avs-call', messages: [] })
  return verdict.refused ? verdict.reason : true
}

const mkAssistant = (blocks: unknown[]): Message =>
  ({ type: 'assistant', message: { content: blocks } }) as unknown as Message
const mkUser = (blocks: unknown[]): Message =>
  ({ type: 'user', message: { content: blocks } }) as unknown as Message

console.log('\n=== A. the read-back demand is satisfiable through the ONE contract store (field L429→L434) ===')
{
  vs._resetVerificationStateForTesting()
  const docs = join(scratch, 'docs-ws')
  mkdirSync(docs, { recursive: true })
  const changed = join(docs, 'URBAN-P1-handoff.md')

  vs.observeCompletedToolCall('Write', { file_path: changed }, true, docs)
  check('workspace probes non-verifiable (docs folder)', vs.workspaceVerifiable(docs) === false, 'a docs-only folder must probe as not verifiable; see workspaceVerifiable in src/platform/verification/verificationState.ts')

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
    'a Write in a non-verifiable workspace should add its path to demandedReadBackPaths in src/platform/verification/verificationState.ts (see observeCompletedToolCall)',
  )

  vs.observeCompletedToolCall('Read', { file_path: changed }, true, docs)
  const settled = vs.verificationSummary(docs, { skipDigest: true })
  check('the read-back minted the evidence row', settled.state === 'verified' && settled.lastEvidence?.scope === 'read-back', settled.detail)
  check('the contract store is paid (no demanded paths left)', vs.demandedReadBackPaths(docs).size === 0, 'a successful Read of the written path should clear it from demandedReadBackPaths in src/platform/verification/verificationState.ts (observeCompletedToolCall)')

  const done = evaluateStop({ ...lightweightDefaults, verification: { ...verification() } })
  check('stop evaluation over the settled state completes', done.kind === 'complete', `got ${done.kind}; evaluateStop in src/engine/run/completionEvaluator.ts should complete once the verification state is verified with no demands`)
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
  check('the green runs minted receipts (verified, digest-bound)', vs.verificationSummary(repo).state === 'verified', 'observeCompletedToolCall in src/platform/verification/verificationState.ts should mint a receipt for each passing verify command (npm test, npm run validate)')

  const commitCmd = 'git add -A _meta && git commit -m "docs(meta): reconcile the ledgers"'
  const fresh = await runWithCwdOverride(repo, () =>
    commitGateAllows(commitCmd),
  )
  check('fresh current-tree receipt passes the commit gate (no rerun)', fresh === true, String(fresh))

  vs.observeCompletedToolCall('Edit', { file_path: join(repo, 'canon.md') }, true, repo)
  const stale = await runWithCwdOverride(repo, () =>
    commitGateAllows(commitCmd),
  )
  check('a post-receipt mutation re-denies (stale receipts refuse)', stale !== true, 'an Edit after the receipts must make them stale so the commit gate in src/permissions/guards/commitGate.ts refuses the commit')

  const piped = await runWithCwdOverride(repo, () =>
    commitGateAllows('set -o pipefail && npm test 2>&1 | tail -40 && git commit -m "x"'),
  )
  check('pipefail|tail verify→commit form passes (readable AND gated)', piped === true, String(piped))

  const noVerify = await runWithCwdOverride(repo, () =>
    commitGateAllows('git commit --no-verify -m "x"'),
  )
  check('--no-verify stays denied even with receipts', noVerify !== true, 'the commit gate in src/permissions/guards/commitGate.ts must refuse git commit --no-verify whatever receipts exist')
}

console.log('\n=== C. preview truth: the 181.5 KB chain + the base64 line ===')
{
  const warnings = Array.from({ length: 1615 }, (_, i) => `WARN canon/urban/settlement-${i}.md: soft-link target missing`).join('\n')
  const tailTruth = '[main 6cdd57a] docs(meta): reconcile the ledgers with the 07-08..11 arc\n 11 files changed, 214 insertions(+)'
  const chain = `${warnings}\n> avs validate: 1615 warnings, 0 errors\n68 passing\n${tailTruth}`
  const p1 = generatePreview(chain, 2000)
  check('the preview now CARRIES the commit result (tail visible)', p1.preview.includes('[main 6cdd57a]'), 'generatePreview in src/engine/tool-dispatch/toolResultStorage.ts must keep the output tail in the preview')
  check('the skip marker names persisted fullness', p1.preview.includes('skipped — full output persisted'), 'generatePreview in src/engine/tool-dispatch/toolResultStorage.ts must write the skipped-middle marker')
  check('head still present (first warnings visible)', p1.preview.includes('settlement-0'), 'generatePreview in src/engine/tool-dispatch/toolResultStorage.ts must keep the output head in the preview')

  const monster = 'src/fonts.css:@font-face{src:url(data:font/woff2;base64,' + 'A'.repeat(76_000) + ')}'
  const grep = `docs/canon/a.md:economy: barley\n${monster}\ndocs/canon/b.md:economy: fish`
  const p2 = generatePreview(grep, 2000)
  const lines = p2.preview.split('\n').filter(l => !l.startsWith('…'))
  check(
    'every preview line is clamped (no line eats the budget)',
    lines.every(l => l.length <= PREVIEW_MAX_LINE_CHARS + 40),
    `max=${Math.max(...lines.map(l => l.length))}; generatePreview in src/engine/tool-dispatch/toolResultStorage.ts must clamp each line to PREVIEW_MAX_LINE_CHARS`,
  )
  check('the clamp marker names the original length', p2.preview.includes('…[line clamped:'), 'generatePreview in src/engine/tool-dispatch/toolResultStorage.ts must append the line-clamped marker with the original length')
}

disengageCommitGate(SESSION)
vs._resetVerificationStateForTesting()
rmSync(scratch, { recursive: true, force: true })
for (const [k, v] of saved) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

console.log(`\n${failures === 0 ? '✅ ALL PASS — the AVS field bars hold' : `❌ ${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
