# Terminal profile and capability detection

Mercury checks the terminal it runs in and answers one question: does this
host satisfy the complete design, and if not, exactly what is missing and
what to do. The answer is the requirement card at boot, the terminal-profile
row of `/health`, and the trace view; the rows below are what it checks.

## The resolution

Every check row carries its id, a requirement class, the evidence consulted
(env var, latch, or sniff — and what it said), and a direct remediation.
The verdict is one of:

- `full` — every row passes; the complete design renders here.
- `capable` — the floor is met; some recommended capability is absent.
  Nothing is reduced: `required` is only the floor the design cannot render
  without, and a missing recommended row only informs the report card.
- `unsupported` — a required row failed. Interactive boot shows the
  requirement card **before** the main interface: the operator can exit (with the missing
  labels named, and the pointer that non-interactive use works anywhere via
  `--print`) or continue knowingly — never a silently degraded cockpit.

Consumers: the boot requirement surface, the `/health` terminal-profile
report card, and the trace view.

### Required rows (the floor)

| id | What it checks |
|---|---|
| `interactive-tty` | stdout is a TTY (piped and scripted use goes through `-p`) |
| `term-vocabulary` | a cursor-addressable terminal (`TERM=dumb` fails; win32 hosts legitimately run without `TERM` and are judged by their own rows) |
| `win32-conpty-host` (win32) | a ConPTY-era console — an OS-build fact first (Windows 10 build 17763 or newer means every console session is VT-capable), with host fingerprints only rescuing exotic builds |
| `win32-first-class-host` (win32) | the full Windows profile: Windows Terminal (stable) or the VS Code integrated terminal. Env fingerprints (`WT_SESSION`, `TERM_PROGRAM=vscode`) decide first; a fingerprint-less host is judged by the live synchronized-output latch, because Windows Terminal running as the OS default terminal attaches after the process starts and injects no fingerprint — the latch is the env-free witness that separates it from the legacy console. A host that announces a non-first-class identity (mintty/MSYS) never rides the latch through |

### Recommended rows (the complete experience)

| id | What it checks |
|---|---|
| `truecolor` | 24-bit color (`COLORTERM=truecolor|24bit`, or a known truecolor host: Windows Terminal, VS Code, iTerm2). A truecolor terminal renders the exact brand palette; reduced-depth hosts get the quantized mapping |
| `synchronized-output` | atomic frames (mode 2026) — no tearing under load |
| `extended-keys` | extended key reporting — more distinguishable chords |
| `hyperlinks` | OSC 8 hyperlinks — clickable file and evidence references |
| `progress-reporting` | OSC 9;4 — long-running work mirrored in the tab/taskbar |

Color is deliberately **not** required: `NO_COLOR` and 16-color hosts are
supported capability families with authored structural equivalents — a
no-color operator gets full Mercury, not a warning card.

## Capability detection

Every "can this terminal do X" answer comes from the environment first
(synchronized output, extended keys, progress, hyperlinks, clear
vocabulary, the win32 cursor-yank quirk), and two answers are upgraded
live:

- **Synchronized output** starts from the environment (known hosts; `tmux`
  deliberately answers no — it parses the markers but chunks frames and
  breaks atomicity) and is upgraded by a boot-time probe of mode 2026, so a
  frame painted after the probe sees the truth even when the boot-time read
  could not. `MERCURY_FORCE_SYNC_OUTPUT` (opt-in) forces it on for paint
  captures; tmux still wins.
- **The terminal's name**, asked of the terminal itself (XTVERSION), which
  survives SSH where `TERM_PROGRAM` does not.

## Input decoding

Keyboard input is read as a stream: a mouse report or escape sequence split
across two reads is finished on the next one rather than mis-read as
keystrokes, and a genuine lone Escape still interrupts. Under
the kitty keyboard protocol a non-Latin layout reports its own codepoint as
the key (Cyrillic ф arrives as 1092): plain typing inserts it, and a chord —
ctrl, alt, super — resolves its name from the base-layout subfield, the
physical key position, with the shifted subfield as the fallback, so ctrl+ф
is ctrl+a.

## Experience controls

The switches for Mercury's visible terminal behaviour are read live, and
every one of them is a row of the in-code registry
(`src/substrate/flagRegistry.ts`):

- `MERCURY_TERMINAL_TITLE` (default-on) — OSC 0/2 terminal-title updates,
  set at boot, cleared at shutdown.
- `MERCURY_ACCESSIBILITY` (opt-in) — screen-reader-friendly rendering:
  disables cursor-hide and live paint.
- `MERCURY_VIRTUAL_SCROLL` (default-on) — the transcript virtual-scroll
  surface.

Two more switches ride the capability profile: fullscreen and mouse
tracking (`MERCURY_FULLSCREEN`) and the terminal ground (`MERCURY_OASIS_BG`
— the background colour of the resolved appearance, set at interactive boot
and restored on exit, TTY-only: pure black on the True Black default, the
oasis navy when that appearance is chosen in `/appearance`).

## Reduced motion

Two inputs, either suffices:

- the `prefersReducedMotion` setting (toggled in `/config`);
- `MERCURY_REDUCED_MOTION=1` (registered; reaches the pre-boot splash too).

Reduced motion suppresses authored animation across the product: the launch
ripple, the greeting shimmer, live glyph animation, spinner and tool-use
ticking, and streaming paint effects. The appearance snapshot records the resulting
`motion: reduced | full` beside the color and theme facts, so captures and
diagnostics state the active profile plainly.
