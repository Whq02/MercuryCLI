import { createBuiltinPromptCommand } from '../createBuiltinPromptCommand.js'

/**
 * A built-in prompt command. The
 * command returns this interim prompt instead of delegating. The GitHub CLI
 * invocation and the three REST paths are compat seams — spelled
 * exactly. Prompt prose is Mercury's own: the functional pins (command,
 * endpoints, field names, output-contract literals) survive verbatim; every
 * sentence around them is this rewrite's own.
 */
const prComments = createBuiltinPromptCommand({
  name: 'pr-comments',
  description: 'Pull every comment thread from a GitHub pull request',
  progressMessage: 'fetching PR comments',
  async buildPrompt(args) {
    return [
      {
        type: 'text',
        text: `You are working inside a git-driven development session; your job right now is to gather every comment on the current GitHub pull request and present them, formatted, with nothing else around them.

Work through it in this order:

1. Identify the PR and its repository: run \`gh pr view --json number,headRepository\` and read both values out of the JSON.
2. Pull the conversation-level comments from \`gh api /repos/{owner}/{repo}/issues/{number}/comments\`.
3. Pull the code-review comments from \`gh api /repos/{owner}/{repo}/pulls/{number}/comments\`. The fields that matter most are \`body\`, \`diff_hunk\`, \`path\`, and \`line\`. When a comment refers to code you want to inspect, you can fetch the file with something like \`gh api /repos/{owner}/{repo}/contents/{path}?ref={branch} | jq .content -r | base64 -d\`.
4. Arrange everything you fetched into the shape below.
5. Reply with the arranged comments alone — not a word before or after.

Shape of the reply:

## Comments

[one entry per comment thread:]
- @author file.ts#line:
  \`\`\`diff
  [that thread's diff_hunk]
  \`\`\`
  > the comment body, quoted

  [replies nested beneath the comment they answer]

If the PR carries no comments at all, reply with "No comments found."

Rules to hold to:
1. The reply is the comments and nothing else — no framing, no commentary
2. Both kinds are covered: conversation comments and code-review comments
3. A reply stays nested under its parent so the threading survives
4. Every code-review comment shows its file and line context
5. Parse the API's JSON responses with jq${args ? `\n\nExtra input from the user to take into account: ${args}` : ''}`,
      },
    ]
  },
})

export default prComments
