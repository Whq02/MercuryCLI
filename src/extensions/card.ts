// ============================================================================
//  src/extensions/card.ts — the approval card's CONTENT, as lines. Every
//  line derives from the fetched manifest (never the catalogue): what runs
//  on your machine, what reaches the model, what it needs, the version and
//  the hash. The CLI prints these; the board paints the same facts on its
//  chassis. A DIFF card marks each line added / removed / changed.
// ============================================================================
import { basename } from 'node:path'
import type { Resolution } from './load/contributions.js'
import { contributionsHash, shortHash, type ExtensionManifest } from './manifest.js'
import { realProbes, resolveContributions } from './load/contributions.js'

export type CardKind = 'install' | 'update' | 'project folder' | 'session' | 'bundled'

export type CardInput = {
  manifest: ExtensionManifest
  root: string
  resolution?: Resolution
  kind: CardKind
  from: { label: string; where: string | null; commit?: string | null }
  previous?: { manifest: ExtensionManifest; root: string; version: string } | null
  optionSet?: (key: string) => boolean
}

const ROOT_PLACEHOLDER = '<root>'

function short(commandLine: string, root: string): string {
  return commandLine.split(root).join(ROOT_PLACEHOLDER)
}

type Line = { text: string; mark?: '+' | '−' | '~' }

function runsLines(manifest: ExtensionManifest, root: string, resolution: Resolution): Line[] {
  const lines: Line[] = []
  const c = manifest.contributes ?? {}
  for (const [event, matchers] of Object.entries(c.hooks ?? {})) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        const resolved = resolution.hooks.find(h => h.event === event && h.hook === hook)
        const command = resolved ? short(resolved.commandLine, root) : hook.command.split('${MERCURY_EXTENSION_ROOT}').join(ROOT_PLACEHOLDER)
        lines.push({ text: `hook      ${event}${matcher.matcher ? `  ${matcher.matcher}` : ''}  →  ${command}${hook.timeout ? `  (${hook.timeout}s)` : ''}` })
      }
    }
  }
  for (const [key, server] of Object.entries(c.servers ?? {})) {
    if ('command' in server) {
      const args = (server.args ?? []).join(' ')
      lines.push({ text: `server    ${key}  →  ${short(`${server.command}${args ? ` ${args}` : ''}`.split('${MERCURY_EXTENSION_ROOT}').join(ROOT_PLACEHOLDER), root)}` })
    } else {
      lines.push({ text: `server    ${key}  →  ${server.type} ${server.url}` })
    }
  }
  for (const [key, language] of Object.entries(c.language ?? {})) {
    const args = (language.args ?? []).join(' ')
    lines.push({ text: `language  ${key}  →  ${language.command}${args ? ` ${args}` : ''}  ·  ${Object.keys(language.extensionToLanguage).join(' ')}` })
  }
  return lines
}

function reachLines(manifest: ExtensionManifest, resolution: Resolution): Line[] {
  const lines: Line[] = []
  const c = manifest.contributes ?? {}
  const skills = [...resolution.skills.map(s => `/${s.name}`), ...resolution.commands.map(cmd => `/${cmd.name}`)]
  if (skills.length > 0) lines.push({ text: `skills    ${skills.join(' · ')}` })
  if (resolution.agents.length > 0) lines.push({ text: `agents    ${resolution.agents.map(a => a.agentType).join(' · ')}` })
  for (const key of Object.keys(c.servers ?? {})) {
    lines.push({ text: `tools     the ${key} server's tools, asking by your permission mode like any MCP tool` })
  }
  for (const channel of c.channels ?? []) {
    lines.push({ text: `channel   ${channel.label} may post into your session (server ${channel.server})` })
  }
  for (const [chord, target] of Object.entries(c.keybindings ?? {})) {
    lines.push({ text: `key       ${chord}  →  ${target} (only when the chord is free)` })
  }
  return lines
}

