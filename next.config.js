/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // Build machines with >1 core fork a static-generation worker that can die
  // silently in some environments; force inline single-worker generation.
  experimental: { cpus: 1, workerThreads: false },
};
