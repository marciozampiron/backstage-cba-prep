/** @type {import('next').NextConfig} */
const nextConfig = {
  // Slice 1 keeps the BFF stub in-app (route handlers). The real Web BFF lives on AWS per ADR-0002;
  // swapping later is a base-URL change, not a frontend rewrite.
  reactStrictMode: true,
};

export default nextConfig;
