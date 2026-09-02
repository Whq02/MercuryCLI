import { getCwd } from '../../utils/cwd.js'
import { evalAvailability } from '../../services/eval/interpreters.js'
import {
  EVAL_DEFAULT_TIMEOUT_SECONDS,
  EVAL_MAX_TIMEOUT_SECONDS,
} from '../../services/eval/contracts.js'
import { EVAL_TOOL_NAME } from './constants.js'

export { EVAL_TOOL_NAME }

export const EVAL_DESCRIPTION =
  'Run one code cell in a retained Python or JavaScript runtime: state persists across cells, and code can call session tools, spawn agents, and make model completions from inside the cell.'

export function buildEvalPrompt(): string {
  const availability = evalAvailability(getCwd())
  const available = availability.filter(a => a.available)
  const languageLines = availability
    .map(a =>
      a.available
        ? `- \`${a.language}\` — ${a.version ?? 'available'} (${a.interpreterPath ?? ''})`
        : `- \`${a.language}\` — unavailable: ${a.whyNot ?? 'unknown'}`,
    )
    .join('\n')

  return `Execute ONE code cell in a retained runtime. Variables, imports, functions and classes survive to your next cell in the same language; \`reset: true\` recreates only that language's runtime.

Languages in this session:
${languageLines}

## Persistence
- One cell per call; cells in one session never overlap.
- State is keyed per (agent, language, working directory): your own cells share a runtime, another agent's do not.
- \`reset: true\` wipes the named language only — the other language keeps its state.
- If a kernel dies mid-cell it is replaced and your cell retried once; the result says so.

## In-cell helpers (both languages)
- \`tool.<Name>(...)\` / \`tool('<Name>', {...})\` — call any session tool from code (Python: keyword args; JS: one input object). Re-entered calls obey the session's permission mode exactly like your direct tool calls: what would auto-allow auto-allows, what would ask asks the operator (the cell waits; its budget is paused meanwhile). A denied call raises into the cell — handle it or let the cell fail; do not retry a denial.
- \`agent(prompt, ...)\` — run one subagent from code (options: agentType, label, schema, strict, worktree). Returns its final text, or parsed+validated data when you pass a JSON schema. In-cell agents are one-shot and never share your kernel.
- \`parallel(thunks, width?)\` — bounded fan-out over no-argument functions; results keep input order; the lowest-index failure propagates. Width defaults to the session's live delegation ceiling.
- \`pipeline(items, ...stages)\` — staged waves with a barrier between stages.
- \`completion(prompt, ...)\` — a stateless, tool-free model call (options: system, model, tier: 'main'|'fast', schema). Any signed-in provider family works; pass any routable model id. A schema failure raises into the cell.
- \`display(x)\` · \`display_markdown(md)\` · \`display_json(obj)\` · \`display_image(bytes)\` — rich output beside stdout. Matplotlib figures are captured automatically after each Python cell.
- \`read_file(path)\` / \`write_file(path, content)\` — sugar over the Read/Write tools (same permission behaviour).
- \`env\` — the kernel's environment, read-only. Provider credentials are stripped from kernels by construction; a cell that needs a secret must receive it through an approved tool call, not ambient env.

## Budget and cancellation
- \`timeoutSeconds\` bounds RUNTIME work only (default ${EVAL_DEFAULT_TIMEOUT_SECONDS}s, max ${EVAL_MAX_TIMEOUT_SECONDS}s, 0 disables): time inside tool/agent/completion calls — permission waits included — never counts. A hard wall ceiling still bounds the whole call.
- On timeout or user abort the kernel is interrupted; the result carries cancelled status and says whether state survived (Python: yes; JS: the kernel is recreated). Interactive stdin (input()) is refused, never hung.
- Output is bounded (head + tail); when truncated, the FULL stream is spilled to a file named in the result — read it back with the Read tool.

## Dialect notes
- Python: the last expression's value is the cell result (like a notebook).
- JS: top-level await works; \`import\` statements and top-level \`const/let/class\` declarations persist across cells via a source transform. Keep top-level declarations simple (one per statement reads best); regex literals containing quotes or braces can confuse the transform — prefer \`new RegExp(...)\` at top level. \`import.meta\` is unavailable in cells.
- Prefer cells over ${'`Bash`'} for anything stateful, iterative, or data-shaped; prefer ${'`Bash`'} for plain shell commands.

${available.length === 0 ? 'NO language is currently available — this tool will refuse every call and should not be used.' : ''}
The tool name is ${EVAL_TOOL_NAME}.`
}
