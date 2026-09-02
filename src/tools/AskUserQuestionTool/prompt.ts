// AskUserQuestion name/description constants, preview guidance, and the
// asking doctrine.

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

/** Chip label cap — shared with the permission UI's chip width. */
export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12

export const DESCRIPTION =
  'Put a fixed set of choices in front of the user — to collect facts, resolve something ambiguous, learn a preference, settle a decision, or present alternatives.'

/** Preview guidance appended ONLY when the host declares a format. */
export const PREVIEW_FEATURE_PROMPT: Record<'markdown' | 'html', string> = {
  markdown: `## Option previews (markdown)
Options may carry a \`preview\` rendered when the option is focused. Use previews for artefacts the user must visually compare — ASCII mockups, code snippets, diagram sketches, alternative configs. A preview renders as markdown inside a monospace box and may span several lines. When any option carries a preview the layout switches to a vertical option list beside the preview pane. Previews are wasted on simple preference questions, and forbidden on multi-select — single-select only.`,
  html: `## Option previews (HTML)
Options may carry a \`preview\` rendered when the option is focused. Use previews for artefacts the user must visually compare — HTML mockups, formatted code, visual comparisons. A preview has to arrive as one self-contained HTML fragment: no document wrapper (\`<html>\`, \`<body>\`, doctype), no \`<script>\` or \`<style>\` elements — use inline style attributes. Previews are single-select only; never use them on a multi-select question.`,
}

export const ASK_USER_QUESTION_TOOL_PROMPT = `Ask the user structured multiple-choice questions to collect facts, resolve ambiguity, learn preferences, or settle decisions.

## The asking doctrine
Investigate before asking. Use what the request itself, the architecture already committed to, the project's conventions, decisions already on record, and measurable constraints tell you to eliminate choices already decided — a question the code answers is not a question. Never ask what you could find out by reading the code.

- Ask only unresolved, consequential decisions. Do not ask about file names, internal types, or test frameworks the repository already uses — those details are yours to settle.
- State briefly why the decision is still open despite what you found.
- Offer 2–4 genuinely distinct options. Each description spells out honestly what follows from picking it — never steer with loaded phrasing.
- When the evidence supports a recommendation, put that option FIRST and append "(Recommended)" to its label. Recommend nothing otherwise.
- Group independent decisions into one call; ask a dependent question only after its parent answer is known.
- Do not re-ask a question the user already answered unless new evidence makes the earlier answer inconsistent — and then say what changed.
- Stop asking when all material ambiguity is resolved.

## Usage notes
- An "Other" free-text option is supplied automatically — never author one.
- Set \`multiSelect: true\` to allow several answers to one question.

## In strategy mode
Reach for this tool to pin down requirements or weigh approaches BEFORE the plan is final. Never route "Is my plan ready?" or a proceed/no-proceed question through here — the plan-exit tool owns that moment. Never reference "the plan" in a question: the user cannot see it until the plan-exit tool runs.`
