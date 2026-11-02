#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { argAfter, bootLead, closeWorld, LEAD_MODEL, makeWorld, toolResultOf } from '../crew/crew-world.ts'
import { isHandoffRequest, type CapturedRequest, type ScriptedTurn } from '../lib/fixtureApi.ts'

assert(process.env.MERCURY_CONFIG_DIR, 'run with a scratch MERCURY_CONFIG_DIR')
const scenario = argAfter('--scenario') ?? 'all'
assert(['all', 'roster', 'images', 'compact'].includes(scenario), 'unknown scenario')
let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`)
}
const json = (value: unknown): string => JSON.stringify(value) ?? 'undefined'
const hash = (value: unknown): string => createHash('sha256').update(json(value)).digest('hex').slice(0, 12)
type Body = { tools?: unknown[]; system?: unknown[]; messages?: Array<{ role: string; content: unknown }>; model?: string; thinking?: unknown; output_config?: unknown; diagnostics?: { previous_message_id: string | null } }
type Diff = { path: string; before: string; after: string }

function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, part]) => [key, key === 'input' || key === 'input_schema' ? part : withoutCacheControl(part)]))
}
function firstDifference(before: unknown, after: unknown, path: string): Diff | null {
  if (json(before) === json(after)) return null
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      const diff = firstDifference(before[i], after[i], `${path}[${i}]`)
      if (diff) return diff
    }
  } else if (before !== null && after !== null && typeof before === 'object' && typeof after === 'object') {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const diff = firstDifference(a[key], b[key], `${path}.${key}`)
      if (diff) return diff
    }
  }
  return { path, before: `${json(before).length} chars sha256:${hash(before)}`, after: `${json(after).length} chars sha256:${hash(after)}` }
}
function prefixDifference(before: Body, after: Body): Diff | null {
  for (const key of ['tools', 'system'] as const) {
    const diff = firstDifference(before[key], after[key], key)
    if (diff) return diff
  }
  for (let i = 0; i < (before.messages?.length ?? 0); i++) {
    const diff = firstDifference(withoutCacheControl(before.messages![i]), withoutCacheControl(after.messages?.[i]), `messages[${i}]`)
    if (diff) return diff
  }
  return null
}
function reportPair(label: string, before: Body, after: Body, holds: boolean): void {
  const diff = prefixDifference(before, after)
  check(label, holds ? diff === null : diff !== null, diff ? json(diff) : 'prefix held')
  check(`${label}: model, thinking and effort unchanged`, json([before.model, before.thinking, before.output_config]) === json([after.model, after.thinking, after.output_config]))
}
const text = (words: string): ScriptedTurn => ({ kind: 'text', text: words, thinking: `fixture reasoning ${words}`, model: LEAD_MODEL })
const tool = (name: string, input: Record<string, unknown>, id: string): ScriptedTurn => ({ kind: 'tool_use', name, input, id, thinking: `fixture reasoning ${id}`, model: LEAD_MODEL })
const bodies = (requests: CapturedRequest[]): Body[] => requests.filter(request => !isHandoffRequest(request)).map(request => request.body as Body)

async function rosterReplay(): Promise<void> {
  const launch = (name: string): ScriptedTurn => tool('Crewmate', { name, team: 'fixture', description: `Check ${name}`, prompt: `Finish ${name}'s synthetic task.`, crewmate_type: 'mercury-crew', model: LEAD_MODEL, run_in_background: false }, `launch-${name}`)
  const world = await makeWorld('cache-roster-replay', [
    launch('alpha'), { ...text('ALPHA-ONE'), whenBody: 'You are alpha, team fixture,' },
    launch('beta'), { ...text('BETA-ONE'), whenBody: 'You are beta, team fixture,' },
    tool('ResumeCrewmate', { to: 'alpha', message: 'Continue the synthetic task.' }, 'resume-alpha'),
    { ...text('ALPHA-TWO'), whenBody: 'You are alpha, team fixture,' },
    ...Array.from({ length: 4 }, () => text('ROSTER-DONE')),
  ])
  const settings = join(world.config, 'settings.json')
  writeFileSync(settings, json({ ...(existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {}), swarm: { enabled: true } }))
  Object.assign(world.env, { MERCURY_TOOL_SEARCH: 'tst', MERCURY_CACHE_DIAGNOSTICS: '1', MERCURY_THINKING_BINDING: 'drop_block', TMPDIR: process.env.TMPDIR })
  const session = bootLead(world, ['--sovereign'], ['Crewmate', 'CrewBoard', 'ResumeCrewmate'])
  try {
    session.submit('/swarm on')
    await session.waitFor('board enabled', () => session.stdout().includes('Swarm on for new crewmates'))
    session.submit('Launch alpha, then beta, then resume alpha.')
    await session.waitFor('roster replay finished', () => session.stdout().includes('ROSTER-DONE'), 120_000)
    await session.waitFor('resumed alpha settles', () => session.frames.some(frame => frame.type === 'task' && frame.state === 'ended' && frame.status === 'completed'))
    const exit = await session.end()
    check('roster run exits zero', exit === 0, `exit=${exit} ${session.stderr().slice(-300)}`)
    for (const id of ['launch-alpha', 'launch-beta', 'resume-alpha']) check(`${id} succeeds`, toolResultOf(world, id)?.isError === false)
    const requests = world.fixture.messageRequests().filter(request => !isHandoffRequest(request))
    const alpha = requests.filter(request => (request.body as Body).system?.some(block => json(block).includes('You are alpha, team fixture,')))
    check('exactly two alpha requests captured across re-entry', alpha.length === 2, String(alpha.length))
    if (alpha.length === 2) {
      const before = alpha[0]!.body as Body, after = alpha[1]!.body as Body
      reportPair('roster re-entry keeps the sent prefix', before, after, true)
      check('resumed diagnostics names alpha previous response', after.diagnostics?.previous_message_id === `msg_fixture_${requests.indexOf(alpha[0]!) + 1}`, json(after.diagnostics))
      check('resumed alpha keeps signed thinking', json(after.messages).includes('fixture reasoning ALPHA-ONE'))
    }
    check('beta really joined the board', bodies(requests).some(body => json(body.system).includes('You are beta, team fixture,') && json(body.system).includes('alpha (fixture)')))
  } finally {
    await session.terminate()
    await closeWorld(world)
  }
}

