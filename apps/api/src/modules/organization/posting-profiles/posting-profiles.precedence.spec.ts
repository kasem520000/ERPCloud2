import { describe, expect, it } from 'vitest';
import { POSTING_PROFILE_WILDCARD } from '@erp/contracts';

import { pickByPrecedence } from './posting-profiles.service.js';

/**
 * The posting-profile fallback chain — PHASE_05 §5.5, §11 ("fallback chain
 * unit-verified"). A branch override must always beat a tenant default, mirroring what
 * `Branches.*Acc` did to `SettingGeneral.*Acc` in the legacy system.
 */

const BRANCH = '018f3b8a-0000-7000-8000-0000000000b1';
const OTHER_BRANCH = '018f3b8a-0000-7000-8000-0000000000b2';
const DOC = 'sales_invoice';

type Candidate = { id: string; branchId: string | null; docType: string };

const branchExact: Candidate = { id: 'branch-exact', branchId: BRANCH, docType: DOC };
const branchWildcard: Candidate = { id: 'branch-wildcard', branchId: BRANCH, docType: POSTING_PROFILE_WILDCARD };
const tenantExact: Candidate = { id: 'tenant-exact', branchId: null, docType: DOC };
const tenantWildcard: Candidate = { id: 'tenant-wildcard', branchId: null, docType: POSTING_PROFILE_WILDCARD };

describe('pickByPrecedence', () => {
  it('prefers the branch-specific profile for the exact doc type', () => {
    const all = [tenantWildcard, tenantExact, branchWildcard, branchExact];
    expect(pickByPrecedence(all, BRANCH, DOC)?.id).toBe('branch-exact');
  });

  it("falls back to the branch's wildcard before any tenant default", () => {
    const all = [tenantWildcard, tenantExact, branchWildcard];
    expect(pickByPrecedence(all, BRANCH, DOC)?.id).toBe('branch-wildcard');
  });

  it('falls back to the tenant default for the exact doc type', () => {
    const all = [tenantWildcard, tenantExact];
    expect(pickByPrecedence(all, BRANCH, DOC)?.id).toBe('tenant-exact');
  });

  it('falls back to the tenant wildcard last — the legacy global mapping', () => {
    expect(pickByPrecedence([tenantWildcard], BRANCH, DOC)?.id).toBe('tenant-wildcard');
  });

  it('never borrows another branch profile', () => {
    const foreign: Candidate = { id: 'foreign', branchId: OTHER_BRANCH, docType: DOC };
    expect(pickByPrecedence([foreign], BRANCH, DOC)).toBeUndefined();
  });

  it('returns nothing when only an unrelated doc type is mapped', () => {
    const other: Candidate = { id: 'other-doc', branchId: BRANCH, docType: 'purchase_invoice' };
    expect(pickByPrecedence([other], BRANCH, DOC)).toBeUndefined();
  });
});
