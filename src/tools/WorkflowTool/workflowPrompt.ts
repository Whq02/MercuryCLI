
import { EFFORT_LEVELS } from '../../utils/effortLadder.js'

const WORKFLOW_TOOL_PROMPT: string = `## Script format
The first statement is \`export const meta = {…}\`, a pure object literal without computed values. name and description are required; title, whenToUse and phases are optional. Each phase has a title, optional detail and optional model. Titles match phase() calls exactly; a call without a matching entry opens its own progress group.

The body is JavaScript in an async wrapper with top-level await and ordinary built-ins. TypeScript syntax, Date.now(), Math.random() and zero-argument new Date() are unavailable. The script has no filesystem or network access; agents do external work.

## Script API
- agent(prompt, opts?) → Promise<any>: dispatch a crewmate; returns its closing text, or validated data when opts.schema is a JSON Schema. Failed validation requests a correction. A skipped crewmate or an unrecoverable API error returns null.
  - opts.label: progress display name; defaults to a prompt prefix.
  - opts.phase: progress group for this call. The ambient phase pointer is shared; explicit phases keep concurrent stages in their intended groups.
  - opts.model: operator-selected model id or family word; overrides opts.tier. Omitted, uses the session's resolved model.
  - opts.effort: ${EFFORT_LEVELS.map(level => `'${level}'`).join(' | ')}. Omitted, the agent definition's effort, else the configured crewmate default (high unless the operator changed it), never the session level. An unsupported level maps to the nearest served level. Enables extended reasoning where supported.
  - opts.tier: 'orchestrator' | 'executor'. With routing enabled, an executor without opts.model uses the pinned execution-tier model; orchestrator keeps the session model. Otherwise the session model applies.
  - opts.isolation: 'worktree' creates a git worktree. An untouched worktree is removed automatically; a modified one is kept.
  - opts.agentType: custom agent definition; its declared tools and permissions apply. Omitted, the built-in worker has the session's permitted worker tools, including connected MCP tools.
- pipeline(items, ...stages) → Promise<any[]>: each item advances independently. Stages receive (previousResult, originalItem, index). A thrown stage makes that item null and skips its remaining stages.
- parallel(thunks) → Promise<any[]>: runs zero-argument functions concurrently and waits for all; rejected calls become null slots.
- log(message): one progress line shown to the user.
- phase(title): opens a progress group for subsequent calls without opts.phase.
- budget: {total, spent(), remaining()}. total is the operator's output-token target or null. spent() counts the whole turn, including all workflows; remaining() is max(0, total − spent()), or Infinity without a target. No further agent calls run once the target is spent.
- workflow(nameOrRef, args?) → Promise<any>: runs a saved workflow by name, or a script file addressed as {scriptPath}, inline. The child shares agent count, concurrency, abort signal and token pool. Its args receive the second argument. One nesting level.

A run allows 1000 agent calls; pipeline and parallel accept 4096 items. Agents' model calls wait for a free seat under the capacity governor (the session's crewmate lanes, named in /health); an agent idle in a tool holds none.

## Resume
The unchanged (position, prompt, opts) prefix of agent calls replays from the journal; the first changed call and everything after it run live. Changed args invalidate replay. A run without a surviving journal has only its saved transcripts, not replay state.`

export function getWorkflowToolPrompt(): string {
  return WORKFLOW_TOOL_PROMPT
}
