import { registerBundledSkill } from '../bundledSkills.js'
import { bundledDocPages } from './mercuryDocsPages.js' with { type: 'macro' }

export const MERCURY_DOCS_SKILL_NAME = 'mercury-docs'
export const MERCURY_DOCS_SITE = 'https://mercury-cli.ai/'
export const MERCURY_DOCS_MAP_URL = 'https://mercury-cli.ai/llms.txt'

const SUMMARY_CHARS = 190
const SHORT_PARAGRAPH = 60
const GENERIC_INTRO_CMDS = new Set([
  '/health',
  'mercury health',
  '/config',
  '/model',
  '/effort',
  '/permissions',
  '/memory',
  '/logins',
  '/accounts',
  '/usage',
  '/clear',
  '/exit',
  'mercury run',
  'mercury runner',
])

const PAGES: Readonly<Record<string, string>> = Object.freeze(bundledDocPages())

export function mercuryDocPages(): Readonly<Record<string, string>> {
  return PAGES
}

export function describeDocPage(text: string): { title: string; summary: string } {
  const lines = text.split('\n')
  const heading = lines.find(line => line.startsWith('# '))
  const title = heading ? heading.slice(2).trim() : ''
  const answersMatch = /<!--\s*answers:\s*([\s\S]*?)-->/i.exec(text)
  if (answersMatch?.[1]?.trim()) {
    return { title, summary: answersMatch[1].trim().replace(/\s+/g, ' ') }
  }
  const start = heading ? lines.indexOf(heading) + 1 : 0
  const firstH2 = lines.findIndex((line, index) => index >= start && line.startsWith('## '))
  const introEnd = firstH2 === -1 ? lines.length : firstH2
  const paragraphs: string[] = []
  let paragraph: string[] = []
  for (const line of [...lines.slice(start, introEnd), '']) {
    const trimmed = line.trim()
    if (trimmed !== '' && !/^(#|[-*] |\d+\. |\||!\[|```|<|---)/.test(line.trimStart())) {
      paragraph.push(trimmed)
      continue
    }
    if (paragraph.length > 0) {
      paragraphs.push(paragraph.join(' '))
      paragraph = []
    }
  }
  const firstPara = paragraphs[0] ?? ''
  const chosen =
    (/in the README|^Measured in\b/.test(firstPara) &&
      paragraphs.find((p, i) => i > 0 && /^(?:This (?:page|guide)|The question was)\b/i.test(p))) ||
    paragraphs.find(p => p.length >= SHORT_PARAGRAPH) ||
    firstPara
  const cleaned = chosen
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s*\([^)]{28,}\)/g, '')
    .replace(/\s+the way the `[^`]+` tool drives a running [A-Za-z]+ editor/g, '')
    .replace(
      /Run `\/llmhost` in the foreground chat\.\s*Its popup opens on Which model\?, which lists the supported models and where each one can run right now:/g,
      '`/llmhost` lists where each model can run:',
    )
  const sentences = cleaned
    .split(/(?<=[.?!])\s+(?=[A-Z`"'(])/)
    .map(s => s.trim())
    .filter(Boolean)
  let summary = sentences[0] ?? cleaned
  if (summary.length < SHORT_PARAGRAPH && sentences[1]) {
    summary = `${summary} ${sentences[1]}`
  }
  if (summary.length > SUMMARY_CHARS) {
    const cut = summary.slice(0, SUMMARY_CHARS)
    const clauseCut = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf(', and '))
    const spaceCut = Math.max(cut.lastIndexOf(' '), SUMMARY_CHARS - 30)
    const cutAt = clauseCut >= 110 ? clauseCut : spaceCut
    summary = `${cut.slice(0, cutAt).trimEnd().replace(/[,;:]$/, '')}…`
  }
  const h2s = lines.filter(line => line.startsWith('## ')).join('\n')
  const introBlock = lines.slice(start, introEnd).join('\n').replace(/\s+/g, ' ')
  const proseLines = lines
    .filter(line => !line.trimStart().startsWith('- ['))
    .join('\n')
    .replace(/\s+/g, ' ')
  const sigCandidates: string[] = []
  const seen = new Set<string>()
  const addCandidate = (tok: string): void => {
    if (!tok || seen.has(tok)) return
    seen.add(tok)
    if (!summary.includes(tok)) sigCandidates.push(tok)
  }
  const pageStem = title.toLowerCase()
  for (const match of proseLines.matchAll(
    /`(\/(?:restart|samples|mcp|skills|concourse|sessions|saturn|loop|voice|advise|submodels|hooks|extensions|lsp|localsetup|llmhost|realms|bug))(?:\s+[^`]*)?`/g,
  )) {
    const tok = match[1]!
    const stem = tok.slice(1)
    if (
      pageStem.includes(stem) ||
      (tok === '/advise' && pageStem.includes('advisor')) ||
      (tok === '/submodels' && pageStem.includes('advisor')) ||
      (tok === '/restart' && pageStem.includes('runtime')) ||
      ((tok === '/mcp' || tok === '/skills') && pageStem.includes('mcp')) ||
      ((tok === '/concourse' || tok === '/sessions') && pageStem.includes('session')) ||
      (tok === '/loop' && pageStem.includes('schedule')) ||
      (tok === '/lsp' && pageStem.includes('language'))
    ) {
      addCandidate(tok)
    }
  }
  for (const src of [title, introBlock, h2s]) {
    for (const match of src.matchAll(
      /`(\/[a-z][a-z0-9-]*|mercury\s+(?:run|runner|host|update|install|health|auth|models|mcp|extensions|roster|usage|daemon|sessions|lsp|acp|bridge|godot)|(?:Ast|Lsp)[A-Z][A-Za-z]+|ChangeSet)(?:\s+[^`]*)?`/g,
    )) {
      const tok = match[1]!.replace(/\s+/g, ' ')
      if (tok === '/name' || tok === '/something') continue
      const stem = tok.replace(/^\/|^mercury\s+/, '').toLowerCase()
      if (src !== title && GENERIC_INTRO_CMDS.has(tok) && !pageStem.includes(stem)) continue
      addCandidate(tok)
    }
    for (const match of src.matchAll(/\b(AstSearch|AstEdit|ChangeSet)\b/g)) {
      addCandidate(match[1]!)
    }
  }
  const titleWords = [...title.toLowerCase().matchAll(/[a-z0-9]{4,}/g)]
    .map(m => m[0])
    .filter(w => w !== 'mercury')
  const summaryLower = summary.toLowerCase()
  if (sigCandidates.length === 0 && !titleWords.some(w => summaryLower.includes(w))) {
    for (const match of proseLines.matchAll(
      /`(\/[a-z][a-z0-9-]*|mercury\s+(?:run|runner|host|update|install|health|auth|models|mcp|extensions|roster|usage|daemon|sessions|lsp|acp|bridge|godot))(?:\s+[^`]*)?`/g,
    )) {
      const tok = match[1]!.replace(/\s+/g, ' ')
      if (tok !== '/name' && tok !== '/something') addCandidate(tok)
    }
  }
  if (sigCandidates.length > 0) {
    const tags = sigCandidates.slice(0, 3).map(t => `\`${t}\``).join(', ')
    summary = `${summary.replace(/\.$/, '')} (${tags}).`
  }
  return { title, summary }
}

