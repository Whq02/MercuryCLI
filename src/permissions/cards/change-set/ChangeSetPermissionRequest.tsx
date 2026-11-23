import { relative } from 'node:path';
import * as React from 'react';
import type { z } from 'zod/v4';
import { FAINT } from '../../../screen/theme/mercuryPalette.js';
import { StructuredDiffList } from '../../../screen/structured-diff/StructuredDiffList.js';
import { useTerminalSize } from '../../../screen/fullscreen-layout/useTerminalSize.js';
import { useKeybinding } from '../../../screen/keys/useKeybinding.js';
import { Box, Text } from '../../../screen/themedRenderer.js';
import {
  boundHunks,
  consentBodyBudget,
  consentContentWidth,
  diffPaintWidth,
  totalHunkRows,
} from '../consentBodyBudget.js';
import { fileLanguageKind } from '../../../platform/native/color-diff/index.js';
import type { ChangeSetPlan } from '../../../tools/engines/change-transaction/changeSetContracts.js';
import { planChangeSet, formatChangeSetRefusal } from '../../../tools/engines/change-transaction/changeSetPlan.js';
import { getChangeSetPlan } from '../../../tools/engines/change-transaction/changeSetStore.js';
import { ownerFromToolUseContext } from '../../../engine/run-owner/resolveOwner.js';
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js';
import { ChangeSetTool } from '../../../tools/change-set/ChangeSetTool.js';
import { matchExactEdit } from '../../../tools/edit/EditTool.js';
import { getFocusedSessionConnector } from '../../../engine/connector/focusedConnector.js';
import { usePermissionRequestLogging } from '../cardArrival.js';
import { PermissionDialog } from '../PermissionDialog.js';
import { PermissionPrompt, type PermissionPromptOption } from '../PermissionPrompt.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js';

type ChangeSetInput = z.infer<typeof ChangeSetTool.inputSchema>;
type DecisionValue = 'yes' | 'no';


function displayPath(abs: string): string {
  const rel = relative(getFocusedSessionConnector().workspace().cwd, abs);
  return rel.startsWith('..') ? abs : rel;
}

interface PreviewData {
  plan?: ChangeSetPlan;
  refusalText?: string;
  planMissing?: boolean;
}

function computePreview(input: ChangeSetInput, owner: OwnerKey): PreviewData {
  if (input.changes !== undefined && input.changes.length > 0) {
    const planned = planChangeSet(input.changes, {
      ownerKey: owner,
      exactEdit: (target, edit) =>
        matchExactEdit(target.content, edit, undefined, firstLine => fileLanguageKind(target.canonicalPath, firstLine) === 'prose'),
    });
    if (!planned.ok) return { refusalText: formatChangeSetRefusal(planned) };
    return { plan: planned.plan };
  }
  if (input.plan_id) {
    const plan = getChangeSetPlan(owner, input.plan_id);
    if (!plan) return { planMissing: true };
    return { plan };
  }
  return { planMissing: true };
}

