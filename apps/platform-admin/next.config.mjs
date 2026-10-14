import { loadEnvFiles } from '../../scripts/dotenv.mjs';

// Next.js only reads `apps/platform-admin/.env*`. The monorepo keeps a single root `.env`, so it
// is loaded here before the config object is evaluated.
loadEnvFiles(process.cwd());

const apiTarget = (process.env.API_PROXY_TARGET ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`).replace(/\/+$/, '');

/**
 * Which hosts may talk to the dev server.
 *
 * Carried over from the staff surface (`apps/staff/next.config.mjs` L11–28), which learned
 * it first: the console is opened through a tunnel host (`https://3003-<sandbox>.e2b.app`),
 * and Next 15 treats every `/_next/*` request whose Host is not localhost as cross-origin —
 * it warns today and in a future major version refuses to serve the chunks, which leaves the
 * preview a blank page. The wildcard is dev-only: `next start` ignores the option.
 */
const allowedDevOrigins = ['localhost', '127.0.0.1', '*.e2b.app', '*.e2b.dev', '*.arena.ai'];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Design System v3 — the shared kit ships as TypeScript source and is
  // compiled by this app's own toolchain, so there is no build step to keep
  // in sync between the three surfaces (ADR-030).
  transpilePackages: ['@erp/ui'],
  poweredByHeader: false,
  allowedDevOrigins,
  env: {
    // Exposed to the browser. Empty means "same origin" — requests go to /api/v1/* on
    // this server and the rewrite below forwards them to the API. That is what makes
    // the UI work from any host (LAN, tunnel, container) without touching CORS.
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? '',
  },
  async rewrites() {
    return [
      { source: '/api/v1/:path*', destination: `${apiTarget}/api/v1/:path*` },
      { source: '/api/health/:path*', destination: `${apiTarget}/health/:path*` },
      // P-C11 — مستكشف الـAPI يقرأ وثيقة OpenAPI وواجهة Swagger من نفس الأصل، فلا حاجة
      // لفتح منفذ الـAPI في المتصفّح ولا لضبط CORS على مسارٍ للتوثيق.
      { source: '/api/docs/:path*', destination: `${apiTarget}/api/docs/:path*` },
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
