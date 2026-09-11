import { spawnSync } from "node:child_process";

const packed = spawnSync(
  "npm",
  ["pack", "--json", "--dry-run", "--ignore-scripts"],
  { encoding: "utf8" }
);

if (packed.status !== 0) {
  process.stderr.write(packed.stderr);
  process.exit(packed.status ?? 1);
}

const [manifest] = JSON.parse(packed.stdout);
const files = manifest.files.map(({ path }) => path);
const unexpected = files.filter((path) => (
  path !== "LICENSE" &&
  path !== "README.md" &&
  path !== "package.json" &&
  !path.startsWith("dist/")
));

if (!files.includes("dist/cli.js")) {
  throw new Error("npm package is missing dist/cli.js");
}
if (unexpected.length > 0) {
  throw new Error(`npm package contains non-CLI files: ${unexpected.join(", ")}`);
}

console.log(`Verified CLI npm package boundary (${files.length} files, ${manifest.size} bytes).`);
