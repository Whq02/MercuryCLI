import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, delimiter, extname, isAbsolute, join, resolve } from 'node:path'
import { validateAgentIdentifier } from '../../../crew/agents/codec.js'
import { parseFrontmatter, type FrontmatterData } from '../../../platform/text/frontmatterParser.js'
import { bundledReleaseMissingFor } from '../bundled/index.js'
import {
  HOOK_EVENT_NAMES,
  type ExtensionManifest,
  type ManifestHook,
  type ManifestServer,
  parseExtensionId,
  resolveInsideRoot,
  serverRuntimeName,
} from '../manifest.js'
import { substituteRootAndData } from '../options.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'
import { isExecutableFile, isExecutablePath, pathExtensions } from '../../../platform/host-os/programs.js'


type ResolvedSkill = { name: string; skillName: string; dir: string; file: string; body: string; frontmatter: FrontmatterData }
type ResolvedCommand = { name: string; file: string; body: string; frontmatter: FrontmatterData }
export type ResolvedAgent = { agentType: string; file: string; body: string; frontmatter: FrontmatterData; ignoredFields: string[] }
type ResolvedHook = {
  event: string
  hook: ManifestHook
  commandLine: string
  scriptPath: string | null
}
type ResolvedServer = { key: string; runtimeName: string; config: ManifestServer; transport: 'stdio' | 'http' | 'sse' }
type ResolvedLanguage = { key: string; runtimeName: string; config: NonNullable<ExtensionManifest['contributes']>['language'] extends Record<string, infer T> | undefined ? T : never }
type ResolvedKeybinding = { chord: string; target: string; taken: boolean }

export type Resolution = {
  skills: ResolvedSkill[]
  commands: ResolvedCommand[]
  agents: ResolvedAgent[]
  hooks: ResolvedHook[]
  servers: ResolvedServer[]
  language: ResolvedLanguage[]
  keybindings: ResolvedKeybinding[]
  defects: string[]
  notes: string[]
}

export type Probes = {
  onPath: (binary: string) => boolean
  envSet: (name: string) => boolean
  chordTaken: (chord: string) => boolean
  optionSet: (key: string) => boolean
}


function isOnPath(binary: string): boolean {
  if (binary === '') return false
  if (binary.includes('/') || binary.includes('\\')) return existsSync(binary)
  const env = hostEnv()
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const exts = pathExtensions(env)
  for (const dir of dirs) {
    for (const ext of exts) {
      if (isExecutableFile(join(dir, binary + ext))) return true
    }
  }
  return false
}

function isEnvSet(name: string): boolean {
  const value = hostEnv()[name]
  return value !== undefined && value !== ''
}

export function realProbes(overrides: Partial<Probes> = {}): Probes {
  return {
    onPath: isOnPath,
    envSet: isEnvSet,
    chordTaken: () => false,
    optionSet: () => false,
    ...overrides,
  }
}


const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---/

const SKILL_NAME_HOSTILE = /[\x00-\x1f\x7f\s/\\:]/

function isLegalSkillName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false
  if (name.startsWith('.')) return false
  return !SKILL_NAME_HOSTILE.test(name)
}

type MarkdownRead =
  | { ok: true; body: string; frontmatter: FrontmatterData; parsed: boolean }
  | { ok: false; reason: string }

function readMarkdown(file: string): MarkdownRead {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const md = parseFrontmatter(raw, file)
  const block = FRONTMATTER_BLOCK.exec(raw)
  const parsed = md.parseError === undefined && !(block && block[1]!.trim() !== '' && Object.keys(md.frontmatter).length === 0)
  return { ok: true, body: md.content, frontmatter: md.frontmatter, parsed }
}

type DirListing =
  | { ok: true; entries: Array<{ name: string; isDir: boolean }> }
  | { ok: false; missing: true }
  | { ok: false; missing: false; reason: string }

