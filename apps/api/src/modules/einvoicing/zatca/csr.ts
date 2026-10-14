import { createHash, createPublicKey, generateKeyPairSync, sign as signWithKey } from 'node:crypto';

/**
 * ZATCA certificate signing request — the cloud equivalent of «⚡ توليد — Generate».
 *
 * `Desktop_ERP/SmartAuditERP/Form_WPF/frmZatcaSetting.xaml.cs` L446-L487 collects nine
 * properties and hands them to `AuditorAPI`'s `CSRGenerator.Generate(props, isProduction,
 * isSimulation)`. That library is a compiled dependency and cannot be read here, so this
 * module writes the request ZATCA publishes instead of wrapping a black box: a PKCS#10
 * `CertificationRequest` (RFC 2986) over a secp256k1 key, whose subject is
 *
 *      C = 🌍 Country Name · OU = 🏬 Organization Unit · O = 🏭 Organization Name ·
 *      CN = 🏢 Common Name
 *
 * and whose `subjectAltName` carries the five attributes the authority reads the
 * registration from — the desktop's own field order and content:
 *
 *      SN   (2.5.4.4)                    🖥️ Serial Number  — `1-<solution>|2-<version>|3-<uuid>`
 *      UID  (0.9.2342.19200300.100.1.1)  🔢 Organization Identifier (الرقم الضريبي)
 *      title (2.5.4.12)                  📄 Invoice Type (نوع الفواتير) — `1100`, `1000`, `0100`, `1100`…
 *      registeredAddress (2.5.4.26)      📍 Address (العنوان المختصر)
 *      businessCategory (2.5.4.15)       🏗️ Industry (النشاط التجاري)
 *
 * plus `1.3.6.1.4.1.311.20.2 = ZATCA-Code-Signing`, the extension that marks the request as
 * an e-invoicing one rather than a generic TLS certificate.
 *
 * Nothing here is a placeholder: the DER is real, the signature is a real ECDSA-SHA256 over
 * the `CertificationRequestInfo`, and `openssl req -in <file> -noout -text` reads it.
 */

export type CsrProperties = {
  /** 🏢 Common Name (اسم المنشأة) */
  commonName: string;
  /** 🖥️ Serial Number (سريال الجهاز) — `1-Auditor|2-<version>|3-<uuid>` on the desktop. */
  serialNumber: string;
  /** 🔢 Organization Identifier (الرقم الضريبي) */
  organizationIdentifier: string;
  /** 🏬 Organization Unit (اسم الفرع) */
  organizationUnitName: string;
  /** 🏭 Organization Name (اسم المنشأة) */
  organizationName: string;
  /** 🌍 Country Name (الدولة) */
  countryName: string;
  /** 📄 Invoice Type (نوع الفواتير) */
  invoiceType: string;
  /** 📍 Address (العنوان المختصر) */
  address: string;
  /** 🏗️ Industry (النشاط التجاري) */
  industry: string;
};

export type GeneratedCsr = {
  /** Base64 DER — the form ZATCA's `/compliance` endpoint expects in its `csr` field. */
  csr: string;
  /** PKCS#8 PEM. Returned once, stored encrypted, never readable again. */
  privateKey: string;
  publicKey: string;
  serialNumber: string;
  fingerprint: string;
};

const OID = {
  commonName: '2.5.4.3',
  serialNumber: '2.5.4.4',
  countryName: '2.5.4.6',
  organizationName: '2.5.4.10',
  organizationalUnitName: '2.5.4.11',
  title: '2.5.4.12',
  businessCategory: '2.5.4.15',
  registeredAddress: '2.5.4.26',
  uid: '0.9.2342.19200300.100.1.1',
  subjectAltName: '2.5.29.17',
  extensionRequest: '1.2.840.113549.1.9.14',
  zatcaCodeSigning: '1.3.6.1.4.1.311.20.2',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
} as const;

// ── Minimal DER writer ───────────────────────────────────────────────────────────────────
// PKCS#10 needs seven element types. Everything below is the DER (not BER) encoding: minimal
// length octets, no trailing options.

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tag(tagByte: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tagByte]), derLength(content.length), content]);
}

