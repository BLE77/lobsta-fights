/** @type {import('next').NextConfig} */
const ALLOW_LENIENT_BUILD = process.env.ALLOW_LENIENT_BUILD === "1";

const nextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  typescript: {
    ignoreBuildErrors: ALLOW_LENIENT_BUILD,
  },
  eslint: {
    ignoreDuringBuilds: ALLOW_LENIENT_BUILD,
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

export default nextConfig;
// Build trigger Wed Feb  4 14:21:08 EST 2026
