// scripts/messages/bench-normalize.ts — R2 message-pipeline perf baseline.
//
// Times the hot normalization/lookup paths over a large synthetic session
// (the plan's ≥2k-message bar). Not a gate suite — run by hand; numbers land
// in the profiling record. The rewrite must not
// regress these (honest bar: where the path is already optimal the
// deliverable is ownership + "no regression", recorded truthfully).
//
//   bun run scripts/messages/bench-normalize.ts

import * as M from '../../src/utils/messages.ts';
import type { Message } from '../../src/types/message.ts';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as never;
const ts = (n: number) => new Date(1_750_000_000_000 + n * 1000).toISOString();

// 2,400-message synthetic session: 400 turns of user → assistant(2 tool_use)
// → 2 tool_result users → assistant text, with progress noise every 4 turns.
function buildSession(turns = 400): Message[] {
  const msgs: Message[] = [];
  let id = 0;
  for (let t = 0; t < turns; t++) {
    msgs.push(
      M.createUserMessage({ content: `turn ${t} request`, uuid: uuid(++id), timestamp: ts(id) }),
    );
    const tu1 = `toolu_${t}_a`;
    const tu2 = `toolu_${t}_b`;
    msgs.push(
      M.createAssistantMessage({
        content: [
          { type: 'tool_use', id: tu1, name: 'Read', input: { file_path: `/f${t}.ts` } },
          { type: 'tool_use', id: tu2, name: 'Bash', input: { command: `echo ${t}` } },
        ] as never,
      }) as Message,
    );
    if (t % 4 === 0) {
      msgs.push({
        type: 'progress',
        uuid: uuid(++id),
        timestamp: ts(id),
        data: { type: 'bash_progress', output: `partial ${t}` },
        toolUseID: tu2,
        parentToolUseID: tu2,
      } as never);
    }
    for (const tu of [tu1, tu2]) {
      msgs.push(
        M.createUserMessage({
          content: [
            { type: 'tool_result', tool_use_id: tu, content: [{ type: 'text', text: `result ${tu}` }] },
          ] as never,
          toolUseResult: { ok: true },
          uuid: uuid(++id),
          timestamp: ts(id),
        }),
      );
    }
    msgs.push(M.createAssistantMessage({ content: `turn ${t} done` }) as Message);
  }
  return msgs;
}

const session = buildSession();
const TOOLS = [{ name: 'Read' }, { name: 'Bash' }] as never;

function bench(label: string, iters: number, fn: () => unknown) {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = (performance.now() - t0) / iters;
  console.log(`${label.padEnd(38)} ${ms.toFixed(3)} ms/op   (${iters} iters, n=${session.length} msgs)`);
  return ms;
}

console.log(`message-pipeline bench — session of ${session.length} messages`);
const normalized = M.normalizeMessages(session) as never[];
bench('normalizeMessagesForAPI', 50, () => M.normalizeMessagesForAPI(session, TOOLS));
bench('normalizeMessages', 50, () => M.normalizeMessages(session));
bench('buildMessageLookups', 50, () => M.buildMessageLookups(normalized as never, session));
bench('reorderMessagesInUI', 50, () => M.reorderMessagesInUI(normalized as never, [] as never));
bench('reorderAttachmentsForAPI', 50, () => M.reorderAttachmentsForAPI(session));
bench('filterUnresolvedToolUses', 50, () => M.filterUnresolvedToolUses(session));
