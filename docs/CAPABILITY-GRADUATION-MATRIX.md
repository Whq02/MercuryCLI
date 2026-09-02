# Capability graduation matrix

The truth table for Mercury's user-facing capabilities: what is live, what is opt-in,
what is deliberately parked, and what has left the tree. Every row carries a verdict
from the closed vocabulary, the flag (or `N/A`) that governs it, a source anchor that
must exist on disk, and a proof — a suite or prover file for live rows, a stated
reason for non-live ones. `scripts/capabilities/run-all.sh` is the anti-rot gate:
`prove-matrix-complete.ts` parses these tables and fails the suite when a row is
incomplete or cites a file that no longer exists, `prove-capability-wiring.ts`
asserts the listed implementation symbols have real runtime consumers, and
`prove-readiness.ts` proves the readiness truth center's honesty laws.

Verdict vocabulary: `LIVE_DEFAULT_ON` (present without any arming), `LIVE_OPT_IN`
(present behind an explicit flag or sign-in), `PARKED_INTENTIONAL` (machinery kept,
deliberately inert), `DEAD_VENDORED`, `BROKEN`, `UNKNOWN`, `DELETED` (machinery
removed from the tree; the proof names the sweep that keeps it out). Flag polarity
and off-contracts live in the in-code registry (`src/substrate/flagRegistry.ts`;
rendered on demand to an untracked path).

## Session, prompt, and UI

