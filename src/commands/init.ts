import { maybeMarkProjectOnboardingComplete } from '../projectOnboardingState.js'
import type { Command } from '../types/command.js'
import type { ContentBlockParam } from '../types/wire.js'

/**
 * The /init prompt (Mercury-authored): analyse the repository and produce
 * the NATIVE instruction file, with the explicit-import law for compat
 * files. Wording is Mercury's own; the behavioural envelope (what to add,
 * what to avoid, the import law) is the contract.
 */
const INIT_PROMPT = `Study this repository and write MERCURY.md — the project instruction file
Mercury loads into every session here (its gitignored sibling is MERCURY.local.md).

Put in it:
1. The commands a developer actually runs: build, lint, and test — including how to run one
   single test, not just the whole suite.
2. The architecture at altitude: the structure and relationships someone could only learn by
   reading several files together. Skip anything obvious from a directory listing.

Ground rules while writing:
- If MERCURY.md already exists, propose improvements to it and show the proposed change before
  touching it — never overwrite silently.
- Say each thing once. Leave out generic engineering advice, and instructions nobody needs
  ("write tests", "handle errors", "follow best practices").
- Do not catalogue every file or component that a reader could discover with a glance.
- Mine the README and any editor-assistant rule files (Cursor's rule files, GitHub Copilot's
  instruction file) for material worth keeping.
- Claim nothing you did not verify in files you actually read.
- Open the file with a two-line header naming MERCURY.md and stating that it guides the
  Mercury harness when working in this repository.

The explicit-import law (this is load-bearing): Mercury loads its native instruction files and
does NOT automatically load compatible-harness instruction files (CLAUDE.md and friends). If
such files exist here: never copy their content into MERCURY.md, and never load them silently.
Read them, show the operator a short preview of what they cover, and OFFER a one-line explicit
import (@<file>) — add that import only if the operator says yes; otherwise write native
guidance from your own analysis. Why: an explicit import composes that file deliberately, with
source and digest provenance, visible in the health surface.`

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
    // Running /init IS project onboarding.
    maybeMarkProjectOnboardingComplete()
    return [{ type: 'text', text: INIT_PROMPT }]
  },
} satisfies Command

export default init
