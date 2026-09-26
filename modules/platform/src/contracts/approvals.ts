/**
 * In-process API for putting a document through its approval flow (step 0.8). Call it inside
 * the use case's UnitOfWork: the instance is created with the document's state change.
 * The outcome arrives later as `platform.ApprovalCompleted.v1`.
 */
export interface ApprovalPort {
  submit(request: ApprovalRequest): Promise<ApprovalSubmission>;
  /** Withdraws an open approval (e.g. the document was cancelled). No-op if none is open. */
  cancel(entityType: string, entityId: string, reason: string): Promise<void>;
}

export interface ApprovalRequest {
  readonly companyId: string;
  readonly plantId?: string;
  /** `module.document`, e.g. `procurement.purchase_order`. Selects the workflow. */
  readonly entityType: string;
  readonly entityId: string;
  /** Document facts that step conditions and approver limits read, e.g. `{ amount: '750000.00' }`. */
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
  /** The user asking for approval; never allowed to approve their own request. */
  readonly requesterId: string;
}

export type ApprovalSubmission =
  { readonly required: false } | { readonly required: true; readonly instanceId: string };

export type ApprovalOutcome = 'approved' | 'rejected' | 'cancelled';

export const APPROVAL_PORT = Symbol('APPROVAL_PORT');
