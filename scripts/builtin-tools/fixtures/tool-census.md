# builtin-tools capability census (GENERATED)

> Regenerate: `bun run scripts/builtin-tools/census-gen.ts` · drift gate:
> `scripts/builtin-tools/prove-builtin-tools-census.ts` (compares the committed JSON
> anchor against the live catalog — a new/changed production tool that
> skips regeneration is RED). Live columns (enabled/support) reflect the
> generating environment and are NOT drift-anchored.

Census version 1 — 71 built-in production tools · 170 operations · 71 with a declared capability contract.

## Summary

- support (at generation time): 46 available · 14 conditional · 0 degraded · 11 unavailable (gated out of this environment's catalog — still rowed, never silently dropped)
- class: 20 observation · 22 mutation · 9 execution · 20 coordination · 0 unclassified
- integrations: 10 declare transactions · 11 declare executions · 31 declare mercury:// outputs · 36 name a focused proof
- capability units covered: application-verification · browser-drive · capability-discovery · code-intelligence · debugging · game-engine · git-inspection · git-transactions · memory · operator-io · persistent-evaluation · pixel-art · planning · process-execution · resource-inspection · scheduling · service-management · source-reading · structural-mutation · task-coordination · text-mutation · web-access
- every tool is unit-classified

## Per-tool census

| Tool | class | units | ops | cancel | deferred | transactions | execution | resources | proof |
|---|---|---|---|---|---|---|---|---|---|
| Agent | coordination | task-coordination | — | block | no | — | agent (external-projection) | mercury://agent | scripts/tools/prove-tool-contracts.ts |
| ApolloReview | coordination | operator-io | — | block | yes | — | — | — | NAMED GAP |
| ArtifactsList | observation | resource-inspection | — | block | no | — | — | mercury://artifact | NAMED GAP |
| Aseprite | mutation | pixel-art | 5 | block | yes | — | — | — | scripts/aseprite/run-all.sh |
| AskUserQuestion | coordination | operator-io | — | block | yes | — | — | — | NAMED GAP |
| AstEdit | mutation | structural-mutation, text-mutation | — | block | no | file +receipts | — | mercury://file, mercury://receipt | scripts/ast-tools/run-all.sh |
| AstSearch | observation | source-reading, code-intelligence | — | block | no | — | — | — | scripts/ast-tools/run-all.sh |
| Bash | execution | process-execution | — | block | no | — | background-job (external-projection) | mercury://task | scripts/tools/prove-stream-watchdog.ts |
| Browser | execution | browser-drive | 18 | cancel | yes | — | browser-session (child-execution) | — | scripts/browser/prove-browser-drive.ts |
| ChangeSet | mutation | text-mutation | 4 | block | yes | file +receipts | — | mercury://file, mercury://receipt | scripts/changesets/run-all.sh |
| Checkpoint | mutation | task-coordination | — | block | no | — | — | — | scripts/run-recovery/run-all.sh |
| Correct | mutation | memory | 3 | block | yes | — | — | — | scripts/memory/prove-verbs-lifecycle.ts |
| CronCreate | mutation | scheduling | — | block | yes | — | — | — | NAMED GAP |
| CronDelete | mutation | scheduling | — | block | yes | — | — | — | NAMED GAP |
| CronList | observation | scheduling | — | block | yes | — | — | — | NAMED GAP |
| Debug | execution | debugging | 27 | block | yes | — | debug-adapter (external-projection) | — | scripts/ide/prove-native-debug.ts |
| Edit | mutation | text-mutation | — | block | no | file +receipts | — | mercury://file, mercury://receipt | scripts/project-services/prove-change-receipts.ts |
| EnterPlanMode | coordination | planning | — | block | yes | — | — | — | NAMED GAP |
| EnterWorktree | mutation | git-transactions | — | block | yes | — | — | — | NAMED GAP |
| Eval | execution | persistent-evaluation | — | block | no | — | eval-kernel (child-execution) | — | scripts/eval/prove-kernel-persistence.ts |
| ExitPlanMode | coordination | planning | — | block | yes | — | — | — | NAMED GAP |
| ExitWorktree | mutation | git-transactions | — | block | yes | — | — | — | NAMED GAP |
| Git | mutation | git-inspection, git-transactions | 21 | block | yes | git.commit +receipts | — | mercury://git | scripts/builtin-tools/prove-git-plans.ts |
| Glob | observation | source-reading | — | block | no | — | — | — | NAMED GAP |
| Godot | mutation | game-engine | — | block | yes | — | — | — | scripts/vulcan/run-all.sh |
| Grep | observation | source-reading | — | block | no | — | — | — | NAMED GAP |
| Inspect | observation | resource-inspection | — | block | no | — | — | mercury://file, mercury://run, mercury://receipt, mercury://task, mercury://execution, mercury://transaction, mercury://evidence | scripts/project-services/prove-resource-plane.ts |
| Journey | execution | application-verification, service-management | 3 | cancel | yes | — | journey (full-execution-owner) | mercury://journey, mercury://service, mercury://execution, mercury://evidence | scripts/builtin-tools/prove-journeys.ts |
| Launch | execution | process-execution, debugging | 7 | block | yes | — | debug-adapter (external-projection) | — | scripts/ide/prove-launch-profiles.ts |
| LaunchFleet | coordination | task-coordination | — | block | yes | — | — | mercury://team | NAMED GAP |
| ListMcpResourcesTool | observation | resource-inspection | — | block | yes | — | — | — | NAMED GAP |
| LSP | mutation | code-intelligence | — | block | yes | lsp.rename +receipts | — | mercury://file, mercury://receipt | scripts/lsp/run-all.sh |
| Monitor | observation | task-coordination | — | block | yes | — | — | mercury://task | NAMED GAP |
| NotebookEdit | mutation | text-mutation | — | block | yes | notebook +receipts | — | mercury://file, mercury://receipt | NAMED GAP |
| ProviderSearch | observation | web-access | — | block | yes | — | — | — | scripts/search/run-all.sh |
| PushNotification | coordination | operator-io | — | block | yes | — | — | — | NAMED GAP |
| Read | observation | source-reading | — | block | no | — | — | mercury://file | scripts/project-services/prove-change-anchors.ts |
| ReadMcpResourceTool | observation | resource-inspection | — | block | yes | — | — | — | NAMED GAP |
| Recall | observation | memory | — | block | yes | — | — | — | scripts/memory/prove-verbs-lifecycle.ts |
| RecordConvention | mutation | text-mutation | — | block | yes | file +receipts | — | — | NAMED GAP |
| Reflect | observation | memory | — | block | yes | — | — | — | scripts/memory/prove-reflect-grounding.ts |
| RememberLesson | mutation | memory | — | block | yes | — | — | — | NAMED GAP |
| Retain | mutation | memory | — | block | yes | — | — | — | scripts/memory/prove-retain-honesty.ts |
| Rewind | mutation | task-coordination | — | block | no | — | — | — | scripts/run-recovery/run-all.sh |
| ScheduleWakeup | coordination | scheduling | — | block | yes | — | — | — | NAMED GAP |
| SendMessage | coordination | task-coordination | — | block | yes | — | — | mercury://team | scripts/crew/run-all.sh |
| SendUserFile | coordination | operator-io | — | block | no | — | — | — | NAMED GAP |
| SendUserMessage | coordination | operator-io | — | block | no | — | — | — | NAMED GAP |
| Service | execution | service-management | 8 | block | no | — | service (full-execution-owner) | mercury://service, mercury://execution | scripts/project-services/prove-services.ts |
| SetTier | coordination | task-coordination | — | block | no | — | — | — | scripts/autopilot/run-all.sh |
| Skill | coordination | capability-discovery | — | block | no | — | — | — | NAMED GAP |
| Sleep | observation | scheduling | — | block | no | — | — | — | scripts/tools/prove-sleep-tool.ts |
| Structure | mutation | structural-mutation, code-intelligence | 4 | block | yes | structure.apply +receipts | — | mercury://structure, mercury://receipt | scripts/builtin-tools/prove-structure-transform.ts |
| TaskCreate | mutation | task-coordination | — | block | yes | — | — | mercury://task | NAMED GAP |
| TaskGet | observation | task-coordination | — | block | yes | — | — | mercury://task | NAMED GAP |
| TaskList | observation | task-coordination | — | block | yes | — | — | mercury://task | NAMED GAP |
| TaskOutput | observation | task-coordination | — | block | yes | — | — | mercury://task, mercury://agent | NAMED GAP |
| TaskStop | coordination | task-coordination | — | block | yes | — | — | mercury://task | NAMED GAP |
| TaskUpdate | mutation | task-coordination | — | block | yes | — | — | mercury://task | NAMED GAP |
| TeamBrief | coordination | task-coordination | — | block | no | — | — | mercury://team | NAMED GAP |
| TeamCreate | coordination | task-coordination | — | block | yes | — | — | mercury://team | NAMED GAP |
| TeamDelete | coordination | task-coordination | — | block | yes | — | — | mercury://team | NAMED GAP |
| Test | execution | application-verification | 5 | block | yes | — | background-job (external-projection) | mercury://test | scripts/ide/prove-python-tests.ts |
| TodoWrite | coordination | planning | — | block | yes | — | — | — | NAMED GAP |
| ToolSearch | observation | capability-discovery | — | block | no | — | — | — | scripts/builtin-tools/prove-toolsearch-capability.ts |
| Transaction | coordination | application-verification | 6 | block | yes | — | — | mercury://ide | scripts/ide/prove-closed-loop.ts |
| WebFetch | observation | web-access | — | block | yes | — | — | — | NAMED GAP |
| WebSearch | observation | web-access | — | block | yes | — | — | — | scripts/search/run-all.sh |
| Workflow | coordination | task-coordination | — | block | yes | — | workflow-worker (child-execution) | mercury://workflow | scripts/workflows/run-all.sh |
| Workshop | execution | persistent-evaluation | — | block | no | workshop +receipts | workshop-js (full-execution-owner) | mercury://execution, mercury://artifact | scripts/project-services/prove-workshop.ts |
| Write | mutation | text-mutation | — | block | no | file +receipts | — | mercury://file, mercury://receipt | scripts/project-services/prove-change-receipts.ts |

## Reading notes

- **class** — declared contract class; pre-declaration rows show the
  isReadOnly-probe-derived `observation` or `unclassified` (honest gap).
- **cancel** — `cancel` stops the call on operator steer; `block` queues
  the new message (the Tool.interruptBehavior contract).
- **transactions / execution / resources** — DECLARED integrations only;
  every declared claim is mechanically cross-checked by the constitution
  gate (flagRegistry · EXECUTION_DOMAIN_CENSUS · the resource registry ·
  proof paths on disk). `—` = not declared (a named gap, not a denial).
- Uniform properties not repeated per-row: every catalog tool is reachable
  from Workshop (`mercury.tool`) and workflow agents unless its contract
  declares otherwise; every tool is available in all permission modes
  except SetTier (autopilot-mode-narrowed in toolPool).
