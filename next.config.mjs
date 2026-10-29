/** @type {import('next').NextConfig} */
const nextConfig = {
  // The app is server-rendered and reads a local SQLite via Prisma.
  // In production flip the Prisma datasource to Postgres/Supabase (docs/deploy.md)
  // and set NEXT_OUTPUT=standalone for container deploys.
  output: process.env.NEXT_OUTPUT ? process.env.NEXT_OUTPUT : undefined,
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
