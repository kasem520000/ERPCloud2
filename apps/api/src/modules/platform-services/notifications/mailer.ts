import { randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import { Injectable, Logger } from '@nestjs/common';
import { env } from '@erp/config';

/**
 * Mail port — TARGET_ARCHITECTURE §8 ("email (SMTP/SES port)").
 *
 * `MAIL_TRANSPORT=console` (default) logs the message; `MAIL_TRANSPORT=smtp` delivers
 * through the SMTP client below — tested against MailHog in `infrastructure/docker-compose.yml`
 * (service `mailhog`, port 1025) and against any real relay that accepts plain or LOGIN auth.
 *
 * The client is deliberately hand-rolled on `node:net`/`node:tls` (no nodemailer): the
 * subset we need — EHLO, optional STARTTLS, optional AUTH LOGIN, MAIL/RCPT/DATA — is small,
 * and keeping the dependency surface at zero matters more in this codebase than SMTP
 * conveniences we would never use.
 */

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  /**
   * P-M7 — النسخة المرئية (HTML) من النصّ نفسه. تُطلب من **حملة** لأن بكسل الفتح لا يُحمَّل
   * في نصٍّ مجرّد، فتصير الرسالة `multipart/alternative`: النصّ أوّلاً (من يقرأ نصّاً يقرأ نصّاً)
   * وHTML ثانياً. والفارغ يعني رسالةٌ نصّية كاملة كسابقتها — فلا يتغيّر سلوك بلا سبب.
   */
  html?: string;
  /**
   * P-M7 — ترويسات يضيفها المرسل: `List-Unsubscribe` و`List-Unsubscribe-Post` (RFC 8058).
   * تُنقّى من محارف السطر الجديد قبل الكتابة، فلا تُحقن ترويسةٌ من محتوى.
   */
  headers?: Record<string, string>;
  /** Tenant the message belongs to; used for per-tenant templates later. */
  tenantId?: string | null;
  /**
   * P-C6 — هوية المُرسِل من `email_settings` (اسمٌ عربيّ وعنوانٌ لكل عميل). غيابها يعني
   * `MAIL_FROM` من البيئة، وهو ما كان قبل خدمة البريد.
   */
  from?: string;
  fromName?: string;
  replyTo?: string | null;
};

export interface MailerPort {
  send(message: MailMessage): Promise<void>;
  readonly transport: string;
}

export const MAILER = 'ERP_MAILER';

/** In development `MAIL_TRANSPORT=console` prints the message instead of delivering it. */
@Injectable()
export class ConsoleMailer implements MailerPort {
  private readonly logger = new Logger(ConsoleMailer.name);
  readonly transport = 'console';

  async send(message: MailMessage): Promise<void> {
    this.logger.log(
      {
        transport: this.transport,
        from: env.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        tenantId: message.tenantId ?? null,
        // P-M7: وجود HTML وترويسات الامتثال يُقاس من السجلّ بلا قراءة القاعدة.
        htmlChars: message.html?.length ?? 0,
        headers: message.headers ? Object.keys(message.headers) : [],
      },
      'outbound mail (console transport)',
    );
  }
}

export type SmtpOptions = {
  host: string;
  port: number;
  from: string;
  username?: string;
  password?: string;
  /** Implicit TLS on connect (port 465 style) instead of cleartext + STARTTLS. */
  secure?: boolean;
  timeoutMs?: number;
};

/**
 * Reads `process.env` directly instead of the parsed `env` snapshot: the snapshot is
 * materialised once per process, and tests flip these values per file (vi.hoisted) after
 * another suite in the same worker has already imported `@erp/config`.
 */
