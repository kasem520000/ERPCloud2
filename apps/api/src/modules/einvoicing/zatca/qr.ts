/**
 * The ZATCA QR code and the invoice hash.
 *
 * Every Saudi invoice carries a QR whose payload is base64 of a TLV sequence: one byte of
 * tag, one byte of length, then the UTF-8 value. Tags 1–5 (seller, VAT number, timestamp,
 * total with VAT, VAT amount) are the phase-1 requirement and can be produced by anyone who
 * knows the invoice — which is why they are always emitted here. Tags 6–8 (invoice hash,
 * signature, public key) belong to phase 2 and appear only once the tenant has uploaded the
 * private key that pairs with their ZATCA certificate; a QR that claims to be signed when it
 * is not would fail the first inspection it meets.
 */
import { createHash, createSign, createPublicKey, createPrivateKey, type KeyObject } from 'node:crypto';

export type QrInput = {
  sellerName: string;
  vatNo: string;
  /** Invoice issue instant, ISO 8601 in UTC — the same value that is in the XML. */
  timestamp: string;
  /** Total including VAT. */
  grandTotal: string;
  vatTotal: string;
  /** Base64 SHA-256 of the invoice XML (phase 2). */
  invoiceHash?: string;
  signature?: Buffer;
  publicKeyDer?: Buffer;
  /** The certificate authority's signature over the certificate's public key (phase 2, standard invoices). */
  certificateSignature?: Buffer;
};

/** One byte of tag, one byte of length; values are trimmed so a long name cannot overflow it. */
function tlv(tag: number, value: Buffer): Buffer {
  const trimmed = value.length > 255 ? value.subarray(0, 255) : value;
  return Buffer.concat([Buffer.from([tag, trimmed.length]), trimmed]);
}

export function buildQrPayload(input: QrInput): string {
  const parts = [
    tlv(1, Buffer.from(input.sellerName, 'utf8')),
    tlv(2, Buffer.from(input.vatNo, 'utf8')),
    tlv(3, Buffer.from(input.timestamp, 'utf8')),
    tlv(4, Buffer.from(input.grandTotal, 'utf8')),
    tlv(5, Buffer.from(input.vatTotal, 'utf8')),
  ];
  if (input.invoiceHash) parts.push(tlv(6, Buffer.from(input.invoiceHash, 'utf8')));
  if (input.signature) parts.push(tlv(7, input.signature));
  if (input.publicKeyDer) parts.push(tlv(8, input.publicKeyDer));
  if (input.certificateSignature) parts.push(tlv(9, input.certificateSignature));
  return Buffer.concat(parts).toString('base64');
}

/** Decodes a TLV payload back into `{ tag: value }` — used by the tests and the diagnostics screen. */
export function decodeQrPayload(payload: string): Array<{ tag: number; value: Buffer }> {
  const bytes = Buffer.from(payload, 'base64');
  const found: Array<{ tag: number; value: Buffer }> = [];
  let cursor = 0;
  while (cursor + 2 <= bytes.length) {
    const tag = bytes[cursor]!;
    const length = bytes[cursor + 1]!;
    found.push({ tag, value: bytes.subarray(cursor + 2, cursor + 2 + length) });
    cursor += 2 + length;
  }
  return found;
}

/**
 * ZATCA's invoice hash: base64 of the SHA-256 digest of the invoice XML.
 *
 * The specification hashes the canonicalised document with the signature, QR and
 * `UBLExtensions` nodes removed. Our generator never writes those three nodes, so the
 * document as produced *is* the hashed form; when the XAdES step is added, the canonicaliser
 * has to strip them before calling this.
 */
export function hashInvoiceXml(xml: string): string {
  return createHash('sha256').update(Buffer.from(xml, 'utf8')).digest('base64');
}

export type SignedHash = { signature: Buffer; publicKeyDer: Buffer; curve: string };

/**
 * Signs the invoice hash with the tenant's EC private key (ZATCA uses secp256k1 + SHA-256).
 *
 * Returns `null` for a key that is missing, malformed or not an EC key: an unsigned invoice
 * is a recoverable state that the submission ledger records, while a wrong signature is a
 * rejected filing.
 */
export function signInvoiceHash(invoiceHash: string, privateKeyPem: string): SignedHash | null {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    return null;
  }
  if (key.asymmetricKeyType !== 'ec') return null;
  try {
    const signer = createSign('SHA256');
    signer.update(Buffer.from(invoiceHash, 'utf8'));
    signer.end();
    return {
      signature: signer.sign(key),
      publicKeyDer: createPublicKey(key).export({ type: 'spki', format: 'der' }),
      curve: String(key.asymmetricKeyDetails?.namedCurve ?? 'unknown'),
    };
  } catch {
    return null;
  }
}
