import { registerBundledSkill } from '../bundledSkills.js'
import { bundledDocPages } from './mercuryDocsPages.js' with { type: 'macro' }

export const MERCURY_DOCS_SKILL_NAME = 'mercury-docs'
export const MERCURY_DOCS_SITE = 'https://mercury-cli.ai/'
export const MERCURY_DOCS_MAP_URL = 'https://mercury-cli.ai/llms.txt'

const SUMMARY_CHARS = 180
const SHORT_PARAGRAPH = 60

const PAGES: Readonly<Record<string, string>> = Object.freeze(bundledDocPages())

export function mercuryDocPages(): Readonly<Record<string, string>> {
  return PAGES
}

export function describeDocPage(text: string): { title: string; summary: string } {
  const lines = text.split('\n')
  const heading = lines.find(line => line.startsWith('# '))
  const title = heading ? heading.slice(2).trim() : ''
  const start = heading ? lines.indexOf(heading) + 1 : 0
  let summary = ''
  let paragraph: string[] = []
  for (const line of [...lines.slice(start), '']) {
    if (line.trim() !== '' && !/^(#|[-*] |\d+\. |\||!\[|```|<)/.test(line.trimStart())) {
      paragraph.push(line.trim())
      continue
    }
    const joined = paragraph.join(' ')
    paragraph = []
    if (joined.length >= SHORT_PARAGRAPH) {
      summary = joined
      break
    }
  }
  if (summary.length > SUMMARY_CHARS) {
    const cut = summary.slice(0, SUMMARY_CHARS)
    summary = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), SUMMARY_CHARS - 30)).trimEnd()}…`
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

const GUIDANCE = `Answer the question from Mercury's own documentation. It ships with this install and stands extracted under the base directory above: README.md (what Mercury is, the install, the daily loop, providers and models, the headless verbs and the slash-command table) and docs/*.md, one page per surface. Pick the page from the map below, read it with the Read tool (Grep across the folder when the map does not settle it), and answer from what the page says — the exact command, setting, flag, skill, tool or screen it names — in a few plain sentences, with a short example where one helps, naming the page you drew from. The same pages are published at ${MERCURY_DOCS_SITE} with ${MERCURY_DOCS_MAP_URL} as their map; fetch there only when the local pages leave the question open, and fetch no other site. When the documentation does not cover the question, say so and name the nearest page instead of guessing. Mercury is the harness; describe it in its own terms.`

export function mercuryDocsPrompt(question: string): string {
  const parts = [GUIDANCE, `## The pages\n${mercuryDocsMap()}`]
  if (question.trim()) parts.push(`## The question\n${question.trim()}`)
  return parts.join('\n\n')
}

export function registerMercuryDocsSkill(): void {
  registerBundledSkill({
    name: MERCURY_DOCS_SKILL_NAME,
    description:
      'Use when the user asks how to use Mercury itself — a command, a setting, a flag, a mode, agents, sessions, scheduling, providers, any Mercury screen or feature — or what a Mercury surface does. Answers from the documentation that ships with this install, never from memory.',
    argumentHint: '<question about using Mercury>',
    allowedTools: ['Read', 'Grep', 'Glob'],
    files: { ...mercuryDocPages() },
    getPromptForCommand: async args => [{ type: 'text', text: mercuryDocsPrompt(args) }],
  })
}
