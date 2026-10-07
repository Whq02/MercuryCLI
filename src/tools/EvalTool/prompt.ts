import type { Tools } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { primeEvalAvailability } from '../../services/eval/interpreters.js'
import {
  EVAL_DEFAULT_TIMEOUT_SECONDS,
  EVAL_IDLE_TTL_MS,
  EVAL_MAX_TIMEOUT_SECONDS,
  EVAL_WALL_CEILING_MS,
} from '../../services/eval/contracts.js'
import { samplesEnabled } from '../../services/samples/contracts.js'
import { EVAL_TOOL_NAME } from './constants.js'

export { EVAL_TOOL_NAME }

export const EVAL_DESCRIPTION =
  'Run one code cell in a retained Python or JavaScript runtime: state persists across cells, and code can call session tools, spawn agents, and make model completions from inside the cell.'

export async function buildEvalPrompt(tools: Tools = []): Promise<string> {
  const availability = await primeEvalAvailability(getCwd())
  const available = availability.filter(a => a.available)
  const languageLines = availability
    .map(a => a.available
      ? a.language === 'js' ? `- \`js\` — Node ${a.version ?? 'available'}` : `- \`py\` — ${a.version ?? 'available'} (${a.interpreterPath ?? ''})`
      : `- \`${a.language}\` — unavailable: ${a.whyNot ?? 'unknown'}`)
    .join('\n')
  const inspect = tools.some(tool => tool.name === 'Inspect') ? ' `tool.Inspect({ref})` reads a mercury:// ref.' : ''
  const sample = samplesEnabled()
    ? '\n- `sample({name, title?, html, ask?})` — keep a page as a sample: a versioned page the operator opens in the browser and marks up; returns `{id, title, version, url}` and the result lists it. ONLY when the operator asked to see something (a page, a design, a mockup, a report to look at, "show me") — never unasked, never to decorate an answer; pass the operator\'s words as `ask`. The same name publishes the next version.'
    : ''

  return `Run ONE code cell in a retained runtime. Variables, imports, functions and classes survive to your next cell in the same language. One call is one cell: for several steps, make several Eval calls — calls in one message run in order, each with its own result.

Languages in this session:
${languageLines}

## Persistence
- State is keyed per (agent, language, working directory): your own cells share a runtime, another agent's do not. \`reset: true\` recreates only that language's runtime.
- A runtime idle for ${EVAL_IDLE_TTL_MS / 60_000} minutes is reaped; the next cell starts fresh and its result says so — re-run your setup cell.

## In-cell helpers (both languages)
- \`tool.<Name>(...)\` / \`tool('<Name>', {...})\` — call any session tool from code (Python: keyword args; JS: one input object).${inspect} A call obeys the session's permission mode exactly like your direct calls — one that asks the operator waits, and the budget pauses. It RAISES into the cell only when the tool refused to run (an unknown tool, the kill switch, a permission, a ward): handle it or let the cell fail; do not retry a denial.
- \`tool.Bash({command})\` — a command that RAN returns \`{code, stdout, stderr}\` whatever it exited: \`code\` is the exit code (null while it runs in the background), \`stdout\` is the one interleaved capture, \`stderr\` is always \`''\`. A non-zero exit is a value, never a raise.
- \`tool.attempt.<Name>(...)\` (JS) / \`tool.attempt('<Name>', ...)\` (both) — the same call with its error as a value: \`{ok: true, value}\` or \`{ok: false, error}\`.
- A cell that throws keeps what it bound before the throw; the result names the bindings that survived.
- \`agent(prompt, ...)\` — run one subagent (options: agentType, label, schema, strict, worktree); returns its final text, or parsed and validated data when you pass a JSON schema.
- \`parallel(thunks, width?)\` — bounded fan-out over no-argument functions; results keep input order; the lowest-index failure propagates. \`pipeline(items, ...stages)\` — staged waves with a barrier between stages.
- \`completion(prompt, ...)\` — a stateless, tool-free model call (options: system, model, tier: 'main'|'fast', schema); a schema failure raises.
- \`display(x)\` · \`display_markdown(md)\` · \`display_json(obj)\` · \`display_image(bytes)\` — rich output beside stdout; Matplotlib figures are captured after each Python cell.
- \`read_file(path)\` / \`write_file(path, content)\` — the Read and Write tools.
- \`env\` — the environment, read-only; provider credentials are stripped.${sample}

## Budget and cancellation
- \`timeoutSeconds\` bounds runtime work only: default ${EVAL_DEFAULT_TIMEOUT_SECONDS}, at most ${EVAL_MAX_TIMEOUT_SECONDS} (a larger value runs at ${EVAL_MAX_TIMEOUT_SECONDS} and the result says so), 0 disables. Time inside tool, agent and completion calls, permission waits included, never counts; a ${EVAL_WALL_CEILING_MS / 60_000}-minute wall ceiling (permission waits excluded) bounds the whole call.
- A cell stopped by its budget or an abort comes back as an error: Python keeps its variables; the JS runtime is recreated and its state is gone. \`input()\` is refused, never hung.
- Output is bounded (head + tail); a cut names the file holding the full stream — Read it back.

## Dialect notes
- Both languages: the last expression's value is the cell result, shown after \`⇒\`.
- JS: an ES module with top-level await; \`process.cwd()\` is the working directory. \`import\` statements and top-level \`const\`/\`let\`/\`var\`/\`class\`/\`function\` declarations persist across cells (one per statement; prefer \`new RegExp(...)\` to a regex literal with quotes or braces). \`require()\` resolves from the working directory; \`module\`, \`exports\`, \`__dirname\`, \`__filename\` and \`import.meta\` are not defined. The global \`crypto\` is Web Crypto; \`createHash\`, \`createHmac\` and \`randomBytes\` come from \`node:crypto\`.
- Prefer cells over \`Bash\` for anything stateful, iterative or data-shaped; prefer \`Bash\` for plain shell commands.

${available.length === 0 ? 'NO language is currently available — this tool will refuse every call and should not be used.\n\n' : ''}The tool name is ${EVAL_TOOL_NAME}.`
}
