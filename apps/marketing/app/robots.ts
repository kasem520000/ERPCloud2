import type { MetadataRoute } from 'next';

import { siteInfo } from '../lib/meta';
import { robotsRules } from '../lib/site';

export default async function robots(): Promise<MetadataRoute.Robots> {
  const site = await siteInfo();
  return robotsRules(site);
}
