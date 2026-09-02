import { relative } from 'node:path';
import * as React from 'react';
import type { z } from 'zod/v4';
import { FAINT } from '../../../components/mercuryPalette.js';
import { StructuredDiffList } from '../../../components/StructuredDiffList.js';
import { useTerminalSize } from '../../../hooks/useTerminalSize.js';
import { useKeybinding } from '../../../keybindings/useKeybinding.js';
import { Box, Text } from '../../../ink.js';
// The row budget, plan and hunk walk live in ../boundedDiffPreview.ts — the
// ONE home of the bounded-preview law every diff-bearing consent card rides
// (prove-consent-preview-bounded §5 pins this card onto it).
import {
  boundHunksToRows,
  boundedPreviewPlan,
  consentDiffBudget,
  totalHunkRows,
} from '../boundedDiffPreview.js';
import type { ChangeSetPlan } from '../../../services/changeTransaction/changeSetContracts.js';
import { planChangeSet, formatChangeSetRefusal } from '../../../services/changeTransaction/changeSetPlan.js';
import { getChangeSetPlan } from '../../../services/changeTransaction/changeSetStore.js';
import { ownerFromToolUseContext } from '../../../services/run/resolveOwner.js';
import { ChangeSetTool } from '../../../tools/ChangeSetTool/ChangeSetTool.js';
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js';
import { env } from '../../../utils/env.js';
import { logUnaryEvent } from '../../../utils/unaryLogging.js';
import { usePermissionRequestLogging } from '../hooks.js';
import { PermissionDialog } from '../PermissionDialog.js';
import { PermissionPrompt, type PermissionPromptOption } from '../PermissionPrompt.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js';

type ChangeSetInput = z.infer<typeof ChangeSetTool.inputSchema>;
type DecisionValue = 'yes' | 'no';

// ============================================================================
//  ChangeSetPermissionRequest — the aggregate decision surface.
//  Shows EVERY touched path with its bounded exact diff from the immutable
//  plan (or a freshly computed plan for the fast apply+changes path). ONE
//  decision covers the set; any denial writes nothing. Cuts are NAMED.
// ============================================================================

function displayPath(abs: string): string {
  const rel = relative(getFocusedSessionConnector().workspace().cwd, abs);
  return rel.startsWith('..') ? abs : rel;
}

interface PreviewData {
  plan?: ChangeSetPlan;
  refusalText?: string;
  planMissing?: boolean;
}

function computePreview(input: ChangeSetInput, owner: string): PreviewData {
  if (input.changes !== undefined && input.changes.length > 0) {
    const planned = planChangeSet(input.changes, { ownerKey: owner });
    if (!planned.ok) return { refusalText: formatChangeSetRefusal(planned) };
    return { plan: planned.plan };
  }
  if (input.plan_id) {
    const plan = getChangeSetPlan(owner as never, input.plan_id);
    if (!plan) return { planMissing: true };
    return { plan };
  }
  return { planMissing: true };
}

export function ChangeSetPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { toolUseConfirm, toolUseContext, onDone, onReject, workerBadge } = props;
  const { columns, rows } = useTerminalSize();
  // THE BOUNDED-PREVIEW LAW at the FILE-LIST level: per-file hunks are
  // already bounded upstream (the plan's omittedHunks), but a set touching
  // many files stacked one full block per file with no overall height
  // budget — the same blind-Enter stranding class, one level up. The walk
  // below spends the viewport-derived budget across files, cuts the
  // boundary file at line granularity, names the remainder, and the whole
  // set is one explicit chord away.
  const [expanded, setExpanded] = React.useState(false);
  useKeybinding('confirm:toggleFullPreview', () => setExpanded(prev => !prev), {
    context: 'Confirmation',
  });
  const budget = consentDiffBudget(rows);
  const input = toolUseConfirm.input as ChangeSetInput;
  const owner = ownerFromToolUseContext(toolUseContext);

  usePermissionRequestLogging(toolUseConfirm, {
    completion_type: 'tool_use_single',
    language_name: 'none',
  });

  // Computed once per confirm — the same pure planner the call uses, so the
  // consent diff can never disagree with the applied change (a post-consent
  // drift still refuses typed at the in-call revalidation).
  const preview = React.useMemo(() => computePreview(input, owner), [input, owner]);

  const logDecision = (event: 'accept' | 'reject') => {
    logUnaryEvent({
      completion_type: 'tool_use_single',
      event,
      metadata: {
        language_name: 'none',
        message_id: toolUseConfirm.assistantMessage.message.id,
        platform: env.platform,
      },
    });
  };
  const handleSelect = (value: DecisionValue, feedback?: string) => {
    if (value === 'yes') {
      logDecision('accept');
      toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback);
      onDone();
      return;
    }
    logDecision('reject');
    toolUseConfirm.onReject(feedback);
    onReject();
    onDone();
  };
  const handleCancel = () => {
    logDecision('reject');
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
  const innerWidth = Math.max(20, columns - 12);

  // The bounded projection: each kept file spends its path row + its hunk
  // lines against the shared budget; the boundary file's hunks cut at line
  // granularity; later files are counted, never painted.
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
      const total = totalHunkRows(target.diff.hunks);
      const spendBesideHunks = 1; // the path row
      if (total + spendBesideHunks <= left) {
        files.push({ target, hunks: target.diff.hunks, cutLines: 0 });
        left -= total + spendBesideHunks;
      } else {
        const shown = Math.max(1, left - spendBesideHunks);
        const plan2 = boundedPreviewPlan(total, shown, false);
        files.push({ target, hunks: boundHunksToRows(target.diff.hunks, plan2.shown), cutLines: plan2.hidden });
        left = 0;
      }
    }
    return { files, hiddenFiles };
  }, [changed, budget, expanded]);

  return (
    <PermissionDialog title="Apply change set" workerBadge={workerBadge}>
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
          toolType="tool"
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