export function ChangeSetPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { toolUseConfirm, toolUseContext, onDone, onReject, workerBadge } = props;
  const { columns, rows } = useTerminalSize();
  const [expanded, setExpanded] = React.useState(false);
  useKeybinding('confirm:toggleFullPreview', () => setExpanded(prev => !prev), {
    context: 'Confirmation',
  });
  const budget = consentBodyBudget(rows);
  const input = toolUseConfirm.input as ChangeSetInput;
  const owner = ownerFromToolUseContext(toolUseContext);

  usePermissionRequestLogging(toolUseConfirm, 'ChangeSetPermissionRequest');

  const preview = React.useMemo(() => computePreview(input, owner), [input, owner]);

  const handleSelect = (value: DecisionValue, feedback?: string) => {
    if (value === 'yes') {
      toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback);
      onDone();
      return;
    }
    toolUseConfirm.onReject(feedback);
    onReject();
    onDone();
  };
  const handleCancel = () => {
    toolUseConfirm.onReject();
    onReject();
    onDone();
  };

  const options: PermissionPromptOption<DecisionValue>[] = [
    { label: 'Yes', value: 'yes', feedbackConfig: { type: 'accept' } },
    { label: 'No', value: 'no', feedbackConfig: { type: 'reject' } },
  ];

  const plan = preview.plan;
  const changed = plan?.targets.filter(t => t.changed) ?? [];
  const innerWidth = Math.max(20, consentContentWidth(columns) - 4);

  type BoundedFile = { target: (typeof changed)[number]; hunks: (typeof changed)[number]['diff']['hunks']; cutLines: number };
  const bounded = React.useMemo((): { files: BoundedFile[]; hiddenFiles: number } => {
    if (expanded) return { files: changed.map(target => ({ target, hunks: target.diff.hunks, cutLines: 0 })), hiddenFiles: 0 };
    const files: BoundedFile[] = [];
    let left = budget;
    let hiddenFiles = 0;
    for (const target of changed) {
      if (left <= 1) {
        hiddenFiles++;
        continue;
      }
      left -= 1;
      const paintWidth = diffPaintWidth(innerWidth, target.diff.hunks);
      const projection = boundHunks(target.diff.hunks, paintWidth, left);
      files.push({ target, hunks: projection.hunks, cutLines: projection.hiddenLines });
      if (projection.hiddenLines > 0) {
        left = 0;
      } else {
        left -= totalHunkRows(projection.hunks, paintWidth);
      }
    }
    return { files, hiddenFiles };
  }, [changed, budget, expanded, innerWidth]);

  return (
    <PermissionDialog title="Apply change set" crewmate={toolUseConfirm.crewmate} workerBadge={workerBadge}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {plan ? (
          <>
            <Text>
              Apply this change set to{' '}
              <Text bold>{changed.length}</Text> file{changed.length === 1 ? '' : 's'} (
              {plan.totalHunks} hunk{plan.totalHunks === 1 ? '' : 's'})? One decision covers every
              file — any denial writes nothing.
            </Text>
            <Text dimColor>
              plan {plan.id} · digest {plan.digest.slice(0, 12)}
            </Text>
            {bounded.files.map(({ target: t, hunks, cutLines }) => (
              <Box key={t.canonicalPath} flexDirection="column" marginTop={1}>
                <Text bold>{displayPath(t.canonicalPath)}</Text>
                <StructuredDiffList
                  hunks={hunks}
                  dim={false}
                  width={innerWidth}
                  filePath={t.canonicalPath}
                  firstLine={null}
                />
                {cutLines > 0 ? (
                  <Text dimColor>
                    … +{cutLines} more line{cutLines === 1 ? '' : 's'} in this file · ctrl+f expands (the apply covers them exactly)
                  </Text>
                ) : null}
                {t.diff.omittedHunks > 0 ? (
                  <Text dimColor>
                    … +{t.diff.omittedHunks} hunk{t.diff.omittedHunks === 1 ? '' : 's'} not shown
                    (bounded preview — the apply covers them exactly)
                  </Text>
                ) : null}
              </Box>
            ))}
            {bounded.hiddenFiles > 0 ? (
              <Text dimColor>
                … +{bounded.hiddenFiles} more file{bounded.hiddenFiles === 1 ? '' : 's'} not shown · ctrl+f expands
                the whole set (one decision still covers every file)
              </Text>
            ) : null}
            {expanded ? <Text dimColor>ctrl+f collapses the preview</Text> : null}
            {plan.noChangePaths.length > 0 ? (
              <Text color={FAINT}>
                already satisfied (will not be written):{' '}
                {plan.noChangePaths.map(displayPath).join(', ')}
              </Text>
            ) : null}
          </>
        ) : preview.refusalText ? (
          <>
            <Text>This change set will refuse at preflight — nothing will be written:</Text>
            <Text color={FAINT}>{preview.refusalText}</Text>
          </>
        ) : (
          <Text>
            Apply change set {input.plan_id ?? ''} — the plan is not previewable here (absent or
            expired); the call will refuse honestly if it cannot apply.
          </Text>
        )}
      </Box>
      <Box flexDirection="column">
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
        />
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={handleCancel}
        />
      </Box>
    </PermissionDialog>
  );
}
