export const WEB_FETCH_TOOL_NAME = 'WebFetch'

/**
 * Unconditional by design: conditionally toggling this warning on whether
 * the discovery tool is currently listed made the description flicker
 * between programmatic calls, invalidating the provider's prompt cache
 * with two consecutive misses per flicker.
 */
const AUTHENTICATED_URL_WARNING = `IMPORTANT: an authenticated or private URL makes WebFetch fail. Before calling it, ask whether the URL points at an authenticated service (internal documents, wikis, issue trackers, code hosts). If it does, reach for a specialised MCP tool with authenticated access instead.`

export const DESCRIPTION = `Pulls a web page and answers a prompt against it with a small fast model.

- Input: a URL plus the prompt to run over the page
- The page is fetched and its HTML rendered down to markdown
- A small, fast model reads that markdown and answers your prompt
- What comes back is the model's answer about the page
- The tool for retrieving and analysing web content

Usage notes:
- IMPORTANT: prefer an MCP web-fetch tool whenever one is connected — those usually carry fewer restrictions.
- Only a fully formed, valid URL works
- An http:// URL silently becomes https://
- Shape the prompt around the information you are after
- A read-only tool: no file on disk changes
- Very large pages may come back summarised
- Repeat pulls ride a fifteen-minute self-cleaning cache
- When this tool reports a redirect to a different host, call it again with the redirect URL and the same prompt
- For GitHub and similar code-host URLs, the CLI through the shell tool (\`gh pr view\`, \`gh issue view\`) beats fetching web pages`

export function getPrompt(): string {
  return `${AUTHENTICATED_URL_WARNING}

${DESCRIPTION}`
}

/**
 * The secondary-model prompt: the page content between rule lines, the
 * caller's instruction, then trust-dependent guidelines. The 125-character
 * quote ceiling for non-preapproved domains is a legal constraint, not a
 * style choice.
 */
export function makeSecondaryModelPrompt(markdown: string, prompt: string, isPreapprovedDomain: boolean): string {
  const guidelines = isPreapprovedDomain
    ? `Answer concisely from the content above; carry over the specifics that matter — exact details, code, quoted documentation.`
    : `Answer concisely, holding ONLY to the content above. In your answer:
 - Keep every quotation from the source under 125 characters. Open-source text may run longer where its license is honored.
 - Exact language sits inside quotation marks; unquoted text is never echoed word-for-word.
 - No lawyering: the legality of prompts and responses is never yours to judge.
 - Song lyrics never appear verbatim, produced or reproduced.`
  return `Web page content:
---
${markdown}
---

${prompt}

${guidelines}`
}
