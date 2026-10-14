import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

/**
 * Identifiers — PROJECT_CONTRACT §2: every primary key is a UUID **v7** generated
 * application-side (never DB `gen_random_uuid()`, which is not time-ordered).
 */
export function newId(): string {
  return uuidv7();
}

export const uuidSchema = z.string().uuid();

export const idParamSchema = z.object({ id: uuidSchema });

export type IdParam = z.infer<typeof idParamSchema>;

/** True when the value looks like a UUID (used by guards before hitting the DB). */
export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}
