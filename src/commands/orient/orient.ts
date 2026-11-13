import { maybeMarkProjectOnboardingComplete } from '../../projectOnboardingState.js'
import type { Command } from '../../commands.js'
import { otherToolsImportLines } from '../../services/instructions/listing.js'
import type { ContentBlockParam } from '../../types/wire.js'

const ORIENT_PROMPT = `Study this repository and write MERCURY.md — the project instruction file
Mercury loads into every session here (its gitignored sibling is MERCURY.local.md). Mercury
loads MERCURY.md first; while a project has no MERCURY.md it loads the instruction and rule
files other tools left there; once MERCURY.md exists only MERCURY.md loads, and those files
come in only where it imports them.

Put in it:
1. The commands a developer actually runs: build, lint, and test — including how to run one
   single test, not just the whole suite.
2. The practices and relationships someone could only learn by reading several files together:
   the non-obvious conventions, not a tour of the tree. Skip anything obvious from a directory
   listing.

Ground rules while writing:
- If MERCURY.md already exists, propose improvements to it and show the proposed change before
  touching it — never overwrite silently.
- If other tools' files load here today (this message ends with their lines when they do), open
  MERCURY.md with exactly those lines, one @ line each, so that what loads today keeps loading,
  and keep only what is Mercury-specific below them — never duplicate their content. A rules
  folder is one line; each rule in it keeps its own scope.
- Say each thing once. Leave out generic engineering advice, and instructions nobody needs
  ("write tests", "handle errors", "follow best practices").
- Do not catalogue every file or component that a reader could discover with a glance.
- Read the README and the instruction files the repository already holds, so that the guide
  neither repeats nor contradicts them.
- Claim nothing you did not verify in files you actually read.
- Open the file with a two-line header naming MERCURY.md and stating that it guides the
  Mercury harness when working in this repository.

The explicit-import law (this is load-bearing): once MERCURY.md exists, Mercury loads no other
tool's file on its own. Never copy such a file's content into MERCURY.md; an @ line composes it
deliberately, with source and digest provenance, visible in the health surface.`

async function linesOfWhatLoads(): Promise<string> {
  const { project, aside } = await otherToolsImportLines()
  const blocks: string[] = []
  if (project.length > 0) {
    blocks.push(`Other tools' files that load here today — the first lines of MERCURY.md:\n${project.join('\n')}`)
  }
  if (aside.length > 0) {
    const lead =
      aside.length === 1
        ? 'A file that is personal or stands outside this project loads here today — its line belongs in MERCURY.local.md, never in MERCURY.md:'
        : 'Files that are personal or stand outside this project load here today — their lines belong in MERCURY.local.md, never in MERCURY.md:'
    blocks.push(`${lead}\n${aside.join('\n')}`)
  }
  return blocks.length === 0 ? '' : `\n\n${blocks.join('\n\n')}\n`
}

export default {
  type: 'prompt',
  name: 'orient',
  get description(): string {
    return 'Analyze the codebase and create (or improve) MERCURY.md'
  },
  progressMessage: 'analyzing your codebase',
  contentLength: ORIENT_PROMPT.length,
  source: 'builtin',
  async getPromptForCommand(): Promise<ContentBlockParam[]> {
    maybeMarkProjectOnboardingComplete()
    return [{ type: 'text', text: `${ORIENT_PROMPT}${await linesOfWhatLoads()}` }]
  },
} satisfies Command
