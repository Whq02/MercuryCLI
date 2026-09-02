import type { Command } from '../commands.js'
import { VERIFICATION_AGENT_TYPE } from '../tools/AgentTool/constants.js'

const PROMPT = `The user invoked /verify — run an INDEPENDENT adversarial verification of the work done in this session and report its verdict. Do not vouch for the work yourself; the verifier's job is to try to break it.

1. Determine what changed. Run \`git status --short\` and \`git diff --stat\`, then \`git diff\` for the substance. If the working tree is clean, fall back to the branch's recent commits (\`git log --oneline -8\`, \`git show --stat HEAD\`) and verify those.
2. Reconstruct the original intent — what this session's work was meant to accomplish — from the conversation and the diff.
3. Spawn the Agent tool with subagent_type="${VERIFICATION_AGENT_TYPE}". Pass it: the original task/intent, the full list of files changed (by anyone), the approach taken, and the path to any plan or spec file if one exists. Do NOT tell it the work is correct, and do NOT share your own test results — only flag concerns if you have them.
4. When it returns, relay its VERDICT (PASS / FAIL / PARTIAL) verbatim with the load-bearing evidence. On FAIL: summarize what broke, with the exact failing output, and offer to fix. On PASS: spot-check it first — re-run 2-3 commands from its report and confirm each PASS has a "Command run" block whose output matches your re-run; if any diverges or lacks a command block, resume the verifier with the specifics before reporting PASS. On PARTIAL: report what was verified and what could not be, and why.`

const command = {
  type: 'prompt',
  name: 'verify',
  description:
    'Run an independent adversarial verification of the work in this session (spawns the red-team verifier for a PASS/FAIL/PARTIAL verdict)',
  menuDescription: 'Red-team the work in this session for a PASS/FAIL/PARTIAL verdict',
  argumentHint: '[focus]',
  contentLength: PROMPT.length,
  progressMessage: 'verifying the work in this session',
  source: 'builtin',
  isEnabled: () => true,
  get isHidden() {
    return false
  },
  async getPromptForCommand(args: string) {
    const focus = args.trim()
    const text = focus
      ? `${PROMPT}\n\nFocus the verification on: ${focus}`
      : PROMPT
    return [{ type: 'text', text }]
  },
} satisfies Command

export default command
