/**
 * The buyer's public surface: import from here, never from a file inside.
 *
 * The BUYER side. It drives the portal from the outside, the way a paying
 * agent would.
 *
 * Two rules, both load-bearing:
 *
 *   1. It shares no code with the portal's seller side. It speaks x402 through
 *      the reference library, so an end-to-end pass is evidence of
 *      interoperability rather than of one codebase agreeing with itself.
 *   2. The portal never imports it. The moment the seller depends on the
 *      buyer, a test between them stops being external.
 */

export {
  payForRequest,
  requestQuote,
  AgentError,
  type PaidRequestResult,
  type PayForRequestInput,
  type Quote,
  type Settlement,
} from './client.js';

export { loadAgentConfig, redactedConfig, AgentConfigError, type AgentConfig } from './config.js';
