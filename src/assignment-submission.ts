import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ApiClient, MoodleRecord } from "./types.js";

export interface AssignmentSubmissionResult {
  assignId: number;
  file: string;
  submissionStatus: string;
  time: number;
}

export type AssignmentSubmissionProgress = (phase: "uploading" | "submitting") => void;

/** Upload one local file and submit it through Moodle's assignment API. */
export async function submitAssignmentFile(
  assignId: number,
  filepath: string,
  api: ApiClient,
  onProgress?: AssignmentSubmissionProgress
): Promise<AssignmentSubmissionResult> {
  if (!Number.isSafeInteger(assignId) || assignId <= 0) throw new Error("Assignment ID must be a positive integer.");
  if (!existsSync(filepath)) throw new Error(`File not found: ${filepath}`);

  onProgress?.("uploading");
  const uploadResult = await api.uploadFile(filepath);
  const itemId = Number(uploadResult.itemid);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    throw new Error(`Assignment upload failed: ${JSON.stringify(uploadResult)}`);
  }

  onProgress?.("submitting");
  await api.call("mod_assign_save_submission", {
    assignmentid: assignId,
    "plugindata[files_filemanager]": itemId
  });
  const status = await api.call<MoodleRecord>("mod_assign_get_submission_status", { assignid: assignId });
  const submission = status.lastattempt?.submission || {};

  return {
    assignId,
    file: basename(filepath),
    submissionStatus: String(submission.status || "unknown"),
    time: Number(submission.timemodified || 0)
  };
}
