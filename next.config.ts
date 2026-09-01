import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native addon; keep it external to the server bundle.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
