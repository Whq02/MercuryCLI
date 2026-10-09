export const WEB_FETCH_TOOL_NAME = 'WebFetch'

const AUTHENTICATED_URL_WARNING = `An authenticated or private URL (internal documents, wikis, issue trackers, code hosts) fails here; an MCP tool with authenticated access is the road to those, and a connected MCP web-fetch tool usually carries fewer restrictions than this one.`

export const DESCRIPTION = `Pulls a web page and answers a prompt against it with a small fast model.

- Input: a URL plus the prompt to run over the page
- The page is fetched and its HTML rendered down to markdown; a small, fast model reads that markdown and answers your prompt
- Only a fully formed, valid URL works; an http:// URL silently becomes https://
- Very large pages may come back summarised
- Repeat pulls ride a fifteen-minute self-cleaning cache
- When this tool reports a redirect to a different host, call it again with the redirect URL and the same prompt
- For GitHub and similar code-host URLs, the CLI through the shell tool (\`gh pr view\`, \`gh issue view\`) beats fetching web pages`

export function getPrompt(): string {
  return `${AUTHENTICATED_URL_WARNING}

${DESCRIPTION}`
}

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
