import { readFileSync } from "node:fs";

type PackageMetadata = { version?: unknown };

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageMetadata;

if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error("Root package version is missing or invalid.");
}

export const VERSION = packageMetadata.version;
