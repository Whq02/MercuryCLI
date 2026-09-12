import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { findGodotProjectRoot } from '../services/lsp/godotLane.js'
import { runningGodotProcesses } from '../services/vulcan/godotProcessCensus.js'
import { engineTreePath } from '../services/vulcan/engine/paths.js'
import { engineProcessesFor } from '../services/vulcan/engine/spawn.js'
import { endProcessTree } from '../utils/processGroup.js'

export const GODOT_CLI_VERBS = ['run', 'check', 'jobs', 'cancel', 'result', 'capture', 'frames', 'profile', 'tour'] as const

export type GodotCliVerb = (typeof GODOT_CLI_VERBS)[number]

export interface GodotCliParse {
  verb: string
  positional: string[]
  flags: Record<string, string | true>
}

const VALUE_FLAGS = new Set(['tree', 'priority', 'budget-ms', 'label', 'tail-chars', 'tail', 'parallel', 'project', 'wait-ms', 'threshold', 'max-lag', 'grid', 'request', 'run', 'source'])

export function parseGodotCliArgs(argv: readonly string[]): GodotCliParse {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  let verb = ''
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=')
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2)
      if (eq > 0) {
        flags[name] = a.slice(eq + 1)
      } else if (VALUE_FLAGS.has(name) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[name] = argv[++i]
      } else {
        flags[name] = true
      }
      continue
    }
    if (verb.length === 0) verb = a
    else positional.push(a)
  }
  return { verb, positional, flags }
}

export function godotCliUsage(cliName: string): string {
  return [
    `Usage: ${cliName} godot <verb> …  — the engine job service for the Godot project in the working directory (or --project <dir>)`,
    `  ${cliName} godot run [suite …] [--tree <HEAD|ref|working|ref+a,b>] [--native] [--capture] [--priority <verifier|fold-gate|lane-gate|profile>] [--budget-ms <n>] [--display-shared] [--keep-tree] [--label <s>] [--no-wait] [--tail-chars <n>]`,
    `  ${cliName} godot check [file …] [--all] [--tree <spec>] [--no-shaders] [--parallel <n>] [--run <id>]`,
    `  ${cliName} godot jobs`,
    `  ${cliName} godot cancel <id>`,
    `  ${cliName} godot result <id> [--tail <n>]`,
    `  ${cliName} godot capture [tour] [--request <json file>] [--tree <spec>] [--display] [--display-shared]`,
    `  ${cliName} godot profile [tour] [--source <engine|project|auto>] [--request <json file>] [--tree <spec>] [--display]`,
    `  ${cliName} godot tour <name> [--tree <spec>] [--request <json file>]`,
    `  ${cliName} godot frames diff <a.png> <b.png> [--threshold <0..255>]`,
    `  ${cliName} godot frames stats <frame.png> [--max-lag <n>] [--grid <columns>x<rows>]`,
    `  ${cliName} godot frames contact-sheet <id>`,
    'Each verb prints its record as JSON; run exits 0 on allPass, check on no diagnostics or proof drift, cancel and result on success, 2 on a usage or project error.',
  ].join('\n')
}

