/** @type {import('next').NextConfig} */
// apps/web is a client of the /v1 API (NA-05): it bundles no server-side platform package and holds no database access.
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
