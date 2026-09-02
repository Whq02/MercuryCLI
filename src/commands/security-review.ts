import { createBuiltinPromptCommand } from './createBuiltinPromptCommand.js'
import type { ToolUseContext } from '../Tool.js'
import type { ContentBlockParam } from '../types/wire.js'
import { parseSlashCommandToolsFromFrontmatter } from '../utils/markdownConfigLoader.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { applyPermissionUpdate } from '../utils/permissions/PermissionUpdate.js'
import { permissionRuleValueFromString } from '../utils/permissions/permissionRuleParser.js'
import { executeShellCommandsInPrompt } from '../utils/promptShellExecution.js'

const DESCRIPTION = 'Analyze the changes on this branch for security risks'

/**
 * The command body: a markdown document WITH frontmatter, parsed at call
 * time — the frontmatter's allowed-tools list is the pre-approval set for
 * the embedded shell captures, never a duplicated literal list. Wording is
 * Mercury's own; the prohibitions, exclusions and precedents carry the same
 * policy, nothing weakened.
 */
const SECURITY_REVIEW_DOCUMENT = `---
description: ${DESCRIPTION}
allowed-tools:
  - "Bash(git diff:*)"
  - "Bash(git status:*)"
  - "Bash(git log:*)"
  - "Bash(git show:*)"
  - "Bash(git remote show:*)"
  - Read
  - Glob
  - Grep
  - LS
  - Task
---
You are working as a senior security engineer. Your scope is exactly the changes on this
branch — nothing else.

Current state of the branch:

Status: !\`git status\`

Files changed vs. the default branch: !\`git diff --name-only origin/HEAD...\`

Commits on this branch: !\`git log --no-decorate origin/HEAD...\`

Full diff vs. the default branch: !\`git diff origin/HEAD...\`

## Objective

Find high-confidence vulnerabilities with genuine exploitation potential that THIS CHANGE
introduces. Pre-existing problems in the codebase are out of scope, however tempting.

Four instructions that outrank everything else:
1. Minimise false positives — report a finding only when you judge it more than 80% likely to
   be exploitable in practice.
2. Do not pad the report. A short honest report beats a long speculative one.
3. Weight findings by impact, not by how easy they were to spot.
4. Three categories are excluded outright, always: denial of service, secrets at rest, and
   rate limiting / resource exhaustion.

## What to examine

Grouped by class:
- input handling: injection in all its forms (SQL, command, path, template, …);
- authentication and authorization flaws;
- cryptography and secret management;
- code execution and deserialization risks, plus cross-site scripting;
- exposure of sensitive data.

A vulnerability reachable only from the local network can still be high severity — judge by
consequence, not by reachability alone.

## Method

Three phases, in order:
1. Research the repository: how is it structured, what does the changed code participate in?
2. Compare the change against the codebase's existing security patterns — does it bypass or
   weaken an established control?
3. Assess each changed file, tracing where untrusted data flows and where privilege
   boundaries are crossed.

## Output format

Report each finding in markdown with: the file, the line, a severity (high/medium/low), a
short category slug, a description, a concrete exploit scenario, and a recommended fix.

Worked example:

### finding: command injection in export path (HIGH · injection)
- file: src/export/run.ts
- line: 41
- description: the export filename is interpolated into a shell string unquoted.
- exploit scenario: a filename of \`x; rm -rf ~\` executes arbitrary commands when the export
  runs.
- fix: pass the filename as an argv element via execFile, never through a shell string.

Severity guidance: HIGH means directly exploitable remote code execution, data breach, or an
authentication bypass; MEDIUM means significant but requiring specific conditions; LOW is
defence-in-depth. Score confidence 0 to 1 and report nothing under 0.7. The final report
carries only HIGH and MEDIUM findings.

## False-positive filtering (instructions for a filtering sub-task)

You are validating one candidate finding. Read code only — do not run shell commands and do
not write files.

Hard exclusions — reject the candidate outright if it is any of these:
1. denial of service or resource exhaustion (memory, CPU, disk);
2. a secret stored at rest in a secured location;
3. missing rate limiting;
4. missing input validation on a field that is not security-critical;
5. unsanitised input in a CI workflow with no untrusted trigger;
6. a general "could be hardened" observation with no concrete attack;
7. a theoretical race or timing window with no practical exploitation;
8. an outdated dependency (that has its own reporting channel);
9. a memory-safety concern in a memory-safe language;
10. anything confined to test-only files;
11. log spoofing via user content in log lines;
12. SSRF where only the path (not the host) is attacker-controlled;
13. user content passed into model prompts;
14. regex injection or regex-based DoS;
15. documentation files;
16. missing audit logging.

Precedents to apply:
- a plaintext high-value secret in a log IS a finding; a logged URL is not;
- UUIDs may be treated as unguessable;
- environment variables and CLI flags are trusted inputs;
- resource leaks are not security findings;
- subtle web vectors (tabnabbing, cross-site leaks, prototype pollution, open redirects)
  need extremely high confidence to keep;
- mainstream front-end frameworks escape output — XSS needs an explicit unsafe-HTML escape
  hatch to be real;
- a CI-workflow finding needs a concrete attack path;
- client-side permission or authentication checks are not vulnerabilities — the server
  validates;
- keep a MEDIUM only when it is obvious and concrete;
- a notebook finding needs a concrete untrusted path;
- logging non-PII is not a finding;
- shell-script command injection needs a concrete untrusted-input path.

Judge signal quality: is the finding specific, evidenced in the diff, and actionable? Score
it 1–10 for confidence that it is real and worth an engineer's time.

## Execution plan

1. Launch one sub-task to identify candidate vulnerabilities, carrying this whole brief.
2. For each candidate, launch a filtering sub-task IN PARALLEL carrying the false-positive
   filtering instructions above.
3. Drop every candidate scored below 8.

Your reply must contain only the final markdown report.`

async function buildSecurityReviewPrompt(
  _args: string,
  context: ToolUseContext,
): Promise<ContentBlockParam[]> {
  const { frontmatter, content } = parseFrontmatter(SECURITY_REVIEW_DOCUMENT)
  const allowedTools = parseSlashCommandToolsFromFrontmatter(
    (frontmatter as { 'allowed-tools'?: unknown })['allowed-tools'],
  )
  // The captures run with this command's own allowed-tools pre-approved for
  // the duration — an overlaid COPY of the permission state, never a write
  // to the live one.
  const baseState = context.getAppState()
  const overlaidPermissions = applyPermissionUpdate(baseState.toolPermissionContext, {
    type: 'addRules',
    behavior: 'allow',
    destination: 'session',
    rules: allowedTools.map(permissionRuleValueFromString),
  })
  const overlaidContext: ToolUseContext = {
    ...context,
    getAppState: () => ({ ...baseState, toolPermissionContext: overlaidPermissions }),
  }
  const text = await executeShellCommandsInPrompt(content, overlaidContext, 'security-review')
  return [{ type: 'text', text }]
}

const securityReview = createBuiltinPromptCommand({
  name: 'security-review',
  description: DESCRIPTION,
  progressMessage: 'analyzing changes for security risks',
  buildPrompt: buildSecurityReviewPrompt,
})

export default securityReview
