import { featureReached } from '../../../platform/substrate/featureReached.js';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { getCwd } from '../../../platform/files/cwd.js';
import { enterConcourse, enterRootChat } from '../../routes/surfaceRoute.js';
import type { scanBootCardFacts, BootProjectFact } from '../bootCardFacts.js';
import { isProcessAlive } from '../../../daemon/control/ownerWatch.js';
import { readSessionWorkers, stampedTerminalPid, terminalStampsOf } from '../../../daemon/concourse-workers/concourseWorkers.js';
import type { AsyncListNote } from '../../widgets/useInteractiveList.js';
import type { AppState } from '../../app-state/AppStateStore.js';
import type { bornSession } from '../../../daemon/switchboard/bornSession.js';

export type BootRow = {
  key: string;
  icon: string;
  label: string;
  ctx: string;
  dim?: boolean;
};

export function continueOpenElsewhere(facts: ReturnType<typeof scanBootCardFacts>): boolean {
  const sessionId = (facts.cwdProject ?? facts.recentLast)?.sessionId;
  if (!sessionId) return false;
  return Object.values(readSessionWorkers()).some(
    rec =>
      rec.sessionId === sessionId &&
      rec.endedAt === undefined &&
      terminalStampsOf(rec).some(by => {
        const pid = stampedTerminalPid(by);
        return pid !== undefined && pid !== process.pid && isProcessAlive(pid);
      }),
  );
}

async function groundTrustedProject(dir: string): Promise<void> {
  const { isPathTrusted } = await import('../../../platform/settings/config.js');
  if (isPathTrusted(dir)) {
    const [snap, ground] = await Promise.all([
      import('../../concourse-model/concourseSnapshot.js'),
      import('../../../daemon/switchboard/harnessGround.js'),
    ]);
    await snap.writeConcourseSeedOverride({ projectDir: dir });
    await ground.applyHarnessGround(dir);
  }
}

export function openProjectOf({ flipFirstBirth }: { flipFirstBirth: (start: (born: typeof bornSession) => ReturnType<typeof bornSession>) => Promise<string | null> }, p: BootProjectFact): AsyncListNote {
  return {
    pending: 'opening…',
    result: (async (): Promise<string | null> => {
      try {
        await groundTrustedProject(p.dir);
        if (p.sessionId !== null) {
          const hop = await import('../../../daemon/switchboard/hopIntoSession.js');
          const outcome = await hop.focusResumedSession(p.sessionId, p.transcriptPath ?? undefined, { title: p.base });
          if (!outcome.ok) return outcome.reason;
        } else if (
          p.firstSessionId !== null &&
          (await import('../../../daemon/concourse-workers/concourseWorkers.js')).sessionOwnedByLiveWorker(p.firstSessionId) !== null
        ) {
          const hop = await import('../../../daemon/switchboard/hopIntoSession.js');
          const outcome = await hop.hopIntoBoardSession(p.firstSessionId);
          if (!outcome.ok) return outcome.reason;
        } else {
          return await flipFirstBirth(bornSession => bornSession({ workspaceDir: p.dir }));
        }
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
      enterRootChat();
      return null;
    })(),
  };
}

export function runRowOf({ flipFirstBirth, facts, permissionModeRef, setSettingsOpen, setLoginsOpen, setProfilesOpen }: { flipFirstBirth: (start: (born: typeof bornSession) => ReturnType<typeof bornSession>) => Promise<string | null>; facts: ReturnType<typeof scanBootCardFacts>; permissionModeRef: RefObject<AppState['toolPermissionContext']['mode'] | undefined>; setSettingsOpen: Dispatch<SetStateAction<boolean>>; setLoginsOpen: Dispatch<SetStateAction<boolean>>; setProfilesOpen: Dispatch<SetStateAction<boolean>> }, row: BootRow | null): AsyncListNote | null {
  if (row == null || row.dim) return null;
  switch (row.key) {
    case 'new': {
      return {
        pending: 'starting a session…',
        result: flipFirstBirth(bornSession => bornSession({ workspaceDir: getCwd() })),
      };
    }
    case 'continue': {
      const cross = facts.cwdProject === null;
      const target = facts.cwdProject ?? facts.recentLast;
      if (!target?.sessionId) return null;
      const sid = target.sessionId;
      return {
        pending: 'opening…',
        result: (async (): Promise<string | null> => {
          try {
            if (cross) await groundTrustedProject(target.dir);
            const hop = await import('../../../daemon/switchboard/hopIntoSession.js');
            const outcome = await hop.focusResumedSession(sid, target.transcriptPath ?? undefined, {
              permissionMode: permissionModeRef.current,
            });
            if (!outcome.ok) return outcome.reason;
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
          enterRootChat();
          return null;
        })(),
      };
    }
    case 'menu':
      featureReached('screen', 'menu');
      setSettingsOpen(true);
      return null;
    case 'logins':
      featureReached('screen', 'logins');
      setLoginsOpen(true);
      return null;
    case 'concourse':
      enterConcourse();
      return null;
    case 'profiles':
      setProfilesOpen(true);
      return null;
  }
  return null;
}
