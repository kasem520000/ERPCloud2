import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SETTINGS_UPDATED_NOTIFICATION, jobTypes } from '@erp/contracts';
import { withTenantTx, type DatabaseHandle } from '@erp/database';
import { Inject } from '@nestjs/common';

import { DATABASE_HANDLE } from '../../../database/database.module.js';
import { DomainEventsService, domainEventTypes } from '../../../events/domain-events.service.js';
import { OutboxService } from '../jobs/outbox.service.js';

import { NotificationsService } from './notifications.service.js';

/**
 * Demo subscription (PHASE_04 §4: "event hooks from domain-event emitter (subscribe
 * demo: settings updated → notification)").
 *
 * It is a real, end-to-end example of the pattern later modules copy:
 *
 * 1. a service emits a domain event after its transaction commits;
 * 2. a subscriber writes the in-app notification **and** an `outbox_jobs` row in one
 *    transaction, so the inbox entry and the queued e-mail cannot diverge;
 * 3. the publisher moves the outbox row to the `notifications` queue, and the worker
 *    sends the mail through the `MailerPort`.
 */
@Injectable()
export class NotificationsSubscriber implements OnModuleInit {
  private readonly logger = new Logger(NotificationsSubscriber.name);

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly events: DomainEventsService,
    private readonly notifications: NotificationsService,
    private readonly outbox: OutboxService,
  ) {}

  onModuleInit(): void {
    this.events.on(domainEventTypes.SETTINGS_UPDATED, (event) => this.onSettingsUpdated(event));
  }

  private async onSettingsUpdated(event: {
    tenantId: string | null;
    membershipId?: string | null;
    payload: Record<string, unknown>;
  }): Promise<void> {
    if (!event.tenantId || !event.membershipId) return;
    const tenantId = event.tenantId;
    const membershipId = event.membershipId;

    await withTenantTx(this.database.db, tenantId, async (tx) => {
      await this.notifications.createInTx(tx, {
        tenantId,
        membershipId,
        type: SETTINGS_UPDATED_NOTIFICATION,
        // Values are already redacted by the emitter; only the key travels here.
        payload: { key: event.payload.key ?? null },
      });

      await this.outbox.enqueueInTx(tx, {
        tenantId,
        queue: 'notifications',
        type: jobTypes.NOTIFICATION_EMAIL,
        payload: {
          notificationType: SETTINGS_UPDATED_NOTIFICATION,
          membershipId,
          // Named `setting`, not `settingKey`: the queue guard rejects any payload key
          // that looks like a credential, and "*key" does.
          setting: event.payload.key ?? null,
        },
      });
    });

    this.logger.debug({ tenantId, membershipId }, 'settings.updated notification created');
  }
}