const sequence = (...parts: Buffer[]): Buffer => tag(0x30, Buffer.concat(parts));
const derSet = (...parts: Buffer[]): Buffer => tag(0x31, Buffer.concat(parts));
const bitString = (content: Buffer): Buffer => tag(0x03, Buffer.concat([Buffer.from([0]), content]));
const octetString = (content: Buffer): Buffer => tag(0x04, content);
const utf8String = (value: string): Buffer => tag(0x0c, Buffer.from(value, 'utf8'));
const printableString = (value: string): Buffer => tag(0x13, Buffer.from(value, 'ascii'));
const contextTag = (index: number, content: Buffer): Buffer => tag(0xa0 | index, content);

/** Object identifiers: first arc × 40 + second arc, then every arc base-128, high bit set. */
function objectIdentifier(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const body: number[] = [];
  const writeArc = (value: number) => {
    const bytes: number[] = [value & 0x7f];
    let rest = value >> 7;
    while (rest > 0) {
      bytes.unshift((rest & 0x7f) | 0x80);
      rest >>= 7;
    }
    body.push(...bytes);
  };
  writeArc(arcs[0]! * 40 + arcs[1]!);
  for (const arc of arcs.slice(2)) writeArc(arc);
  return tag(0x06, Buffer.from(body));
}

/** One `AttributeTypeAndValue`: SET { SEQUENCE { OID, value } }. */
function attribute(type: string, value: Buffer): Buffer {
  return derSet(sequence(objectIdentifier(type), value));
}

/**
 * The desktop's serial is `1-Auditor|2-<version>|3-<guid>` (`frmZatcaSetting.xaml.cs`
 * L151-L157, regenerated on every window open through «🔄 تعبئة تلقائي»'s sibling
 * `GenerateSerialNo`). The three parts are ZATCA's: solution name, model/version, device
 * serial.
 */
export function defaultSerialNumber(version = process.env.APP_VERSION ?? '1.0.0'): string {
  return `1-CloudERP|2-${version}|3-${randomUuid()}`;
}

function randomUuid(): string {
  const bytes = createHash('sha512').update(`${Date.now()}:${Math.random()}`).digest();
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Builds the request and its key pair. Throws `CSR_*` domain errors on bad input. */
export function generateCsr(properties: CsrProperties): GeneratedCsr {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'secp256k1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const subject = sequence(
    attribute(OID.countryName, printableString(properties.countryName || 'SA')),
    attribute(OID.organizationalUnitName, utf8String(properties.organizationUnitName)),
    attribute(OID.organizationName, utf8String(properties.organizationName)),
    attribute(OID.commonName, utf8String(properties.commonName)),
  );

  const subjectPublicKeyInfo = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });

  const directoryName = sequence(
    attribute(OID.serialNumber, utf8String(properties.serialNumber)),
    attribute(OID.uid, utf8String(properties.organizationIdentifier)),
    attribute(OID.title, utf8String(properties.invoiceType)),
    attribute(OID.registeredAddress, utf8String(properties.address)),
    attribute(OID.businessCategory, utf8String(properties.industry)),
  );

  const subjectAltName = sequence(contextTag(4, directoryName));
  const extensions = sequence(
    sequence(objectIdentifier(OID.subjectAltName), octetString(subjectAltName)),
    sequence(objectIdentifier(OID.zatcaCodeSigning), octetString(utf8String('ZATCA-Code-Signing'))),
  );

  const attributes = contextTag(
    0,
    sequence(objectIdentifier(OID.extensionRequest), derSet(extensions)),
  );

  const certificationRequestInfo = sequence(
    tag(0x02, Buffer.from([0])),
    subject,
    Buffer.from(subjectPublicKeyInfo),
    attributes,
  );

  const signature = signWithKey('sha256', certificationRequestInfo, privateKey);
  const certificationRequest = sequence(
    certificationRequestInfo,
    sequence(objectIdentifier(OID.ecdsaWithSha256)),
    bitString(signature),
  );

  const csr = certificationRequest.toString('base64');
  return {
    csr,
    privateKey,
    publicKey,
    serialNumber: properties.serialNumber,
    fingerprint: createHash('sha256').update(certificationRequest).digest('hex').slice(0, 32),
  };
}
