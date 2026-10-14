import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { OrgProvisioningService } from '../../organization/provisioning/org-provisioning.service.js';
import { RequiresPlatformRole } from '../decorators/requires-platform-role.decorator.js';
import { PlatformAdminGuard } from '../guards/platform-admin.guard.js';

import { PlatformAdminService, type CreateTenantInput } from './platform-admin.service.js';

/**
 * `/api/v1/platform/*` — the SaaS control plane consumed by the admin console at
 * `/platform`. Every route sits behind `PlatformAdminGuard`.
 *
 * **P-C1 (2026-09-17) — the permission repair.** Until this part, two routes carried a
 * `console.*` code and the other eleven were reachable by *any* effective platform
 * administrator: the `pam` claim alone was enough to suspend a customer, retire a plan or
 * cancel a licence (INCOMPLETE_INVENTORY §4.2 measured it: 10 of 12 codes declared but
 * unused). Every route below now names the code it needs, so the five Family-A roles in
 * `@erp/contracts`' `platformRoleCatalog` mean what their descriptions say:
 *
 * | Route | Code | Owner | Operations | Billing | Support | Auditor |
 * |---|---|---|---|---|---|---|
 * | `GET overview` | `console.tenants.view` | ✓ | ✓ | ✓ | ✓ | ✓ |
 * | `GET tenants` | `console.tenants.view` | ✓ | ✓ | ✓ | ✓ | ✓ |
 * | `POST tenants` | `console.tenants.manage` | ✓ | | | | |
 * | `POST tenants/:id/status` (P-C2, in `PlatformTenantsController`) | `console.tenants.manage` | ✓ | | | | |
 * | `GET activation-requests` | `console.activation.review` | ✓ | | ✓ | | |
 * | `POST activation-requests/:id/review` | `console.activation.review` | ✓ | | ✓ | | |
 * | `GET users` | `console.users.view` | ✓ | | | | |
 * | `GET roles` | `console.users.view` | ✓ | | | | |
 * | `GET permissions` | `console.users.view` | ✓ | | | | |
 * | `POST users/:id/roles` | `console.users.manage` | ✓ | | | | |
 * | `DELETE users/:id/roles/:roleCode` | `console.users.manage` | ✓ | | | | |
 *
 * Read routes are mapped to the code that owns the *area* (plans/subscriptions/activation
 * queue/identity) rather than to a read-only twin, because no `console.*.view` twin exists
 * for them in the registry and inventing four codes to read four lists is not a smaller
 * surface — it is a bigger one. The console sidebar hides exactly what these codes deny
 * (`apps/platform-admin/lib/navigation.ts`), so the operator sees no dead links.
 */
@ApiTags('platform-admin')
@ApiBearerAuth()
@UseGuards(PlatformAdminGuard)
@Controller('platform')
export class PlatformAdminController {
  constructor(
    private readonly admin: PlatformAdminService,
    private readonly provisioning: OrgProvisioningService,
  ) {}

  @Get('overview')
  @RequiresPlatformRole('console.tenants.view')
  @ApiOperation({ summary: 'Control-plane KPIs: customers, licences, MRR, pending activations' })
  async overview() {
    return { data: await this.admin.overview() };
  }

  // ------------------------------------------------------------------ tenants

  @Get('tenants')
  @RequiresPlatformRole('console.tenants.view')
  @ApiOperation({ summary: 'List every customer with its current licence' })
  async listTenants(@Query('search') search?: string, @Query('status') status?: string) {
    return { data: await this.admin.listTenants(search, status) };
  }

  @Post('tenants')
  @RequiresPlatformRole('console.tenants.manage')
  @ApiOperation({ summary: 'Create a customer, its owner account and its default branch' })
  async createTenant(@Body() body: CreateTenantInput) {
    const created = await this.admin.createTenant(body);
    // A tenant without a branch cannot number a document or hold stock, so the org
    // defaults are provisioned right away (idempotent).
    const defaults = await this.provisioning.provisionOrgDefaults(created.tenantId, {
      actorUserId: created.ownerUserId,
    });
    return { data: { ...created, defaults } };
  }

  // `PATCH tenants/:id/status` lived here and took a status with no reason. P-C2 replaced it
  // with `POST /platform/tenants/:id/status` (`PlatformTenantsController`) which requires
  // «السبب»: suspending a customer must be explainable a month later, and two routes for one
  // decision — one of them reason-less — means the rule is only as strong as the caller.

  // «الباقات» and «التراخيص» used to be answered here. P-C4 moved them — **with their
  // paths** — to `PlatformBillingController`, because a plan's entitlement set, a licence's
  // lifecycle and the invoices that follow are one subject, and the class that answers them
  // should be the one that owns that subject. Two handlers were *replaced* rather than moved
  // (recorded in the P-C4 report): `PATCH plans/:id/active` became `PATCH plans/:id`, and
  // `POST subscriptions/:id/cancel` gained a reason and `atPeriodEnd`.

  // ------------------------------------------------------------------ activation queue

  @Get('activation-requests')
  @RequiresPlatformRole('console.activation.review')
  @ApiOperation({ summary: 'Manual activation queue' })
  async listActivationRequests(@Query('status') status?: string) {
    return { data: await this.admin.listActivationRequests(status ?? 'pending') };
  }

  @Post('activation-requests/:id/review')
  @RequiresPlatformRole('console.activation.review')
  @ApiOperation({ summary: 'Approve or reject an activation request' })
  async reviewActivation(@Param('id') id: string, @Body() body: { approve: boolean; notes?: string }) {
    return { data: await this.admin.reviewActivation(id, body.approve, body.notes) };
  }

  // ------------------------------------------------- identity
  //
  // `GET users` · `GET users/:id` · `GET roles` · `GET permissions` · `POST users/:id/roles` ·
  // `DELETE users/:id/roles/:roleCode` used to live here. P-C3 moved them — unchanged paths —
  // to `PlatformIdentityController`, because «who exists and what may they do» is one subject
  // and this controller's subject is customers, plans, licences and activation review. One
  // path, one owner: the same rule that retired the duplicate `PATCH …/status` route in P-C2.
}
