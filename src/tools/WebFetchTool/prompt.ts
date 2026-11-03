export const WEB_FETCH_TOOL_NAME = 'WebFetch'

export const DESCRIPTION = `Fetch HTTP(S) pages without credentials. Returns Markdown page text or a saved binary path. Sparse HTML on public hosts may send the full URL to r.jina.ai; private addresses are excluded and no cookies or credentials go to that reader. Repeat pulls ride a fifteen-minute cache.`

export function getPrompt(): string {
  return DESCRIPTION
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