| Capability | Verdict | Flag / Default | Source anchor | Proof |
| --- | --- | --- | --- | --- |
| MercuryFrame statusbar | `LIVE_DEFAULT_ON` | `N/A` | `src/components/MercuryFrame.tsx` | `scripts/capabilities/run-all.sh` |
| FullscreenLayout (alternate-screen shells) | `LIVE_DEFAULT_ON` | `N/A` | `src/components/FullscreenLayout.tsx` | `scripts/capabilities/run-all.sh` |
| /cockpit board | `LIVE_DEFAULT_ON` | `N/A` | `src/components/CockpitView.tsx` · `src/commands/cockpit/index.ts` | `scripts/capabilities/run-all.sh` |
| Warm background paint | `LIVE_DEFAULT_ON` | `MERCURY_WARM_BG` (value knob) | `src/utils/cockpit/warmBackground.ts` | `scripts/capabilities/run-all.sh` |
| Apollo Mode (pre-flight interview) | `LIVE_DEFAULT_ON` | `N/A` (mode; poll budget setting `apollo.preflightQuestions`) | `src/prompt/apolloMode.ts` | `scripts/apollo/prove-apollo-mode.ts` |
| Readiness truth center | `LIVE_DEFAULT_ON` | `N/A` | `src/utils/readiness.ts` | `scripts/capabilities/prove-readiness.ts` |
| render_tui MCP render-verify tool | `LIVE_DEFAULT_ON` | `N/A` | `src/services/mcp/renderTuiTool.ts` | `scripts/capabilities/run-all.sh` |
| Skill discovery (skill tool commands) | `LIVE_DEFAULT_ON` | `N/A` | `src/commands.ts` | `scripts/capabilities/run-all.sh` |
| Session transcripts (versioned record format) | `LIVE_DEFAULT_ON` | `N/A` | `src/utils/sessionStorage/vnext.ts` | `scripts/sessionStorage/run-all.sh` |
| Session Concourse (multi-session home board) | `LIVE_DEFAULT_ON` | `MERCURY_CONCOURSE` (startup policy; `off` default — `/concourse` reaches the board regardless) | `src/components/concourse/ConcourseRoute.tsx` · `src/commands/concourse/index.ts` · `src/context/surfaceRoute.ts` | `scripts/notifications/prove-concourse-surface-live.ts` |
| Prompts panel (/workbench) | `LIVE_DEFAULT_ON` | `MERCURY_WORKBENCH` | `src/commands/workbench/index.ts` · `src/services/workbench/contracts.ts` | `scripts/prompts-panel/run-all.sh` |
| Critters (session identity mascots: accent picker · hero · idle/gaze/sleep) | `LIVE_DEFAULT_ON` | `MERCURY_CRITTER` (value knob) + `MERCURY_CRITTER_IDLE`/`_GAZE`/`_SLEEP` | `src/commands/critter/index.ts` · `src/components/mercury-ui/sessionAccent.ts` | `scripts/critters/run-all.sh` |
| Live tiles (every board row streams its session's NOW cell; `→` peeks in place) | `LIVE_DEFAULT_ON` | `N/A` (rides the concourse board) | `src/components/concourse/liveTiles.ts` | `scripts/switchboard/prove-live-tiles.ts` |
| Pings (one bell tap when a session needs you or finishes; the ⚑ strip badge; `/pings`) | `LIVE_DEFAULT_ON` | `N/A` (persisted `/pings` toggle; on by default) | `src/services/pings/pingEngine.ts` · `src/commands/pings/index.ts` | `scripts/pings/prove-ping-engine.ts` |
| Warm runner (the pre-booted session runner behind the first paint) | `LIVE_DEFAULT_ON` | `MERCURY_WARM_RUNNER` (`=0` off) | `src/daemon/warmRunner.ts` | `scripts/daemon/prove-warm-runner.ts` |
| Work scope (`/tasks`, `/workflows` and the board's work chip follow the focused session) | `LIVE_DEFAULT_ON` | `N/A` | `src/utils/task/workRoster.ts` · `src/components/tasks/useFocusedWork.ts` | `scripts/engine-connector/prove-work-scope.ts` |
| Settings schema (Mercury's own, generated from the validator and refreshed into the config home) | `LIVE_DEFAULT_ON` | `N/A` | `src/utils/settings/localSchema.ts` | `scripts/settings/prove-settings-schema.ts` |
| Foreign-harness detection (`/health` Store isolation, by Mercury's own fingerprint) | `LIVE_DEFAULT_ON` | `N/A` (rides `MERCURY_DOCTOR_CERT`) | `src/utils/knownAgentClis.ts` | `scripts/health/prove-foreign-harness-inversion.ts` |

## Teams, scribe, and autonomy

| Capability | Verdict | Flag / Default | Source anchor | Proof |
| --- | --- | --- | --- | --- |
| Agent teams (in-process teammates) | `LIVE_DEFAULT_ON` | `MERCURY_SWARMS` (`=0` off) | `src/utils/agentSwarmsEnabled.ts` | `scripts/swarm/run-all.sh` |
| Team roster lock (concurrent appends) | `LIVE_DEFAULT_ON` | `N/A` | `src/utils/swarm/teamHelpers.ts` | `scripts/substrate/prove-team-roster-lock.ts` |
| SendMessage governance | `LIVE_DEFAULT_ON` | `N/A` | `src/utils/swarm/sendMessageGovernance.ts` | `scripts/capabilities/run-all.sh` |
| Honesty-gated handoff | `LIVE_DEFAULT_ON` | `N/A` | `src/utils/swarm/handoff.ts` | `scripts/capabilities/run-all.sh` |
| TeamBrief tool | `LIVE_DEFAULT_ON` | `MERCURY_BRIEF` (mixed polarity per context) | `src/tools/TeamBriefTool/TeamBriefTool.ts` | `scripts/capabilities/run-all.sh` |
| Scribe mode | `LIVE_OPT_IN` | `MERCURY_SCRIBE` | `src/utils/scribeMode.ts` | `scripts/scribe/run-all.sh` |
| Scribe candidate ratify (/scribe-promote) | `LIVE_DEFAULT_ON` | `N/A` | `src/memdir/scribePromote.ts` | `scripts/capabilities/run-all.sh` |
| Autopilot | `LIVE_OPT_IN` | `MERCURY_AUTOPILOT` | `src/utils/autopilot/autopilotGates.ts` | `scripts/autopilot/run-all.sh` |

## Tool planes

| Capability | Verdict | Flag / Default | Source anchor | Proof |
| --- | --- | --- | --- | --- |
| Workflows engine | `LIVE_DEFAULT_ON` | `MERCURY_WORKFLOWS` | `src/tools/WorkflowTool/workflowEnablement.ts` | `scripts/workflows/run-all.sh` |
| Task lists | `LIVE_DEFAULT_ON` | `MERCURY_TASKS` (force-on; interactive default) | `src/utils/tasks.ts` | `scripts/task-durability/run-all.sh` |
| ChangeSet (atomic multi-file change) | `LIVE_DEFAULT_ON` | `MERCURY_CHANGESET` | `src/services/changeTransaction/changeSetContracts.ts` | `scripts/changesets/prove-changeset-flag.ts` |
| Structure tool | `LIVE_DEFAULT_ON` | `MERCURY_STRUCTURE` | `src/services/structure/contracts.ts` | `scripts/builtin-tools/prove-structure-transform.ts` |
| AstSearch / AstEdit (structural search and rewrite) | `LIVE_DEFAULT_ON` | `MERCURY_STRUCTURE_POLYGLOT` | `src/utils/astPatterns.ts` | `scripts/ast-tools/run-all.sh` |
| Git work-graph resources | `LIVE_DEFAULT_ON` | `MERCURY_GIT_GRAPH` | `src/services/gitGraph/contracts.ts` | `scripts/builtin-tools/prove-git-plans.ts` |
| Journey tool | `LIVE_DEFAULT_ON` | `MERCURY_JOURNEYS` | `src/services/journeys/contracts.ts` | `scripts/builtin-tools/prove-journeys.ts` |
| mercury:// reference plane | `LIVE_DEFAULT_ON` | `MERCURY_REFS` | `src/services/resources/contracts.ts` | `scripts/project-services/run-all.sh` |
| Project services | `LIVE_DEFAULT_ON` | `MERCURY_SERVICES` | `src/services/projectServices/contracts.ts` | `scripts/project-services/run-all.sh` |
| Workshop (persistent code cells) | `LIVE_DEFAULT_ON` | `MERCURY_WORKSHOP` | `src/services/workshop/contracts.ts` | `scripts/project-services/run-all.sh` |
| LSP bridge | `LIVE_DEFAULT_ON` | `MERCURY_LSP` | `src/services/lsp/mercuryLsp.ts` | `scripts/lsp/prove-lsp-e2e.ts` |
| Debug tool (DAP) | `LIVE_DEFAULT_ON` | `MERCURY_DAP` | `src/services/dap/dapClient.ts` | `scripts/dap/prove-dap.ts` |
| Browser tool | `LIVE_DEFAULT_ON` | `MERCURY_BROWSER` | `src/tools/BrowserTool/BrowserTool.ts` | `scripts/language-sidecars/prove-browser-resolution.ts` |
| IDE transaction loop | `LIVE_DEFAULT_ON` | `MERCURY_IDE_LOOP` | `src/services/ide/ideTransaction.ts` | `scripts/ide/prove-closed-loop.ts` |
| Vulcan (Godot editor control) | `LIVE_OPT_IN` | `MERCURY_GODOT_TOOLS` | `src/utils/vulcan/vulcanGates.ts` | `scripts/vulcan/run-all.sh` |

## Notepad and scheduling

| Capability | Verdict | Flag / Default | Source anchor | Proof |
| --- | --- | --- | --- | --- |
| Tabula (Minerva's room over the saved prompts; the project notepad file) | `LIVE_DEFAULT_ON` | `MERCURY_TABULA` | `src/utils/tabula/tabulaStore.ts` · `src/components/tabula/MinervaRoom.tsx` | `scripts/tabula/run-all.sh` |
| Minerva curator | `LIVE_OPT_IN` | `MERCURY_TABULA_MINERVA` | `src/utils/tabula/minerva.ts` | `scripts/tabula/prove-minerva.ts` |
| Sub-model containers (/submodels) | `LIVE_DEFAULT_ON` | `MERCURY_MINERVA_MODEL` · `MERCURY_CONSOLE_MODEL` (pins) | `src/utils/model/subModelSlots.ts` | `scripts/model-registry/prove-submodels.ts` |
| Saturn scheduling (session schedules + tools + engine) | `LIVE_DEFAULT_ON` | `MERCURY_SATURN_DISABLE` (kill switch) | `src/daemon/saturnTicker.ts` | `scripts/daemon/prove-saturn-core.ts` |
| Catch-up window (late fires) | `LIVE_DEFAULT_ON` | `MERCURY_DAEMON_CATCHUP` | `src/daemon/saturnTicker.ts` | `scripts/daemon/prove-saturn-core.ts` |

## Engines

Recognition for every family is always on (the routing law); dispatch refuses honestly
without a credential. The two newest lanes carry a deferred-live caveat in their own
headers and readiness detail until verified against a live endpoint.

| Capability | Verdict | Flag / Default | Source anchor | Proof |
| --- | --- | --- | --- | --- |
| Anthropic engine (home lane) | `LIVE_DEFAULT_ON` | `N/A` | `src/services/providers/anthropic/index.ts` | `scripts/core-runtime/prove-provider-contract.ts` |
| OpenAI engine | `LIVE_DEFAULT_ON` | `N/A` (credential-gated) | `src/services/providers/openai/openaiCallModel.ts` | `scripts/provider-compat/run-all.sh` |
| Z.AI engine | `LIVE_DEFAULT_ON` | `N/A` (credential-gated) | `src/services/providers/zai/zaiCallModel.ts` | `scripts/provider-compat/run-all.sh` |
| Moonshot engine | `LIVE_DEFAULT_ON` | `N/A` (credential-gated) | `src/services/providers/moonshot/moonshotCallModel.ts` | `scripts/provider-compat/run-all.sh` |
| DeepSeek engine | `LIVE_DEFAULT_ON` | `N/A` (credential-gated) | `src/services/providers/deepseek/deepseekCallModel.ts` | `scripts/provider-compat/run-all.sh` |
| Gemini engine | `LIVE_DEFAULT_ON` | `N/A` (credential-gated) | `src/services/providers/gemini/geminiCallModel.ts` | `scripts/provider-compat/run-all.sh` |
| OpenRouter engine | `LIVE_DEFAULT_ON` | `N/A` (credential-gated) | `src/services/providers/openrouter/openrouterCallModel.ts` | `scripts/provider-compat/run-all.sh` |
| Custom endpoint (compat slot) | `LIVE_DEFAULT_ON` | `N/A` (operator-named endpoint + key) | `src/services/providers/openaicompat/compatCallModel.ts` | `scripts/provider-compat/prove-compat-chat-transport.ts` |
| Hugging Face engine (deferred-live caveat) | `LIVE_DEFAULT_ON` | `N/A` (credential-gated) | `src/services/providers/huggingface/huggingfaceCallModel.ts` | `scripts/provider-compat/prove-huggingface-catalogue.ts` |
| Local models engine (deferred-live caveat) | `LIVE_DEFAULT_ON` | `N/A` (discovered servers) | `src/services/providers/local/localCallModel.ts` | `scripts/provider-compat/run-all.sh` |
| Multi-auth wallet (provider accounts: slots · identity · re-auth · failover widening) | `LIVE_DEFAULT_ON` | `N/A` (per-family sign-in via `/logins`; `/accounts` is the surface) | `src/services/wallet/wallet.ts` · `src/commands/accounts/index.ts` | `scripts/accounts/run-all.sh` |
| Session model arms (a session dispatches on any credentialed family, economy tier included; the crew arm stays frontier-only; typed refusals carry their action) | `LIVE_DEFAULT_ON` | `N/A` | `src/services/concourse/workerModels.ts` | `scripts/switchboard/prove-session-model-arms.ts` |
| Per-provider limit warning (whichever provider the session runs on, from its own signals) | `LIVE_DEFAULT_ON` | `N/A` | `src/services/providers/limitWarning.ts` | `scripts/usage-warning/run-all.sh` |
| Default provider (the provider of the most recent sign-in, from the sign-in ledger; `/defaultprovider` switches it by the operator's word) | `LIVE_DEFAULT_ON` | `N/A` (the sign-in ledger; the older config record orders untimed credentials only) | `src/utils/model/computedDefault.ts` | `scripts/default-model/run-all.sh` · `scripts/default-provider/run-all.sh` |

## Parked and deleted

| Capability | Verdict | Flag / Default | Source anchor | Proof |
| --- | --- | --- | --- | --- |
| Per-account model-limit fetch | `PARKED_INTENTIONAL` | `N/A` | `src/utils/model/modelCapabilities.ts` | eligibility is hard-disabled (an early unconditional false): lookups return nothing and refresh is a no-op — the declared behaviour any rebuild must preserve |

## Roll-up (61 capabilities classified)

| Verdict | Count |
| --- | --- |
| `LIVE_DEFAULT_ON` | 56 |
| `LIVE_OPT_IN` | 4 |
| `PARKED_INTENTIONAL` | 1 |

## Extending the matrix

Add a capability by adding a row: a live verdict needs a real `src/` anchor and a real
proof file (`run-all.sh` or `prove-*`), a non-live verdict needs a stated reason, and
the roll-up counts must re-tally — `prove-matrix-complete.ts` enforces all of it. When
a row cites `scripts/capabilities/run-all.sh` as its proof, add its implementation
symbol to the wiring list in `prove-capability-wiring.ts` so the severed-loop detector
covers it.
