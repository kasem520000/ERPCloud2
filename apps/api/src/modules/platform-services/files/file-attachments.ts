import { Injectable, Logger } from '@nestjs/common';
import type { DrizzleTx } from '@erp/database';

/**
 * Entity-attachment validation hook (PHASE_04 §4: "finalize attach (`entity/entity_id`
 * validation hook)").
 *
 * A file may only be attached to an entity whose owning module has registered a
 * validator. Without this, `POST /files/{id}/finalize` would be an unchecked way to
 * write an arbitrary `entity`/`entity_id` pair into the tenant's data — and later
 * modules would each re-invent the "does this row exist in my tenant?" check.
 *
 * A module registers itself on bootstrap:
 *
 * ```ts
 * attachments.register('sales_invoice', async (tx, tenantId, entityId) => {
 *   const [row] = await tx.select({ id: salesInvoices.id })
 *     .from(salesInvoices).where(eq(salesInvoices.id, entityId)).limit(1);
 *   return row !== undefined;
 * });
 * ```
 *
 * Phase 04 registers none: no domain entity exists yet, so every `entity` is rejected
 * with 422 until its module arrives. That is the safe default — an unknown entity is a
 * bug, not an opportunity.
 */

export type AttachmentValidator = (tx: DrizzleTx, tenantId: string, entityId: string) => Promise<boolean>;

@Injectable()
export class FileAttachmentRegistry {
  private readonly logger = new Logger(FileAttachmentRegistry.name);
  private readonly validators = new Map<string, AttachmentValidator>();

  register(entity: string, validator: AttachmentValidator): void {
    if (this.validators.has(entity)) {
      this.logger.warn({ entity }, 'attachment validator replaced');
    }
    this.validators.set(entity, validator);
  }

  unregister(entity: string): void {
    this.validators.delete(entity);
  }

  isRegistered(entity: string): boolean {
    return this.validators.has(entity);
  }

  registeredEntities(): string[] {
    return [...this.validators.keys()].sort();
  }

  /** `undefined` when the entity is unknown — the caller turns that into a 422. */
  validatorFor(entity: string): AttachmentValidator | undefined {
    return this.validators.get(entity);
  }
}