function imageSources(body: Body): string[] {
  const found: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (value === null || typeof value !== 'object') return
    const block = value as { type?: string; source?: { data?: string }; [key: string]: unknown }
    if (block.type === 'image' && typeof block.source?.data === 'string') found.push(block.source.data)
    Object.values(block).forEach(visit)
  }
  visit(body.messages)
  return found
}
async function imageReplay(): Promise<void> {
  const sharp = (await import('sharp')).default
  const wide = await sharp({ create: { width: 2500, height: 1400, channels: 3, background: '#a1b2c3' } }).png().toBuffer()
  const small = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#123456' } }).png().toBuffer()
  const world = await makeWorld('cache-images-replay', [text('IMAGES-TWENTY'), text('IMAGES-TWENTYONE'), text('IMAGES-NEXT')])
  Object.assign(world.env, { MERCURY_CACHE_DIAGNOSTICS: '1', MERCURY_THINKING_BINDING: 'drop_block', TMPDIR: process.env.TMPDIR })
  const session = bootLead(world, [], ['Read'])
  const inputImage = (buffer: Buffer) => ({ type: 'image', media_type: 'image/png', data: buffer.toString('base64') })
  try {
    session.child.stdin!.write(json({ type: 'prompt', content: [{ type: 'text', text: 'Inspect the twenty synthetic images.' }, ...Array.from({ length: 20 }, (_, i) => inputImage(i === 0 ? wide : small))] }) + '\n')
    await session.waitFor('twenty images answered', () => session.stdout().includes('IMAGES-TWENTY'))
    session.child.stdin!.write(json({ type: 'prompt', content: [{ type: 'text', text: 'Inspect one more image.' }, inputImage(small)] }) + '\n')
    await session.waitFor('twenty-one images answered', () => session.stdout().includes('IMAGES-TWENTYONE'))
    session.submit('And the next step?')
    await session.waitFor('image continuation answered', () => session.stdout().includes('IMAGES-NEXT'))
    check('images run exits zero', await session.end() === 0, session.stderr().slice(-300))
    const requests = bodies(world.fixture.messageRequests())
    check('three image requests captured', requests.length === 3, String(requests.length))
    if (requests.length === 3) {
      const [before, crossing, after] = requests as [Body, Body, Body]
      check('twenty then twenty-one images remain available', imageSources(before).length === 20 && imageSources(crossing).length === 21 && imageSources(after).length === 21)
      const dims = await Promise.all([before, crossing, after].map(async body => { const meta = await sharp(Buffer.from(imageSources(body)[0]!, 'base64')).metadata(); return `${meta.width}x${meta.height}` }))
      console.log(`image dimensions before/crossing/after: ${dims.join(' / ')}`)
      check('native-sized input keeps its full resolution from first send', dims[0] === '2500x1400' && dims[1] === '2500x1400' && dims[2] === '2500x1400')
      reportPair('20-to-21 image transition keeps the sent prefix', before, crossing, true)
      reportPair('image continuation keeps the fitted prefix', crossing, after, true)
    }
  } finally {
    await session.terminate()
    await closeWorld(world)
  }
}

