import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("curl installer", () => {
  it("passes a requested release version to npm CLI installation", async () => {
    const directory = await mkdtemp(`${tmpdir()}/uit-installer-test-`);
    directories.push(directory);
    const record = `${directory}/npm-args`;
    const node = `${directory}/node`;
    const npm = `${directory}/npm`;
    await writeFile(node, "#!/bin/sh\nexit 0\n");
    await writeFile(npm, '#!/bin/sh\nprintf "%s\\n" "$@" > "$UIT_TEST_RECORD"\n');
    await Promise.all([chmod(node, 0o755), chmod(npm, 0o755)]);

    await promisify(execFile)("sh", ["scripts/install.sh", "--cli"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${directory}:/usr/bin:/bin`,
        UIT_INSTALL_VERSION: "v1.2.0",
        UIT_TEST_RECORD: record
      }
    });

    expect((await readFile(record, "utf8")).trim().split("\n")).toEqual(["install", "--global", "uit-cli@1.2.0"]);
  });
});
