import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { env } from '@erp/config';
import {
  emailAuditActions,
  type EmailProvider,
  type EmailSettings,
  type EmailSettingsUpdate,
} from '@erp/contracts';
import { newId, withPlatformAdminTx, type DatabaseHandle, type DrizzleTx } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.tokens.js';
import { getAuthContext } from '../../request-context/request-context.js';
import { AuditService } from '../platform-services/audit/audit.service.js';
import type { EmailProviderCredentials } from '../platform-services/notifications/mailer.js';
import { openSecret, sealSecret } from '../platform/auth/secret-box.js';

function maskSecret(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.length <= 6) return '••••••';
  return `${raw.slice(0, 3)}••••${raw.slice(-4)}`;
}

function tryUnseal(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  if (!sealed.startsWith('v1:')) return sealed;
  try {
    return openSecret(sealed).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * P-C6 — إعدادات البريد: هوية المُرسِل، المزوّد (Console / SMTP / Resend / HTTP)، والحدود.
 */
@Injectable()
export class EmailSettingsService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly audit: AuditService,
  ) {}

  /** الإعدادات الفعّالة لعميلٍ (أو للمنصة عند `null`). */
  async effective(tenantId: string | null): Promise<EmailSettings> {
    return withPlatformAdminTx(this.database.db, (tx) => this.effectiveInTx(tx, tenantId));
  }

  /** الاعتمادات الفعّالة لمزوّد البريد لحظة الإرسال (مفكوكة التشفير داخلياً فقط). */
  async credentialsFor(tenantId: string | null): Promise<EmailProviderCredentials> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const platform = (await tx.execute(sql`
        SELECT api_key_enc, api_endpoint, smtp_host, smtp_port, smtp_user, smtp_password_enc, smtp_secure
          FROM email_settings WHERE tenant_id IS NULL LIMIT 1
      `)).rows[0];
      const tenant = tenantId
        ? (await tx.execute(sql`
            SELECT api_key_enc, api_endpoint, smtp_host, smtp_port, smtp_user, smtp_password_enc, smtp_secure
              FROM email_settings WHERE tenant_id = ${tenantId} LIMIT 1
          `)).rows[0]
        : undefined;

      const pick = <T>(key: string, fallback: T): T => {
        const fromTenant = tenant ? (tenant[key] as T | null | undefined) : undefined;
        if (fromTenant !== undefined && fromTenant !== null) return fromTenant;
        const fromPlatform = platform ? (platform[key] as T | null | undefined) : undefined;
        if (fromPlatform !== undefined && fromPlatform !== null) return fromPlatform;
        return fallback;
      };

      return {
        apiKey: tryUnseal(pick<string | null>('api_key_enc', null)),
        apiEndpoint: pick<string | null>('api_endpoint', null),
        smtpHost: pick<string | null>('smtp_host', env.SMTP_HOST || null),
        smtpPort: pick<number | null>('smtp_port', env.SMTP_PORT || null),
        smtpUser: pick<string | null>('smtp_user', process.env.SMTP_USER || null),
        smtpPassword: tryUnseal(pick<string | null>('smtp_password_enc', null)) ?? (process.env.SMTP_PASS || null),
        smtpSecure: pick<boolean | null>('smtp_secure', null),
      };
    });
  }

  private async effectiveInTx(tx: DrizzleTx, tenantId: string | null): Promise<EmailSettings> {
    const platform = (await tx.execute(sql`
      SELECT id, tenant_id, provider, from_name, from_email, reply_to, sending_domain,
             daily_limit, monthly_limit, api_key_enc, api_endpoint,
             smtp_host, smtp_port, smtp_user, smtp_password_enc, smtp_secure,
             updated_at, updated_by
        FROM email_settings WHERE tenant_id IS NULL LIMIT 1
    `)).rows[0];
    const tenant = tenantId
      ? (await tx.execute(sql`
          SELECT id, tenant_id, provider, from_name, from_email, reply_to, sending_domain,
                 daily_limit, monthly_limit, api_key_enc, api_endpoint,
                 smtp_host, smtp_port, smtp_user, smtp_password_enc, smtp_secure,
                 updated_at, updated_by
            FROM email_settings WHERE tenant_id = ${tenantId} LIMIT 1
        `)).rows[0]
      : undefined;

    const pick = <T>(key: string, fallback: T): T => {
      const fromTenant = tenant ? (tenant[key] as T | null | undefined) : undefined;
      if (fromTenant !== undefined && fromTenant !== null) return fromTenant;
      const fromPlatform = platform ? (platform[key] as T | null | undefined) : undefined;
      if (fromPlatform !== undefined && fromPlatform !== null) return fromPlatform;
      return fallback;
    };

    const row = tenant ?? platform;
    const rawApiKey = tryUnseal(pick<string | null>('api_key_enc', null)) || process.env.RESEND_API_KEY || null;
    const smtpHost = pick<string | null>('smtp_host', env.SMTP_HOST || null);
    const smtpPort = pick<number | null>('smtp_port', env.SMTP_PORT ? Number(env.SMTP_PORT) : null);
    const smtpUser = pick<string | null>('smtp_user', process.env.SMTP_USER || null);
    const smtpPassPresent = Boolean(
      pick<string | null>('smtp_password_enc', null) || process.env.SMTP_PASS,
    );

    return {
      tenantId,
      provider: pick<EmailProvider>('provider', env.MAIL_TRANSPORT as EmailProvider),
      fromName: pick<string>('from_name', 'منصة ERP'),
      fromEmail: pick<string>('from_email', env.MAIL_FROM),
      replyTo: pick<string | null>('reply_to', null),
      sendingDomain: pick<string | null>('sending_domain', null),
      dailyLimit: pick<number | null>('daily_limit', null),
      monthlyLimit: pick<number | null>('monthly_limit', null),
      smtpHost,
      smtpPort,
      smtpUser,
      smtpSecure: pick<boolean>('smtp_secure', false),
      smtpConfigured: Boolean((smtpUser && smtpPassPresent) || rawApiKey),
      apiKeyMasked: maskSecret(rawApiKey),
      apiEndpoint: pick<string | null>('api_endpoint', null),
      updatedAt: row?.updated_at ? new Date(row.updated_at as string).toISOString() : null,
      updatedBy: row?.updated_by ? String(row.updated_by) : null,
    };
  }

  /** كتابة صفٍّ عامّ أو صفّ عميل — upsert بلا مسار حذف (إفراغ حقلٍ يعني «ارث من المنصة»). */
  async update(
    tenantId: string | null,
    input: EmailSettingsUpdate,
    reason?: string,
  ): Promise<EmailSettings> {
    return withPlatformAdminTx(this.database.db, async (tx) => {
      const before = await this.effectiveInTx(tx, tenantId);
      const existing = (await tx.execute(sql`
        SELECT id FROM email_settings
         WHERE ${tenantId === null ? sql`tenant_id IS NULL` : sql`tenant_id = ${tenantId}`}
         LIMIT 1
      `)).rows[0];

      const sealedApiKey =
        input.apiKey === undefined
          ? undefined
          : input.apiKey === null || input.apiKey.trim() === ''
            ? null
            : sealSecret(input.apiKey.trim());

      const sealedSmtpPass =
        input.smtpPassword === undefined
          ? undefined
          : input.smtpPassword === null || input.smtpPassword === ''
            ? null
            : sealSecret(input.smtpPassword);

      if (existing) {
        await tx.execute(sql`
          UPDATE email_settings SET
            provider          = COALESCE(${input.provider ?? null}, provider),
            from_name         = COALESCE(${input.fromName ?? null}, from_name),
            from_email        = COALESCE(${input.fromEmail ?? null}, from_email),
            reply_to          = CASE WHEN ${input.replyTo === undefined} THEN reply_to ELSE ${input.replyTo ?? null} END,
            sending_domain    = CASE WHEN ${input.sendingDomain === undefined} THEN sending_domain ELSE ${input.sendingDomain ?? null} END,
            daily_limit       = CASE WHEN ${input.dailyLimit === undefined} THEN daily_limit ELSE ${input.dailyLimit ?? null} END,
            monthly_limit     = CASE WHEN ${input.monthlyLimit === undefined} THEN monthly_limit ELSE ${input.monthlyLimit ?? null} END,
            api_key_enc       = CASE WHEN ${sealedApiKey === undefined} THEN api_key_enc ELSE ${sealedApiKey ?? null} END,
            api_endpoint      = CASE WHEN ${input.apiEndpoint === undefined} THEN api_endpoint ELSE ${input.apiEndpoint ?? null} END,
            smtp_host         = CASE WHEN ${input.smtpHost === undefined} THEN smtp_host ELSE ${input.smtpHost ?? null} END,
            smtp_port         = CASE WHEN ${input.smtpPort === undefined} THEN smtp_port ELSE ${input.smtpPort ?? null} END,
            smtp_user         = CASE WHEN ${input.smtpUser === undefined} THEN smtp_user ELSE ${input.smtpUser ?? null} END,
            smtp_password_enc = CASE WHEN ${sealedSmtpPass === undefined} THEN smtp_password_enc ELSE ${sealedSmtpPass ?? null} END,
            smtp_secure       = COALESCE(${input.smtpSecure ?? null}, smtp_secure),
            updated_at        = now(),
            updated_by        = ${getAuthContext().userId}
          WHERE id = ${String(existing.id)}
        `);
      } else {
        await tx.execute(sql`
          INSERT INTO email_settings
            (id, tenant_id, provider, from_name, from_email, reply_to, sending_domain,
             daily_limit, monthly_limit, api_key_enc, api_endpoint,
             smtp_host, smtp_port, smtp_user, smtp_password_enc, smtp_secure, updated_by)
          VALUES (
            ${newId()}, ${tenantId},
            ${(input.provider ?? before.provider) as string},
            ${(input.fromName ?? before.fromName) as string},
            ${(input.fromEmail ?? before.fromEmail) as string},
            ${input.replyTo === undefined ? null : input.replyTo},
            ${input.sendingDomain === undefined ? null : input.sendingDomain},
            ${input.dailyLimit === undefined ? null : input.dailyLimit},
            ${input.monthlyLimit === undefined ? null : input.monthlyLimit},
            ${sealedApiKey ?? null},
            ${input.apiEndpoint ?? null},
            ${input.smtpHost ?? null},
            ${input.smtpPort ?? null},
            ${input.smtpUser ?? null},
            ${sealedSmtpPass ?? null},
            ${input.smtpSecure ?? false},
            ${getAuthContext().userId}
          )
        `);
      }

      const after = await this.effectiveInTx(tx, tenantId);
      await this.audit.recordInTx(tx, {
        tenantId,
        actorUserId: getAuthContext().userId,
        action: tenantId ? emailAuditActions.tenantSettingsUpdate : emailAuditActions.settingsUpdate,
        entity: 'email_settings',
        entityId: existing ? String(existing.id) : null,
        before: { provider: before.provider, fromName: before.fromName, fromEmail: before.fromEmail },
        after: {
          provider: after.provider,
          fromName: after.fromName,
          fromEmail: after.fromEmail,
          sendingDomain: after.sendingDomain,
          dailyLimit: after.dailyLimit,
          monthlyLimit: after.monthlyLimit,
        },
        meta: { scope: tenantId ? 'tenant' : 'platform_console', reason: reason ?? null },
      });
      return after;
    });
  }

  async limitsFor(tenantId: string | null): Promise<{ daily: number | null; monthly: number | null }> {
    const settings = await this.effective(tenantId);
    return { daily: settings.dailyLimit, monthly: settings.monthlyLimit };
  }
}
