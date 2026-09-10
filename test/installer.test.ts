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

  it("restores the previous Studio app when replacement is interrupted", async () => {
    const directory = await mkdtemp(`${tmpdir()}/uit-studio-installer-test-`);
    directories.push(directory);
    const bin = `${directory}/bin`;
    const applications = `${directory}/Applications`;
    const interrupted = `${directory}/interrupted`;
    await promisify(execFile)("mkdir", ["-p", `${bin}`, `${applications}/UIT Studio.app`]);
    await writeFile(`${applications}/UIT Studio.app/marker`, "previous\n");
    await writeFile(`${bin}/uname`, '#!/bin/sh\n[ "$1" = "-s" ] && printf "Darwin\\n" || printf "arm64\\n"\n');
    await writeFile(`${bin}/curl`, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output" ]; then shift; : > "$1"; fi\n  shift\ndone\n');
    await writeFile(`${bin}/shasum`, "#!/bin/sh\nexit 0\n");
    await writeFile(`${bin}/ditto`, '#!/bin/sh\nif [ "$1" = "-x" ]; then\n  mkdir -p "$4/UIT Studio.app"\n  printf "replacement\\n" > "$4/UIT Studio.app/marker"\nelse\n  /bin/cp -R "$1" "$2"\nfi\n');
    await writeFile(`${bin}/mv`, '#!/bin/sh\n/bin/mv "$1" "$2" || exit $?\ncase "$2" in\n  *"UIT Studio.previous.app")\n    if [ ! -e "$UIT_TEST_INTERRUPTED" ]; then\n      : > "$UIT_TEST_INTERRUPTED"\n      kill -TERM "$PPID"\n    fi\n    ;;\nesac\n');
    await Promise.all(["uname", "curl", "shasum", "ditto", "mv"].map((name) => chmod(`${bin}/${name}`, 0o755)));

    await expect(promisify(execFile)("sh", ["scripts/install.sh", "--studio"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        UIT_INSTALL_APPLICATIONS_DIR: applications,
        UIT_INSTALL_BASE_URL: "https://example.invalid",
        UIT_TEST_INTERRUPTED: interrupted
      }
    })).rejects.toThrow();

    expect(await readFile(`${applications}/UIT Studio.app/marker`, "utf8")).toBe("previous\n");
  });
});
