#!/usr/bin/env bun
// gate-watch: src/tools/AgentTool/agentPermissionPosture.ts src/tools/AgentTool/loadAgentsDir.ts src/tools/AgentTool/runAgent.ts
// gate-watch: src/utils/permissions/decision/engine.ts src/services/agents/codec.ts src/types/permissions.ts
// gate-watch: src/components/agents/studio/StudioEditor.tsx src/components/agents/studio/AgentStudio.tsx src/components/BootAgentsScreen.tsx
// gate-watch: scripts/lib/firstRunSeed.ts
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_PERMISSION_MODE', 'MERCURY_SKIP_PERMISSIONS', 'CI']) delete process.env[key]
process.env.NODE_ENV = 'test'
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'agent-mode-consent-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'seam-home')
const ROOT = join(import.meta.dir, '..', '..')
const BIN = process.env.MERCURY_PROOF_BUNDLE ?? join(ROOT, 'dist', 'mercury.mjs')
const KEEP = process.argv.includes('--keep')
const src = (...p: string[]): string => readFileSync(join(ROOT, 'src', ...p), 'utf8')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const { composeAgentAppState, definitionModeWithinConsent, offeredDefinitionModes } = await import('../../src/tools/AgentTool/agentPermissionPosture.ts')
const { postureBypassesAsks } = await import('../../src/utils/permissions/decision/engine.ts')
const { parseAgentFromJson, parseAgentsFromJson } = await import('../../src/tools/AgentTool/loadAgentsDir.ts')
const { decodeAgentDocument } = await import('../../src/services/agents/codec.ts')
const { PERMISSION_MODES } = await import('../../src/types/permissions.ts')

const UNKNOWN_WORDS = ['frobnicate', 'bubble', 'wibble', 'Default', 'SOVEREIGN']
type Ctx = { mode: string; isBypassPermissionsModeAvailable: boolean }
const parentOf = (mode: string, consent: boolean): { toolPermissionContext: Ctx } => ({
  toolPermissionContext: { mode, alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: consent } as unknown as Ctx,
})
const childOf = (parentMode: string, consent: boolean, definitionMode: string): Ctx =>
  (composeAgentAppState(parentOf(parentMode, consent) as never, { definitionMode: definitionMode as never, avoidPrompts: false, isAsync: false, allowedTools: undefined, effortValue: undefined }) as unknown as { toolPermissionContext: Ctx }).toolPermissionContext

section("§1 the posture owner: a definition's bypass word never exceeds the parent's launch consent")
{
  for (const parentMode of ['default', 'flow', 'dontAsk']) {
    const child = childOf(parentMode, false, 'sovereign')
    check(`parent ${parentMode}, no consent, definition sovereign ⇒ the child keeps '${parentMode}' and its asks still ask`, child.mode === parentMode && !postureBypassesAsks(child as never), `child=${child.mode}`)
  }
  const consented = childOf('default', true, 'sovereign')
  check('parent default WITH the launch consent, definition sovereign ⇒ the child is sovereign (the consent honoured)', consented.mode === 'sovereign' && postureBypassesAsks(consented as never), `child=${consented.mode}`)
  const implement = childOf('implement', true, 'sovereign')
  check("parent implement never yields to a definition's word, consent or not", implement.mode === 'implement', `child=${implement.mode}`)
  for (const word of ['dontAsk', 'apollo', 'flow']) {
    const child = childOf('default', false, word)
    check(`a non-bypass definition word ('${word}') still overrides a default parent without any consent`, child.mode === word, `child=${child.mode}`)
  }
  check('definitionModeWithinConsent: sovereign under no consent is nothing; under consent itself; a plain word always itself; nothing is nothing', definitionModeWithinConsent('sovereign', { isBypassPermissionsModeAvailable: false }) === undefined && definitionModeWithinConsent('sovereign', { isBypassPermissionsModeAvailable: true }) === 'sovereign' && definitionModeWithinConsent('flow', { isBypassPermissionsModeAvailable: false }) === 'flow' && definitionModeWithinConsent(undefined, { isBypassPermissionsModeAvailable: true }) === undefined)
}

