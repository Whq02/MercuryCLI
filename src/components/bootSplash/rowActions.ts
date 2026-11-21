import { featureReached } from '../../substrate/featureReached.js';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { getCwd } from '../../utils/cwd.js';
import { enterConcourse, enterRootChat } from '../../context/surfaceRoute.js';
import type { scanBootCardFacts, BootProjectFact } from '../../utils/bootCardFacts.js';
import type { AsyncListNote } from '../mercury-ui/useInteractiveList.js';
import type { AppState } from '../../state/AppStateStore.js';
import type { bornSession } from '../../services/switchboard/bornSession.js';

export type BootRow = {
  key: string;
  icon: string;
  label: string;
  ctx: string;
  dim?: boolean;
};

export function openProjectOf({ flipFirstBirth }: { flipFirstBirth: (start: (born: typeof bornSession) => ReturnType<typeof bornSession>) => Promise<string | null> }, p: BootProjectFact): AsyncListNote {
  return {
    pending: 'opening…',
    result: (async (): Promise<string | null> => {
      try {
        const [{ isPathTrusted }, snap] = await Promise.all([
          import('../../utils/config.js'),
          import('../../services/concourse/concourseSnapshot.js'),
        ]);
        if (isPathTrusted(p.dir)) {
          await snap.writeConcourseSeedOverride({ projectDir: p.dir });
          const ground = await import('../../services/switchboard/harnessGround.js');
          await ground.applyHarnessGround(p.dir);
        }
        if (p.sessionId !== null) {
          const hop = await import('../../services/switchboard/hopIntoSession.js');
          const outcome = await hop.focusResumedSession(p.sessionId, p.transcriptPath ?? undefined, { title: p.base });
          if (!outcome.ok) return outcome.reason;
        } else if (
          p.firstSessionId !== null &&
          (await import('../../daemon/concourseWorkers.js')).sessionOwnedByLiveWorker(p.firstSessionId) !== null
        ) {
          const hop = await import('../../services/switchboard/hopIntoSession.js');
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

export function runRowOf({ flipFirstBirth, facts, permissionModeRef, setSettingsOpen, setKitOpen, setHealthOpen, setSaturnOpen, setAgentsOpen, setLoginsOpen, setResumeOpen }: { flipFirstBirth: (start: (born: typeof bornSession) => ReturnType<typeof bornSession>) => Promise<string | null>; facts: ReturnType<typeof scanBootCardFacts>; permissionModeRef: RefObject<AppState['toolPermissionContext']['mode'] | undefined>; setSettingsOpen: Dispatch<SetStateAction<boolean>>; setKitOpen: Dispatch<SetStateAction<boolean>>; setHealthOpen: Dispatch<SetStateAction<boolean>>; setSaturnOpen: Dispatch<SetStateAction<boolean>>; setAgentsOpen: Dispatch<SetStateAction<boolean>>; setLoginsOpen: Dispatch<SetStateAction<boolean>>; setResumeOpen: Dispatch<SetStateAction<boolean>> }, row: BootRow | null): AsyncListNote | null {
  if (row == null || row.dim) return null;
  switch (row.key) {
    case 'new': {
      return {
        pending: 'starting a session…',
        result: flipFirstBirth(bornSession => bornSession({ workspaceDir: getCwd() })),
      };
    }
    case 'continue': {
      const target = facts.cwdProject;
      if (!target?.sessionId) return null;
      const sid = target.sessionId;
      return {
        pending: 'opening…',
        result: (async (): Promise<string | null> => {
          try {
            const hop = await import('../../services/switchboard/hopIntoSession.js');
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
    case 'kit':
      featureReached('screen', 'kit');
      setKitOpen(true);
      return null;
    case 'health':
      featureReached('screen', 'health');
      setHealthOpen(true);
      return null;
    case 'saturn':
      featureReached('screen', 'saturn');
      setSaturnOpen(true);
      return null;
    case 'agents':
      featureReached('screen', 'agents');
      setAgentsOpen(true);
      return null;
    case 'logins':
      featureReached('screen', 'logins');
      setLoginsOpen(true);
      return null;
    case 'concourse':
      enterConcourse();
      return null;
    case 'sessions':
      featureReached('screen', 'sessions');
      setResumeOpen(true);
      return null;
  }
  return null;
}
