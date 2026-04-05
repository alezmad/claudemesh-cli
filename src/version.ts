/**
 * Bundled version string. Bun inlines the package.json JSON at build
 * time, so the shipped binary carries the exact version that was
 * published.
 */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
