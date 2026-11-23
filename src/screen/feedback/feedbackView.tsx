import React from 'react'
import { Box, Text, type DOMElement } from '../themedRenderer.js'
import TextInput from '../composer/text-input/TextInput.js'
import { Select } from '../select/Select.js'
import { ISSUE_FORMS, ISSUE_KINDS, noGhParagraph, type promptedFields, type IssueForm, type IssueKind } from '../../commands/feedback/issueForms.js'
import { issuesPageUrl, type IssueAccess } from '../../platform/repo-host/ghIssue.js'
import type { MercuryThemeTokens } from '../theme/mercuryTokens.js'

export type Step =
  | 'kind'
  | 'ask'
  | 'preparing'
  | 'review'
  | 'filing'
  | 'done'
  | 'unavailable'
  | 'failed'

export function feedbackView({
  tokens,
  surfaceRef,
  columns,
  form,
  setForm,
  step,
  setStep,
  setAskIndex,
  draft,
  setDraft,
  cursorOffset,
  setCursorOffset,
  title,
  scroll,
  paths,
  access,
  failure,
  issueUrl,
  formUrl,
  cancel,
  field,
  advance,
  lines,
  viewRows,
  bytes,
  slug,
  surfaceTitle,
}: {
  tokens: MercuryThemeTokens
  surfaceRef: (el: DOMElement | null) => void
  columns: number
  form: IssueForm | null
  setForm: React.Dispatch<React.SetStateAction<IssueForm | null>>
  step: Step
  setStep: React.Dispatch<React.SetStateAction<Step>>
  setAskIndex: React.Dispatch<React.SetStateAction<number>>
  draft: string
  setDraft: React.Dispatch<React.SetStateAction<string>>
  cursorOffset: number
  setCursorOffset: React.Dispatch<React.SetStateAction<number>>
  title: string | null
  scroll: number
  paths: { json: string; body: string } | null
  access: IssueAccess | null
  failure: { note: string; remedy: string } | null
  issueUrl: string | null
  formUrl: string | null
  cancel: () => void
  field: ReturnType<typeof promptedFields>[number]
  advance: (value: string) => void
  lines: string[]
  viewRows: number
  bytes: number
  slug: string
  surfaceTitle: (form: IssueForm | null) => string
}): React.ReactNode {
  return (
    <Box
      ref={surfaceRef}
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.borderSubtle}
      paddingX={1}
      gap={1}
    >
      <Text bold>{surfaceTitle(form)}</Text>
      {step === 'kind' ? (
        <Box flexDirection="column" gap={1}>
          <Text>Which form does this follow?</Text>
          <Select
            options={ISSUE_KINDS.map(k => ({
              label: ISSUE_FORMS[k].name,
              value: k,
              description: ISSUE_FORMS[k].description,
            }))}
            onChange={value => {
              const chosen = ISSUE_FORMS[value as IssueKind]
              setForm(chosen)
              setAskIndex(0)
              setStep('ask')
            }}
            onCancel={cancel}
          />
          <Text dimColor>↑↓ choose · enter to continue · esc to cancel</Text>
        </Box>
      ) : null}
      {step === 'ask' && field !== null ? (
        <Box flexDirection="column" gap={1}>
          <Text>
            {field.label}
            {field.source === 'ask' && !field.required ? <Text dimColor> (optional — enter to skip)</Text> : null}:
          </Text>
          {field.prompt !== undefined ? <Text dimColor>{field.prompt}</Text> : null}
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={advance}
            onExit={cancel}
            columns={Math.max(30, columns - 6)}
            multiline
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            placeholder={field.source === 'words' ? 'What happened?' : ''}
          />
          <Text dimColor>enter to continue · esc to cancel</Text>
        </Box>
      ) : null}
      {step === 'preparing' ? <Text dimColor>Preparing the report…</Text> : null}
      {step === 'review' && form !== null ? (
        <Box flexDirection="column" gap={1}>
          <Text>
            This exact body ({bytes} bytes) will be filed as a new issue in {slug} through your own gh, titled:
          </Text>
          <Text bold>{title}</Text>
          <Box flexDirection="column" borderStyle="single" borderColor={tokens.borderSubtle} paddingX={1}>
            {lines.slice(scroll, scroll + viewRows).map((line, i) => (
              <Text key={scroll + i}>{line === '' ? ' ' : line}</Text>
            ))}
          </Box>
          <Text dimColor>
            {lines.length > viewRows
              ? `lines ${scroll + 1}–${Math.min(lines.length, scroll + viewRows)} of ${lines.length} · ↑↓ pgup pgdn scroll · `
              : ''}
            The session transcript stays in the local draft ({paths?.json}) and is not sent.
          </Text>
          <Text dimColor>enter to file it · esc to keep the draft only</Text>
        </Box>
      ) : null}
      {step === 'filing' ? <Text dimColor>Filing through gh…</Text> : null}
      {step === 'done' && form !== null ? (
        <Box flexDirection="column" gap={1}>
          <Text color={tokens.success}>Filed: {issueUrl}</Text>
          <Text dimColor>
            The body that left the box: {paths?.body} · the local draft (with the transcript): {paths?.json}
          </Text>
          <Text dimColor>press any key to close</Text>
        </Box>
      ) : null}
      {step === 'unavailable' && access !== null && access.state !== 'ok' ? (
        <Box flexDirection="column" gap={1}>
          <Text>
            {noGhParagraph({
              note: access.note,
              remedy: access.remedy,
              slug,
              draftPath: paths?.json ?? null,
              bodyPath: paths?.body ?? null,
            })}
          </Text>
          {formUrl !== null ? (
            <Box flexDirection="column">
              <Text>
                {form?.kind === 'tester'
                  ? "Or open the short issue form prefilled from this report; the transcript stays in the local draft:"
                  : "Or open the repository's issue form prefilled from this report; the health --json block and the transcript stay in the local draft (paste the health block by hand):"}
              </Text>
              <Text dimColor>{formUrl}</Text>
            </Box>
          ) : null}
          <Text dimColor>enter to open the prefilled form in your browser · any other key to close (the link stays in the transcript, to copy)</Text>
        </Box>
      ) : null}
      {step === 'failed' && failure !== null ? (
        <Box flexDirection="column" gap={1}>
          <Text color={tokens.failureText}>Not filed: {failure.note}</Text>
          <Text>
            {failure.remedy}.
            {paths !== null
              ? ` The body to paste is at ${paths.body} and the local draft at ${paths.json}; the issues page is ${issuesPageUrl(slug)}.`
              : ''}
          </Text>
          <Text dimColor>press any key to close</Text>
        </Box>
      ) : null}
    </Box>
  )
}