async function compactReplay(): Promise<void> {
  const world = await makeWorld('cache-compact-replay', [
    tool('ToolSearch', { query: 'select:WebFetch' }, 'discover-fetch'),
    { ...tool('Read', { file_path: 'note.txt' }, 'read-note'), usage: { input_tokens: 150_000 } },
    { kind: 'text', text: 'Summary: the synthetic note was read.', model: LEAD_MODEL, whenBody: 'Produce the summary now.' },
    tool('Bash', { command: 'echo after-fold' }, 'after-fold'), text('FOLD-ONE'), text('FOLD-TWO'),
  ])
  writeFileSync(join(world.project, 'note.txt'), 'synthetic note\n')
  Object.assign(world.env, { MERCURY_TOOL_SEARCH: 'tst', MERCURY_CACHE_DIAGNOSTICS: '1', MERCURY_THINKING_BINDING: 'drop_block', MERCURY_AUTOCOMPACT_PCT_OVERRIDE: '7', MERCURY_COMPACT_KEEP_TAIL: '0', TMPDIR: process.env.TMPDIR })
  const session = bootLead(world, ['--sovereign'], ['ToolSearch', 'Read', 'Bash', 'WebFetch'])
  try {
    session.submit('Discover WebFetch without fetching, then read the synthetic note.')
    await session.waitFor('fold turn finished', () => session.stdout().includes('FOLD-ONE'))
    session.submit('And now?')
    await session.waitFor('post-fold turn finished', () => session.stdout().includes('FOLD-TWO'))
    check('compact run exits zero', await session.end() === 0, session.stderr().slice(-300))
    const requests = world.fixture.messageRequests().filter(request => !isHandoffRequest(request))
    const summary = requests.findIndex(request => request.raw.includes('Produce the summary now.'))
    check('compaction request follows two main requests', summary === 2, String(summary))
    const main = requests.filter(request => !request.raw.includes('Produce the summary now.')).map(request => request.body as Body)
    check('five main requests captured across compact', main.length === 5, String(main.length))
    if (main.length === 5 && summary === 2) {
      reportPair('ToolSearch is stable before the boundary', main[0]!, main[1]!, true)
      reportPair('compaction changes the prefix at its boundary', main[1]!, main[2]!, false)
      check('the discovered deferred tool changes only at compaction', prefixDifference(main[1]!, main[2]!)?.path.startsWith('tools[') === true && toolResultOf(world, 'discover-fetch')?.isError === false)
      reportPair('first post-fold tool round is stable', main[2]!, main[3]!, true)
      reportPair('next post-fold turn is stable', main[3]!, main[4]!, true)
    }
  } finally {
    await session.terminate()
    await closeWorld(world)
  }
}

for (const [name, replay] of [['roster', rosterReplay], ['images', imageReplay], ['compact', compactReplay]] as const) {
  if (scenario !== 'all' && scenario !== name) continue
  console.log(`\n${name} replay`)
  try { await replay() } catch (error) { check(`${name} replay completes`, false, error instanceof Error ? error.message : String(error)) }
}
console.log(`\nprove-cache-divergence-replay: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
