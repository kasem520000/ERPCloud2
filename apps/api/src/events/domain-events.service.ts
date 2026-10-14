import { Injectable, Logger } from '@nestjs/common';

/**
 * In-process domain-event emitter (PHASE_04 §4 "event hooks from domain-event emitter").
 *
 * Deliberately tiny and dependency-free:
 *
 * - It is **not** a delivery guarantee. Anything that must survive a crash is written to
 *   `outbox_jobs` inside the business transaction and drained by the publisher
 *   (TARGET_ARCHITECTURE §6); the emitter only fans out to in-process subscribers.
 * - Subscribers never run inside the emitter's transaction, and a throwing subscriber can
 *   never fail the request that emitted the event — it is logged and swallowed.
 *
 * It lives outside `modules/` because both `modules/platform` (producer: settings) and
 * `modules/platform-services` (consumer: notifications) depend on it; putting it in
 * either module would create an import cycle between them.
 */

export type DomainEvent<TPayload = Record<string, unknown>> = {
  type: string;
  tenantId: string | null;
  /** Membership that caused the event, when a person did. */
  membershipId?: string | null;
  actorUserId?: string | null;
  payload: TPayload;
  occurredAt: Date;
};

export type DomainEventInput<TPayload = Record<string, unknown>> = Omit<
  DomainEvent<TPayload>,
  'occurredAt'
> & {
  occurredAt?: Date;
};

export type DomainEventHandler = (event: DomainEvent) => void | Promise<void>;

/** Event types Phase 04 emits. Later phases add their own next to their module. */
export const domainEventTypes = {
  SETTINGS_UPDATED: 'settings.updated',
  FILE_ATTACHED: 'file.attached',
} as const;

@Injectable()
export class DomainEventsService {
  private readonly logger = new Logger(DomainEventsService.name);
  private readonly handlers = new Map<string, DomainEventHandler[]>();

  on(type: string, handler: DomainEventHandler): () => void {
    const existing = this.handlers.get(type) ?? [];
    existing.push(handler);
    this.handlers.set(type, existing);
    return () => {
      this.handlers.set(
        type,
        (this.handlers.get(type) ?? []).filter((entry) => entry !== handler),
      );
    };
  }

  subscriberCount(type: string): number {
    return (this.handlers.get(type) ?? []).length;
  }

  /**
   * Fans the event out to every subscriber. Resolves once they have all settled, so a
   * caller (or a test) can await the side effects without polling.
   */
  async emit(input: DomainEventInput): Promise<void> {
    const event: DomainEvent = { ...input, occurredAt: input.occurredAt ?? new Date() };
    const handlers = this.handlers.get(event.type) ?? [];

    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (error) {
        this.logger.error(
          { err: error instanceof Error ? error.message : String(error), type: event.type },
          'domain event subscriber failed',
        );
      }
    }
  }
}