function num(v: string | true | undefined): number | undefined {
  if (typeof v !== 'string') return undefined
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

function parsed(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export interface GodotCliIo {
  out(line: string): void
  err(line: string): void
  cliName: string
}

const defaultIo: GodotCliIo = {
  out: line => process.stdout.write(line + '\n'),
  err: line => process.stderr.write(line + '\n'),
  cliName: 'mercury',
}

export async function godotEngineCli(argv: readonly string[], io: GodotCliIo = defaultIo): Promise<number> {
  const { verb, positional, flags } = parseGodotCliArgs(argv)
  if (verb.length === 0 || verb === 'help' || flags.help === true) {
    io.out(godotCliUsage(io.cliName))
    return verb.length === 0 || verb === 'help' ? 2 : 0
  }
  if (!(GODOT_CLI_VERBS as readonly string[]).includes(verb)) {
    io.err(`${io.cliName} godot: unknown verb "${verb}"`)
    io.err(godotCliUsage(io.cliName))
    return 2
  }
  if (flags.source !== undefined && (verb !== 'profile' || !['engine', 'project', 'auto'].includes(String(flags.source)))) {
    io.err('--source needs engine, project, or auto and is only supported by profile')
    return 2
  }
  const projectArg = typeof flags.project === 'string' ? path.resolve(flags.project) : undefined
  const root = findGodotProjectRoot(projectArg)
  if (!root) {
    io.err(`${io.cliName} godot: no project.godot at or above ${projectArg ?? process.cwd()} — run inside a Godot project or pass --project <dir>`)
    return 2
  }
  const { runEngineOp } = await import('../services/vulcan/engine/ops.js')
  switch (verb as GodotCliVerb) {
    case 'run': {
      const text = await runEngineOp(
        'engine_run',
        {
          suites: positional,
          tree: flags.tree,
          native: flags.native === true,
          capture: flags.capture === true,
          priority: flags.priority,
          budgetMs: num(flags['budget-ms']),
          displayShared: flags['display-shared'] === true,
          keepTree: flags['keep-tree'] === true,
          label: typeof flags.label === 'string' ? flags.label : undefined,
          wait: flags['no-wait'] !== true,
          waitMs: num(flags['wait-ms']),
          tailChars: num(flags['tail-chars']),
        },
        root,
      )
      io.out(text)
      const record = parsed(text)
      if (!record) return 2
      if (flags['no-wait'] === true) return 0
      return record.allPass === true ? 0 : 1
    }
    case 'check': {
      const text = await runEngineOp(
        'engine_check',
        {
          files: positional,
          all: flags.all === true,
          tree: flags.tree,
          shaders: flags['no-shaders'] === true ? false : undefined,
          parallel: num(flags.parallel),
          run: typeof flags.run === 'string' ? flags.run : undefined,
        },
        root,
      )
      io.out(text)
      const result = parsed(text)
      return result?.ok === true ? 0 : result ? 1 : 2
    }
    case 'capture':
    case 'profile':
    case 'tour': {
      try {
        let args: Record<string, unknown> = {}
        if (flags.request !== undefined) {
          if (typeof flags.request !== 'string') throw new Error('--request needs a JSON file path')
          const value = parsed(readFileSync(path.resolve(flags.request), 'utf8'))
          if (!value) throw new Error('--request must name a JSON object of operation arguments')
          args = value
        }
        if (positional[0]) args.tour = positional[0]
        if (verb === 'tour' && typeof args.tour !== 'string') throw new Error('tour needs the name of a registered tour')
        for (const name of ['tree', 'priority', 'label', 'source']) if (flags[name] !== undefined) args[name] = flags[name]
        if (flags['budget-ms'] !== undefined) {
          const budget = num(flags['budget-ms'])
          if (budget === undefined) throw new Error('--budget-ms needs a positive number')
          args.budgetMs = budget
        }
        if (flags.display === true) args.display = true
        if (flags['display-shared'] === true) args.displayShared = true
        if (flags['keep-tree'] === true) args.keepTree = true
        if (flags['no-wait'] || args.wait === false) throw new Error('capture, profile and tour wait for their worker; use the Godot tool for a queued job')
        args.wait = true
        const text = await runEngineOp(verb === 'profile' ? 'engine_profile' : 'engine_capture', args, root)
        io.out(text)
        const result = parsed(text)
        return result?.allPass === true ? 0 : result ? 1 : 2
      } catch (e) {
        io.err(`${io.cliName} godot ${verb}: ${(e as Error).message}`)
        return 2
      }
    }
    case 'frames': {
      const action = positional[0]
      const args: Record<string, unknown> = { action }
      if (action === 'diff') {
        args.a = positional[1]
        args.b = positional[2]
        if (flags.threshold !== undefined) args.threshold = typeof flags.threshold === 'string' ? Number(flags.threshold) : flags.threshold
      } else if (action === 'stats') {
        args.frame = positional[1]
        if (flags['max-lag'] !== undefined) args.maxLag = typeof flags['max-lag'] === 'string' ? Number(flags['max-lag']) : flags['max-lag']
        if (flags.grid !== undefined) args.grid = typeof flags.grid === 'string' ? flags.grid.split('x').map(Number) : flags.grid
      } else if (action === 'contact-sheet') {
        args.id = positional[1]
      }
      const text = await runEngineOp('engine_frames', args, root)
      io.out(text)
      const result = parsed(text)
      return result && !result.error ? 0 : 2
    }
    case 'jobs': {
      const text = await runEngineOp('engine_jobs', {}, root)
      const snapshot = parsed(text) ?? {}
      const alive = engineProcessesFor(root, await runningGodotProcesses()).map(p => ({ pid: p.pid, project: p.project, executable: p.executable }))
      io.out(JSON.stringify({ ...snapshot, enginesAliveUnderProject: alive, note: 'a queue lives in the session that started it; this process lists the runs on disk and the engines alive under the project' }, null, 2))
      return 0
    }
    case 'cancel': {
      const id = positional[0]
      if (!id) {
        io.err(`${io.cliName} godot cancel: an id is needed (${io.cliName} godot jobs lists the runs)`)
        return 2
      }
      const text = await runEngineOp('engine_cancel', { id }, root)
      const answer = parsed(text)
      if (answer && typeof answer.error !== 'string') {
        io.out(text)
        return 0
      }
      const tree = engineTreePath(root, id)
      const targets = engineProcessesFor(root, await runningGodotProcesses()).filter(p => p.project !== undefined && path.resolve(p.project) === path.resolve(tree))
      const receipts = []
      for (const p of targets) receipts.push({ pid: p.pid, receipt: await endProcessTree(p.pid, 'SIGKILL') })
      io.out(JSON.stringify({ id, engines: receipts, note: receipts.length > 0 ? 'ended by pid from the process census (the job belongs to another session)' : 'no engine of that job is alive on this machine' }, null, 2))
      return receipts.length > 0 ? 0 : 1
    }
    case 'result': {
      const id = positional[0]
      if (!id) {
        io.err(`${io.cliName} godot result: an id is needed (${io.cliName} godot jobs lists the runs)`)
        return 2
      }
      const text = await runEngineOp('engine_result', { id, tail: num(flags.tail) }, root)
      io.out(text)
      return parsed(text) ? 0 : 1
    }
  }
  return 2
}
