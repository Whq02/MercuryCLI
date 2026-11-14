#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { gitFixture } from '../builtin-tools/gitFixture.ts'
import { dist, runDoor, say, sceneRoot } from '../hooks/lib/runDoor.ts'
import { handoffTurn } from '../lib/fixtureApi.ts'

if (!process.argv.includes('--child')) {
  const wrapper = gitFixture('rejected-input-home-')
  try {
    const child = spawnSync(process.execPath, [import.meta.filename, '--child'], { env: { ...wrapper.env, REJECTED_INPUT_HOME: wrapper.home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DESKTOP_DRIVER: 'none', NODE_ENV: 'test' }, stdio: 'inherit' })
    process.exitCode = child.status ?? 1
  } finally { wrapper.dispose() }
} else {
  if (homedir() !== process.env.REJECTED_INPUT_HOME) throw new Error('wrong proof home before product imports')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const world = gitFixture('rejected-input-')
  const { setOriginalCwd } = await import('../../src/bootstrap/state.ts')
  const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
  const { enableConfigs } = await import('../../src/utils/config.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { decideToolPermission, defaultDecisionPorts } = await import('../../src/utils/permissions/decision/engine.ts')
  const { createPermissionRequestMessage } = await import('../../src/utils/permissions/decision/requestMessage.ts')
  const { getAllBaseTools } = await import('../../src/tools.ts')
  const { GitTool } = await import('../../src/tools/GitTool/GitTool.ts')
  enableConfigs()
  setOriginalCwd(world.root)
  const startedIn = process.cwd()
  process.chdir(world.root)
  let checks = 0
  let failures = 0
  const check = (label: string, ok: boolean, detail = ''): void => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`) }
  type Verdict = { behavior: 'allow' | 'ask' | 'deny'; message?: string; note: string }
  type AnyTool = { name: string; inputSchema: { safeParse(input: unknown): { success: boolean }; parse(input: unknown): unknown }; inputJSONSchema?: unknown; checkPermissions(input: unknown, context: unknown): Promise<unknown>; requiresUserInteraction?(): boolean; backfillObservableInput?(input: unknown): void; call(input: unknown, context: unknown): Promise<{ data: { result: string } }> }
  const DEGRADED = 'resolution failed — degraded to passthrough'
  const rank = { allow: 0, ask: 1, deny: 2 } as const
  const basePorts = { ...defaultDecisionPorts, resolveToolVerdict: async (tool: AnyTool, input: Record<string, unknown>, context: unknown) => tool.checkPermissions(tool.inputSchema.parse(input), context) }
  const tools = getAllBaseTools() as unknown as AnyTool[]
  const contextFor = (mode: string, deny: string[] = [], allow: string[] = []) => {
    const permission = { ...getEmptyToolPermissionContext(), mode, alwaysDenyRules: { session: deny }, alwaysAllowRules: { session: allow } }
    return { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: permission, sessionHooks: new Map(), tasks: {}, mcp: { clients: [], tools: [], resources: {} } }), setAppState: () => {}, messages: [], options: { tools, mcpClients: [], isNonInteractiveSession: false, agentDefinitions: { activeAgents: [], allAgents: [] } }, readFileState: new Map() } as never
  }
  const decide = async (tool: AnyTool, input: Record<string, unknown>, context: never, ports?: unknown): Promise<Verdict> => {
    const out = await (ports ? decideToolPermission(tool as never, structuredClone(input), context, ports as never) : decideToolPermission(tool as never, structuredClone(input), context))
    return { behavior: out.decision.behavior, message: (out.decision as { message?: string }).message, note: out.trace.stages.find(stage => stage.stage === 'toolVerdict')?.note ?? '' }
  }
  const sample = (schema: unknown): unknown => {
    const s = (schema ?? {}) as Record<string, unknown> & { properties?: Record<string, unknown>; required?: string[] }
    if ('const' in s) return s.const
    if (Array.isArray(s.enum)) return s.enum[0]
    if (Array.isArray(s.anyOf)) return sample(s.anyOf[0])
    if (Array.isArray(s.oneOf)) return sample(s.oneOf[0])
    const type = Array.isArray(s.type) ? s.type[0] : s.type
    if (type === 'object' || s.properties) return Object.fromEntries((s.required ?? []).map(key => [key, sample(s.properties?.[key])]))
    if (type === 'array') return Array.from({ length: Number(s.minItems ?? 0) }, () => sample(s.items))
    if (type === 'number' || type === 'integer') return Math.max(1, Number(s.minimum ?? 1))
    if (type === 'boolean') return false
    return 'x'.repeat(Math.max(1, Number(s.minLength ?? 1)))
  }
  const wrong = (value: unknown): unknown => typeof value === 'string' ? 7 : typeof value === 'number' ? 'seven' : typeof value === 'boolean' ? 'maybe' : 'neither'
  const written: Record<string, Array<Record<string, unknown>>> = {
    Bash: [{ command: 'cat notes.txt' }, { command: 'rm -rf build' }, { command: 'ls', description: 'list' }],
    PowerShell: [{ command: 'Get-ChildItem' }, { command: 'Remove-Item notes.txt' }],
    Read: [{ file_path: 'notes.txt' }, { file_path: join(world.root, 'locked', 'one.txt') }, { file_path: join(world.scratch, 'outside.txt') }],
    Edit: [{ file_path: 'notes.txt', old_string: 'notes', new_string: 'other' }, { file_path: 'locked/one.txt', old_string: 'one', new_string: 'other' }],
    Write: [{ file_path: 'made.txt', content: 'made' }, { file_path: 'locked/made.txt', content: 'made' }],
    Glob: [{ pattern: '*.txt' }, { pattern: '*', path: world.scratch }],
    Grep: [{ pattern: 'notes' }, { pattern: 'notes', path: world.scratch }],
    Git: [{ op: 'status' }, { op: 'stage', files: ['notes.txt'] }, { op: 'resolve', path: 'notes.txt', take: 'ours' }, { op: 'fileAtRef', ref: 'HEAD', path: 'locked/one.txt' }],
    AstSearch: [{ pattern: 'needle($X)' }],
    AstEdit: [{ pattern: 'needle($X)', rewrite: 'found($X)' }, { pattern: 'needle($X)', rewrite: 'found($X)', apply: true, plan: 'ae-0000' }],
  }
  try {
    mkdirSync(join(world.root, 'locked'))
    const names = ['open.txt', 'locked/one.txt']
    const seed = (text: string) => { for (const file of names) world.put(file, text); world.put('notes.txt', 'notes\n'); world.put('code.ts', 'const a = needle(1)\n'); world.git(['add', '-A']); world.git(['commit', '--quiet', '-m', text.trim()]) }
    writeFileSync(join(world.scratch, 'outside.txt'), 'outside\n')
    seed('base\n')

    await runWithCwdOverride(world.root, async () => {
      world.put('notes.txt', 'notes\nplanned\n')
      const planned = await GitTool.call({ op: 'plan', cwd: world.root, groups: [{ files: ['notes.txt'], message: 'a planned commit' }] }, contextFor('default'))
      const planId = planned.data.result.match(/gp-[A-Za-z0-9]+/)?.[0] ?? ''
      const apply = GitTool.inputSchema.parse({ op: 'apply', planId }) as Record<string, unknown>
      GitTool.backfillObservableInput(apply as never)
      const applyAsk = await decide(GitTool as never, apply, contextFor('default'))
      check('apply of a stored plan gains a private preview key the public schema rejects', planId !== '' && 'preview' in apply && !GitTool.inputSchema.safeParse(apply).success, planned.data.result.slice(0, 200))
      check('that enriched apply is still asked, in Git\'s own sentence', applyAsk.behavior === 'ask' && applyAsk.message === `Git apply commit plan ${planId} (creates local commits; never pushes; pre-commit and commit-msg hooks are not run)` && applyAsk.note === 'verdict: ask', JSON.stringify(applyAsk))
      check('and is allowed with no question in Sovereign', (await decide(GitTool as never, apply, contextFor('sovereign'))).behavior === 'allow')
      world.git(['checkout', '--', 'notes.txt'])
    })

    world.git(['switch', '--quiet', '-c', 'other']); seed('theirs\n'); world.git(['switch', '--quiet', 'main']); seed('ours\n')
    try { world.git(['merge', '--no-edit', 'other']) } catch {}
    const marker = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n'
    for (const file of names) world.put(file, marker)

    await runWithCwdOverride(world.root, async () => {
      const listed = await GitTool.call({ op: 'conflicts', cwd: world.root }, contextFor('default'))
      const region = (file: string) => listed.data.result.slice(listed.data.result.indexOf(` ${file} (`)).match(/gr-[a-f0-9]+/)?.[0] ?? ''
      for (const mode of ['default', 'sovereign']) {
        const context = contextFor(mode, ['Edit(locked/**)'])
        const denied = GitTool.inputSchema.parse({ op: 'resolve', cwd: world.root, resolutions: [{ region: region('locked/one.txt'), take: 'ours' }] }) as Record<string, unknown>
        GitTool.backfillObservableInput(denied as never)
        const refused = await decide(GitTool as never, denied, context)
        check(`${mode}: a region resolve into an Edit-denied file is refused before any card`, 'resolutionPlanId' in denied && refused.behavior === 'deny' && String(refused.message).includes('is denied by the rule Edit(locked/**)') && refused.note === 'verdict: deny', JSON.stringify(refused))
        const open = GitTool.inputSchema.parse({ op: 'resolve', cwd: world.root, resolutions: [{ region: region('open.txt'), take: 'ours' }] }) as Record<string, unknown>
        GitTool.backfillObservableInput(open as never)
        const asked = await decide(GitTool as never, open, context)
        check(`${mode}: a region resolve into an allowed file keeps the mode's answer`, mode === 'sovereign' ? asked.behavior === 'allow' : asked.behavior === 'ask' && asked.message === `Git resolve 1 conflict region in open.txt in ${world.root}`, JSON.stringify(asked))
      }
      check('no file and no index entry moved while deciding', names.every(file => world.get(file) === marker) && world.git(['ls-files', '--unmerged']).includes('open.txt'))

      const bash = tools.find(tool => tool.name === 'Bash')!
      const read = tools.find(tool => tool.name === 'Read')!
      const amended = { command: 'cat notes.txt', bogus: 1 }
      const plain = await decide(bash, amended, contextFor('default'))
      check('a read-only command with a key the schema rejects is asked, in the words of an ungranted tool', plain.behavior === 'ask' && plain.message === createPermissionRequestMessage('Bash') && plain.note === DEGRADED, JSON.stringify(plain))
      check('the same command with no rejected key is allowed by the tool itself', (await decide(bash, { command: 'cat notes.txt' }, contextFor('default'))).behavior === 'allow')
      const reading = await decide(read, { file_path: 'notes.txt', bogus: 1 }, contextFor('default'))
      check('a read inside the project with a key the schema rejects is asked', reading.behavior === 'ask' && reading.message === createPermissionRequestMessage('Read') && reading.note === DEGRADED, JSON.stringify(reading))
      for (const mode of ['default', 'sovereign']) {
        const ruled = await decide(bash, amended, contextFor(mode, ['Bash(cat *)']))
        check(`${mode}: a deny rule still answers the input the schema rejected`, ruled.behavior === 'deny' && String(ruled.message).includes('is denied by the rule Bash(cat *)') && ruled.note === 'verdict: deny', JSON.stringify(ruled))
        const before = await decide(bash, amended, contextFor(mode, ['Bash(cat *)']), basePorts)
        check(`${mode}: where the parent's port never consulted that rule`, before.behavior === (mode === 'sovereign' ? 'allow' : 'ask') && before.note === DEGRADED, JSON.stringify(before))
      }
      const whole = await decide(bash, amended, contextFor('default', [], ['Bash']))
      check('a whole-tool allow rule answers a rejected input as it did', whole.behavior === 'allow' && whole.note === DEGRADED, JSON.stringify(whole))
      const throwing = { ...bash, inputSchema: z.strictObject({ command: z.string() }), checkPermissions: async (input: { command: string }) => { input.command.trim(); throw new Error('unreachable') } }
      const thrown = await decide(throwing as never, { command: null } as never, contextFor('default'))
      check('a checker that throws on the rejected input degrades as before', thrown.behavior === 'ask' && thrown.note === DEGRADED, JSON.stringify(thrown))

      let rows = 0
      let valid = 0
      let stronger = 0
      const validMoved: string[] = []
      const weaker: string[] = []
      const taken: string[] = []
      const sovereignAsks = new Set<string>()
      for (const tool of tools) {
        let samples = written[tool.name]
        if (!samples) {
          let json: unknown
          try { json = tool.inputJSONSchema ?? z.toJSONSchema(tool.inputSchema as never, { io: 'input', unrepresentable: 'any' }) } catch { json = undefined }
          const made = sample(json)
          samples = made && typeof made === 'object' ? [made as Record<string, unknown>] : [{}]
        }
        for (const given of samples) {
          const variants: Array<Record<string, unknown>> = [given, { ...given, bogus: 1 }, {}]
          for (const key of Object.keys(given)) {
            const without = { ...given }
            delete without[key]
            variants.push({ ...given, [key]: wrong(given[key]) }, without, { ...given, [key]: null }, { ...given, [key]: [given[key]] })
          }
          for (const deny of [[], ['Bash(cat *)', 'Read(locked/**)', 'Edit(locked/**)']]) for (const mode of ['default', 'implement', 'dontAsk', 'flow', 'apollo', 'sovereign']) {
            const context = contextFor(mode, deny)
            for (const input of variants) {
              const accepted = tool.inputSchema.safeParse(input).success
              const before = await decide(tool, input, context, basePorts)
              const now = await decide(tool, input, context)
              const row = `${tool.name} ${mode}${deny.length ? ' with deny rules' : ''} ${JSON.stringify(input).slice(0, 120)}: ${before.behavior} → ${now.behavior} (${now.note})`
              rows++
              if (accepted) {
                valid++
                if (before.behavior !== now.behavior || before.message !== now.message) validMoved.push(row)
                continue
              }
              if (rank[now.behavior] < rank[before.behavior]) weaker.push(row)
              if (rank[now.behavior] > rank[before.behavior]) stronger++
              if (now.note !== DEGRADED && now.note !== 'verdict: deny' && now.note !== 'verdict: ask') taken.push(row)
              if (mode === 'sovereign' && now.behavior === 'ask') sovereignAsks.add(tool.name)
            }
          }
        }
      }
      check(`every base tool was read through both ports (${tools.length} tools, ${rows} decisions)`, tools.length >= 40 && rows >= 4000 && valid >= 400, `${tools.length} tools, ${rows} rows, ${valid} valid`)
      check('an input the schema accepts is decided exactly as before', validMoved.length === 0, validMoved.slice(0, 5).join(' | '))
      check('no rejected input is decided more weakly than the parent decided it (no ask became an allow, no deny an ask or an allow)', weaker.length === 0, `${weaker.length} weaker: ${weaker.slice(0, 5).join(' | ')}`)
      check('a rejected input takes only a deny or an ask from the tool; anything else is the parse failure it was', taken.length === 0, `${taken.length}: ${taken.slice(0, 5).join(' | ')}`)
      check('the tool\'s deny and ask are what the fallback adds', stronger > 0, String(stronger))
      check('in Sovereign a rejected input is asked only by a tool whose own nature is to ask the operator', [...sovereignAsks].every(name => tools.find(tool => tool.name === name)?.requiresUserInteraction?.() === true), [...sovereignAsks].join(', '))
    })

    if (!existsSync(dist)) check('the built bundle exists', false, `${dist} is missing; build first`)
    else {
      const scene = async (tool: string, input: Record<string, unknown>, amended: Record<string, unknown> | undefined, args: string[] = [], deny: string[] = []) => {
        const paths = sceneRoot('rejected-input-road-')
        writeFileSync(join(paths.cwd, 'notes.txt'), 'NOTES-CONTENT\n')
        writeFileSync(join(paths.cwd, 'other.txt'), 'OTHER-CONTENT\n')
        const hooks: Record<string, Array<Record<string, unknown>>> = amended ? { 'tool.before': [{ name: 'amend', match: tool, run: say({ input: amended }) }] } : {}
        const result = await runDoor(paths, {
          turns: [{ kind: 'tool_use', name: tool, input, id: 'rejected_input_1' }, { kind: 'text', text: 'fixture answered' }, handoffTurn()],
          hooks,
          args,
          beforeRun: ({ home }) => writeFileSync(join(home, 'settings.json'), JSON.stringify({ events: { hooks }, ...(deny.length ? { guardrails: { deny } } : {}) })),
        })
        rmSync(paths.root, { recursive: true, force: true })
        const row = result.rows.find(r => r.type === 'tool_result')
        return { status: String(row?.status), output: String(row?.output ?? ''), seen: `${row?.status}: ${String(row?.output ?? result.stderr).slice(0, 240)}` }
      }
      const control = await scene('Bash', { command: 'echo ORIGINAL' }, { command: 'cat notes.txt' })
      check('built product: a hook\'s amended input the schema accepts runs', control.status === 'ok' && control.output.includes('NOTES-CONTENT'), control.seen)
      const bogus = await scene('Bash', { command: 'echo ORIGINAL' }, { command: 'cat notes.txt', bogus: 1 })
      check('built product: the same amended input with a key the schema rejects is not run; the unattended run reads the ask it cannot answer', bogus.status === 'error' && !bogus.output.includes('NOTES-CONTENT') && bogus.output.includes(createPermissionRequestMessage('Bash')) && bogus.output.includes('auto-denied'), bogus.seen)
      const reads = await scene('Read', { file_path: 'notes.txt' }, { file_path: 'other.txt', bogus: 1 })
      check('built product: an amended read with a rejected key is not read', reads.status === 'error' && !reads.output.includes('OTHER-CONTENT') && reads.output.includes(createPermissionRequestMessage('Read')), reads.seen)
      const ruled = await scene('Bash', { command: 'echo ORIGINAL' }, { command: 'cat notes.txt', bogus: 1 }, ['--mode', 'sovereign'], ['Bash(cat *)'])
      check('built product: in Sovereign a deny rule refuses the amended input the schema rejects', ruled.status === 'error' && !ruled.output.includes('NOTES-CONTENT') && ruled.output.includes('is denied by the rule Bash(cat *)'), ruled.seen)
      const free = await scene('Bash', { command: 'echo ORIGINAL' }, { command: 'cat notes.txt', bogus: 1 }, ['--mode', 'sovereign'])
      check('built product: in Sovereign with no rule it runs with no question, as before', free.status === 'ok' && free.output.includes('NOTES-CONTENT'), free.seen)
      for (const args of [[], ['--mode', 'sovereign']]) {
        const sent = await scene('Bash', { command: 'cat notes.txt', bogus: 1 }, undefined, args)
        check(`built product${args.length ? ', Sovereign' : ''}: a model's own rejected input is answered by validation before any decision`, sent.status === 'error' && sent.output.includes('The parameter `bogus` was not expected') && !sent.output.includes('NOTES-CONTENT'), sent.seen)
      }
    }
  } finally { process.chdir(startedIn); world.dispose() }
  console.log(`Rejected input keeps its ask: ${checks - failures}/${checks}`)
  process.exitCode = failures ? 1 : 0
}
