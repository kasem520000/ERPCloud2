import { Module } from '@nestjs/common';

import { BranchesController } from './branches/branches.controller.js';
import { BranchesService } from './branches/branches.service.js';
import { CashLocationsController } from './cash-locations/cash-locations.controller.js';
import { CashLocationsService } from './cash-locations/cash-locations.service.js';
import { CompanyProfileController } from './company-profile/company-profile.controller.js';
import { CompanyProfileService } from './company-profile/company-profile.service.js';
import { CurrenciesController, FxRatesController } from './currencies/currencies.controller.js';
import { CurrenciesService } from './currencies/currencies.service.js';
import { FxService } from './currencies/fx.service.js';
import { PostingProfilesController } from './posting-profiles/posting-profiles.controller.js';
import { PostingProfilesService } from './posting-profiles/posting-profiles.service.js';
import { PriceListsController } from './price-lists/price-lists.controller.js';
import { PriceListsService } from './price-lists/price-lists.service.js';
import { OrgProvisioningService } from './provisioning/org-provisioning.service.js';
import { WarehousesController } from './warehouses/warehouses.controller.js';
import { WarehousesService } from './warehouses/warehouses.service.js';

/**
 * Organization module — PHASE_05. Company profile, branches, warehouses, cash
 * locations, currencies and FX, price lists and branch posting profiles
 * (DOMAIN_MODEL §2: "owns … consumes platform").
 *
 * It depends on `platform` (guards, tenant context) and `platform-services` (audit,
 * files) exclusively through their public surfaces — both are `@Global()`, so no
 * `imports:` edge is needed and no module cycle can form.
 *
 * `exports` is what PHASE_06+ may use: the CRUD services for reference checks,
 * `OrgProvisioningService.provisionOrgDefaults` for tenant bootstrap, `FxService`
 * for valuation and `PostingProfilesService.resolvePostProfile` for every posting
 * engine.
 */
@Module({
  controllers: [
    CompanyProfileController,
    BranchesController,
    WarehousesController,
    CashLocationsController,
    CurrenciesController,
    FxRatesController,
    PriceListsController,
    PostingProfilesController,
  ],
  providers: [
    CompanyProfileService,
    BranchesService,
    WarehousesService,
    CashLocationsService,
    CurrenciesService,
    FxService,
    PriceListsService,
    PostingProfilesService,
    OrgProvisioningService,
  ],
  exports: [
    CompanyProfileService,
    BranchesService,
    WarehousesService,
    CashLocationsService,
    CurrenciesService,
    FxService,
    PriceListsService,
    PostingProfilesService,
    OrgProvisioningService,
  ],
})
export class OrganizationModule {}