function listDir(dir: string): DirListing {
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).map(entry => {
      let isDir = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        try {
          isDir = statSync(join(dir, entry.name)).isDirectory()
        } catch {
          isDir = false
        }
      }
      return { name: entry.name, isDir }
    })
    return { ok: true, entries }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, missing: true }
    return { ok: false, missing: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function isExecutable(path: string): boolean {
  return isExecutablePath(path)
}

const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'node', 'bun', 'python', 'python3', 'ruby', 'perl', 'pwsh', 'powershell', 'deno'])

function tokenise(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current) out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current) out.push(current)
  return out
}

function hookScriptPath(
  commandLine: string,
  root: string,
): { path: string; direct: boolean } | { escaped: string } | null {
  const tokens = tokenise(commandLine)
  const first = tokens[0]
  if (!first) return null
  const pathShaped = (token: string): boolean => isAbsolute(token) || token.startsWith('.')
  const inside = (token: string): string | null => {
    const abs = resolve(root, token)
    return resolveInsideRoot(root, abs) !== null ? abs : null
  }
  if (pathShaped(first)) {
    const direct = inside(first)
    return direct !== null ? { path: direct, direct: true } : { escaped: first }
  }
  if (INTERPRETERS.has(basename(first)) && tokens[1] && pathShaped(tokens[1])) {
    const script = inside(tokens[1])
    return script !== null ? { path: script, direct: false } : { escaped: tokens[1] }
  }
  return null
}


const SKILL_FILE = 'SKILL.md'

