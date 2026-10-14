import { loadEnvFiles } from '../../scripts/dotenv.mjs';

loadEnvFiles(process.cwd());

/**
 * Hosts allowed to talk to the dev server.
 *
 * The site is opened through a tunnel host (`https://3002-<sandbox>.e2b.app`) and Next 15
 * treats any `/_next/*` request whose Host is not localhost as a cross-origin dev request:
 * it warns today and refuses in a future major — which leaves the preview a blank page.
 * Listed here once, together with `apps/staff`/`apps/platform-admin`.
 */
const allowedDevOrigins = [
  'localhost',
  '127.0.0.1',
  '*.e2b.app',
  '*.e2b.dev',
  '*.arena.ai',
];

const apiTarget = (process.env.API_PROXY_TARGET ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`).replace(/\/+$/, '');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Design System v3 — the shared kit ships as TypeScript source and is
  // compiled by this app's own toolchain, so there is no build step to keep
  // in sync between the three surfaces (ADR-030).
  transpilePackages: ['@erp/ui'],
  // مخرج بناءٍ بديل عند الطلب (`NEXT_DIST_DIR`): يسمح ببناءٍ إنتاجيّ للتحقّق **بينما**
  // خادم التطوير يعمل على `.next` — بلا أن يدوس أحدهما الآخر.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  allowedDevOrigins,
  poweredByHeader: false,
  env: {
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
            // SH-01: restrict frame-ancestors to self + Arena/e2b preview hosts (or CSP_FRAME_ANCESTORS)
            // instead of `*`, and drop 'unsafe-eval' in production builds while keeping dev HMR working.
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
