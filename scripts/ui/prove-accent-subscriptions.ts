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
  const subscribes =
    src.includes('useSessionAccent') || src.includes('useMercuryTokens');
  const plainReads = /\bgetSessionAccent\s*\(/.test(src);
  check(`${file.split('/').pop()} subscribes (useSessionAccent/useMercuryTokens)`, subscribes);
  check(`${file.split('/').pop()} has no plain getSessionAccent() read`, !plainReads);
}

process.exit(fail);
