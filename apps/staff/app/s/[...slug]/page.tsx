'use client';

import { use } from 'react';

import { ScreenScaffold } from '../../../components/screen';

/**
 * Catch-all for every screen that exists in the navigation tree but has no
 * implementation yet. It renders the real status of that screen — never fake data.
 */
export default function ScaffoldPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = use(params);
  return <ScreenScaffold href={`/s/${slug.join('/')}`} />;
}
