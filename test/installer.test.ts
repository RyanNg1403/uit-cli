import { chmod, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// These fixtures exercise the POSIX installer with /bin tools, signals, and symlinks.
describe.skipIf(process.platform === "win32")("curl installer", () => {
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

  it("restores the previous native Studio archive when replacement is interrupted", async () => {
    const directory = await mkdtemp(`${tmpdir()}/uit-studio-installer-test-`);
    directories.push(directory);
    const bin = `${directory}/bin`;
    const studio = `${directory}/studio`;
    const launcherDirectory = `${directory}/local-bin`;
    const interrupted = `${directory}/interrupted`;
    await promisify(execFile)("mkdir", ["-p", `${bin}`, `${studio}`]);
    await writeFile(`${studio}/marker`, "previous\n");
    await writeFile(`${bin}/uname`, '#!/bin/sh\n[ "$1" = "-s" ] && printf "Darwin\\n" || printf "arm64\\n"\n');
    await writeFile(`${bin}/curl`, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output" ]; then shift; printf "archive\\n" > "$1"; fi\n  shift\ndone\n');
    await writeFile(`${bin}/shasum`, "#!/bin/sh\nexit 0\n");
    await writeFile(`${bin}/tar`, '#!/bin/sh\ncase "$1" in\n  -t*) printf "uit-studio\\nuit-studio/bin\\nuit-studio/bin/uit-studio\\nuit-studio/bin/node\\n" ;;\n  -x*)\n    destination=""\n    while [ "$#" -gt 0 ]; do\n      if [ "$1" = "-C" ]; then shift; destination="$1"; fi\n      shift\n    done\n    mkdir -p "$destination/uit-studio/bin"\n    printf "#!/bin/sh\\n" > "$destination/uit-studio/bin/uit-studio"\n    printf "node\\n" > "$destination/uit-studio/bin/node"\n    chmod 755 "$destination/uit-studio/bin/uit-studio" "$destination/uit-studio/bin/node"\n    ;;\n  *) exit 1 ;;\nesac\n');
    await writeFile(`${bin}/mv`, '#!/bin/sh\nif [ "$1" = "-f" ]; then shift; fi\n/bin/mv "$1" "$2" || exit $?\ncase "$2" in\n  *"/previous")\n    if [ ! -e "$UIT_TEST_INTERRUPTED" ]; then\n      : > "$UIT_TEST_INTERRUPTED"\n      kill -TERM "$PPID"\n    fi\n    ;;\nesac\n');
    await Promise.all(["uname", "curl", "shasum", "tar", "mv"].map((name) => chmod(`${bin}/${name}`, 0o755)));

    await expect(promisify(execFile)("sh", ["scripts/install.sh", "--studio"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        UIT_INSTALL_STUDIO_DIR: studio,
        UIT_INSTALL_BIN_DIR: launcherDirectory,
        UIT_INSTALL_BASE_URL: "https://example.invalid",
        UIT_TEST_INTERRUPTED: interrupted
      }
    })).rejects.toThrow();

    expect(await readFile(`${studio}/marker`, "utf8")).toBe("previous\n");
  });

  it("installs the Linux native Studio archive under the UIT directory", async () => {
    const directory = await mkdtemp(`${tmpdir()}/uit-linux-studio-installer-test-`);
    directories.push(directory);
    const bin = `${directory}/bin`;
    const studio = `${directory}/studio`;
    const launcherDirectory = `${directory}/local-bin`;
    await promisify(execFile)("mkdir", ["-p", bin]);
    await writeFile(`${bin}/uname`, '#!/bin/sh\n[ "$1" = "-s" ] && printf "Linux\\n" || printf "x86_64\\n"\n');
    await writeFile(`${bin}/curl`, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output" ]; then shift; printf "archive\\n" > "$1"; fi\n  shift\ndone\n');
    await writeFile(`${bin}/sha256sum`, "#!/bin/sh\nexit 0\n");
    await writeFile(`${bin}/tar`, '#!/bin/sh\ncase "$1" in\n  -t*) printf "uit-studio\\nuit-studio/bin\\nuit-studio/bin/uit-studio\\nuit-studio/bin/node\\n" ;;\n  -x*)\n    destination=""\n    while [ "$#" -gt 0 ]; do\n      if [ "$1" = "-C" ]; then shift; destination="$1"; fi\n      shift\n    done\n    mkdir -p "$destination/uit-studio/bin"\n    printf "#!/bin/sh\\n" > "$destination/uit-studio/bin/uit-studio"\n    printf "node\\n" > "$destination/uit-studio/bin/node"\n    chmod 755 "$destination/uit-studio/bin/uit-studio" "$destination/uit-studio/bin/node"\n    ;;\n  *) exit 1 ;;\nesac\n');
    await Promise.all(["uname", "curl", "sha256sum", "tar"].map((name) => chmod(`${bin}/${name}`, 0o755)));

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

    const target = `${studio}/bin/uit-studio`;
    expect(await readFile(target, "utf8")).toContain("#!/bin/sh");
    expect(await readlink(`${launcherDirectory}/uit-studio`)).toBe(target);
  });
});
