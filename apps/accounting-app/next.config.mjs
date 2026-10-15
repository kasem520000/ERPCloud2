import { loadEnvFiles } from '../../scripts/dotenv.mjs';

// Next.js only reads `apps/accounting-app/.env*`. The monorepo keeps a single root `.env`,
// so it is loaded here before the config object is evaluated (same as apps/staff).
loadEnvFiles(process.cwd());

const apiTarget = (process.env.API_PROXY_TARGET ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`).replace(/\/+$/, '');

/**
 * @type {import('next').NextConfig'}
 */
const nextConfig = {
  output: 'standalone',
  // The shared kits ship as TypeScript source and are compiled by this app's own
  // toolchain (ADR-030), same as the other surfaces.
  transpilePackages: ['@erp/ui', '@erp/web-core'],
  poweredByHeader: false,
  // The app is opened through tunnel hosts (`https://3005-<sandbox>.e2b.app`); listing the
  // sandbox domains keeps the tunneled dev preview working (same rationale as staff).
  allowedDevOrigins: [
    'localhost',
    '127.0.0.1',
    '*.e2b.app',
    '*.e2b.dev',
    '*.arena.ai',
  ],
  env: {
    // Empty means "same origin" — requests go to /api/v1/* on this server and the rewrite
    // below forwards them to the API, so the UI works from any host without touching CORS.
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? '',
  },
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${apiTarget}/api/v1/:path*` },
      { source: '/api/health/:path*', destination: `${apiTarget}/health/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            // SH-01: restrict frame-ancestors to self + Arena/e2b preview hosts (or
            // CSP_FRAME_ANCESTORS), drop 'unsafe-eval' in production builds.
            value: [
              "default-src 'self'",
              "base-uri 'self'",
              "object-src 'none'",
              "form-action 'self'",
              "connect-src 'self' http: https:",
              "img-src 'self' data: blob:",
              "style-src 'self' 'unsafe-inline'",
              process.env.NODE_ENV === 'production'
                ? "script-src 'self' 'unsafe-inline'"
                : "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
              `frame-ancestors ${process.env.CSP_FRAME_ANCESTORS ?? "'self' https://*.e2b.app https://*.e2b.dev https://*.arena.ai"}`,
            ].join('; '),
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
