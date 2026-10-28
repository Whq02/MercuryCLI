import type { Tools } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { primeEvalAvailability } from '../../services/eval/interpreters.js'
import { EVAL_IDLE_TTL_MS, EVAL_WALL_CEILING_MS } from '../../services/eval/contracts.js'
import { samplesEnabled } from '../../services/samples/contracts.js'
import { EVAL_TOOL_NAME } from './constants.js'

export { EVAL_TOOL_NAME }

export const EVAL_DESCRIPTION =
  'Run one code cell in a retained Python or JavaScript runtime: state persists across cells, and code can call session tools, spawn crewmates, and make model completions from inside the cell.'

export const SAMPLE_PROMPT_LINES: readonly string[] = [
  '- `sample({name, title?, doc, ask?})` — keep a page as a sample: a versioned page the operator opens in the browser and marks up; returns `{id, title, version, url}` and the result lists it. ONLY when the operator asked to see something (a page, a design, a mockup, a report to look at, "show me") — never unasked, never to decorate an answer; pass the operator\'s words as `ask`. The same name publishes the next version.',
  '  `doc` is `{ subtitle?, meta?: string[], verdict?: string, parts: [...] }`: Mercury draws the page, you supply the parts. Raw `html` is refused. Each part is one of:',
  '  1. `{ kind: "verdict", status?: "approved"|"changes-needed"|"warning"|"info"|"halted", summary, detail? }` — the bottom line, once, first.',
  '  2. `{ kind: "section", heading?, prose?: string|string[], items?: string[], note? }` — paragraphs; `code` in backticks.',
  '  3. `{ kind: "cards", heading?, columns?: 2|3|4, items: [{ label?, value?, title?, body?, tone?: "ok"|"warn"|"danger"|"accent" }] }`',
  '  4. `{ kind: "table", heading?, columns?: string[], rows: (string|{text, tone?})[][] | object[], caption? }` — object rows name their own columns.',
  '  5. `{ kind: "diff", heading?, before: string|{label?, meta?, code}, after: string|{label?, meta?, code}, caption? }`',
  '  6. `{ kind: "terminal", heading?, title?, command?, lines: string|(string|{text, tone?})[], caption? }`',
  '  7. `{ kind: "figure", heading?, steps?: (string|{label, detail?})[], svg?, src?: "data:image/…", alt?, caption? }` — never a remote URL.',
  '  8. `{ kind: "checklist", heading?, items: (string|{text, state?: "done"|"pending"|"failed"|"skipped", detail?})[] }` — "[x] …", "[ ] …", "[!] …", "[-] …" work.',
  '  9. `{ kind: "question", heading, prompt?, options: (string|{label, description?, recommended?})[] }` — the operator\'s click comes back as `Decision (<heading>): <option>`.',
  '  Headed parts are numbered I, II, III … in order. Write the parts, not the page: no HTML, no styles. Keep the data in the cell and call again to publish the next version.',
]

