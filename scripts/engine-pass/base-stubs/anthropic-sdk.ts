export class APIError extends Error {}
export class APIConnectionError extends APIError {}
export class APIConnectionTimeoutError extends APIConnectionError {}
export class APIUserAbortError extends APIError {}
export class AuthenticationError extends APIError {}
export class NotFoundError extends APIError {}
export default class Anthropic {}
