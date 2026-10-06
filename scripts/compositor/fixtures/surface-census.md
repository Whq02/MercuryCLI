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
| Resume Session picker (bare --resume: loading · picker · resuming · Chat swap) | `src/screens/ResumeConversation.tsx` | claims the held screen (<AlternateScreen> host; Chat swap rides the nested path) |
| Chat cockpit (direct boot / --continue / --resume <id>) | `src/screens/Chat.tsx → src/ink/components/AlternateScreen.tsx` | claims the held screen (outermost mount consumes + arms the takeover erase) |
| non-takeover argv paths (run · --help · subcommands · piped stdout) | `src/entrypoints/cli.tsx` | releases the hold before any output |

## Slash routes — modal-slot views (local-jsx: 48)

Host: the FullscreenLayout modal slot (opaque claim; SURFACE-CLAIM
INVARIANT forces height = terminalRows at peek 0). Kernel signals name
the interaction primitives the view actually mounts (1-hop join).

| route | kernel signals | unit |
|---|---|---|
| /accounts | ilist irow | `src/commands/accounts` |
| /agents | flat | `src/commands/agents` |
| /appearance | irow | `src/commands/appearance` |
| /caching | irow | `src/commands/caching` |
| /capabilities | — | `src/commands/capabilities` |
| /console | irow | `src/commands/console` |
| /context | — | `src/commands/context` |
| /contract | — | `src/commands/contract` |
| /copy | ilist irow | `src/commands/copy` |
| /crewmates | — | `src/commands/crewmates` |
| /critter | ilist | `src/commands/critter` |
| /daemon | — | `src/commands/daemon` |
| /defaultprovider | — | `src/commands/defaultprovider` |
| /diff | — | `src/commands/diff` |
| /effort | irow | `src/commands/effort` |
| /exit | — | `src/commands/exit` |
| /export | — | `src/commands/export` |
| /extensions | panes | `src/commands/extensions` |
| /feedback | — | `src/commands/feedback` |
| /health | irow | `src/commands/health` |
| /help | — | `src/commands/help` |
| /hooks | — | `src/commands/hooks` |
| /keys | irow | `src/commands/keys` |
| /keysetup | — | `src/commands/keysetup` |
| /logins | ilist irow | `src/commands/login` |
| /logout | — | `src/commands/logout` |
| /mcp | ilist irow | `src/commands/mcp` |
| /memory | flat irow | `src/commands/memory` |
| /mission | — | `src/commands/mission` |
| /model | irow | `src/commands/model` |
| /palette | — | `src/commands/palette` |
| /permissions | — | `src/commands/permissions` |
| /realms | ilist irow | `src/commands/realms` |
| /rename | — | `src/commands/rename` |
| /router | panes | `src/commands/router` |
| /run | irow | `src/commands/run` |
| /runs | — | `src/commands/tasks` |
| /samples | irow | `src/commands/samples` |
| /sandbox | — | `src/commands/sandbox-toggle` |
| /saturn | ilist irow | `src/commands/saturn` |
| /sessions | irow | `src/commands/sessions` |
| /showcase | — | `src/commands/showcase` |
| /skills | ilist irow | `src/commands/skills` |
| /submodels | ilist irow | `src/commands/submodels` |
| /title | — | `src/commands/title` |
| /trace | — | `src/commands/trace` |
| /workbench | panes | `src/commands/workbench` |
| /workflows | panes | `src/commands/workflows` |

## Slash routes — transcript prints (local: 19)

`/advise` · `/bootmenu` · `/browser` · `/clear` · `/compact` · `/concourse` · `/config` · `/jev` · `/keybindings` · `/kill` · `/localsetup` · `/mouse` · `/rewind` · `/seats` · `/subagents` · `/update-notes` · `/usage` · `/vim` · `/voice`

## Slash routes — model turns (prompt: 2)

`/review` · `/verify`

## Other route types (2)

`/audit` (addRules) · `/crew` (text)
