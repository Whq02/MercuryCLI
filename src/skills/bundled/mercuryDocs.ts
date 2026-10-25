import { registerBundledSkill } from '../bundledSkills.js'
import { bundledDocPages } from './mercuryDocsPages.js' with { type: 'macro' }

export const MERCURY_DOCS_SKILL_NAME = 'mercury-docs'
export const MERCURY_DOCS_SITE = 'https://mercury-cli.ai/'
export const MERCURY_DOCS_MAP_URL = 'https://mercury-cli.ai/llms.txt'

const SUMMARY_CHARS = 180
const SHORT_PARAGRAPH = 60
const NOT_ABOUT_THE_PAGE = /\bin the README\b|^Measured in\b/
const SENTENCE_BREAK = /(?<=[.?!])(?<!\b(?:e\.g|i\.e|vs)\.)\s+(?=[A-Z`"'(])/

const occurrences = (text: string, mark: string): number => text.split(mark).length - 1
const balanced = (text: string): boolean => occurrences(text, '`') % 2 === 0 && occurrences(text, '(') <= occurrences(text, ')')

function clip(text: string): string {
  if (text.length <= SUMMARY_CHARS) return text
  const space = text.lastIndexOf(' ', SUMMARY_CHARS)
  let cut = text.slice(0, space > 0 ? space : SUMMARY_CHARS)
  while (!balanced(cut)) cut = cut.slice(0, occurrences(cut, '`') % 2 === 1 ? cut.lastIndexOf('`') : cut.lastIndexOf('('))
  return `${cut.replace(/[\s,;:(]+$/, '')}…`
}

const PAGES: Readonly<Record<string, string>> = Object.freeze(bundledDocPages())

export function mercuryDocPages(): Readonly<Record<string, string>> {
  return PAGES
}

function htmlHeadingTitle(lines: readonly string[], start: number): string {
  const end = lines.findIndex((line, index) => index >= start && /<\/h1>/i.test(line))
  const heading = lines.slice(start, end === -1 ? start + 1 : end + 1).join(' ')
  const alt = /<img\b[^>]*\balt="([^"]*)"/i.exec(heading)?.[1]
  return (alt ?? heading.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

export function describeDocPage(text: string): { title: string; summary: string } {
  const lines = text.split('\n')
  const h1 = lines.findIndex(line => line.startsWith('# ') || /^<h1[\s>]/i.test(line))
  const title = h1 === -1 ? '' : lines[h1]!.startsWith('# ') ? lines[h1]!.slice(2).trim() : htmlHeadingTitle(lines, h1)
  const h2 = lines.findIndex((line, index) => index > h1 && line.startsWith('## '))
  const opening = lines.slice(0, h2 === -1 ? undefined : h2)
  const answers = /<!--\s*answers:\s*([\s\S]*?)-->/i.exec(opening.join('\n'))?.[1]?.trim()
  if (answers) return { title, summary: answers.replace(/\s+/g, ' ') }
  const paragraphs: string[] = []
  let current: string[] = []
  let fenced = false
  for (const line of [...opening.slice(h1 + 1), '']) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) fenced = !fenced
    if (!fenced && trimmed !== '' && !/^(#|[-*] |\d+\. |\||!\[|```|<|---)/.test(trimmed)) {
      current.push(trimmed)
      continue
    }
    if (current.length > 0) paragraphs.push(current.join(' '))
    current = []
  }
  const prose = paragraphs.filter(paragraph => paragraph.length >= SHORT_PARAGRAPH)
  const chosen = (prose.find(paragraph => !NOT_ABOUT_THE_PAGE.test(paragraph)) ?? prose[0] ?? paragraphs[0] ?? '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  const [first = '', second] = chosen.split(SENTENCE_BREAK)
  return { title, summary: clip(first.length < SHORT_PARAGRAPH && second ? `${first} ${second}` : first) }
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

const GUIDANCE = `Answer the question from Mercury's own documentation under the base directory above: README.md (install, what is inside, the slash-command table, reporting a problem, and licence) and docs/*.md, one guide per surface. Pick the page from the map below. When the map does not settle it, or the page is long, Grep across the folder first, then read it with the Read tool, only the lines the match points at. State the exact command, setting, flag, skill, tool or screen the page names in a few plain sentences, with a short example when one helps, and name the page path. The same docs publish at ${MERCURY_DOCS_SITE} (map: ${MERCURY_DOCS_MAP_URL}); fetch there only if the local pages leave the question open, and fetch no other site. If the documentation does not cover the question, say so and name the nearest page instead of guessing.`

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
