import type { Command } from '../types/command.js'
import type { ContentBlockParam } from '../types/wire.js'

/** The /review prompt (own wording; the coverage list is the contract). */
function buildReviewPrompt(args: string): string {
  return `Act as an expert code reviewer.

${
  args.trim()
    ? `Fetch pull request ${args.trim()} — its details and its diff — and review it.`
    : 'No PR number was given: list the open pull requests so one can be picked.'
}

The review should cover:
- an overview of what the change does;
- code quality and style;
- specific suggestions for improvement;
- potential issues or risks.

Keep it concise but thorough, weighting correctness, project conventions, performance, test
coverage and security. Format the review with clear sections and bullet points.`
}

const review = {
  type: 'prompt',
  name: 'review',
  description: 'Have Mercury review a pull request (bare: pick from open PRs)',
  argumentHint: '[PR number]',
  progressMessage: 'reviewing a pull request',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(args: string): Promise<ContentBlockParam[]> {
    return [{ type: 'text', text: buildReviewPrompt(args) }]
  },
} satisfies Command

export default review
