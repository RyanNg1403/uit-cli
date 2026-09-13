import { chmod, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("curl installer", () => {
  it("rejects Windows shells and points users to the Node installer", async () => {
    const directory = await mkdtemp(`${tmpdir()}/uit-windows-installer-test-`);
    directories.push(directory);
    const uname = `${directory}/uname`;
    await writeFile(uname, '#!/bin/sh\n[ "$1" = "-s" ] && printf "MINGW64_NT-10.0\\n" || printf "x86_64\\n"\n');
    await chmod(uname, 0o755);

    await expect(promisify(execFile)("sh", ["scripts/install.sh", "--cli"], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${directory}:/usr/bin:/bin` }
    })).rejects.toThrow("use npm on Windows");
  });

  it("rejects Intel Macs instead of requesting an unavailable release", async () => {
    const directory = await mkdtemp(`${tmpdir()}/uit-intel-installer-test-`);
    directories.push(directory);
    const uname = `${directory}/uname`;
    await writeFile(uname, '#!/bin/sh\n[ "$1" = "-s" ] && printf "Darwin\\n" || printf "x86_64\\n"\n');
    await chmod(uname, 0o755);

    await expect(promisify(execFile)("sh", ["scripts/install.sh", "--cli"], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${directory}:/usr/bin:/bin` }
    })).rejects.toThrow("unsupported Mac architecture: x86_64");
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

  it("installs the Linux Studio AppImage under the UIT directory", async () => {
    const directory = await mkdtemp(`${tmpdir()}/uit-linux-studio-installer-test-`);
    directories.push(directory);
    const bin = `${directory}/bin`;
    const studio = `${directory}/studio`;
    const launcherDirectory = `${directory}/local-bin`;
    await promisify(execFile)("mkdir", ["-p", bin]);
    await writeFile(`${bin}/uname`, '#!/bin/sh\n[ "$1" = "-s" ] && printf "Linux\\n" || printf "x86_64\\n"\n');
    await writeFile(`${bin}/curl`, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output" ]; then shift; printf "AppImage\\n" > "$1"; fi\n  shift\ndone\n');
    await writeFile(`${bin}/sha256sum`, "#!/bin/sh\nexit 0\n");
    await Promise.all(["uname", "curl", "sha256sum"].map((name) => chmod(`${bin}/${name}`, 0o755)));

    await promisify(execFile)("sh", ["scripts/install.sh", "--studio"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        UIT_INSTALL_BASE_URL: "https://example.invalid",
        UIT_INSTALL_STUDIO_DIR: studio,
        UIT_INSTALL_BIN_DIR: launcherDirectory
      }
    });

    const target = `${studio}/UIT-Studio.AppImage`;
    expect(await readFile(target, "utf8")).toBe("AppImage\n");
    expect(await readlink(`${launcherDirectory}/uit-studio`)).toBe(target);
  });
});
