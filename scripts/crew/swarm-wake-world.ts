import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { open } from '../../src/services/crewBoard/store.ts'
import { makeWorld, bootLead, closeWorld, LEAD_MODEL, findFiles, toolResultOf, userTextsOf, record } from './crew-world.ts'

export async function proveWakeJourney(missingWorktree: boolean, check: (label: string, value: unknown) => void): Promise<void> {
  const childModel = 'claude-opus-4-6'
  const schema = { type: 'object', properties: { phase: { type: 'string' } }, required: ['phase'] }
  const world = await makeWorld(missingWorktree ? 'swarm-wake-worktree' : 'swarm-parked-wake', [
    { kind: 'tool_use', name: 'Bash', id: 'wake-first-pwd', input: { command: 'pwd', description: 'Read the assigned directory' }, thinking: 'WAKE-SIGNED-THINKING', signature: 'wake-signed-fixture', whenModel: 'opus-4-6', model: childModel },
    { kind: 'tool_use', name: 'CrewBoard', id: 'wake-declare', input: { op: 'post', clientOpId: 'built-wait', kind: 'ask', text: '@main wake me when about built-trigger' }, whenModel: 'opus-4-6', model: childModel },
    { kind: 'tool_use', name: 'StructuredOutput', id: 'wake-first-schema', input: { phase: 'waiting' }, whenModel: 'opus-4-6', model: childModel },
    { kind: 'text', text: 'BUILT-WORKER-PARKED', whenModel: 'opus-4-6', model: childModel },
    { kind: 'tool_use', name: 'Bash', id: 'wake-second-pwd', input: { command: 'pwd', description: 'Read the retained directory' }, whenModel: 'opus-4-6', model: childModel },
    { kind: 'tool_use', name: 'StructuredOutput', id: 'wake-second-schema', input: { phase: 'resumed' }, whenModel: 'opus-4-6', model: childModel },
    { kind: 'text', text: 'BUILT-WORKER-WOKE', whenModel: 'opus-4-6', model: childModel },
    { kind: 'tool_use', name: 'Crewmate', id: 'wake-launch', input: { name: 'wake-target', description: 'Wait for the board subject', prompt: 'wake-child-only. Read your directory, declare the subject wait, and finish.', crewmate_type: 'mercury-crew', run_in_background: true, model: childModel, effort: 'max', isolation: 'worktree', output_schema: schema }, whenModel: 'fable-5-1', model: LEAD_MODEL },
    { kind: 'tool_use', name: 'ResumeCrewmate', id: 'manual-resume', input: { to: 'wake-target', message: 'manual-explicit-continue' }, whenSaid: 'MANUAL-RESUME-WORKER', whenModel: 'fable-5-1', model: LEAD_MODEL },
    ...Array.from({ length: 12 }, () => ({ kind: 'text' as const, text: 'BUILT-LEAD-IDLE', whenModel: 'fable-5-1', model: LEAD_MODEL })),
  ])
  execFileSync('git', ['init', world.project], { stdio: 'pipe' })
  execFileSync('git', ['-C', world.project, 'add', 'README.md'], { stdio: 'pipe' })
  execFileSync('git', ['-C', world.project, 'commit', '-m', 'fixture'], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } })
  const settings = join(world.config, 'settings.json')
  writeFileSync(settings, JSON.stringify({ ...(existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {}), swarm: { enabled: true } }))
  const session = bootLead(world, ['--sovereign'], ['Crewmate', 'CrewBoard', 'Bash', 'ResumeCrewmate'])
  let live: ReturnType<typeof open> | undefined
  let movedWorktree: { from: string; to: string } | undefined
  const childRequests = () => world.fixture.messageRequests().filter(request => (request.body as { model?: string }).model === childModel)
  try {
    session.submit('/swarm on')
    await session.waitFor('the built wave opens', () => session.stdout().includes('Swarm on for new crewmates'))
    const path = findFiles(world.config, 'board.sqlite')[0]!
    const sid = dirname(dirname(dirname(path))).split(/[\\/]/).at(-1)!
    live = open(path, sid)
    const sender = { author: { sessionId: sid, agentId: 'fixture-poster', executionId: 'fixture' }, name: 'Fixture poster' }
    live.enroll(sender)
    session.submit('wake-parent-only: launch the worker, then wait.')
    await session.waitFor('the worker declares its wait', () => toolResultOf(world, 'wake-declare') !== null)
    await session.waitFor('the worker completes and parks', () => live!.screenEvents(0).some(event => event.authorName === 'wake-target' && event.lifecycle?.kind === 'parked'))
    const target = live.seats().find(seat => seat.name === 'wake-target')!
    const before = childRequests().length
    const firstBody = childRequests()[0]!.body as { system?: unknown; tools?: { name?: string; input_schema?: unknown }[]; output_config?: { effort?: string } }
    const metaPath = findFiles(world.config, `agent-${target.agent}.meta.json`)[0]!
    const metadataRecord = readFileSync(metaPath, 'utf8')
    const metadata = JSON.parse(metadataRecord)
    assert(metadata.worktreePath)
    if (missingWorktree) {
      const withinFixture = relative(realpathSync(world.project), realpathSync(metadata.worktreePath))
      assert(withinFixture && !withinFixture.startsWith('..') && !isAbsolute(withinFixture), 'only the fixture-created worktree may move')
      movedWorktree = { from: metadata.worktreePath, to: metadata.worktreePath + '.proof-away' }
      assert(!existsSync(movedWorktree.to))
      renameSync(movedWorktree.from, movedWorktree.to)
    }
    const posted = live.post(sender, { clientOpId: 'built-trigger', kind: 'result', about: 'built-trigger', text: 'BUILT-WAKE-PACKET' })
    assert(posted.ok)
    assert(live.post(sender, { clientOpId: 'built-trigger', kind: 'result', about: 'built-trigger', text: 'BUILT-WAKE-PACKET' }).ok)
    if (missingWorktree) {
      await session.waitFor('the unavailable worktree holds the wake', () => live!.seats().find(seat => seat.agent === target.agent)?.wakeProblem?.kind === 'worktree-missing' || childRequests().length > before)
      check('a missing worktree never starts an automatic turn in another checkout', childRequests().length === before && live.view().peerTurns === 0)
      await session.waitFor('the lead receives the missing-worktree notice', () => userTextsOf(world).some(text => text.includes('The board resume did not start:') && text.includes(metadata.worktreePath)))
      const heldSeat = live.seats().find(seat => seat.agent === target.agent)!
      check('the roster stays parked with the recorded path and the original wait', heldSeat.state === 'parked' && heldSeat.wait !== undefined && heldSeat.wakeProblem?.path === metadata.worktreePath)
      check('held admission leaves the recorded model and worktree unchanged', readFileSync(metaPath, 'utf8') === metadataRecord)
      const { Database } = createRequire(import.meta.url)('bun:sqlite')
      const heldDb = new Database(path, { readonly: true })
      try {
        check('a held missing-worktree trigger remains unread', heldDb.query('SELECT event FROM seen_events WHERE agent = ? AND event = ?').get(target.agent, posted.eventId) === null)
        assert(live.post(sender, { clientOpId: 'built-repeat', kind: 'result', about: 'built-trigger', text: 'Still waiting.' }).ok)
        session.submit('VERIFY-HELD-QUIET')
        await session.waitFor('the next lead boundary leaves the hold intact', () => userTextsOf(world).some(text => text.includes('VERIFY-HELD-QUIET')))
        const notices = heldDb.query("SELECT text FROM lead_notices WHERE agent = ? AND subject LIKE 'wake:%'").all(target.agent) as { text: string }[]
        check('repeated matching posts create no second notice or resume', notices.length === 1 && notices[0]!.text.includes('wake-target') && notices[0]!.text.includes(metadata.worktreePath) && childRequests().length === before)
      } finally { heldDb.close() }
      session.submit('MANUAL-RESUME-WORKER')
      await session.waitFor('the explicit manual resume retains its fallback', () => toolResultOf(world, 'wake-second-schema') !== null)
      const manual = toolResultOf(world, 'manual-resume'), pwd = toolResultOf(world, 'wake-second-pwd')
      check('explicit manual resume keeps the existing parent-checkout fallback', manual?.isError === false && pwd?.isError === false && pwd.text.includes(world.project) && !pwd.text.includes(metadata.worktreePath) && live.seats().find(seat => seat.agent === target.agent)?.wakeProblem === undefined)
      assert.equal(await session.end(), 0, session.stderr())
      return
    }
    await session.waitFor('the real resumed worker submits its existing schema', () => toolResultOf(world, 'wake-second-schema') !== null)
    await session.waitFor('the resumed worker completes once', () => live!.seats().find(seat => seat.agent === target.agent)?.state === 'parked' && live!.view().peerTurns === 1)
    const resumed = childRequests().slice(before)
    assert(resumed.length)
    const resumedBody = resumed[0]!.body as { system?: unknown; tools?: { name?: string; input_schema?: unknown }[]; output_config?: { effort?: string }; messages?: unknown[] }
    const wire = JSON.stringify(resumedBody.messages)
    check('the built runner resumes from the transcript with exactly one triggering body', wire.includes('BUILT-WORKER-PARKED') && wire.split('BUILT-WAKE-PACKET').length === 2 && live.view().peerTurns === 1)
    check('signed thinking stays intact on the resumed request', wire.includes('WAKE-SIGNED-THINKING') && wire.includes('wake-signed-fixture'))
    const firstSchema = firstBody.tools?.find(tool => tool.name === 'StructuredOutput')?.input_schema
    const resumedSchema = resumedBody.tools?.find(tool => tool.name === 'StructuredOutput')?.input_schema
    check('the selected model and max effort remain on both requests', (resumed[0]!.body as { model?: string }).model === childModel && firstBody.output_config?.effort === 'max' && resumedBody.output_config?.effort === 'max' && JSON.stringify(firstBody.output_config) === JSON.stringify(resumedBody.output_config))
    check('the recorded system prefix remains present and byte-identical', firstBody.system !== undefined && resumedBody.system !== undefined && JSON.stringify(firstBody.system) === JSON.stringify(resumedBody.system))
    check('the declared output schema remains present and byte-identical', firstSchema !== null && typeof firstSchema === 'object' && resumedSchema !== null && typeof resumedSchema === 'object' && JSON.stringify(firstSchema) === JSON.stringify(schema) && JSON.stringify(firstSchema) === JSON.stringify(resumedSchema))
    const firstPwd = toolResultOf(world, 'wake-first-pwd'), secondPwd = toolResultOf(world, 'wake-second-pwd')
    check('the same recorded worktree and callable output schema survive the wake', !firstPwd?.isError && !secondPwd?.isError && firstPwd?.text.includes(metadata.worktreePath) && secondPwd?.text.includes(metadata.worktreePath) && toolResultOf(world, 'wake-second-schema')?.isError === false)
    check('the one-shot wait is consumed and the worker retains its identity', live.seats().filter(seat => seat.name === 'wake-target').length === 1 && live.seats().find(seat => seat.agent === target.agent)?.wait === undefined)
    const node = live.screenEvents(0).filter(event => event.author.agentId === target.agent && event.lifecycle)
    check('a real completed run contributes one parked row and its resumed run one Done', node.filter(event => event.lifecycle?.kind === 'parked').length === 1 && node.filter(event => event.lifecycle?.kind === 'done').length === 1)
    assert.equal(await session.end(), 0, session.stderr())
  } finally {
    record(missingWorktree ? 'missing-worktree-out.txt' : 'parked-wake-out.txt', session.stdout())
    record(missingWorktree ? 'missing-worktree-requests.json' : 'parked-wake-requests.json', JSON.stringify(childRequests().map(request => request.body)))
    live?.close()
    await session.terminate()
    if (movedWorktree && existsSync(movedWorktree.to)) renameSync(movedWorktree.to, movedWorktree.from)
    await closeWorld(world)
  }
}
