import { v7 as uuidv7 } from 'uuid';

/**
 * Primary-key generation — PROJECT_CONTRACT §2: UUID v7, application-side, never
 * `gen_random_uuid()` (which is not time-ordered and would fragment the PK index).
 */
export function newId(): string {
  return uuidv7();
}