function live(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export function smtpOptionsFromEnv(): SmtpOptions {
  return {
    host: live('SMTP_HOST', env.SMTP_HOST ?? 'localhost'),
    port: Number(live('SMTP_PORT', String(env.SMTP_PORT))),
    from: live('MAIL_FROM', env.MAIL_FROM),
    username: process.env.SMTP_USER || undefined,
    password: process.env.SMTP_PASS || undefined,
    secure: live('SMTP_SECURE', 'false') === 'true',
  };
}

type Reply = { code: number; lines: string[] };

/** ترويسةٌ آمنة: بلا CR/LF وبلا طولٍ يشقّ الرسالة. */
const safe = (value: string): boolean => value.length <= 998 && !/[\r\n]/.test(value);

const encodedWord = (text: string): string => `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;

export class SmtpMailer implements MailerPort {
  readonly transport = 'smtp';

  constructor(private readonly options: SmtpOptions) {}

  async send(message: MailMessage): Promise<void> {
    const session = await SmtpSession.open(this.options);
    try {
      await session.deliver({
        from: formatFrom(message.fromName, message.from) ?? this.options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      });
    } finally {
      await session.quit().catch(() => undefined);
    }
  }
}

/**
 * One connection per send. Transactional volume here is a handful of messages per grant or
 * password event — pooling would be premature, and short-lived connections are what
 * MailHog-lookalikes in CI expect anyway.
 */
class SmtpSession {
  private buffer = '';
  /** One waiter at a time — SMTP is strictly lock-step. */
  private notify: (() => void) | undefined;
  /** Set by socket-level failures; surfaced to whichever reply wait is in flight. */
  private failure: Error | undefined;

  private constructor(
    private socket: Socket,
    private readonly options: SmtpOptions,
  ) {}

  static async open(options: SmtpOptions): Promise<SmtpSession> {
    const socket: Socket = options.secure
      ? tlsConnect({ host: options.host, port: options.port })
      : netConnect({ host: options.host, port: options.port });
    const session = new SmtpSession(socket, options);
    session.attach(socket);

    const greeting = await session.readReply();
    if (greeting.code !== 220) session.fail(`unexpected greeting ${greeting.code}`);

    const ehlo = await session.command(`EHLO ${clientHostname()}`, [250]);
    if (!options.secure && ehlo.lines.some((line) => line.toUpperCase().includes('STARTTLS'))) {
      await session.command('STARTTLS', [220]);
      await session.upgradeToTls();
      await session.command(`EHLO ${clientHostname()}`, [250]);
    }

    if (options.username && options.password) {
      await session.command('AUTH LOGIN', [334]);
      await session.command(Buffer.from(options.username, 'utf8').toString('base64'), [334]);
      await session.command(Buffer.from(options.password, 'utf8').toString('base64'), [235]);
    }

    return session;
  }

  async deliver(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
    headers?: Record<string, string>;
    replyTo?: string;
  }): Promise<void> {
    await this.command(`MAIL FROM:<${message.from}>`, [250]);
    await this.command(`RCPT TO:<${message.to}>`, [250, 251]);
    await this.command('DATA', [354]);

    const boundary = `erp-${randomBytes(12).toString('hex')}`;
    const lines = [
      `From: ${message.from}`,
      `To: ${message.to}`,
      `Subject: ${encodedWord(message.subject)}`,
      'MIME-Version: 1.0',
      // ترويسات المرسل (P-M7): تُنقّى من CR/LF — ترويسةٌ مبنيةٌ من محتوى تُحقَن بلا ذلك.
      ...Object.entries(message.headers ?? {})
        .filter(([name, value]) => /^[A-Za-z][A-Za-z0-9-]{1,60}$/.test(name) && safe(value))
        .map(([name, value]) => `${name}: ${value.replace(/[\r\n]+/g, ' ').trim()}`),
      ...(message.replyTo ? [`Reply-To: ${message.replyTo}`] : []),
      // نسختان حين يوجد HTML (النصّ أوّلٌ لمن لا يعرض HTML)، ونسخةٌ واحدة حين لا يوجد.
      ...(message.html
        ? [`Content-Type: multipart/alternative; boundary="${boundary}"`]
        : ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit']),
      `Date: ${new Date().toUTCString()}`,
    ];

    const body = message.html
      ? [
          `--${boundary}`,
          'Content-Type: text/plain; charset=utf-8',
          'Content-Transfer-Encoding: 8bit',
          '',
          message.text,
          `--${boundary}`,
          'Content-Type: text/html; charset=utf-8',
          'Content-Transfer-Encoding: 8bit',
          '',
          message.html,
          `--${boundary}--`,
          '',
        ].join('\r\n')
      : message.text;

    // Dot-stuffing (RFC 5321 §4.5.2): a line starting with '.' gets one extra '.'.
    const stuffed = body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    this.socket.write(`${lines.join('\r\n')}\r\n\r\n${stuffed}\r\n.\r\n`, 'utf8');
    await this.expect([250]);
  }

  async quit(): Promise<void> {
    try {
      if (!this.socket.destroyed && !this.failure) await this.command('QUIT', [221]);
    } finally {
      this.socket.destroy();
    }
  }

  // --- protocol plumbing -------------------------------------------------------

  private readonly onData = (chunk: Buffer): void => {
    this.buffer += chunk.toString('utf8');
    this.notify?.();
  };

  private readonly onError = (error: Error): void => {
    this.abort(new Error(`SMTP ${this.options.host}:${this.options.port} — ${error.message}`));
  };

  private readonly onTimeout = (): void => {
    this.abort(new Error(`SMTP ${this.options.host}:${this.options.port} — timed out waiting for the server`));
  };

  private readonly onClose = (): void => {
    if (!this.failure) {
      this.abort(new Error(`SMTP ${this.options.host}:${this.options.port} — connection closed unexpectedly`));
    }
  };

  /** Pipes socket bytes into `buffer` and wakes whoever is waiting for a reply. */
  private attach(socket: Socket): void {
    socket.setTimeout(this.options.timeoutMs ?? 15_000, this.onTimeout);
    socket.on('data', this.onData);
    socket.once('error', this.onError);
    socket.once('close', this.onClose);
  }

  private detach(socket: Socket): void {
    socket.off('data', this.onData);
    socket.off('error', this.onError);
    socket.off('close', this.onClose);
    socket.setTimeout(0);
  }

  private upgradeToTls(): Promise<void> {
    return new Promise((resolve, reject) => {
      // The raw listeners must come off *before* the TLS layer takes the socket over,
      // otherwise they would be fed encrypted bytes.
      this.detach(this.socket);
      const secured = tlsConnect({ socket: this.socket, servername: this.options.host });
      secured.once('secureConnect', () => {
        this.socket = secured;
        this.buffer = '';
        this.attach(secured);
        resolve();
      });
      secured.once('error', reject);
    });
  }

  private async command(line: string, accepted: number[]): Promise<Reply> {
    this.socket.write(`${line}\r\n`, 'utf8');
    return this.expect(accepted);
  }

  private async expect(accepted: number[]): Promise<Reply> {
    const reply = await this.readReply();
    if (!accepted.includes(reply.code)) {
      this.fail(`expected ${accepted.join('/')} but got ${reply.code}: ${reply.lines.join(' | ')}`);
    }
    return reply;
  }

  /** Waits until a complete (possibly multi-line) reply can be parsed from the buffer. */
  private async readReply(): Promise<Reply> {
    for (;;) {
      if (this.failure) throw this.failure;
      const parsed = this.parseReply();
      if (parsed) return parsed;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
      this.notify = undefined;
    }
  }

  /**
   * Multi-line replies use `code-` continuation lines; `code ` (space) ends the reply.
   * Returns `undefined` until a full reply is present.
   */
  private parseReply(): Reply | undefined {
    const lines: string[] = [];
    let cursor = 0;
    for (;;) {
      const end = this.buffer.indexOf('\r\n', cursor);
      if (end === -1) return undefined;
      const line = this.buffer.slice(cursor, end);
      if (line.length < 4 || !/^\d{3}[- ]/.test(line)) return undefined;
      lines.push(line.slice(4));
      if (line[3] === ' ') {
        this.buffer = this.buffer.slice(end + 2);
        return { code: Number(line.slice(0, 3)), lines };
      }
      cursor = end + 2;
    }
  }

  /** Socket-level failure: record, destroy, wake the waiter so it can throw. */
  private abort(error: Error): void {
    this.failure = error;
    this.socket.destroy();
    this.notify?.();
  }

  /** Command-level failure: throw synchronously. */
  private fail(reason: string): never {
    this.socket.destroy();
    throw new Error(`SMTP ${this.options.host}:${this.options.port} — ${reason}`);
  }
}

function clientHostname(): string {
  return env.SMTP_CLIENT_HOSTNAME || 'erp-saas.local';
}

/**
 * `اسم عربي <address@domain>` — وصيغة `from` في الرسالة تبقى العنوان وحده إن لم يُضبط اسم.
 * الاسم يُرمَّز (`=?UTF-8?B?…?=`) كما تُرمَّز العناوين، لا كبايتات خام.
 */
export function formatFrom(fromName?: string, from?: string): string | undefined {
  if (!from) return undefined;
  if (!fromName) return from;
  return `${encodedWord(fromName)} <${from}>`;
}

/** Chooses the wired implementation from `MAIL_TRANSPORT` (read live — see `live`). */
export function createMailer(): MailerPort {
  if (live('MAIL_TRANSPORT', env.MAIL_TRANSPORT) === 'smtp') return new SmtpMailer(smtpOptionsFromEnv());
  return new ConsoleMailer();
}

export type EmailProviderCredentials = {
  apiKey?: string | null;
  apiEndpoint?: string | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  smtpPassword?: string | null;
  smtpSecure?: boolean | null;
};

/**
 * Resend API mailer (`https://api.resend.com/emails`) or custom compatible endpoint.
 * Falls back to logging when no API key is configured in local/test environments.
 */
export class ResendMailer implements MailerPort {
  private readonly logger = new Logger(ResendMailer.name);
  readonly transport = 'resend';

  constructor(
    private readonly options: {
      apiKey?: string | null;
      endpoint?: string | null;
      defaultFrom: string;
    },
  ) {}

  async send(message: MailMessage): Promise<void> {
    const apiKey = this.options.apiKey || process.env.RESEND_API_KEY || '';
    const endpoint = this.options.endpoint || process.env.RESEND_API_URL || 'https://api.resend.com/emails';
    const fromAddress = message.from || this.options.defaultFrom;
    const fromHeader = message.fromName ? `${message.fromName} <${fromAddress}>` : fromAddress;

    if (!apiKey) {
      this.logger.log(
        {
          transport: this.transport,
          from: fromHeader,
          to: message.to,
          subject: message.subject,
          tenantId: message.tenantId ?? null,
          mode: 'simulated-no-api-key',
        },
        'outbound mail (resend transport without API key — logged)',
      );
      return;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromHeader,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Resend API (${response.status}): ${errorText || response.statusText}`);
    }
  }
}

/**
 * Generic HTTP/Webhook JSON email provider (Mailgun/Postmark/SendGrid-compatible webhook relay).
 */
export class HttpWebhookMailer implements MailerPort {
  private readonly logger = new Logger(HttpWebhookMailer.name);
  readonly transport = 'http';

  constructor(
    private readonly options: {
      apiKey?: string | null;
      endpoint?: string | null;
      defaultFrom: string;
    },
  ) {}

  async send(message: MailMessage): Promise<void> {
    const endpoint = this.options.endpoint || process.env.EMAIL_HTTP_ENDPOINT || '';
    const apiKey = this.options.apiKey || process.env.EMAIL_HTTP_API_KEY || '';
    const fromAddress = message.from || this.options.defaultFrom;

    if (!endpoint) {
      this.logger.log(
        {
          transport: this.transport,
          from: fromAddress,
          to: message.to,
          subject: message.subject,
          tenantId: message.tenantId ?? null,
          mode: 'simulated-no-endpoint',
        },
        'outbound mail (http transport without endpoint — logged)',
      );
      return;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: fromAddress,
        fromName: message.fromName ?? null,
        replyTo: message.replyTo ?? null,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html ?? null,
        headers: message.headers ?? null,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP Email Provider (${response.status}): ${errorText || response.statusText}`);
    }
  }
}

/**
 * P-C6 — المزوّد المختار من `email_settings` لحظة الإرسال، مع دعم `console` و`smtp` و`resend` و`http`.
 */
export function createMailerFor(
  provider: 'console' | 'smtp' | 'resend' | 'http',
  credentials?: EmailProviderCredentials,
): MailerPort {
  if (provider === 'resend') {
    return new ResendMailer({
      apiKey: credentials?.apiKey,
      endpoint: credentials?.apiEndpoint,
      defaultFrom: live('MAIL_FROM', env.MAIL_FROM),
    });
  }
  if (provider === 'http') {
    return new HttpWebhookMailer({
      apiKey: credentials?.apiKey,
      endpoint: credentials?.apiEndpoint,
      defaultFrom: live('MAIL_FROM', env.MAIL_FROM),
    });
  }
  if (provider === 'smtp') {
    const base = smtpOptionsFromEnv();
    return new SmtpMailer({
      host: credentials?.smtpHost || base.host,
      port: credentials?.smtpPort || base.port,
      from: base.from,
      username: credentials?.smtpUser || base.username,
      password: credentials?.smtpPassword || base.password,
      secure: credentials?.smtpSecure ?? base.secure,
    });
  }
  return new ConsoleMailer();
}
