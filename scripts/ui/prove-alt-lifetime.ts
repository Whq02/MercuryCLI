// prove-alt-lifetime — the alternate screen's lifetime is decoupled from
// mouse arming, and a launcher-held buffer is taken over atomically
//
//
// Two bug classes closed:
//   a. /mouse toggle tore the WHOLE buffer down: the REPL root passes the
//      LIVE isMouseTrackingEnabled() as the mouseTracking prop, and the
//      alt-screen effect listed the prop in its deps — every toggle ran the
//      depth-1→0 cleanup (EXIT_ALT_SCREEN) + re-entry, a full-screen flash
//      for an input-mode change whose escapes /mouse's live setter already
//      writes. The prop is now a mount-time ref read; deps = [writeRaw].
//   b. Boot black beat: the splash hands over INSIDE a held alt buffer
//      ("taking the deck…"), and the root mount re-entered (?1049h — a
//      buffer clear on iTerm2) + 2J'd it long before React's first frame.
//      The launcher now marks the hold (MERCURY_ALT_HELD, one-shot); the
//      outermost mount skips enter/clear and arms ink.armAltScreenTakeover()
//      — the first frame carries the erase INSIDE its one atomic write. An
//      early exit with the hold unconsumed releases the buffer.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

// ── a. lifetime ≠ arming ────────────────────────────────────────────────────
const alt = readFileSync('src/ink/components/AlternateScreen.tsx', 'utf8');
check(
  'alt-screen effect deps exclude the mouse prop (lifetime never cycles on it)',
  // Deps gained inkFromContext at native-core T6 (the context that
  // replaced the hardwired instances.get(process.stdout)) — both are
  // mount-stable; the invariant is that mouseTracking stays OUT.
  alt.includes('}, [writeRaw, inkFromContext]);') && !alt.includes('mouseTracking]'),
);
check(
  'mouse pref read through a mount-time ref',
  alt.includes('mouseTrackingRef.current') && alt.includes('const mouseTrackingRef = useRef(mouseTracking)'),
);
check(
  'final exit disables tracking unconditionally (mid-life /mouse on covered)',
  alt.includes('DISABLE_ALTERNATE_SCROLL + DISABLE_MOUSE_TRACKING + EXIT_ALT_SCREEN'),
);

// ── b. launcher-hold takeover ───────────────────────────────────────────────
check(
  'outermost mount skips ENTER/2J when the launcher holds the buffer',
  alt.includes('const launcherHolds = consumeLauncherAltHold();') &&
    alt.includes("writeRaw(RESET_SCROLL_REGION + '\\x1b[0m' + armBytes);"),
);
// The NO-HOLD mount defers the WHOLE entry (switch + wipe + arming) into the
// first non-empty frame's atomic write — the surface below stays visible
// until the alt face exists (the onboarding blank-and-torn class). Bare
// mounts without an instance keep the immediate write.
check(
  'no-hold mount defers entry through ink.armAltScreenEntry',
  alt.includes('ink.armAltScreenEntry(ENTER_ALT_SCREEN + RESET_SCROLL_REGION') &&
    !alt.includes("writeRaw(\n        (launcherHolds ? '' : ENTER_ALT_SCREEN)"),
);
{
  const inkSrcEarly = readFileSync('src/ink/ink.tsx', 'utf8');
  check(
    'armAltScreenEntry flushes only into a NON-EMPTY frame write',
    /pendingAltEntry !== null && this\.altScreenActive && hasDiff/.test(inkSrcEarly),
  );
  check(
    'an armed entry dies when the alt mode drops before flushing',
    /setAltScreenActive\(active[\s\S]{0,900}pendingAltEntry = null/.test(inkSrcEarly),
  );
}
check(
  'takeover arms the atomic first-frame erase',
  alt.includes('if (launcherHolds) ink?.armAltScreenTakeover();'),
);
const ink = readFileSync('src/ink/ink.tsx', 'utf8');
check(
  'armAltScreenTakeover rides the SAME atomic seam as resize (needsEraseBeforePaint)',
  /armAltScreenTakeover\(\): void \{\s*\n\s*this\.needsEraseBeforePaint = true;/.test(ink),
);

// One-shot module semantics, exercised in a subprocess with the env set:
// pending → consume true → consume false → env deleted (children never
// inherit a claim about this process's terminal).
const out = execFileSync(
  process.execPath.includes('bun') ? process.execPath : `${process.env.HOME}/.bun/bin/bun`,
  [
    '-e',
    `const m = await import('./src/ink/launcherAltHold.ts');
     console.log(JSON.stringify([m.launcherAltHoldPending(), m.consumeLauncherAltHold(), m.consumeLauncherAltHold(), process.env.MERCURY_ALT_HELD ?? null]));`,
  ],
  { encoding: 'utf8', env: { ...process.env, MERCURY_ALT_HELD: '1' } },
).trim();
check(
  'one-shot semantics: pending → consumed once → env deleted',
  out === '[true,true,false,null]',
  out,
);
const module_ = readFileSync('src/ink/launcherAltHold.ts', 'utf8');
check(
  // 3.6.2 (UI-037): the release set gained ?1007l — the hold frame arms
  // alternate scroll, so the safety net releases EXACTLY the transferred
  // modes (SGR reset · alternate-scroll off · alt screen closed · cursor).
  'early-exit safety net releases an unconsumed hold',
  module_.includes("process.on('exit'") && module_.includes('\\x1b[0m\\x1b[?1007l\\x1b[?1049l\\x1b[?25h'),
);

// ── launcher side: the marker is exported exactly when the splash holds ─────
// the settled screen fact rides the splash's EXIT CODE
// now (0 = held handoff) — the launcher marks alt-held only on that number,
// still NO_FLICKER-gated, inside the managed splash-action block.
const launcher = readFileSync('scripts/ops/launcher-mercury.sh', 'utf8');
check(
  'launcher exports MERCURY_ALT_HELD=1 on the exit-0 held handoff, NO_FLICKER-gated',
  launcher.includes('export MERCURY_ALT_HELD=1') &&
    launcher.includes('[ "$MERCURY_SA_EXIT" = "0" ] && [ "${MERCURY_FULLSCREEN:-}" != "0" ]'),
);

process.exit(fail);
