import open from "open";
import { beforeEach, expect, it, vi } from "vitest";
import {
  openCodexDesktopThread,
  openSystemTarget
} from "../src/studio-web-server.js";

vi.mock("open", () => ({ default: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

it("passes the complete launch URL to the default application opener", async () => {
  const target = "http://127.0.0.1:1234/#bootstrap=test&name=O'Brien";
  await openSystemTarget(target);
  expect(open).toHaveBeenCalledWith(target);
});

it("reports application opener failures to the launcher", async () => {
  vi.mocked(open).mockRejectedValue(new Error("No browser association"));
  await expect(openSystemTarget("http://127.0.0.1:1234/")).rejects.toThrow("No browser association");
});

it("opens a Desktop thread with one exact deep link and propagates opener failure", async () => {
  await openCodexDesktopThread("thread/id");
  expect(open).toHaveBeenCalledExactlyOnceWith("codex://threads/thread%2Fid");

  vi.mocked(open).mockRejectedValue(new Error("Desktop launch failed"));
  await expect(openCodexDesktopThread("thread")).rejects.toThrow("Desktop launch failed");
});
