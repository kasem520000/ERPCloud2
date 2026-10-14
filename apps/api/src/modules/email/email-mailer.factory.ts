import type { EmailProvider } from '@erp/contracts';

import {
  createMailerFor,
  type EmailProviderCredentials,
  type MailerPort,
} from '../platform-services/notifications/mailer.js';

export type EmailMailerFactory = (
  provider: EmailProvider,
  credentials?: EmailProviderCredentials,
) => MailerPort;

export const EMAIL_MAILER_FACTORY = 'ERP_EMAIL_MAILER_FACTORY';

export const defaultEmailMailerFactory: EmailMailerFactory = (provider, credentials) =>
  createMailerFor(provider, credentials);
