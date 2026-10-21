/** @type {import('next').NextConfig} */
// apps/web is a client of the /v1 API (NA-05): it bundles no server-side platform package and holds no database access.
//
// Static export (POS-8d-2a): `NEXT_OUTPUT=export` (set by scripts/build-export.mjs) builds the counter as plain files in `out/` for the native device
// shell to bundle. It is OFF by default, so the normal server build is unchanged. `trailingSlash` gives every screen a folder with its own index file,
// which is what a bundled app serves. The business screens are built once under a placeholder id (see app/(client)/businesses/[businessId]/layout.tsx).
const exportMode = process.env.NEXT_OUTPUT === 'export';

const nextConfig = {
  reactStrictMode: true,
  ...(exportMode
    ? {
        output: 'export',
        trailingSlash: true,
      }
    : {}),
};

export default nextConfig;
