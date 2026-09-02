import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'

export const TODO_WRITE_TOOL_NAME = 'TodoWrite'

export const DESCRIPTION =
  "Update the session's todo list. Use it proactively and often; keep at least one task in progress at all times; every item needs both an imperative content form and a present-continuous activeForm."

export function getPrompt(): string {
  return `Keep the session's structured task list here — create it, then manage it as the work moves. It tracks your progress, organises complex work, and makes your progress legible to the user.

## When this tool earns its place

Reach for it when:
1. The work spans three or more distinct steps.
2. The task is non-trivial and needs planning or multiple operations.
3. A todo list is what the user asked for.
4. The user supplies several tasks at once.
5. The moment new instructions arrive — the requirements become todos.
6. On starting a task: in_progress goes on BEFORE the work does, one item at a time ideally.
7. After finishing a task: mark it completed and add any newly-discovered follow-ups.

## When the list is overhead

Skip it when:
1. One straightforward task is the whole job.
2. Tracking a trivial task adds nothing.
3. The work completes in fewer than three trivial steps.
4. The request is purely conversational or informational.

A single trivial task is better done directly than tracked.

## Examples of when to use it

<example>
User: Add dark mode to the settings page, make sure the tests and the build pass.
Assistant: *Creates a todo list:* 1. Add the dark-mode toggle to settings state. 2. Implement the CSS-variable theme switch. 3. Wire the toggle into the settings page. 4. Run the test suite and the build and fix any failures.
<reasoning>A multi-part feature with an explicit demand that tests and build pass — the verification work is itself a closing task.</reasoning>
</example>

<example>
User: Rename getCwd to getCurrentWorkingDirectory across the repo.
Assistant: *Searches first, finds 15 call sites in 8 files, then creates a todo list with one entry per file.*
<reasoning>The scope was discovered by searching; decomposing per file keeps every edit tracked and none forgotten.</reasoning>
</example>

<example>
User: Implement account onboarding, the product catalog, order tracking, and checkout.
Assistant: *Opens a todo list that splits each feature into its own tasks.*
<reasoning>Several large features handed over as a list — each needs its own decomposition to stay manageable.</reasoning>
</example>

<example>
User: The app is slow — figure out why and speed it up.
Assistant: *Profiles first, then creates a todo list with one optimisation task per finding.*
<reasoning>Analysis precedes the optimisation list; the findings become concrete tracked items.</reasoning>
</example>

## Worked examples — the list left unopened

<example>
User: What prints a value in Python?
Assistant: print("...") — with a one-line explanation.
<reasoning>A one-line informational answer; a todo list would be noise.</reasoning>
</example>

<example>
User: What is git status for?
Assistant: *Explains the command.*
<reasoning>Explaining a command is a single conversational answer.</reasoning>
</example>

<example>
User: Drop a comment above the parse function.
Assistant: *Uses ${FILE_EDIT_TOOL_NAME} to add the comment.*
<reasoning>A single localised edit in one known place needs no tracking.</reasoning>
</example>

<example>
User: Please run npm install here.
Assistant: *Runs the command and reports the outcome.*
<reasoning>A single command execution with an immediate result.</reasoning>
</example>

## The three states, and keeping them honest

- States: pending (not started), in_progress (actively working), completed (fully done).
- Every item carries BOTH forms: content is imperative ("Run the tests"), activeForm is present-continuous ("Running the tests").
- Statuses move the moment reality does; completed goes on IMMEDIATELY at the finish, never in batches.
- ONE task holds in_progress at any moment — never zero, never two.
- Finish the current task before starting a new one; remove items that stopped being relevant.

## What completed requires

- A task turns completed only once it is FULLY accomplished.
- Keep it in_progress when there are errors or blockers, and create a new task naming the blocker.
- Never mark completed with failing tests, a partial implementation, unresolved errors, or missing files or dependencies.

## Task breakdown

- Make items specific and actionable; break complex work into smaller steps; use clear names.
- Always supply both forms, e.g. content: "Fix the auth bug", activeForm: "Fixing the auth bug".

Unsure? Open the list: worked-in-the-open task tracking shows the user your attention and lets no requirement slip.`
}
