import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
});

/** @type {import('next').NextConfig} */
const ALLOW_LENIENT_BUILD = process.env.ALLOW_LENIENT_BUILD === "1";
// Enforce strict TypeScript/ESLint checks in production even if ALLOW_LENIENT_BUILD is set.
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SHOULD_IGNORE_BUILD_ERRORS = ALLOW_LENIENT_BUILD && !IS_PRODUCTION;
const isDevelopment = process.env.NODE_ENV === "development";
const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  ...(isDevelopment ? ["'unsafe-eval'"] : []), // required by Next.js dev tooling
].join(" ");

const nextConfig = {
  productionBrowserSourceMaps: false,
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  typescript: {
    ignoreBuildErrors: SHOULD_IGNORE_BUILD_ERRORS,
  },
  eslint: {
    ignoreDuringBuilds: SHOULD_IGNORE_BUILD_ERRORS,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              `script-src ${scriptSrc}`,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.helius-rpc.com wss://*.helius-rpc.com https://api.devnet.solana.com https://api.mainnet-beta.solana.com",
              "media-src 'self' blob: https://*.supabase.co",
              "worker-src 'self'",
              "manifest-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, max-age=0, s-maxage=0" },
        ],
      },
    ];
  },
  webpack: (config) => {
    config.resolve.fallback = {
      fs: false,
      net: false,
      tls: false,
    };
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "pino-pretty": false,
    };
    return config;
  },
};

export default withSerwist(nextConfig);
// Build trigger Wed Feb  4 14:21:08 EST 2026
