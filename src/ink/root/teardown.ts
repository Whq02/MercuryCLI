// ============================================================================
//  teardown.ts — T6: the exit mode-restore suite as DATA.
//
//  React's componentWillUnmount won't run in time when process.exit() is
//  called, so the terminal modes are reset synchronously here to prevent
//  escape leakage into the shell. Every disable is UNCONDITIONAL (except the
//  alt exit): terminal detection may have missed (tmux, screen) and the
//  sequences are no-ops where unsupported; altScreenActive itself can be
//  stale if AlternateScreen's unmount raced a blocked event loop + SIGINT —
//  which is exactly why the mouse/scroll disables don't consult it.
//
//  The ORDER is the contract (prove-root-contract LAW TEARDOWN pins it
//  byte-for-byte, both as this pure sequence and end-to-end in a child
//  process): the synchronized-update close comes first (a killed paint's
//  open bracket must not freeze the terminal through the restore), then
//  exit alt so everything else lands on the main screen;
//  drain stdin after the mouse/scroll disables so in-flight mouse events
//  don't leak to the shell; cursor back last-but-one; progress/tab OSCs
//  close.
//
//  The writer is INJECTED — production hands in a loss-proof synchronous
//  fd-1 writer (delivery's writeAllSync: EAGAIN-spin bounded, EPIPE-at-exit
//  tolerated); laws hand in a capture. The old body hardcoded fs.writeSync(1)
//  (the T6 fd-1 finding) — observable only on a real fd; this seam makes the
//  suite provable in-process.
// ============================================================================
import { DBP, DFE, DISABLE_ALTERNATE_SCROLL, DISABLE_MOUSE_TRACKING, ESU, EXIT_ALT_SCREEN, SHOW_CURSOR } from '../termio/dec.js'
import { DISABLE_KITTY_KEYBOARD, DISABLE_MODIFY_OTHER_KEYS } from '../termio/csi.js'
import { CLEAR_ITERM2_PROGRESS, CLEAR_TAB_STATUS, wrapForMultiplexer } from '../termio/osc.js'

export type TeardownStep =
  | { kind: 'bytes'; when: 'alt-only' | 'always' | 'tab-status'; bytes: string; why: string }
  | { kind: 'pointer-reset'; why: string }
  | { kind: 'drain-stdin'; why: string }

/** The suite, in contract order. */
export const TEARDOWN_SUITE: readonly TeardownStep[] = Object.freeze([
  {
    kind: 'bytes',
    when: 'always',
    bytes: ESU,
    why: 'close any open synchronized-update bracket FIRST — a paint killed between BSU and ESU must not leave the terminal frozen; a no-op when no bracket is open',
  },
  {
    kind: 'bytes',
    when: 'alt-only',
    bytes: EXIT_ALT_SCREEN,
    why: "AlternateScreen's unmount effect won't run during signal-exit; exit alt so the rest lands on the main screen",
  },
  {
    kind: 'bytes',
    when: 'always',
    bytes: DISABLE_MOUSE_TRACKING,
    why: 'unconditional — altScreenActive can be stale after a blocked loop + SIGINT; no-op if never enabled',
  },
  { kind: 'pointer-reset', why: "pointer shape back to the terminal's default (self-noops when never emitted)" },
  { kind: 'bytes', when: 'always', bytes: DISABLE_ALTERNATE_SCROLL, why: 'same staleness rule' },
  { kind: 'drain-stdin', why: "drain stdin so in-flight mouse events don't leak to the shell" },
  { kind: 'bytes', when: 'always', bytes: DISABLE_MODIFY_OTHER_KEYS, why: 'extended key reporting off' },
  { kind: 'bytes', when: 'always', bytes: DISABLE_KITTY_KEYBOARD, why: 'kitty keyboard pop' },
  { kind: 'bytes', when: 'always', bytes: DFE, why: 'focus events off (DECSET 1004)' },
  { kind: 'bytes', when: 'always', bytes: DBP, why: 'bracketed paste off' },
  { kind: 'bytes', when: 'always', bytes: SHOW_CURSOR, why: 'the cursor back' },
  { kind: 'bytes', when: 'always', bytes: CLEAR_ITERM2_PROGRESS, why: 'iTerm2 progress bar clear' },
  {
    kind: 'bytes',
    when: 'tab-status',
    bytes: '', // resolved at run time — wrapForMultiplexer is env-sensitive
    why: "tab status (OSC 21337) clear so a stale dot doesn't linger",
  },
])

export type TeardownHost = {
  altScreenActive: boolean
  tabStatusSupported: boolean
  /** Synchronous, must complete before process exit. */
  write: (bytes: string) => void
  drainStdin: () => void
  /** resetPointerShape — takes the writer so its own bytes ride the seam. */
  resetPointer: (write: (s: string) => void) => void
}

export function runTeardownSuite(host: TeardownHost): void {
  for (const step of TEARDOWN_SUITE) {
    switch (step.kind) {
      case 'bytes':
        if (step.when === 'alt-only' && !host.altScreenActive) break
        if (step.when === 'tab-status') {
          if (host.tabStatusSupported) host.write(wrapForMultiplexer(CLEAR_TAB_STATUS))
          break
        }
        host.write(step.bytes)
        break
      case 'pointer-reset':
        host.resetPointer(host.write)
        break
      case 'drain-stdin':
        host.drainStdin()
        break
    }
  }
}
