import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitAssignmentFile } from "../src/assignment-submission.js";
import type { ApiClient } from "../src/types.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("assignment submission", () => {
  it("reuses the CLI upload, save, and status sequence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uit-assignment-submit-"));
    temporaryDirectories.push(directory);
    const filepath = join(directory, "report.pdf");
    writeFileSync(filepath, "report");
    const api = {
      uploadFile: vi.fn().mockResolvedValue({ itemid: 99 }),
      call: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ lastattempt: { submission: { status: "submitted", timemodified: 1_700_000_000 } } })
    } as unknown as ApiClient;
    const progress = vi.fn();

    await expect(submitAssignmentFile(50664, filepath, api, progress)).resolves.toEqual({
      assignId: 50664,
      file: "report.pdf",
      submissionStatus: "submitted",
      time: 1_700_000_000
    });
    expect(api.call).toHaveBeenNthCalledWith(1, "mod_assign_save_submission", {
      assignmentid: 50664,
      "plugindata[files_filemanager]": 99
    });
    expect(api.call).toHaveBeenNthCalledWith(2, "mod_assign_get_submission_status", { assignid: 50664 });
    expect(progress.mock.calls).toEqual([["uploading"], ["submitting"]]);
  });

  it("does not call Moodle when the local file is missing", async () => {
    const api = { uploadFile: vi.fn(), call: vi.fn() } as unknown as ApiClient;
    await expect(submitAssignmentFile(50664, "/tmp/uit-file-that-does-not-exist.pdf", api)).rejects.toThrow("File not found");
    expect(api.uploadFile).not.toHaveBeenCalled();
    expect(api.call).not.toHaveBeenCalled();
  });
});
