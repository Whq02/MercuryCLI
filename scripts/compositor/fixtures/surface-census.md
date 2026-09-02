# compositor surface census — GENERATED (scripts/compositor/prove-surface-census.ts)

> Regenerate: `bun run scripts/compositor/prove-surface-census.ts --write`.
> The bare prover run DIFFS this file against the live tree — drift is RED.
> Rows derive from live route sources; this is a census, never a router.

## Estate invariants (laws, recorded once — the per-row columns they replace)

- **Background owner** — the S1 canvas model (`docs/TERMINAL-RUNTIME.md`
  the compositor): the epoch erase owns physical blankness in every claimed
  viewport; the OSC 11 ground rides ONE lifecycle owner (`oasisBg.ts`);
  repaired/vacated rectangles resolve to the effective ground
  (`prove-fill-law`).
- **Focus/selection identity** — kernel-owned (`useInteractiveList` /
  `NavigablePanes` / `useStableSelection`; helmFocus is sig-anchored);
  position-derived hover/hit ids are gate-RED (interaction law 5b).
- **Motion owner** — the ONE 80⊂160⊂320 clock lattice
  (`utils/cockpit/liveGlyphs.ts`); no surface-local timers.
- **Terminal-size behavior** — `computeChromeMode(columns, rows)` sheds
  cockpit→deck→inline; rails gate on `railPlan` (center ≥78).

## Boot surfaces — the S2 hold discipline (every row mechanically anchored)

| surface | source | hold discipline |
|---|---|---|
| setup dialogs (showDialog family — onboarding · trust · policy · api-key · teleport · invalid-settings) | `src/interactiveHelpers.tsx` | claims the held screen (SetupScreenHost stations under hold/fullscreen policy; bare inline only when the operator chose inline) |
| exit/error messages (exitWithMessage/exitWithError) | `src/interactiveHelpers.tsx` | releases the hold before inline render |
| Resume Session picker (bare --resume: loading · picker · resuming · REPL swap) | `src/screens/ResumeConversation.tsx` | claims the held screen (<AlternateScreen> host; REPL swap rides the nested path) |
| REPL cockpit (direct boot / --continue / --resume <id>) | `src/screens/REPL.tsx → src/ink/components/AlternateScreen.tsx` | claims the held screen (outermost mount consumes + arms the takeover erase) |
| non-takeover argv paths (-p · --help · subcommands · piped stdout) | `src/entrypoints/cli.tsx` | releases the hold before any output |

## Slash routes — modal-slot views (local-jsx: 78)

Host: the FullscreenLayout modal slot (opaque claim; SURFACE-CLAIM
INVARIANT forces height = terminalRows at peek 0). Kernel signals name
the interaction primitives the view actually mounts (1-hop join).

| route | kernel signals | unit |
|---|---|---|
| /accounts | ilist irow | `src/commands/accounts` |
| /add-dir | — | `src/commands/add-dir` |
| /agent-form | flat | `src/commands/agent-form` |
| /agents | flat | `src/commands/agents` |
| /appearance | irow | `src/commands/appearance` |
| /authority | irow | `src/commands/authority` |
| /branch | — | `src/commands/branch` |
| /caching | irow | `src/commands/caching` |
| /capabilities | — | `src/commands/capabilities` |
| /capabilities-detail | — | `src/commands/capabilities-detail` |
| /cards | — | `src/commands/cards` |
| /cockpit | irow | `src/commands/cockpit` |
| /color | — | `src/commands/color` |
| /config | — | `src/commands/config` |
| /console | irow | `src/commands/console` |
| /context | — | `src/commands/context` |
| /contract | — | `src/commands/contract` |
| /copy | irow | `src/commands/copy` |
| /critter | ilist | `src/commands/critter` |
| /daemon | — | `src/commands/daemon` |
| /defaultprovider | — | `src/commands/defaultprovider` |
| /diff | — | `src/commands/diff` |
| /effort | — | `src/commands/effort` |
| /exit | — | `src/commands/exit` |
| /export | — | `src/commands/export` |
| /extensions | panes | `src/commands/extensions` |
| /feedback | — | `src/commands/feedback` |
| /fleet | — | `src/commands/fleet` |
| /fullscreen | — | `src/commands/fullscreen` |
| /harness | ilist irow | `src/commands/harness` |
| /health | irow | `src/commands/health` |
| /help | — | `src/commands/help` |
| /home | irow | `src/commands/home` |
| /hooks | — | `src/commands/hooks` |
| /ide | — | `src/commands/ide` |
| /keys | irow | `src/commands/keys` |
| /ledger | panes | `src/commands/ledger` |
| /live | — | `src/commands/live` |
| /logins | irow | `src/commands/login` |
| /logout | — | `src/commands/logout` |
| /mcp | — | `src/commands/mcp` |
| /memory | irow | `src/commands/memory` |
| /mission | — | `src/commands/mission` |
| /model | irow | `src/commands/model` |
| /monitor | panes | `src/commands/monitor` |
| /palette | — | `src/commands/palette` |
| /permissions | — | `src/commands/permissions` |
| /plan | — | `src/commands/plan` |
| /policy | — | `src/commands/policy` |
| /provenance | — | `src/commands/provenance` |
| /realms | ilist irow | `src/commands/realms` |
| /rename | — | `src/commands/rename` |
| /resume | irow | `src/commands/resume` |
| /router | panes | `src/commands/router` |
| /run | irow | `src/commands/run` |
| /sandbox | — | `src/commands/sandbox-toggle` |
| /saturn | irow | `src/commands/saturn` |
| /session | irow | `src/commands/session` |
| /sessions | irow | `src/commands/sessions` |
| /sessiontab | — | `src/commands/sessiontab` |
| /showcase | — | `src/commands/showcase` |
| /skills | irow | `src/commands/skills` |
| /sovereign | — | `src/commands/sovereign` |
| /status | ilist irow | `src/commands/status` |
| /submodels | irow | `src/commands/submodels` |
| /substrate | — | `src/commands/substrate` |
| /supercode | ilist irow | `src/commands/supercode` |
| /surfaces | ilist irow | `src/commands/manager` |
| /tabula | — | `src/commands/tabula` |
| /tasks | — | `src/commands/tasks` |
| /team | — | `src/commands/team` |
| /teammates | — | `src/commands/teammates` |
| /terminal-setup | — | `src/commands/terminalSetup` |
| /title | — | `src/commands/title` |
| /trace | — | `src/commands/trace` |
| /usage | — | `src/commands/usage` |
| /workbench | panes | `src/commands/workbench` |
| /workflows | panes | `src/commands/workflows` |

## Slash routes — transcript prints (local: 28)

`/accent` · `/auto-compact-window` · `/bootmenu` · `/branches` · `/browser` · `/clear` · `/compact` · `/companion` · `/concourse` · `/cost` · `/counsel` · `/debrief` · `/good` · `/halt` · `/heapdump` · `/keybindings` · `/kill` · `/meh` · `/mock-limits` · `/mouse` · `/orient` · `/pings` · `/release-notes` · `/remember` · `/rewind` · `/supervisor` · `/themis` · `/vim`

## Slash routes — model turns (prompt: 3)

`/init` · `/review` · `/verify`

## Other route types (5)

`/crew` (text) · `/party` (text) · `/pr-comments` (text) · `/project_areas` (asyncAgent) · `/security-review` (addRules)
