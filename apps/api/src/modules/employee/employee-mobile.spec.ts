import { describe, expect, it } from 'vitest';

import {
  assertPunch,
  classifyPunch,
  decideRequest,
  hrmApprovedLeaves,
  inboxFor,
  outsideAlert,
  ownPayslips,
  planSync,
  type EmployeeRequest,
} from './employee-mobile.js';

const RIYADH = { lat: 24.7136, lng: 46.6753, radiusMeters: 200 };
const ME = 'employee-me';
const OTHER = 'employee-other';

function request(overrides: Partial<EmployeeRequest> = {}): EmployeeRequest {
  return {
    id: 'req-1',
    employeeId: ME,
    type: 'leave',
    status: 'pending',
    reason: 'سفر',
    ...overrides,
  };
}

describe('mobile employee', () => {
  it('records a punch inside the branch geofence as valid', () => {
    const decision = classifyPunch({ lat: 24.7136, lng: 46.6753 }, RIYADH);
    expect(decision.status).toBe('valid');
    expect(decision.alertManager).toBe(false);
    expect(decision.distanceMeters).toBe(0);
  });

  it('records a punch outside the geofence and alerts the manager', () => {
    const decision = classifyPunch({ lat: 24.73, lng: 46.6753 }, RIYADH);
    expect(decision.status).toBe('outside_geofence');
    expect(decision.alertManager).toBe(true);
    expect(decision.distanceMeters).toBeGreaterThan(200);
    expect(outsideAlert('نورة').kind).toBe('outside_geofence');
  });

  it('shows a leave request in the manager inbox', () => {
    const inbox = inboxFor([request(), request({ id: 'req-2', employeeId: OTHER, status: 'approved' })], ME, true);
    expect(inbox.map((row) => row.id)).toEqual(['req-1']);
  });

  it('publishes an approved leave to HRM', () => {
    const decided = decideRequest(request(), 'approved');
    expect(hrmApprovedLeaves([decided.request])).toEqual([decided.request]);
  });

  it('syncs an offline punch once and ignores the same client id', () => {
    const punch = { clientId: 'offline-1', type: 'check_in' as const, lat: 24.7136, lng: 46.6753, at: '2026-09-28T06:00:00Z' };
    const first = planSync([], [punch]);
    const second = planSync(['offline-1'], [punch]);
    expect(first.apply).toEqual([punch]);
    expect(second.apply).toEqual([]);
    expect(second.duplicates).toEqual(['offline-1']);
  });

  it('builds a push notice when a request is approved', () => {
    const decided = decideRequest(request(), 'approved');
    expect(decided.push.kind).toBe('request_approved');
    expect(decided.push.body).toContain('الإجازة');
  });

  it('hides another employee request from a self viewer', () => {
    const visible = inboxFor([request(), request({ id: 'req-2', employeeId: OTHER })], ME, false);
    expect(visible.map((row) => row.employeeId)).toEqual([ME]);
  });

  it('rejects a pending request without approving it', () => {
    const decided = decideRequest(request({ type: 'advance' }), 'rejected');
    expect(decided.request.status).toBe('rejected');
    expect(hrmApprovedLeaves([decided.request])).toEqual([]);
    expect(decided.push.kind).toBe('request_rejected');
  });

  it('accepts check-out as its own punch type inside the fence', () => {
    expect(assertPunch({ type: 'check_out', lat: 24.7136, lng: 46.6753 })).toBe('check_out');
    expect(classifyPunch(RIYADH, RIYADH).status).toBe('valid');
  });

  it('returns only the caller payslip and strips identity numbers', () => {
    const slips = ownPayslips(
      [
        { employeeId: ME, period: '2026-09', net: '4000.00', nationalId: '1012345678', iban: 'SA0380000000608010167519' },
        { employeeId: OTHER, period: '2026-09', net: '9000.00', nationalId: '2098765432' },
      ],
      ME,
    );
    expect(slips).toEqual([{ employeeId: ME, period: '2026-09', net: '4000.00' }]);
    expect(JSON.stringify(slips)).not.toContain('1012345678');
    expect(JSON.stringify(slips)).not.toContain('9000.00');
  });
});
