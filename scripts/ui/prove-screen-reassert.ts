import { readFileSync } from 'node:fs';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

const ink = readFileSync('src/ink/ink.tsx', 'utf8');
const delivery = readFileSync('src/ink/session/delivery.ts', 'utf8');
const editor = readFileSync('src/utils/promptEditor.ts', 'utf8');

console.log('— 1. transactional handover depth —');
check('the depth field exists', ink.includes('private editorHandoverDepth = 0;'));
check(
  'enter ARMS before the composite write',
  /editorHandoverDepth \+= 1;[\s\S]{0,400}enterEditorBytes\(/.test(ink),
);
check(
  'an unmatched exit COLLAPSES into the reassert (never a second release)',
  /exitAlternateScreen\(\): void \{[\s\S]{0,600}if \(this\.editorHandoverDepth === 0\) \{\s*\n\s*this\.reassertScreenState\('unmatched-exit-collapsed'\);\s*\n\s*return;/.test(ink),
);
check(
  'a matched exit consumes the depth before writing',
  /editorHandoverDepth -= 1;[\s\S]{0,500}exitEditorBytes\(/.test(ink),
);

console.log('— 2. the reassert (field-proven cure) —');
check(
  '?1049h re-emits ONLY under believed-alt',
  /reassertScreenState\(reason: string[\s\S]{0,700}if \(this\.altScreenActive\) \{\s*\n\s*termWrite\(this\.options\.stdout, ENTER_ALT_SCREEN, 'mode'\);/.test(ink),
);
check(
  '…with the frame reset + atomic first-paint erase',
  /termWrite\(this\.options\.stdout, ENTER_ALT_SCREEN, 'mode'\);\s*\n\s*this\.resetFramesForAltScreen\(\);\s*\n\s*this\.needsEraseBeforePaint = true;/.test(ink),
);
check(
  '…and the ledger contaminate (full recompose, never a blit of the stale model)',
  /reassertScreenState\(reason: string[\s\S]{0,1200}this\.ledger\.contaminate\('self-heal'\);/.test(ink),
);
check(
  'the reassert is COUNTED (recurrence telemetry the freeze lacked)',
  ink.includes('screenReassertCount += 1'),
);
check(
  'in-render callers defer the repaint (no recursion into onRender)',
  /if \(opts\.repaint !== false\) this\.repaint\(\);/.test(ink),
);

console.log('— 3. the zero-byte-render watchdog (ARMED-WINDOW ONLY) —');
check(
  'the watchdog is inert outside its armed window (a blind reassert IS the iTerm2 blank — proven live)',
  /if \(this\.watchdogCommitsRemaining > 0\) \{\s*\n\s*this\.watchdogCommitsRemaining -= 1;/.test(ink),
);
check(
  'inside the window: the streak counts clean-diff commits ONLY while believed-alt',
  /watchdogCommitsRemaining -= 1;\s*\n\s*if \(this\.altScreenActive && !hasDiff\) \{\s*\n\s*this\.zeroByteRenderStreak \+= 1;/.test(ink),
);
check(
  'the threshold trips ONCE (window disarms) into a deferred reassert',
  /zeroByteRenderStreak >= 5\) \{[\s\S]{0,260}watchdogCommitsRemaining = 0;\s*\n\s*this\.reassertScreenState\('zero-byte-watchdog', \{ repaint: false \}\)/.test(ink),
);
check('any real diff resets the streak', /\} else \{\s*\n\s*this\.zeroByteRenderStreak = 0;\s*\n\s*\}\s*\n\s*\}/.test(ink));
check(
  'the arming seams are the field-suspicion set: SIGCONT re-enter + stdin resume (handover exit rides resume)',
  /reenterAltScreen\(\);[\s\S]{0,220}this\.armScreenWatchdog\(\);/.test(ink) &&
    /this\.reconcileSize\(\);\s*\n\s*\/\/ F1′[\s\S]{0,120}this\.armScreenWatchdog\(\);\s*\n\s*\}/.test(ink),
);
check(
  'the 30s idle-gap heal is RETAINED beside it (external-write drift stays covered — recorded adjudication)',
  ink.includes("this.ledger.contaminate('self-heal');") && ink.includes('> 30_000'),
);

console.log('— adjacent seams —');
check(
  "resumeStdin's live-fired desync branch reasserts instead of proceeding blind",
  /possible desync[\s\S]{0,600}reassertScreenState\('resume-desync'\)/.test(ink),
);
check(
  'the prompt editor refuses re-entry while a handover is armed (site 3)',
  editor.includes('if (editorSessionActive) {') &&
    /editorSessionActive = true\s*\n\s*try \{\s*\n\s*return await editFileInEditorInner\(filePath\)\s*\n\s*\} finally \{\s*\n\s*editorSessionActive = false/.test(editor),
);
check(
  'the delivery writer never emits a naked BSU/ESU pair (TASK-004 idle fact)',
  /const body = serializePatches\(diff\)\s*\n\s*if \(body === ''\) return true/.test(delivery),
);

console.log('— F2: win32 size reconciliation —');
check(
  'reconcileSize is win32-gated, asks the console through the runtime refresh road, and falls back to the ONE drift-detecting handler (FN-015 rank 43)',
  /reconcileSize\(\): void \{\s*\n\s*if \(process\.platform !== 'win32'\) return;\s*\n(?:\s*\/\/[^\n]*\n)*\s*if \(!refreshConsoleSize\(this\.options\.stdout\)\) this\.handleResize\(\);/.test(ink),
);
check(
  'the low-frequency win32 tick exists, unrefs, and clears with the TTY handlers',
  /\? setInterval\(\(\) => this\.reconcileSize\(\), 5_000\)/.test(ink) &&
    ink.includes('win32SizeTimer?.unref?.();') &&
    ink.includes('if (win32SizeTimer !== null) clearInterval(win32SizeTimer)'),
);
check(
  'the raw-mode re-enable seam reconciles (suspended windows queue records undrained)',
  /this\.wasRawMode = false;\s*\n\s*\}\s*\n\s*\/\/ F2[\s\S]{0,220}this\.reconcileSize\(\);/.test(ink),
);

console.log(fail === 0 ? '\n✅ SCREEN-REASSERT GREEN' : '\n❌ SCREEN-REASSERT RED');
process.exit(fail);
