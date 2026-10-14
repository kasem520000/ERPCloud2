import { SetMetadata } from '@nestjs/common';

/** Marks a route as reachable without an access token (API_CONTRACT §1 "public"). */
export const IS_PUBLIC_KEY = 'erp:isPublic';

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
