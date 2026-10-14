import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const source = (name: string) => new URL(`../${name}`, import.meta.url);

describe('offline POS PWA surface', () => {
  it('has an installable manifest and a worker fallback for both offline screens', async () => {
    const manifest = JSON.parse(await readFile(source('public/manifest.webmanifest'), 'utf8')) as {
      start_url: string;
      display: string;
      icons: unknown[];
    };
    const worker = await readFile(source('public/sw.js'), 'utf8');
    expect(manifest.start_url).toBe('/pos/offline');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.length).toBeGreaterThan(0);
    expect(worker).toContain("request.mode === 'navigate'");
    expect(worker).toContain("'/pos/offline'");
    expect(worker).toContain("'/pos/offline-queue'");
  });

  it('keeps the queue, barcode fallback and ten-second reconnect loop in the client', async () => {
    const db = await readFile(source('lib/offline-db.ts'), 'utf8');
    const sync = await readFile(source('lib/sync-engine.ts'), 'utf8');
    const pos = await readFile(source('app/pos/offline/page.tsx'), 'utf8');
    const queue = await readFile(source('app/pos/offline-queue/page.tsx'), 'utf8');
    expect(db).toContain("createObjectStore('queue'");
    expect(db).toContain('OFFLINE-');
    expect(sync).toContain('10_000');
    expect(sync).toContain("'/pos/offline-sync'");
    expect(pos).toContain('BarcodeDetector');
    expect(pos).toContain('إيصال 80mm');
    expect(queue).toContain('retryOfflineConflict');
  });
});
