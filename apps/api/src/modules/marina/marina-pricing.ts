import { Decimal } from 'decimal.js';
export function calculateMarinaPeriod(input: { startsAt: string; endsAt: string; hourlyPrice: string; halfHourPrice?: string; offerPrice?: string }) {
  const ms = new Date(input.endsAt).getTime() - new Date(input.startsAt).getTime();
  if (ms <= 0) throw new Error('booking end must be after start');
  const minutes = new Decimal(ms).div(60000);
  if (input.offerPrice) return new Decimal(input.offerPrice).toFixed(4);
  const hours = minutes.div(60).floor();
  const remainder = minutes.minus(hours.mul(60));
  const halfHours = remainder.gt(0) ? (remainder.lte(30) ? new Decimal(1) : new Decimal(2)) : new Decimal(0);
  return hours.mul(input.hourlyPrice).plus(halfHours.mul(input.halfHourPrice ?? new Decimal(input.hourlyPrice).div(2))).toFixed(4);
}
