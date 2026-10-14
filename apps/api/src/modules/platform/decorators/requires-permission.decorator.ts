import { SetMetadata } from '@nestjs/common';

/**
 * Declares the permission a route requires (SECURITY_ARCHITECTURE §3). Codes come from
 * the registry in `@erp/contracts` and use the `module.entity.action` shape
 * (PROJECT_CONTRACT §1).
 */
export const REQUIRED_PERMISSION_KEY = 'erp:requiredPermission';

/**
 * Additional codes a route needs on top of its primary one. A single code keeps the
 * historical string metadata (every existing route and the guard spec); an array is
 * written only when a route genuinely spans two modules — e.g. the POS checkout,
 * which operates the till *and* posts a sales invoice.
 */
export const RequiresPermission = (code: string, ...also: string[]) =>
  SetMetadata(REQUIRED_PERMISSION_KEY, also.length ? [code, ...also] : code);
