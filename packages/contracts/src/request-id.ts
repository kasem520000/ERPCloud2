import { v7 as uuidv7 } from 'uuid';

/** API_CONTRACT §0 header set. `X-Request-Id` is echoed on every response. */
export const REQUEST_ID_HEADER = 'x-request-id';
export const BRANCH_ID_HEADER = 'x-branch-id';
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const AUTHORIZATION_HEADER = 'authorization';

/** Request ids are UUID v7 so they sort by arrival time (PROJECT_CONTRACT §2). */
export function newRequestId(): string {
  return uuidv7();
}

export type RequestId = string;
