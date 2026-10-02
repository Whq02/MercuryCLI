import { maybeMarkProjectOnboardingComplete } from '../projectOnboardingState.js'
import type { Command } from '../types/command.js'
import type { ContentBlockParam } from '../types/wire.js'

const INIT_PROMPT = `Study this repository and write MERCURY.md — the project instruction file
Mercury loads into every session here (its gitignored sibling is MERCURY.local.md). Mercury
loads MERCURY.md first; when a project has no MERCURY.md it loads AGENTS.md instead; when both
exist only MERCURY.md loads.

Put in it:
1. The commands a developer actually runs: build, lint, and test — including how to run one
   single test, not just the whole suite.
2. The practices and relationships someone could only learn by reading several files together:
   the non-obvious conventions, not a tour of the tree. Skip anything obvious from a directory
   listing.

Ground rules while writing:
- If MERCURY.md already exists, propose improvements to it and show the proposed change before
  touching it — never overwrite silently.
- If AGENTS.md exists, open MERCURY.md with the one line @AGENTS.md so that guide keeps
  loading, and keep only what is Mercury-specific below it — never duplicate its content.
- Say each thing once. Leave out generic engineering advice, and instructions nobody needs
  ("write tests", "handle errors", "follow best practices").
- Do not catalogue every file or component that a reader could discover with a glance.
- Read the README and any other agent instruction files the repository already holds; carry
  what is worth keeping into the guide in your own words.
- Claim nothing you did not verify in files you actually read.
- Open the file with a two-line header naming MERCURY.md and stating that it guides the
  Mercury harness when working in this repository.

The explicit-import law (this is load-bearing): Mercury loads MERCURY.md and AGENTS.md as
described above and no other instruction file on its own. If another agent instruction file
exists here: never copy its content into MERCURY.md, and never load it silently. Read it, show
the operator a short preview of what it covers, and OFFER a one-line explicit import (@<file>)
— add that import only if the operator says yes; otherwise write native guidance from your own
analysis. Why: an explicit import composes that file deliberately, with source and digest
provenance, visible in the health surface.`

const init = {
  type: 'prompt',
  name: 'init',
  get description(): string {
    return 'Analyze the codebase and create (or improve) MERCURY.md'
  },
  progressMessage: 'analyzing your codebase',
  contentLength: INIT_PROMPT.length,
  source: 'builtin',
  async getPromptForCommand(): Promise<ContentBlockParam[]> {
    maybeMarkProjectOnboardingComplete()
    return [{ type: 'text', text: INIT_PROMPT }]
  },
} satisfies Command

export default init
