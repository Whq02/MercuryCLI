#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNTIME = process.versions.bun ? 'bun' : 'node'

if (RUNTIME === 'bun' && process.env.RUNNER_MAIL_AT_INTERRUPT_ARM !== 'node') {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const vendored = join(ROOT, 'vendor', 'node', 'extracted', `${process.platform}-${process.arch}`, 'bin', 'node')
  const nodeBin = existsSync(vendored) ? vendored : 'node'
  const dir = mkdtempSync(join(tmpdir(), 'runner-mail-at-interrupt-'))
  const bundle = join(dir, 'prove-runner-mail-at-interrupt.mjs')
  console.log('── the node arm: bundling the prover with the product\'s own resolution laws ──')
  let status = 1
  try {
    const built = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'search', 'lib', 'bundle-for-node.ts'), fileURLToPath(import.meta.url), bundle],
      { cwd: ROOT, encoding: 'utf8' },
    )
    if (built.status !== 0 || !existsSync(bundle)) {
      console.log(`  [FAIL] the node bundle builds — ${(built.stderr || built.stdout).slice(-800)}`)
    } else {
      console.log(`  [PASS] the node bundle builds (${nodeBin === vendored ? 'vendored node' : 'PATH node'} runs it)`)
      const run = spawnSync(nodeBin, [bundle], {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, RUNNER_MAIL_AT_INTERRUPT_ARM: 'node' },
      })
      status = run.status ?? 1
      if (run.status === null) console.log(`  [FAIL] the node run ended on a signal (${run.signal ?? 'unknown'}) — a parked loop ended by the wall clock reads as one`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  process.exit(status)
}

const h = await import('./lib/runnerLifecycleHarness.ts')
const { check, section, task, waitFor, settleWithin, drainInto, idleNotificationsFor, launch } = h

section(`mail queued while working is delivered AT the interrupt; the teammate continues unnudged (${RUNTIME})`)
{
  const team = 'own7b-s7'
  const s = await launch({
    name: 'probe7',
    team,
    turns: [
      { kind: 'hang', deltas: ['working…'] },
      { kind: 'text', text: 'S7 reply one.' },
      { kind: 'text', text: 'S7 reply two.' },
      { kind: 'text', text: 'S7 reply three.' },
      { kind: 'text', text: 'S7 reply four.' },
    ],
    prompt: 'Work until told otherwise.',
    replacePrompt: 'You are a lifecycle probe. Reply tersely.',
  })
  await s.api.messageRequestStarted(1)
  check(
    'the turn is live (work controller present)',
    await waitFor(() => task(s.store, s.taskId)?.currentWorkAbortController !== undefined, 20_000),
  )
  check('operator line 1 accepted mid-turn', h.injectUserMessageToTeammate(s.taskId, 'MAIL-OP-1 first operator line', s.store.setAppState as never))
  check('operator line 2 accepted mid-turn', h.injectUserMessageToTeammate(s.taskId, 'MAIL-OP-2 second operator line', s.store.setAppState as never))
  await h.writeToMailbox('probe7', { from: 'peer-b', text: 'MAIL-PEER a peer note', timestamp: new Date().toISOString() }, team)
  await h.writeToMailbox('probe7', { from: 'team-lead', text: 'MAIL-LEAD the lead speaks', timestamp: new Date().toISOString() }, team)
  check('the mail is queued, unread, while the turn still hangs', (await h.readMailbox('probe7', team)).filter(m => !m.read).length === 2 && s.api.messageRequests().length === 1)

  const abortedAt = Date.now()
  const pulse = setInterval(() => {
    console.error(`  [mail-at-interrupt] alive +${Math.round((Date.now() - abortedAt) / 1000)}s — requests=${s.api.messageRequests().length} pending=${(task(s.store, s.taskId)?.pendingUserMessages ?? []).length}`)
  }, 5_000)
  task(s.store, s.taskId).currentWorkAbortController!.abort()
  console.error(`  [mail-at-interrupt] abort() returned after ${Date.now() - abortedAt} ms`)
  check(
    'four further turns run on their own — one per queued message',
    await waitFor(() => s.api.messageRequests().length === 5, 60_000),
    `requests=${s.api.messageRequests().length}`,
  )
  clearInterval(pulse)
  check('…and the teammate settles idle, alive', await waitFor(() => task(s.store, s.taskId)?.isIdle === true && s.api.messageRequests().length === 5, 30_000))
  const lastUserText = (req: { body: unknown }): string => {
    const msgs = (req.body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
    const user = [...msgs].reverse().find(m => m.role === 'user')
    const c = user?.content
    return typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (b as { text?: string }).text ?? '').join(' ') : ''
  }
  const turns = s.api.messageRequests().slice(1).map(lastUserText)
  check('every queued message was delivered (none left unread)', (await h.readMailbox('probe7', team)).every(m => m.read) && (task(s.store, s.taskId).pendingUserMessages ?? []).length === 0)
  check(
    "the runner's order: operator lines first, then the lead, then peers",
    turns[0]?.includes('MAIL-OP-1') === true && turns[1]?.includes('MAIL-OP-2') === true && turns[2]?.includes('MAIL-LEAD') === true && turns[3]?.includes('MAIL-PEER') === true,
    JSON.stringify(turns.map(t => t.slice(0, 60))),
  )
  check("the interrupt itself was reported 'interrupted' (the lead knows why the turn ended)", await waitFor(async () => (await idleNotificationsFor(team)).some(n => n.idleReason === 'interrupted'), 10_000))
  check("status stays 'running' throughout", task(s.store, s.taskId).status === 'running', task(s.store, s.taskId).status)

  s.lifecycle.abort()
  const result = await settleWithin(s.runPromise, s, 'mail-at-interrupt')
  drainInto()
  check('the teammate terminalizes cleanly after the delivered mail', result.success === true && task(s.store, s.taskId).status === 'completed')
  check('all four replies made it into the conversation', ['S7 reply one.', 'S7 reply two.', 'S7 reply three.', 'S7 reply four.'].every(r => JSON.stringify(result.messages).includes(r)))
  await s.api.close()
}

console.log('\n============================================================')
if (h.failureCount() === 0) {
  console.log(` ✅ MAIL-AT-INTERRUPT LAW GREEN (under ${RUNTIME})`)
  process.exit(0)
}
console.log(` ❌ ${h.failureCount()} MAIL-AT-INTERRUPT FAILURE(S) (under ${RUNTIME})`)
process.exit(1)
