import { useCallback, useEffect, useMemo, useState } from 'react';
import { reloadAgentDefinitionsIntoAppState } from '../../hooks/useAgentsChange.js';
import type { useSetAppStateMaybe } from '../../state/AppState.js';
import { clearAgentDefinitionsCache, getAgentDefinitionsWithOverrides, type AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js';
import { startAgentWatch, subscribeAgentsChanged } from '../../services/agents/watch.js';
import { buildStudioRows, type StudioRow } from '../agents/studio/studioData.js';

export function useAgentDefinitions({ given, workspaceDir, setAppStateMaybe }: { given: AgentDefinitionsResult | undefined; workspaceDir: string; setAppStateMaybe: ReturnType<typeof useSetAppStateMaybe> }) {
  const [defs, setDefs] = useState<AgentDefinitionsResult | null>(given ?? null);
  const [note, setNote] = useState<string | null>(null);
  const reload = useCallback((): void => {
    if (given !== undefined) {
      setDefs(given);
      return;
    }
    clearAgentDefinitionsCache();
    void getAgentDefinitionsWithOverrides(workspaceDir)
      .then(fresh => setDefs(fresh))
      .catch(e => setNote(`definitions unreadable — ${String(e)}`));
  }, [given, workspaceDir]);
  useEffect(() => {
    reload();
    if (given !== undefined) return;
    void startAgentWatch(workspaceDir).catch(() => {});
    const unsubscribe = subscribeAgentsChanged(reload);
    return unsubscribe;
  }, [given, reload, workspaceDir]);

  const refreshEverywhere = useCallback((): void => {
    reload();
    if (setAppStateMaybe !== null) {
      void reloadAgentDefinitionsIntoAppState(workspaceDir, setAppStateMaybe, { invalidate: true }).catch(() => {});
    }
  }, [reload, setAppStateMaybe, workspaceDir]);

  const built = useMemo(
    () =>
      defs === null
        ? null
        : buildStudioRows(defs, { tab: 'all', filter: 'all', query: '' }),
    [defs],
  );
  const listRows: StudioRow[] = built?.rows ?? [];
  const counts = useMemo(() => {
    const active = listRows.filter(r => r.kind === 'agent' && r.agent!.disabled !== true).length;
    const disabled = listRows.filter(r => r.agent?.disabled === true).length;
    const issues = built?.counts.issues ?? 0;
    return { active, disabled, issues };
  }, [listRows, built]);
  return { defs, note, setNote, refreshEverywhere, built, listRows, counts };
}
