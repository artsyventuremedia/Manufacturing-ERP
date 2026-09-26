/**
 * Public contract of the Platform context for other modules (ADR-0002).
 * Other modules read tenancy through RequestContext; organisation lookups are added here
 * as consumers need them.
 */
export type { Principal } from '../application/principal.js';
export { PLATFORM_EVENTS, type PlatformEventData, type PlatformEventType } from './events.js';
export {
  NUMBERING_PORT,
  type IssuedNumber,
  type NumberRequest,
  type NumberingPort,
} from './numbering.js';
export {
  APPROVAL_PORT,
  type ApprovalOutcome,
  type ApprovalPort,
  type ApprovalRequest,
  type ApprovalSubmission,
} from './approvals.js';
