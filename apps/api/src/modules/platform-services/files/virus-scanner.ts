import { Injectable, Logger } from '@nestjs/common';

/**
 * Antivirus port — TARGET_ARCHITECTURE §8: "antivirus hook interface (deferred: behind
 * `VirusScanner` port)". PHASE_04 §4 explicitly scopes this to *interface only*.
 *
 * `NoopVirusScanner` is the wired implementation: it reports `skipped`, and the verdict
 * is written onto the `files` row's audit meta so that "was this file scanned?" is
 * answerable from data rather than from folklore. Swapping in ClamAV (or a hosted
 * scanner) is a provider change, not a call-site change.
 */

export type ScanVerdict = {
  status: 'clean' | 'infected' | 'skipped';
  scanner: string;
  detail?: string;
};

export interface VirusScannerPort {
  scan(objectKey: string, mime: string, sizeBytes: number): Promise<ScanVerdict>;
}

export const VIRUS_SCANNER = 'ERP_VIRUS_SCANNER';

@Injectable()
export class NoopVirusScanner implements VirusScannerPort {
  private readonly logger = new Logger(NoopVirusScanner.name);

  async scan(objectKey: string, mime: string, sizeBytes: number): Promise<ScanVerdict> {
    this.logger.debug({ objectKey, mime, sizeBytes }, 'virus scanning is not configured; skipping');
    return { status: 'skipped', scanner: 'noop', detail: 'no scanner configured' };
  }
}
