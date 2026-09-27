export const GENERATED_BY = 'scripts/skills/gen-bundled.ts'
import skillMd from './provider-apis/SKILL.md'
import ref_references_anthropic_messages_md from './provider-apis/references/anthropic-messages.md'
import ref_references_chat_completions_md from './provider-apis/references/chat-completions.md'
import ref_references_live_sources_md from './provider-apis/references/live-sources.md'
import ref_references_models_md from './provider-apis/references/models.md'
import ref_references_openai_responses_md from './provider-apis/references/openai-responses.md'

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  "references/anthropic-messages.md": ref_references_anthropic_messages_md,
  "references/chat-completions.md": ref_references_chat_completions_md,
  "references/live-sources.md": ref_references_live_sources_md,
  "references/models.md": ref_references_models_md,
  "references/openai-responses.md": ref_references_openai_responses_md,
}
