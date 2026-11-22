import type { Command } from '../types/command.js'
import type { ContentBlockParam } from '../types/wire.js'
import { unbuilt, type Unbuilt } from '../pi/holes.js'

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

const review: Unbuilt = unbuilt('src/commands/review.ts:23')

export default review