export function mercuryDocsMap(pages: Readonly<Record<string, string>> = mercuryDocPages()): string {
  return Object.keys(pages)
    .sort((a, b) => (a === 'README.md' ? -1 : b === 'README.md' ? 1 : a.localeCompare(b)))
    .map(path => {
      const { title, summary } = describeDocPage(pages[path]!)
      return `- ${path}${title ? ` — ${title}` : ''}${summary ? `: ${summary}` : ''}`
    })
    .join('\n')
}

const GUIDANCE = `Answer the question from Mercury's own documentation under the base directory above: README.md (install, updates, provider sign-ins, headless \`mercury run\`/\`runner\`/CLI verbs, and the slash-command table) and docs/*.md, one guide per surface. Pick the page from the map below. When the map does not settle it, or the page is long, Grep across the folder first, then read it with the Read tool, only the lines the match points at. State the exact command, setting, flag, skill, tool or screen the page names in a few plain sentences, with a short example when one helps, and name the page path. The same docs publish at ${MERCURY_DOCS_SITE} (map: ${MERCURY_DOCS_MAP_URL}); fetch there only if the local pages leave the question open, and fetch no other site. If the documentation does not cover the question, say so and name the nearest page instead of guessing.`

export function mercuryDocsPrompt(question: string): string {
  const parts = [GUIDANCE, `## The pages\n${mercuryDocsMap()}`]
  if (question.trim()) parts.push(`## The question\n${question.trim()}`)
  return parts.join('\n\n')
}

export function registerMercuryDocsSkill(): void {
  registerBundledSkill({
    name: MERCURY_DOCS_SKILL_NAME,
    description:
      'Use when the user asks how to use Mercury itself (commands, scheduling, providers, hosting, headless runs, voice, restart): answered from the documentation that ships with this install, never from memory, even when a skill that does the thing exists.',
    argumentHint: '<question about using Mercury>',
    allowedTools: ['Read', 'Grep', 'Glob'],
    files: { ...mercuryDocPages() },
    getPromptForCommand: async args => [{ type: 'text', text: mercuryDocsPrompt(args) }],
  })
}