export async function buildEvalPrompt(tools: Tools = []): Promise<string> {
  const availability = await primeEvalAvailability(getCwd())
  const available = availability.filter(a => a.available)
  const languageLines = availability
    .map(a => a.available
      ? a.language === 'js' ? `- \`js\` — Node ${a.version ?? 'available'}` : `- \`py\` — ${a.version ?? 'available'} (${a.interpreterPath ?? ''})`
      : `- \`${a.language}\` — unavailable: ${a.whyNot ?? 'unknown'}`)
    .join('\n')
  const inspect = tools.some(tool => tool.name === 'Inspect') ? ' `tool.Inspect({ref})` reads a mercury:// ref.' : ''
  const sample = samplesEnabled() ? '\n' + SAMPLE_PROMPT_LINES.join('\n') : ''

  return `Run one code cell in a retained runtime, for work that is computation: parsing and transforming data, numbers, plots, a workflow of several tool calls whose results code must combine. Shell commands, git, builds, tests, file reads and edits go through Bash, Read, Edit and the other tools directly, never through a cell — a cell that only wraps a shell command is the wrong tool. Variables, imports, functions and classes survive to your next cell in the same language. One call is one cell: for several steps, make several Eval calls — calls in one message run in order, each with its own result.

Languages in this session:
${languageLines}

## Persistence
- State is keyed per (agent, language, working directory): your own cells share a runtime, another agent's do not.
- A runtime idle for ${EVAL_IDLE_TTL_MS / 60_000} minutes is reaped; the next cell starts fresh and its result says so — re-run your setup cell.

## In-cell helpers (both languages)
- JS: \`await tool.<Name>(...)\`, \`await agent(prompt, ...)\`, and \`await completion(prompt, ...)\` resolve async calls. Python helpers are synchronous: no await.
- \`tool.<Name>(...)\` / \`tool('<Name>', {...})\` — call any session tool from code (Python: keyword args; JS: one input object).${inspect} A call obeys the session's permission mode exactly like your direct calls — one that asks the operator waits. It raises into the cell only when the tool refused to run (an unknown tool, the kill switch, a permission, a ward): handle it or let the cell fail; do not retry a denial.
- \`tool.Bash({command})\` — only for a command whose output the cell itself goes on to process; a command run for its own sake is a direct Bash call. A command that ran returns \`{code, stdout, stderr}\` whatever it exited: \`code\` is the exit code (null while it runs in the background), \`stdout\` is the one interleaved capture, \`stderr\` is always \`''\`. A non-zero exit is a value, never a raise.
- \`tool.attempt.<Name>(...)\` (JS) / \`tool.attempt('<Name>', ...)\` (both) — the same call with its error as a value: \`{ok: true, value}\` or \`{ok: false, error}\`.
- A cell that throws keeps what it bound before the throw; the result names the bindings that survived.
- \`agent(prompt, ...)\` — run one crewmate (options: agentType, label, schema, strict, worktree); returns its final text, or parsed and validated data when you pass a JSON schema.
- \`parallel(thunks, {width?, settled:true})\` (JS) / \`parallel(thunks, width=None, settled=True)\` (Python) returns input-ordered \`{ok:true,value}\` or \`{ok:false,error:{kind,name,message}}\` records; \`kind\` distinguishes permission, cancelled and error. Failed indices are zero-based; \`parallel.results\` retains the latest settled batch even if the cell later throws. Without \`settled\`, the lowest-index failure propagates as before. No item is retried. \`pipeline(items, ...stages)\` runs staged waves with a barrier between stages.
- \`completion(prompt, ...)\` — a stateless, tool-free model call (options: system, model, tier: 'main'|'fast', schema); a schema failure raises.
- \`display(x)\` · \`display_markdown(md)\` · \`display_json(obj)\` · \`display_image(bytes)\` — rich output beside stdout; Matplotlib figures are captured after each Python cell.
- \`read_file(path)\` / \`write_file(path, content)\` — the Read and Write tools.
- \`env\` — the environment, read-only; provider credentials are stripped.${sample}

## Budget and cancellation
- \`timeoutSeconds\` bounds runtime work only: time inside tool, agent and completion calls, permission waits included, never counts. A ${EVAL_WALL_CEILING_MS / 60_000}-minute wall ceiling (permission waits excluded) bounds the whole call.
- A cell stopped by its budget or an abort comes back as an error: Python keeps its variables; the JS runtime is recreated and its state is gone. \`input()\` is refused, never hung.
- Output is bounded (head + tail); a cut names the file holding the full stream — Read it back.
- A finished cell reports its bridge tool-call count and total tool-call time, including permission waits; parallel call durations are summed. Bridge calls also count in the crewmate's existing tool-use total while the cell runs.

## Dialect notes
- Both languages: the last expression's value is the cell result, shown after \`⇒\`.
- JS: an ES module with top-level await; \`process.cwd()\` is the working directory. \`import\` statements and top-level \`const\`/\`let\`/\`var\`/\`class\`/\`function\` declarations persist across cells (one per statement; prefer \`new RegExp(...)\` to a regex literal with quotes or braces). \`require()\` resolves from the working directory; \`module\`, \`exports\`, \`__dirname\`, \`__filename\` and \`import.meta\` are not defined. The global \`crypto\` is Web Crypto; \`createHash\`, \`createHmac\` and \`randomBytes\` come from \`node:crypto\`.
- The test for a cell: the work needs a runtime holding state between steps, or code over data. If a one-line shell command would do, Bash does it.${available.length === 0 ? '\n\nNo language is available in this session: every call is refused.' : ''}`
}
