import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@erp/contracts';
import { withTenantTx, type DatabaseHandle } from '@erp/database';

import { DATABASE_HANDLE } from '../../database/database.module.js';
import type { RoleScopeValue } from '../../request-context/request-context.js';
import { assertScope } from '../platform/scopes/scope-policy.js';
import { VanSalesSharedService } from '../van-sales/van-sales-shared.service.js';

/**
 * 🛡️ حارس المندوب (D-004) — the single place that decides who may call a field-sync or
 * rep-workspace route.
 *
 * The product promise is "the rep sees and moves only his own van". That is enforced here
 * in the API, not filtered in the UI (decision D-004, closed 2026-10-15):
 *
 *   1. **Identity** — the rep is derived from the caller's own membership
 *      (`memberships → employees → salesmen`), never from a request parameter. A caller
 *      with no salesman card is a back-office user: field-sync is not for him → 403.
 *   2. **Card state** — an inactive rep or a card with no van warehouse is a setup gap,
 *      reported honestly instead of silently falling back to "all warehouses".
 *   3. **Warehouse scope (AUD-03)** — `assertScope` over `membership_role_scopes`: the
 *      caller's role grants must explicitly cover his van warehouse. A role with no scope
 *      rows grants nothing; `linkSalesmanAccount` is what writes the one row that opens
 *      exactly this warehouse.
 *
 * Every field-sync / rep-workspace route resolves the caller through this guard before
 * touching data; the negative matrix lives in `apps/api/test/field-sync.spec.ts`.
 */
@Injectable()
export class FieldSyncRepGuardService {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    private readonly shared: VanSalesSharedService,
  ) {}

  async authoriseRep(input: {
    tenantId: string;
    membershipId: string | null;
    roleIds?: readonly string[];
    scopes?: readonly RoleScopeValue[];
  }): Promise<AuthorisedRep> {
    const { tenantId, membershipId } = input;

    const rep = await withTenantTx(this.database.db, tenantId, async (tx) =>
      this.shared.resolveSalesmanForMembershipInTx(tx, tenantId, membershipId),
    );
    if (!rep) {
      throw new DomainError(
        'FIELD_SYNC_NOT_A_REP',
        'هذه الواجهات لتطبيق المندوب فقط — حسابك غير مرتبط ببطاقة مندوب توزيع',
        403,
      );
    }
    if (!rep.active) {
      throw new DomainError(
        'FIELD_SYNC_REP_INACTIVE',
        'بطاقة المندوب موقوفة — راجع المحاسب قبل المزامنة',
        403,
      );
    }
    if (!rep.warehouseId) {
      throw new DomainError(
        'FIELD_SYNC_NO_VAN_WAREHOUSE',
        'بطاقة المندوب بلا مستودع سيارة — لا يمكن تحديد عهدته',
        403,
      );
    }

    assertScope(
      input.scopes ?? [],
      input.roleIds ?? [],
      'warehouse',
      rep.warehouseId,
    );

    return rep as AuthorisedRep;
  }
}

export type AuthorisedRep = {
  salesmanId: string;
  salesmanName: string;
  employeeId: string | null;
  warehouseId: string;
  vehiclePlate: string | null;
  active: boolean;
};
