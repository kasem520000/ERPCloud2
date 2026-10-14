import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SmtpMailer, type SmtpOptions } from './mailer.js';

/**
 * The SMTP client is hand-rolled, so the contract it must honour is pinned here against a
 * fake server that speaks exactly the RFC 5321 subset we use: greeting, EHLO, optional
 * AUTH LOGIN, MAIL/RCPT/DATA with dot-stuffing, QUIT.
 */

type CapturedMail = { from: string; to: string; data: string };

type FakeOptions = { requireAuth?: boolean; rejectRcpt?: boolean };

class FakeSmtpServer {
  private server: Server;
  readonly mails: CapturedMail[] = [];

  constructor(private readonly fakeOptions: FakeOptions = {}) {
    this.server = createServer((socket) => {
      let buffer = '';
      let inData = false;
      let current: CapturedMail | undefined;
      let authStep = 0;
      let authenticatedUser = '';
      let authenticatedPass = '';

      const send = (reply: string) => socket.write(`${reply}\r\n`);
      send('220 fake ESMTP ready');

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (;;) {
          if (inData) {
            const end = buffer.indexOf('\r\n.\r\n');
            if (end === -1) return;
            if (current) {
              current.data = buffer.slice(0, end);
              const record = current as CapturedMail & { user?: string; pass?: string };
              record.user = authenticatedUser;
              record.pass = authenticatedPass;
              this.mails.push(record);
            }
            buffer = buffer.slice(end + 5);
            inData = false;
            send('250 OK message accepted');
            continue;
          }
          const end = buffer.indexOf('\r\n');
          if (end === -1) return;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const upper = line.toUpperCase();

          if (authStep === 1) {
            authenticatedUser = Buffer.from(line, 'base64').toString();
            authStep = 2;
            send('334 UGFzc3dvcmQ6');
            continue;
          }
          if (authStep === 2) {
            authenticatedPass = Buffer.from(line, 'base64').toString();
            authStep = 0;
            send('235 Authentication successful');
            continue;
          }

          if (upper.startsWith('EHLO')) {
            // Multi-line reply on purpose — exercises the `250-` continuation parser.
            send(this.fakeOptions.requireAuth ? '250-fake\r\n250 AUTH LOGIN' : '250-fake\r\n250 8BITMIME');
          } else if (upper === 'AUTH LOGIN') {
            if (!this.fakeOptions.requireAuth) {
              send('503 auth not available');
              continue;
            }
            authStep = 1;
            send('334 VXNlcm5hbWU6');
          } else if (upper.startsWith('MAIL FROM:')) {
            current = { from: line.slice(line.indexOf('<') + 1, line.lastIndexOf('>')), to: '', data: '' };
            send('250 OK');
          } else if (upper.startsWith('RCPT TO:')) {
            if (this.fakeOptions.rejectRcpt) {
              send('550 no such user');
              continue;
            }
            if (current) current.to = line.slice(line.indexOf('<') + 1, line.lastIndexOf('>'));
            send('250 OK');
          } else if (upper === 'DATA') {
            inData = true;
            send('354 end with <CRLF>.<CRLF>');
          } else if (upper === 'QUIT') {
            send('221 bye');
            socket.end();
          } else if (upper === 'RSET' || upper === 'NOOP') {
            send('250 OK');
          } else {
            send('500 unknown command');
          }
        }
      });
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe('SmtpMailer', () => {
  let fake: FakeSmtpServer;
  let port = 0;

  const options = (extra: Partial<SmtpOptions> = {}): SmtpOptions => ({
    host: '127.0.0.1',
    port,
    from: 'no-reply@erp.local',
    timeoutMs: 5_000,
    ...extra,
  });

  beforeAll(async () => {
    fake = new FakeSmtpServer();
    port = await fake.listen();
  });

  afterAll(async () => fake.close());

  it('delivers a message with headers, UTF-8 subject and dot-stuffed body', async () => {
    await new SmtpMailer(options()).send({
      to: 'buyer@example.test',
      subject: 'بيانات الدخول إلى بوابة العملاء',
      text: 'السطر الأول.\n.سطر يبدأ بنقطة يجب حشوه\nالنهاية',
    });

    expect(fake.mails).toHaveLength(1);
    const [mail] = fake.mails;
    expect(mail.from).toBe('no-reply@erp.local');
    expect(mail.to).toBe('buyer@example.test');
    expect(mail.data).toContain('Subject: =?UTF-8?B?');
    expect(mail.data).toContain('Content-Type: text/plain; charset=utf-8');
    // The line that began with '.' must arrive doubled; the other lines untouched.
    expect(mail.data).toContain('..سطر يبدأ بنقطة يجب حشوه');
    expect(mail.data).toContain('\r\nالسطر الأول.\r\n');
    // The captured DATA ends with the last content line; the `<CRLF>.<CRLF>` terminator
    // itself is what the server strips.
    expect(mail.data.endsWith('النهاية')).toBe(true);
  });

  it('authenticates with AUTH LOGIN when credentials are configured', async () => {
    const authFake = new FakeSmtpServer({ requireAuth: true });
    const authPort = await authFake.listen();
    try {
      await new SmtpMailer(options({ port: authPort, username: 'relay-user', password: 'relay-pass' })).send({
        to: 'x@y.test',
        subject: 'auth check',
        text: 'body',
      });
      const [mail] = authFake.mails as Array<CapturedMail & { user?: string; pass?: string }>;
      expect(mail.user).toBe('relay-user');
      expect(mail.pass).toBe('relay-pass');
    } finally {
      await authFake.close();
    }
  });

  it('surfaces server rejections as errors', async () => {
    const angry = new FakeSmtpServer({ rejectRcpt: true });
    const angryPort = await angry.listen();
    try {
      await expect(
        new SmtpMailer(options({ port: angryPort })).send({ to: 'ghost@nowhere.test', subject: 'x', text: 'y' }),
      ).rejects.toThrow(/550/);
    } finally {
      await angry.close();
    }
  });
});
