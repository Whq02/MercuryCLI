// prove-accent-subscriptions — persistent/memoized identity-colored surfaces
// SUBSCRIBE to the session accent.
//
// The bug class: a React.memo'd or rarely-re-rendered surface that reads
// getSessionAccent() plainly keeps the OLD accent after /critter · /accent ·
// the Scribe glow — mixed old/new identity hues on screen until an unrelated
// re-render. useSessionAccent() (useSyncExternalStore) pierces memo and
// repaints in the same commit.
//
// Table-driven: each file below is standing chrome or a message renderer that
// must use the HOOK and must NOT plain-read. (Transient modal overlays that
// remount per open may still plain-read — deliberately not listed.
// MercuryHome's berthCritterCols is a pure layout FUNCTION mirrored by
// subscribed components — exempt. The thinking renderers paint the theme's
// subtle role through the thinking grammar, not the accent: they hold no
// subscription at all — prove-thinking-disclosure pins that absence.)
import { readFileSync } from 'node:fs';

let fail = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail}`);
  if (!cond) fail = 1;
};

const MUST_SUBSCRIBE = [
  'src/components/DeckPane.tsx',
  'src/components/messages/TaskAssignmentMessage.tsx',
  'src/components/messages/UserAgentNotificationMessage.tsx',
];

for (const file of MUST_SUBSCRIBE) {
  const src = readFileSync(file, 'utf8');
  // useMercuryTokens is an equally-valid subscription: it resolves through
  // useSessionAccent + useTheme (moved several surfaces
  // from raw accent paint onto the semantic token layer).
  const subscribes =
    src.includes('useSessionAccent') || src.includes('useMercuryTokens');
  const plainReads = /\bgetSessionAccent\s*\(/.test(src);
  check(`${file.split('/').pop()} subscribes (useSessionAccent/useMercuryTokens)`, subscribes);
  check(`${file.split('/').pop()} has no plain getSessionAccent() read`, !plainReads);
}

process.exit(fail);