section('§2 the Studio offers what a definition may carry: sovereign only under the launch consent')
{
  const without = offeredDefinitionModes(false)
  const withConsent = offeredDefinitionModes(true)
  check('without consent the offer is the mode list minus sovereign', j(without) === j(PERMISSION_MODES.filter(m => m !== 'sovereign')), j(without))
  check('with consent the offer is the whole mode list', j(withConsent) === j([...PERMISSION_MODES]), j(withConsent))
  const studio = src('components', 'agents', 'studio', 'StudioEditor.tsx')
  const host = src('components', 'agents', 'studio', 'AgentStudio.tsx')
  const face = src('components', 'BootAgentsScreen.tsx')
  check('the Studio field editor reads the one offer', studio.includes('offeredDefinitionModes(props.sovereignConsent)') && !studio.includes('PERMISSION_MODES.map'))
  check("the Studio host hands it the session's own consent", host.includes('sovereignConsent={toolPermissionContext.isBypassPermissionsModeAvailable === true}'))
  check("the Boot face's agents screen reads the one offer under the launch's consent", face.includes('offeredDefinitionModes(bootBirthFacts().bypassConsent)') && !face.includes('[...PERMISSION_MODES]'))
}

section('§3 both agent routes validate the word against the one list and refuse an unknown word the same way')
{
  for (const word of PERMISSION_MODES) {
    const agents = parseAgentsFromJson({ probe: { description: 'd', prompt: 'p', permissionMode: word } })
    check(`JSON route · '${word}' is a word of the list ⇒ the definition loads carrying it`, agents.length === 1 && (agents[0] as { permissionMode?: string }).permissionMode === word, j(agents.map(a => (a as { permissionMode?: string }).permissionMode)))
  }
  for (const word of UNKNOWN_WORDS) {
    const batch = parseAgentsFromJson({ probe: { description: 'd', prompt: 'p', permissionMode: word } })
    const single = parseAgentFromJson('probe', { description: 'd', prompt: 'p', permissionMode: word })
    const markdown = decodeAgentDocument(`---\nname: probe\ndescription: d\npermissionMode: ${word}\n---\nbody\n`, 'probe.md')
    const markdownRefused = markdown.diagnostics.some(d => d.severity === 'error' && d.code === 'invalid-permission-mode')
    check(`'${word}' ⇒ the JSON route refuses the definition (batch and single) exactly as the markdown route does`, batch.length === 0 && single === null && markdownRefused, `batch=${batch.length} single=${single === null ? 'null' : 'kept'} markdown=${markdownRefused ? 'refused' : j(markdown.diagnostics)}`)
  }
  const sovereignDoc = decodeAgentDocument('---\nname: probe\ndescription: d\npermissionMode: sovereign\n---\nbody\n', 'probe.md')
  check('the markdown route keeps sovereign as a word of the list (the consent is asked at the spawn, not at the file)', sovereignDoc.fields.permissionMode === 'sovereign' && sovereignDoc.diagnostics.length === 0, j(sovereignDoc.diagnostics))
  const schema = src('tools', 'AgentTool', 'loadAgentsDir.ts')
  check('the JSON schema spells the one list', schema.includes('permissionMode: z.enum(PERMISSION_MODES') && !schema.includes('permissionMode: z.string()'))
}

