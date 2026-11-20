export const CONTRACT_TOOL_NAME = 'Contract'

export const DESCRIPTION =
  "This session's work agreement (its contract): read it, acknowledge it in your own words, check a move against it, assess whether it is complete enough, propose an amendment, or file the closing report against it. Advisory always — it encourages, never blocks."

export const CONTRACT_TOOL_PROMPT = `Works with this session's contract, the work agreement the operator wrote for it. read returns its current text and status; acknowledge records your restatement and puts a draft or amended contract in force; check-in returns the agreement beside your planned move; sufficiency returns it beside the standard for judging completeness; propose-amend sends the operator a needs-you to amend it so you can re-acknowledge; close-against files your closing report beside the transcript and closes the contract. Advisory only: nothing here blocks a step.`