export function resolveContributions(
  manifest: ExtensionManifest,
  root: string,
  id: string,
  probes: Probes = realProbes(),
): Resolution {
  const name = manifest.name
  const c = manifest.contributes ?? {}
  const needs = manifest.needs ?? {}
  const defects: string[] = []
  const notes: string[] = []
  const result: Resolution = {
    skills: [],
    commands: [],
    agents: [],
    hooks: [],
    servers: [],
    language: [],
    keybindings: [],
    defects,
    notes,
  }
  const substitute = (text: string): string => substituteRootAndData(text, root, id)

  for (const dir of c.skills ?? []) {
    const abs = resolveInsideRoot(root, dir)
    if (abs === null) continue
    const listed = listDir(abs)
    if (!listed.ok) {
      defects.push(listed.missing ? `skills ${dir}: folder missing` : `skills ${dir}: folder unreadable: ${listed.reason}`)
      continue
    }
    let loaded = 0
    const own = existsSync(join(abs, SKILL_FILE)) ? [{ name: basename(abs), isDir: true, self: true }] : []
    const candidates = own.length > 0 ? own : listed.entries.filter(e => e.isDir).map(e => ({ ...e, self: false }))
    for (const entry of candidates) {
      const skillDir = entry.self ? abs : join(abs, entry.name)
      const file = join(skillDir, SKILL_FILE)
      if (!existsSync(file)) continue
      const md = readMarkdown(file)
      if (!md.ok) {
        defects.push(`skill ${dir}/${entry.name}/${SKILL_FILE}: file unreadable: ${md.reason} — skipped`)
        continue
      }
      if (!md.parsed) {
        defects.push(`skill ${dir}/${entry.name}/${SKILL_FILE}: frontmatter did not parse — skipped`)
        continue
      }
      const declaredName = typeof md.frontmatter['name'] === 'string' && md.frontmatter['name'].trim() ? md.frontmatter['name'].trim() : null
      if (declaredName !== null && !isLegalSkillName(declaredName)) {
        defects.push(`skill ${dir}/${entry.name}/${SKILL_FILE}: name in frontmatter is not a legal skill name — skipped`)
        continue
      }
      const skillName = declaredName ?? entry.name
      result.skills.push({ name: `${name}:${skillName}`, skillName, dir: skillDir, file, body: md.body, frontmatter: md.frontmatter })
      loaded++
    }
    if (loaded === 0) defects.push(`skills ${dir}: no skill found (a skill is a folder holding ${SKILL_FILE})`)
  }

  for (const dir of c.commands ?? []) {
    const abs = resolveInsideRoot(root, dir)
    if (abs === null) continue
    const listed = listDir(abs)
    if (!listed.ok) {
      defects.push(listed.missing ? `commands ${dir}: folder missing` : `commands ${dir}: folder unreadable: ${listed.reason}`)
      continue
    }
    let loaded = 0
    const holdsMarkdownAnywhere = (folder: string, namespace: string[]): boolean => {
      const sub = listDir(folder)
      if (!sub.ok) {
        if (!sub.missing) defects.push(`command ${dir}/${namespace.join('/')}: folder unreadable: ${sub.reason}`)
        return false
      }
      for (const item of sub.entries) {
        if (item.isDir) {
          if (holdsMarkdownAnywhere(join(folder, item.name), [...namespace, item.name])) return true
        } else if (extname(item.name).toLowerCase() === '.md') {
          return true
        }
      }
      return false
    }
    const visit = (folder: string, namespace: string[], depth: number): void => {
      const sub = listDir(folder)
      if (!sub.ok) {
        if (!sub.missing) defects.push(`command ${dir}/${namespace.join('/')}: folder unreadable: ${sub.reason}`)
        return
      }
      for (const item of sub.entries) {
        if (item.isDir) {
          if (depth === 0) {
            visit(join(folder, item.name), [...namespace, item.name], 1)
          } else if (holdsMarkdownAnywhere(join(folder, item.name), [...namespace, item.name])) {
            defects.push(
              `command ${dir}/${[...namespace, item.name].join('/')}: nested deeper than one level — its .md files are not loaded (the commands namespace is one folder deep)`,
            )
          }
          continue
        }
        if (extname(item.name).toLowerCase() !== '.md') continue
        const file = join(folder, item.name)
        const md = readMarkdown(file)
        if (!md.ok) {
          defects.push(`command ${dir}/${[...namespace, item.name].join('/')}: file unreadable: ${md.reason} — skipped`)
          continue
        }
        if (!md.parsed) {
          defects.push(`command ${dir}/${[...namespace, item.name].join('/')}: frontmatter did not parse — skipped`)
          continue
        }
        const commandName = [name, ...namespace, item.name.replace(/\.md$/i, '')].join(':')
        result.commands.push({ name: commandName, file, body: md.body, frontmatter: md.frontmatter })
        loaded++
      }
    }
    visit(abs, [], 0)
    if (loaded === 0) defects.push(`commands ${dir}: no command found (a command is a <cmd>.md prompt file)`)
  }

  const PRIVILEGED = ['permissionMode', 'hooks', 'mcpServers', 'servers'] as const
  for (const dir of c.agents ?? []) {
    const abs = resolveInsideRoot(root, dir)
    if (abs === null) continue
    const listed = listDir(abs)
    if (!listed.ok) {
      defects.push(listed.missing ? `agents ${dir}: folder missing` : `agents ${dir}: folder unreadable: ${listed.reason}`)
      continue
    }
    let loaded = 0
    for (const entry of listed.entries) {
      if (entry.isDir || extname(entry.name).toLowerCase() !== '.md') continue
      const file = join(abs, entry.name)
      const md = readMarkdown(file)
      if (!md.ok) {
        defects.push(`agent ${dir}/${entry.name}: file unreadable: ${md.reason} — skipped`)
        continue
      }
      if (!md.parsed) {
        defects.push(`agent ${dir}/${entry.name}: frontmatter did not parse — skipped`)
        continue
      }
      const base = typeof md.frontmatter['name'] === 'string' && md.frontmatter['name'].trim() ? md.frontmatter['name'].trim() : entry.name.replace(/\.md$/i, '')
      if (validateAgentIdentifier(base) !== null) {
        defects.push(`agent ${dir}/${entry.name}: name is not a legal agent identifier — skipped`)
        continue
      }
      const ignored = PRIVILEGED.filter(field => md.frontmatter[field] !== undefined && md.frontmatter[field] !== null)
      const agentType = `${name}:${base}`
      for (const field of ignored) notes.push(`agent ${base}: ${field} field ignored`)
      result.agents.push({ agentType, file, body: md.body, frontmatter: md.frontmatter, ignoredFields: [...ignored] })
      loaded++
    }
    if (loaded === 0) defects.push(`agents ${dir}: no agent found (an agent is an <agent>.md definition)`)
  }

  for (const [event, entries] of Object.entries(c.hooks ?? {})) {
    if (!HOOK_EVENT_NAMES.has(event)) {
      defects.push(`hook ${event}: not a hook event Mercury fires — skipped`)
      continue
    }
    for (const hook of entries) {
      const commandLine = substitute(hook.run)
      const script = hookScriptPath(commandLine, root)
      if (script !== null && 'escaped' in script) {
        defects.push(`hook ${event}: script ${script.escaped} escapes the extension root — skipped`)
        continue
      }
      let scriptPath: string | null = null
      if (script) {
        scriptPath = script.path
        if (!existsSync(script.path)) {
          defects.push(`hook ${basename(script.path)}: file missing (${event})`)
          continue
        }
        if (script.direct && !isExecutable(script.path)) {
          defects.push(`hook ${basename(script.path)}: not executable (${event}) — chmod +x fixes it`)
          continue
        }
      }
      result.hooks.push({ event, hook, commandLine, scriptPath })
    }
  }

  for (const [key, config] of Object.entries(c.servers ?? {})) {
    const transport = ('type' in config && config.type ? config.type : 'stdio') as 'stdio' | 'http' | 'sse'
    const runtimeName = serverRuntimeName(name, key)
    if (transport === 'stdio') {
      const declaredCommand = (config as { command: string }).command
      const command = declaredCommand === '${MERCURY_NODE}' ? process.execPath : substitute(declaredCommand)
      const isPath = command.includes('/') || command.includes('\\')
      if (isPath ? !existsSync(command) : !probes.onPath(command)) {
        defects.push(`server ${key}: ${command} not on PATH`)
        continue
      }
      const missing = parseExtensionId(id)?.label === 'mercury' ? bundledReleaseMissingFor(root, name) : null
      if (missing !== null) {
        defects.push(`server ${key}: no release for ${missing}`)
        continue
      }
    }
    result.servers.push({ key, runtimeName, config, transport })
  }
  for (const [key, config] of Object.entries(c.language ?? {})) {
    const command = substitute(config.command)
    const isPath = command.includes('/') || command.includes('\\')
    if (isPath ? !existsSync(command) : !probes.onPath(command)) {
      defects.push(`language ${key}: ${command} not on PATH`)
      continue
    }
    result.language.push({ key, runtimeName: serverRuntimeName(name, key), config })
  }

  for (const binary of needs.binaries ?? []) {
    if (!probes.onPath(binary)) defects.push(`${binary} not on PATH`)
  }
  for (const env of needs.env ?? []) {
    if (!probes.envSet(env)) defects.push(`${env} unset`)
  }
  for (const [key, option] of Object.entries(needs.options ?? {})) {
    if (option.required && option.default === undefined && !probes.optionSet(key)) defects.push(`option ${key} not set — o edits`)
  }

  const ownTargets = new Set<string>([...result.skills.map(s => `/${s.name}`), ...result.commands.map(cmd => `/${cmd.name}`)])
  for (const [chord, target] of Object.entries(c.keybindings ?? {})) {
    if (!target.startsWith(`/${name}:`)) {
      defects.push(`keybinding ${chord}: ${target} is not this extension's command`)
      continue
    }
    if (!ownTargets.has(target)) {
      defects.push(`keybinding ${chord}: ${target} is not declared by this extension`)
      continue
    }
    const taken = probes.chordTaken(chord)
    if (taken) notes.push(`keybinding ${chord}: already bound — left alone`)
    result.keybindings.push({ chord, target, taken })
  }

  return result
}