if (!existsSync(BIN)) {
  console.log(`\n  [SKIP] ${BIN} absent — the built-product spawn needs a build`)
} else {
  section('§4 one real sub-agent spawn on the built product: the definition says sovereign; only the launch consent arms it')
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
    const BRIEF = 'agent-mode-probe: mark the repository and report the sha'
    const ASK = 'agent-mode-parent: delegate the mark to the probe agent'
    const MARK = 'agent-mode-mark'
    const COMMAND = `git commit --allow-empty -q -m ${MARK} && git rev-parse --short HEAD`
    const MODEL = 'claude-opus-5'
    const sse = (obj: unknown): string => `data: ${j(obj)}\n\n`
    type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: Record<string, unknown> }
    type Hit = { n: number; route: string; results: string[] }
    const textOf = (content: unknown): string =>
      typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => ((b as { type?: string; text?: string }).type === 'text' ? String((b as { text?: string }).text ?? '') : '')).join('') : ''
    const userTextsOf = (body: unknown): string[] =>
      (((body as { messages?: unknown[] })?.messages ?? []) as Array<{ role?: string; content?: unknown }>).filter(m => m.role === 'user').map(m => textOf(m.content)).filter(t => t.trim() !== '')
    const resultTextsOf = (body: unknown): string[] => {
      const out: string[] = []
      for (const m of ((body as { messages?: unknown[] })?.messages ?? []) as Array<{ role?: string; content?: unknown }>) {
        if (m.role !== 'user' || !Array.isArray(m.content)) continue
        for (const block of m.content as Array<{ type?: string; content?: unknown }>) if (block.type === 'tool_result') out.push(textOf(block.content))
      }
      return out
    }
    const toolNamesOf = (body: unknown): string[] => (((body as { tools?: Array<{ name?: string }> })?.tools ?? []).map(t => t.name ?? '').filter(n => n !== ''))
    const answer = (n: number, model: string, blocks: Block[], streaming: boolean): string => {
      const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
      const usage = { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 }
      if (!streaming) {
        const content = blocks.map((block, index) => (block.type === 'text' ? { type: 'text', text: block.text } : { type: 'tool_use', id: `toolu_am_${n}_${index}`, name: block.name, input: block.input }))
        return j({ id: `msg_am_${n}`, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage })
      }
      const parts: string[] = [`event: message_start\n${sse({ type: 'message_start', message: { id: `msg_am_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } })}`]
      blocks.forEach((block, index) => {
        if (block.type === 'text') {
          parts.push(`event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })}`, `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })}`, `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`)
        } else {
          parts.push(`event: content_block_start\n${sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_am_${n}_${index}`, name: block.name, input: {} } })}`, `event: content_block_delta\n${sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: j(block.input) } })}`, `event: content_block_stop\n${sse({ type: 'content_block_stop', index })}`)
        }
      })
      parts.push(`event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage })}`, `event: message_stop\n${sse({ type: 'message_stop' })}`)
      return parts.join('')
    }
    async function startFixture(): Promise<{ base: string; hits: Hit[]; close: () => Promise<void> }> {
      const hits: Hit[] = []
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = []
        req.on('data', c => chunks.push(c as Buffer))
        req.on('end', () => {
          if (req.method !== 'POST' || !(req.url ?? '').split('?')[0]!.endsWith('/v1/messages')) {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end('{}')
            return
          }
          let body: unknown = null
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            body = null
          }
          const model = typeof (body as { model?: unknown })?.model === 'string' ? (body as { model: string }).model : 'fixture'
          const streaming = (body as { stream?: unknown })?.stream === true
          const results = resultTextsOf(body)
          const tools = toolNamesOf(body)
          const n = hits.length + 1
          let route = 'side'
          let blocks: Block[] = [{ type: 'text', text: 'ok' }]
          if (userTextsOf(body).some(t => t.includes('agent-mode-probe:'))) {
            route = results.length === 0 ? 'agent' : 'agent-done'
            blocks = results.length === 0 ? [{ type: 'tool_use', name: 'Bash', input: { command: COMMAND, description: 'the mark and its sha' } }] : [{ type: 'text', text: `agent-mode-done: ${results[results.length - 1]!.trim().split('\n')[0]!.trim().slice(0, 80)}` }]
          } else if (tools.includes('Agent')) {
            route = results.length === 0 ? 'parent' : 'parent-ack'
            blocks = results.length === 0 ? [{ type: 'tool_use', name: 'Agent', input: { description: 'the probe', prompt: BRIEF, subagent_type: 'probe' } }] : [{ type: 'text', text: `agent-mode-parent-done: ${results[results.length - 1]!.replace(/\s+/g, ' ').slice(0, 160)}` }]
          }
          hits.push({ n, route, results })
          res.writeHead(200, { 'content-type': streaming ? 'text/event-stream' : 'application/json', 'cache-control': 'no-cache' })
          res.end(answer(n, model, blocks, streaming))
        })
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port
      return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
    }
    type World = { home: string; cwd: string }
    function seedWorld(name: string): World {
      const home = join(SCRATCH, `world-${name}-home`)
      const cwd = join(SCRATCH, `world-${name}-cwd`)
      for (const d of [home, cwd]) spawnSync('mkdir', ['-p', d])
      const git = (args: string[]): void => {
        const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args], { encoding: 'utf8' })
        if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
      }
      git(['init', '-q'])
      git(['config', 'user.name', 'probe'])
      git(['config', 'user.email', 'probe@example.invalid'])
      writeFileSync(join(cwd, 'README.md'), 'the probe repository\n')
      git(['add', 'README.md'])
      git(['commit', '-q', '-m', 'seed'])
      seedFirstRun(home, [cwd])
      writeFileSync(join(home, 'settings.json'), '{}\n')
      return { home, cwd }
    }
    const commitCount = (cwd: string): string => spawnSync('git', ['-C', cwd, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    type Run = { frames: Array<Record<string, unknown>>; stderr: string; exit: number | null }
    function runOnce(world: World, fixtureBase: string, args: string[]): Promise<Run> {
      return new Promise(resolvePromise => {
        const child = spawn(nodeBin!, [BIN, 'run', ASK, '--format=rows', '--model', MODEL, ...args], {
          cwd: world.cwd,
          env: {
            HOME: world.home,
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            TERM: 'dumb',
            MERCURY_CONFIG_DIR: world.home,
            MERCURY_DAEMON_DIR: join(world.home, 'daemon'),
            MERCURY_TMPDIR: join(world.home, 'tmp'),
            MERCURY_CREDENTIAL_STORE: 'file',
            MERCURY_LOCAL_PROBE_TARGETS: 'none',
            ANTHROPIC_BASE_URL: fixtureBase,
            ANTHROPIC_API_KEY: 'fixture-key-000',
            OPENAI_API_KEY: '',
            MERCURY_TERMINAL_TITLE: '0',
            MERCURY_OPERATOR: 'sam',
            MERCURY_TURN_RECEIPT: '0',
            MERCURY_THINKING_BINDING: 'drop_block',
          },
        })
        const frames: Array<Record<string, unknown>> = []
        let stdout = ''
        let stderr = ''
        let ended = false
        const finish = (exit: number | null): void => {
          if (ended) return
          ended = true
          clearTimeout(killer)
          for (const line of stdout.split('\n')) {
            try {
              frames.push(JSON.parse(line) as Record<string, unknown>)
            } catch {
              continue
            }
          }
          resolvePromise({ frames, stderr, exit })
        }
        const killer = setTimeout(() => child.kill('SIGKILL'), 120_000)
        child.stdout.on('data', d => (stdout += String(d)))
        child.stderr.on('data', d => (stderr += String(d)))
        child.on('close', exit => finish(exit))
        child.on('error', () => finish(null))
      })
    }
    const isSha = (text: string): boolean => /^[0-9a-f]{7,12}$/.test(text.trim().split('\n')[0]?.trim() ?? '')
    type Leg = { name: string; word: string; consent: boolean; expectRan: boolean; expectAgent: boolean }
    const LEGS: Leg[] = [
      { name: 'no consent · definition sovereign', word: 'sovereign', consent: false, expectRan: false, expectAgent: true },
      { name: '--allow-sovereign · definition sovereign', word: 'sovereign', consent: true, expectRan: true, expectAgent: true },
      { name: 'no consent · definition frobnicate (the JSON route)', word: 'frobnicate', consent: false, expectRan: false, expectAgent: false },
    ]
    for (const leg of LEGS) {
      console.log(`\n— ${leg.name} —`)
      const fixture = await startFixture()
      const world = seedWorld(leg.name.replace(/[^a-z]+/gi, '-'))
      const defs = j({ probe: { description: 'the probe agent', prompt: 'You are the probe. Do exactly what the brief says.', permissionMode: leg.word } })
      let run: Run
      try {
        run = await runOnce(world, fixture.base, ['--agent-defs', defs, ...(leg.consent ? ['--allow-sovereign'] : [])])
      } finally {
        await fixture.close()
      }
      const routes = fixture.hits.map(h => h.route)
      const agentDone = fixture.hits.find(h => h.route === 'agent-done')
      const shellResult = agentDone?.results[agentDone.results.length - 1] ?? ''
      const parentAck = fixture.hits.find(h => h.route === 'parent-ack')
      const agentToolResult = parentAck?.results[parentAck.results.length - 1] ?? ''
      const commits = commitCount(world.cwd)
      const resultRows = run.frames.filter(f => f.type === 'outcome')
      console.log(`  evidence · routes ${routes.join(' → ')} · commits ${commits} · exit ${run.exit} · shell ${j(shellResult.replace(/\s+/g, ' ').slice(0, 160))} · agent tool ${j(agentToolResult.replace(/\s+/g, ' ').slice(0, 160))}`)
      check(`${leg.name}: the run settled with an outcome row`, resultRows.length === 1 && run.exit === 0, `results=${resultRows.length} exit=${run.exit} stderr=${j(run.stderr.slice(-300))}`)
      if (leg.expectAgent) {
        check(`${leg.name}: the probe agent ran (its brief reached the model)`, routes.includes('agent'), routes.join(' → '))
        if (leg.expectRan) {
          check(`${leg.name}: the agent's shell RAN — the mark landed and its sha came back (the consent arms the definition's word)`, isSha(shellResult) && commits === '2', `shell=${j(shellResult.slice(0, 120))} commits=${commits}`)
        } else {
          check(`${leg.name}: the agent's shell did NOT run — one commit, no sha (the definition's word is not the consent)`, !isSha(shellResult) && commits === '1', `shell=${j(shellResult.slice(0, 160))} commits=${commits}`)
        }
      } else {
        check(`${leg.name}: the definition is refused — no probe agent exists and the Agent tool says so`, !routes.includes('agent') && /No agent type named 'probe'/.test(agentToolResult) && commits === '1', `routes=${routes.join(' → ')} agent tool=${j(agentToolResult.slice(0, 160))} commits=${commits}`)
      }
    }
  }
}

if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true })
else console.log(`\n[keep] ${SCRATCH}`)
console.log(failures === 0 ? '\nprove-agent-mode-within-consent: ALL LAWS HOLD' : `\nprove-agent-mode-within-consent: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
