export const CONTRACT_TOOL_NAME = 'contract'

export const DESCRIPTION =
  "This session's work agreement (its contract): read it, acknowledge it in your own words, check a move against it, assess whether it is complete enough, propose an amendment, or file the closing report against it. Advisory always — it encourages, never blocks."

export const CONTRACT_TOOL_PROMPT = `The session you are running in may carry a CONTRACT — a short work agreement the operator or the coordinator wrote: what this session is for, its territory, its deliverables. The contract is ADVISORY: it never blocks a tool, a step, or a decision. You are encouraged by it, not fenced by it. This tool is how you work with it honestly.

Actions:
- "read" — the contract's current text and status, fresh from the record. Use it at the start of work and whenever you want the agreement back in front of you.
- "acknowledge" — the worker's signature, and it is YOURS alone: pass a restatement of the contract in your own words (the restatement is what makes it stick — never paste the contract back). Acknowledging a draft (or an amended contract) puts it in force. Do this once after your first read, and again after any amendment.
- "check-in" — pass what you are about to do; the tool hands you the agreement text back beside it. YOU judge whether the move is on-contract. Nothing is blocked either way.
- "sufficiency" — assess whether the contract is complete enough for the work in front of you. The tool returns the contract plus the standard: the honest outcomes are exactly two — ASK THE USER, naming the specific gap, or CONTINUE. Never silently fill a material gap with a guess.
- "propose-amend" — the amendment door, the honest alternative to silent drift: when a clause does not survive contact with the code, say so (the clause + why). A needs-you ping reaches the operator/coordinator; they amend, you re-acknowledge. You never have to choose between drifting quietly and being stuck.
- "close-against" — at the end of the work: file the closing report against the contract's items (what was delivered, what was not, and why). It lands as a receipt beside the transcript and closes the contract.

A session with NO contract is normal and fine — the tool says so plainly; work as briefed. Never invent a contract, and never treat the contract as permission machinery: permissions, leases and seats are enforced elsewhere; this is the agreement about WHAT the work is.`
