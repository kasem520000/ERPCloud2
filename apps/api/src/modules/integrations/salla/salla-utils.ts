import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { dataEncryptionKey } from '@erp/config';
function keyBytes(secret = dataEncryptionKey()) { return createHash('sha256').update(secret).digest(); }
export function encryptSallaSecret(plain: string, key = process.env.DATA_ENC_KEY) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv); const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]); return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`; }
export function decryptSallaSecret(payload: string, key = process.env.DATA_ENC_KEY) { const [, iv64, tag64, data64] = payload.split(':'); const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(iv64!, 'base64')); decipher.setAuthTag(Buffer.from(tag64!, 'base64')); return Buffer.concat([decipher.update(Buffer.from(data64!, 'base64')), decipher.final()]).toString('utf8'); }
/**
 * AUD-04 — فحص توقيع Salla على **البايتات الخام**. ثلاث دقائق عملية:
 *   • غياب الترويسة (أو قيمة فراغية) ⇒ رفض بلا استثناء `TypeError` من `Buffer.from(undefined)`
 *     كما كان يحدث سابقاً (كان الرفض يظهر 500 بدل 401)؛
 *   • التوقيع المتوقّع hex بستّه وأربعين محرفاً، وما لا يطابق ذلك يُرفض بلا مقارنة؛
 *   • المقارنة زمنية الثبات (`timingSafeEqual`) على طولين متساويين.
 */
export function verifySallaSignature(rawBody: string, signature: string | undefined, secret: string) {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature.toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
export type SallaSnapshot = { name?: string | null; price?: string | null; cost?: string | null; qty?: string | null };
export function detectSallaDiff(current: SallaSnapshot, exported: SallaSnapshot) { const flags: string[] = []; if ((current.name ?? '') !== (exported.name ?? '')) flags.push('name'); if ((current.price ?? '0') !== (exported.price ?? '0')) flags.push('price'); if ((current.cost ?? '0') !== (exported.cost ?? '0')) flags.push('cost'); if ((current.qty ?? '0') !== (exported.qty ?? '0')) flags.push('qty'); return flags; }
