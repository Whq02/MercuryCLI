
import { EFFORT_LEVELS } from '../../utils/effortLadder.js'

const WORKFLOW_TOOL_PROMPT: string = `## Script format
First statement: \`export const meta = {…}\` (pure object literal; required: name, description; optional: title, whenToUse, phases:[{title, detail?, model?}]). Titles match phase() calls; unmatched phase() calls open their own group.

Body: async JS with top-level await and standard built-ins. TypeScript syntax, Date.now(), Math.random(), 0-arg new Date(), filesystem and network access are unavailable; agents do external work.

## Script API
- agent(prompt, opts?) → Promise<any>: runs a crewmate; returns final text, or validated data when opts.schema is a JSON Schema (invalid output prompts correction; skipped/unrecoverable error → null).
  - opts.label: progress name (default prompt prefix).
  - opts.phase: progress group (explicit phases isolate concurrent stages from the shared ambient phase).
  - opts.model: operator-selected model id or family word; overrides opts.tier (default session model).
  - opts.effort: ${EFFORT_LEVELS.map(level => `'${level}'`).join(' | ')}. Omitted, the agent definition's effort, else the configured crewmate default (high unless the operator changed it), never the session level. An unsupported level maps to the nearest served level.
  - opts.tier: 'orchestrator' | 'executor'. With routing enabled, an executor without opts.model uses the pinned execution-tier model; orchestrator keeps the session model. Otherwise the session model applies.
  - opts.isolation: 'worktree' creates a git worktree (untouched worktrees auto-remove; modified ones stay).
  - opts.agentType: custom agent definition; its declared tools and permissions apply. Omitted, the built-in worker has the session's permitted worker tools, including connected MCP tools.
- pipeline(items, ...stages) → Promise<any[]>: items advance independently through (prev, item, index); a throw turns that item null and skips its later stages.
- parallel(thunks) → Promise<any[]>: runs 0-arg thunks concurrently; rejections become null slots.
- log(message): progress line shown to user.
- phase(title): sets ambient progress group for calls without opts.phase.
- budget: {total, spent(), remaining()} over the turn's output-token target (null/Infinity when unset); halts new agent calls once spent.
- workflow(nameOrRef, args?) → Promise<any>: runs a named workflow or {scriptPath} inline (1 nesting level), sharing agent cap, concurrency, abort and budget.

Caps: 1000 agent calls/run; 4096 items in pipeline/parallel. Model calls queue under the session's crewmate-lane capacity governor (/health); tool-idle agents hold no slot.

## Resume
Unchanged (position, prompt, opts) prefix replays from the journal; the first changed call onward runs live. Changed args or a missing journal invalidate replay.`

export function getWorkflowToolPrompt(): string {
  return WORKFLOW_TOOL_PROMPT
}
