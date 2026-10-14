/**
 * Public API of the organization module (TARGET_ARCHITECTURE §4.1).
 *
 * Later phases import from this file only; `eslint-plugin-boundaries` and the
 * cross-module rule of AI_DEVELOPMENT_PROTOCOL §4 block the deep paths.
 */
export { OrganizationModule } from './organization.module.js';

export { BranchesService } from './branches/branches.service.js';
export { WarehousesService, assertBranchUsable } from './warehouses/warehouses.service.js';
export { CashLocationsService } from './cash-locations/cash-locations.service.js';
export { CompanyProfileService } from './company-profile/company-profile.service.js';
export { CurrenciesService } from './currencies/currencies.service.js';
export { FxService, FX_SCALE } from './currencies/fx.service.js';
export type { FxResolution } from './currencies/fx.service.js';
export { PriceListsService } from './price-lists/price-lists.service.js';
export { PostingProfilesService, pickByPrecedence } from './posting-profiles/posting-profiles.service.js';
export { OrgProvisioningService } from './provisioning/org-provisioning.service.js';
export type { OrgDefaults, ProvisionOptions } from './provisioning/org-provisioning.service.js';
