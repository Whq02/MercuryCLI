import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { getOriginalCwd } from '../bootstrap/state.js'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import { SERVER_CATALOGUE, probeCatalogueEntry } from '../services/lsp/serverCatalogue.js'
import { binaryName } from '../utils/config/derived.js'
import { whichSync } from '../utils/which.js'

export type LspCliIo = {
  out: (line: string) => void
  err: (line: string) => void
  interactive: boolean
  ask: (question: string) => Promise<boolean>
  run: (argv: string[]) => Promise<number | null>
}

const defaultIo: LspCliIo = {
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask: async question => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise<string>(resolveAnswer => rl.question(`${question} [y/N] `, resolveAnswer))
    rl.close()
    return /^y(es)?$/i.test(answer.trim())
  },
  run: argv =>
    new Promise(resolveCode => {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit', env: subprocessEnv(), windowsHide: true })
      child.on('error', () => resolveCode(null))
      child.on('exit', code => resolveCode(code))
    }),
}

type CatalogueRow = (typeof SERVER_CATALOGUE)[number]

export type InstallCommand = { kind: 'command'; argv: string[]; tool: string } | { kind: 'words'; words: string }

const INSTALL_TOOLS: ReadonlySet<string> = new Set(['rustup', 'go', 'brew', 'dotnet', 'gem', 'npm', 'ghcup', 'opam', 'cs', 'nix'])
const TRAILING_NOTE = /\s+\((?:[^()]|\([^()]*\))*\)\s*$/

function quotedWords(text: string): string[] | null {
  const words: string[] = []
  let word = ''
  let begun = false
  let quote: string | null = null
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      begun = true
    } else if (/\s/.test(char)) {
      if (begun) words.push(word)
      word = ''
      begun = false
    } else {
      word += char
      begun = true
    }
  }
  if (quote !== null) return null
  if (begun) words.push(word)
  return words
}

export function installCommandOf(remedy: string): InstallCommand {
  const argv = quotedWords(remedy.replace(TRAILING_NOTE, '').trim())
  const tool = argv?.[0] ?? ''
  if (argv === null || argv.length < 2 || !INSTALL_TOOLS.has(tool)) return { kind: 'words', words: remedy }
  return { kind: 'command', argv, tool }
}

export function catalogueRowNamed(name: string): CatalogueRow | null {
  const wanted = name.trim().toLowerCase()
  if (wanted === '') return null
  return SERVER_CATALOGUE.find(entry => entry.id.toLowerCase() === wanted) ?? SERVER_CATALOGUE.find(entry => entry.binaries.some(bin => bin.toLowerCase() === wanted)) ?? null
}

export function rosterLine(): string {
  return `Known servers: ${SERVER_CATALOGUE.map(entry => entry.id).join(', ')}`
}

export function lspListLines(cwd: string = getOriginalCwd()): string[] {
  const rows = SERVER_CATALOGUE.map(entry => ({ entry, probe: probeCatalogueEntry(entry, cwd) }))
  const width = Math.max(...rows.map(row => row.entry.id.length))
  const lines = rows.map(({ entry, probe }) => {
    const state = probe.binaryPath ? `installed  ${probe.binaryPath}${probe.binarySource === 'project-local' ? ' (project-local)' : ''}` : `absent     ${entry.remedy}`
    return `${entry.id.padEnd(width)}  ${state}  [${entry.languages.join(', ')}]`
  })
  const installed = rows.filter(row => row.probe.binaryPath).length
  lines.push('', `${installed} of ${rows.length} installed · install one with: ${binaryName()} lsp install <server> · a server is never installed on its own`)
  return lines
}

export async function lspListCli(io: LspCliIo = defaultIo): Promise<number> {
  for (const line of lspListLines()) io.out(line)
  return 0
}

export async function lspInstallCli(server: string, options: { yes: boolean }, io: LspCliIo = defaultIo): Promise<number> {
  const entry = catalogueRowNamed(server)
  if (entry === null) {
    io.err(`No language server named "${server}" in the catalogue. ${rosterLine()}`)
    return 2
  }
  const cwd = getOriginalCwd()
  const present = probeCatalogueEntry(entry, cwd)
  if (present.binaryPath) {
    io.out(`${entry.label} is already installed: ${present.binaryPath}${present.binarySource === 'project-local' ? ' (project-local)' : ''} — nothing to run`)
    return 0
  }
  const command = installCommandOf(entry.remedy)
  if (command.kind === 'words') {
    io.err(`${entry.label} has no install command to run: ${command.words}`)
    return 2
  }
  if (whichSync(command.tool) === null) {
    io.err(`The install remedy for ${entry.label} needs ${command.tool}, which is not on PATH: ${entry.remedy}`)
    return 2
  }
  io.out(`Install ${entry.label} (${entry.languages.join(', ')}) by running:`)
  io.out(`  ${command.argv.join(' ')}`)
  if (!options.yes) {
    if (!io.interactive) {
      io.err('Not a terminal: pass --yes to run the install command without the question')
      return 2
    }
    if (!(await io.ask('Run it?'))) {
      io.out('Nothing run.')
      return 1
    }
  }
  const code = await io.run(command.argv)
  if (code !== 0) {
    io.err(code === null ? `The install command could not be started: ${command.argv.join(' ')}` : `The install command exited ${code}; ${entry.label} was not installed`)
    return 1
  }
  const landed = probeCatalogueEntry(entry, cwd)
  if (!landed.binaryPath) {
    io.err(`The install command finished, but no ${entry.binaries.join(' or ')} is on PATH yet — open a new shell, or read the installer's output for where it put the binary`)
    return 1
  }
  io.out(`Installed ${entry.label}: ${landed.binaryPath}${landed.binarySource === 'project-local' ? ' (project-local)' : ''} — Mercury offers it in projects that carry ${entry.rootMarkers.length > 0 ? entry.rootMarkers.join(' or ') : 'its files'}`)
  return 0
}
