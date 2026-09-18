import { describe, expect, it } from "vitest";
import { classifySessionError } from "../src/session-health.js";

function error(message: string, errorcode?: string, cause?: unknown): Error {
  const value = cause === undefined ? new Error(message) : new Error(message, { cause });
  if (errorcode) Object.assign(value, { errorcode });
  return value;
}

describe("session health", () => {
  it.each([
    "requireloginerror",
    "servicerequireslogin",
    "invalidsesskey",
    "notloggedin",
    "invalidtoken",
    "tokenexpired"
  ])("classifies %s as expired", (errorcode) => {
    expect(classifySessionError(error("provider rejected session", errorcode))).toBe("expired");
  });

  it("classifies existing expiration text as expired", () => {
    expect(classifySessionError(new Error("UIT session expired. Please sign in again."))).toBe("expired");
  });

  it("classifies Moodle's Vietnamese expired-session response as expired", () => {
    expect(classifySessionError(new Error("Moodle: Dịch vụ web không tồn tại. (Phiên đăng nhập đã hết hạn hoặc đã đăng xuất)."))).toBe("expired");
  });

  it("classifies Moodle's Vietnamese invalid-token response as expired", () => {
    expect(classifySessionError(new Error("Token không hợp lệ - token không được tìm thấy"))).toBe("expired");
  });

  it("walks wrapped causes", () => {
    expect(classifySessionError(error("Moodle request failed", undefined, error("Invalid token", "invalidtoken")))).toBe("expired");
  });

  it("keeps access and transport failures unavailable", () => {
    expect(classifySessionError(error("Moodle denied access to this course.", "nopermissions"))).toBe("unavailable");
    expect(classifySessionError(new Error("HTTP 503: Service Unavailable"))).toBe("unavailable");
  });
});