function needsLines(manifest: ExtensionManifest, resolution: Resolution, optionSet: (key: string) => boolean): Line[] {
  const lines: Line[] = []
  const needs = manifest.needs ?? {}
  const probes = realProbes()
  if (needs.binaries?.length) lines.push({ text: `binaries  ${needs.binaries.map(b => `${b} ${probes.onPath(b) ? '✓' : '✕ not on PATH'}`).join(' · ')}` })
  if (needs.env?.length) lines.push({ text: `env       ${needs.env.map(e => `${e} ${probes.envSet(e) ? '✓ set' : '✕ unset'}`).join(' · ')}` })
  if (needs.network?.length) lines.push({ text: `network   ${needs.network.join(' · ')}` })
  for (const [key, option] of Object.entries(needs.options ?? {})) {
    lines.push({ text: `option    ${key}${option.sensitive ? ' (sensitive)' : ''}${option.required ? ' required' : ''} ${optionSet(key) ? '✓ set' : '· unset'}` })
  }
  void resolution
  return lines
}

function diff(previous: Line[], next: Line[]): Line[] {
  const before = new Set(previous.map(l => l.text))
  const after = new Set(next.map(l => l.text))
  const out: Line[] = []
  for (const line of next) out.push(before.has(line.text) ? line : { ...line, mark: '+' })
  for (const line of previous) if (!after.has(line.text)) out.push({ ...line, mark: '−' })
  return out
}

function render(lines: Line[], indent: string): string[] {
  return lines.map(l => `${indent}${l.mark ? l.mark : ' '} ${l.text}`)
}

/** The card as plain lines, section by section (03 §2.2). */
export function approvalCardLines(input: CardInput): string[] {
  const manifest = input.manifest
  const resolution = input.resolution ?? resolveContributions(manifest, input.root, `${manifest.name}@${input.from.label}`, realProbes({ optionSet: input.optionSet ?? (() => false) }))
  const optionSet = input.optionSet ?? (() => false)
  const out: string[] = []
  const title = input.kind === 'update' && input.previous ? `approve ${manifest.name} ${input.previous.version} → ${manifest.version}` : `approve ${manifest.name} ${manifest.version}`
  out.push(`${title}  (${input.kind})`)
  out.push(`from      ${input.from.label}${input.from.where ? ` · ${input.from.where}` : ''}${input.from.commit ? ` · commit ${input.from.commit.slice(0, 7)}` : ''}`)
  if (manifest.description) out.push(`about     ${manifest.description}`)

  let runs = runsLines(manifest, input.root, resolution)
  let reach = reachLines(manifest, resolution)
  let needs = needsLines(manifest, resolution, optionSet)
  if (input.kind === 'update' && input.previous) {
    const prevResolution = resolveContributions(input.previous.manifest, input.previous.root, `${manifest.name}@${input.from.label}`, realProbes({ optionSet }))
    const prevRuns = runsLines(input.previous.manifest, input.previous.root, prevResolution)
    const prevReach = reachLines(input.previous.manifest, prevResolution)
    const prevNeeds = needsLines(input.previous.manifest, prevResolution, optionSet)
    const changes: string[] = []
    const count = (lines: Line[], word: string): void => {
      const added = lines.filter(l => l.mark === '+').length
      const removed = lines.filter(l => l.mark === '−').length
      if (added || removed) changes.push(`${added ? `+${added}` : ''}${added && removed ? '/' : ''}${removed ? `−${removed}` : ''} ${word}`)
      else changes.push(`${word} unchanged`)
    }
    runs = diff(prevRuns, runs)
    reach = diff(prevReach, reach)
    needs = diff(prevNeeds, needs)
    count(runs, 'runs')
    count(reach, 'reaches')
    count(needs, 'needs')
    out.push(`changes   ${changes.join(' · ')}`)
  }

  out.push('')
  out.push('runs on your machine')
  out.push(...(runs.length > 0 ? render(runs, '  ') : ['    nothing — no hooks, servers or language servers']))
  out.push('')
  out.push('reaches the model')
  out.push(...(reach.length > 0 ? render(reach, '  ') : ['    nothing — no skills, commands, agents, tools or channels']))
  out.push('')
  out.push('needs')
  out.push(...(needs.length > 0 ? render(needs, '  ') : ['    nothing']))
  out.push('')
  out.push(`version   ${manifest.version} · contributions ${shortHash(contributionsHash(manifest, input.root))}`)
  out.push('nothing above runs until you approve')
  return out
}

export function extensionRootLabel(root: string): string {
  return basename(root)
}
