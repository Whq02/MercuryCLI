export const CONTRACT_TOOL_NAME = 'Contract'

export const DESCRIPTION =
  "This session's work agreement (its contract): read it, acknowledge it in your own words, check a move against it, assess whether it is complete enough, propose an amendment, or file the closing report against it. Advisory always — it encourages, never blocks."

export const CONTRACT_TOOL_PROMPT = `Works with this session's contract, the work agreement the operator or coordinator wrote for it. read returns its current text and status. acknowledge records your restatement and puts a draft or amended contract in force. check-in returns the agreement beside the move you name; sufficiency returns it beside the standard for judging whether it is complete enough. propose-amend sends the operator or coordinator a needs-you with your proposal, for them to amend and you to re-acknowledge. close-against files your closing report as a receipt beside the transcript and closes the contract. The contract is advisory: nothing here blocks a step.`
