/**
 * Pure rules for the employee PWA. No database and no network.
 * Attendance is valid only inside the branch geofence. A punch outside is still
 * stored, and the caller must alert a manager. Requests never include another
 * employee's payslip or a national id.
 */

export type PunchType = 'check_in' | 'check_out';
export type AttendanceStatus = 'valid' | 'outside_geofence';
export type RequestType = 'leave' | 'permission' | 'custody' | 'advance';
export type RequestStatus = 'pending' | 'approved' | 'rejected';

export type GeoPoint = { lat: number; lng: number };
export type Geofence = GeoPoint & { radiusMeters: number };

export type PunchInput = {
  clientId: string;
  type: PunchType;
  lat: number;
  lng: number;
  at: string;
};

export type AttendanceDecision = {
  status: AttendanceStatus;
  distanceMeters: number | null;
  alertManager: boolean;
};

export type EmployeeRequest = {
  id: string;
  employeeId: string;
  type: RequestType;
  status: RequestStatus;
  reason: string;
};

export type PushNotice = {
  kind: 'request_approved' | 'request_rejected' | 'outside_geofence';
  title: string;
  body: string;
};

export type PayslipLine = {
  employeeId: string;
  period: string;
  net: string;
  nationalId?: string;
  iban?: string;
};

const EARTH_METERS = 6_371_000;
const REQUEST_TYPES = new Set<RequestType>(['leave', 'permission', 'custody', 'advance']);
const PUNCH_TYPES = new Set<PunchType>(['check_in', 'check_out']);

export function haversineMeters(from: GeoPoint, to: GeoPoint): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function classifyPunch(point: GeoPoint, fence: Geofence | null): AttendanceDecision {
  if (!fence) return { status: 'outside_geofence', distanceMeters: null, alertManager: true };
  const distanceMeters = Math.round(haversineMeters(point, fence));
  const outside = distanceMeters > fence.radiusMeters;
  return {
    status: outside ? 'outside_geofence' : 'valid',
    distanceMeters,
    alertManager: outside,
  };
}

export function assertPunch(input: { type: string; lat: number; lng: number }): PunchType {
  if (!PUNCH_TYPES.has(input.type as PunchType)) throw new Error('نوع الحضور غير مدعوم');
  if (!Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90) throw new Error('خط العرض غير صالح');
  if (!Number.isFinite(input.lng) || input.lng < -180 || input.lng > 180) throw new Error('خط الطول غير صالح');
  return input.type as PunchType;
}

export function assertRequestType(type: string): RequestType {
  if (!REQUEST_TYPES.has(type as RequestType)) throw new Error('نوع الطلب غير مدعوم');
  return type as RequestType;
}

export function redactEmployeeText(value: string): string {
  return value.replace(/\bSA\d{22}\b/gi, '[IBAN]').replace(/(?<!\d)[12]\d{9}(?!\d)/g, '[ID]');
}

export function inboxFor(
  requests: readonly EmployeeRequest[],
  viewerEmployeeId: string,
  canApprove: boolean,
): EmployeeRequest[] {
  if (canApprove) return requests.filter((request) => request.status === 'pending');
  return requests.filter((request) => request.employeeId === viewerEmployeeId);
}

export function hrmApprovedLeaves(requests: readonly EmployeeRequest[]): EmployeeRequest[] {
  return requests.filter((request) => request.type === 'leave' && request.status === 'approved');
}

export function decideRequest(
  request: EmployeeRequest,
  decision: 'approved' | 'rejected',
): { request: EmployeeRequest; push: PushNotice } {
  if (request.status !== 'pending') throw new Error('الطلب محسوم');
  const next = { ...request, status: decision };
  return {
    request: next,
    push:
      decision === 'approved'
        ? { kind: 'request_approved', title: 'تمت الموافقة', body: `وُوفق على طلب ${labelFor(request.type)}.` }
        : { kind: 'request_rejected', title: 'رُفض الطلب', body: `رُفض طلب ${labelFor(request.type)}.` },
  };
}

export function outsideAlert(employeeName: string): PushNotice {
  return {
    kind: 'outside_geofence',
    title: 'حضور خارج النطاق',
    body: `${employeeName} سجّل حضوراً خارج نطاق الفرع.`,
  };
}

export function planSync(existingClientIds: readonly string[], incoming: readonly PunchInput[]): {
  apply: PunchInput[];
  duplicates: string[];
} {
  const seen = new Set(existingClientIds);
  const apply: PunchInput[] = [];
  const duplicates: string[] = [];
  for (const punch of incoming) {
    if (seen.has(punch.clientId)) {
      duplicates.push(punch.clientId);
      continue;
    }
    seen.add(punch.clientId);
    apply.push(punch);
  }
  return { apply, duplicates };
}

export function ownPayslips(lines: readonly PayslipLine[], employeeId: string): Array<Omit<PayslipLine, 'nationalId' | 'iban'>> {
  return lines
    .filter((line) => line.employeeId === employeeId)
    .map(({ employeeId: id, period, net }) => ({ employeeId: id, period, net }));
}

function labelFor(type: RequestType): string {
  if (type === 'leave') return 'الإجازة';
  if (type === 'permission') return 'الاستئذان';
  if (type === 'custody') return 'العهدة';
  return 'السلفة';
}
