export type SessionHealthState = "checking" | "connected" | "expired" | "unavailable";

type ErrorRecord = {
  cause?: unknown;
  errorcode?: unknown;
  message?: unknown;
};

const authenticationErrorCodes = new Set([
  "requireloginerror",
  "servicerequireslogin",
  "invalidsesskey",
  "notloggedin",
  "sessionexpired",
  "sessionnotauthenticated",
  "notauthenticated",
  "authenticationfailed",
  "loginrequired",
  "invalidsession"
]);

function record(value: unknown): ErrorRecord | undefined {
  return value && typeof value === "object" ? value as ErrorRecord : undefined;
}

function isAuthenticationError(value: unknown): boolean {
  const item = record(value);
  const code = String(item?.errorcode || "").toLowerCase().replace(/[\s_-]+/g, "");
  if (authenticationErrorCodes.has(code)) return true;
  return /(?:session|sesskey|authentication)\s+(?:is\s+)?(?:expired|invalid|failed)|(?:session|sesskey)\s+(?:has\s+)?expired|(?:not\s+authenticated|not\s+logged\s+in)|(?:sign|log)\s+in\s+again|(?:requires?|needs?)\s+(?:a\s+)?login|invalid\s+(?:session|sesskey)|phiên\s+đăng\s+nhập\s+đã\s+(?:hết\s+hạn|đăng\s+xuất)/i.test(String(item?.message || value));
}

/** Classify a failed live account request without exposing provider error text to the UI. */
export function classifySessionError(error: unknown): Exclude<SessionHealthState, "checking" | "connected"> {
  const visited = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; current && depth < 8 && !visited.has(current); depth += 1) {
    visited.add(current);
    if (isAuthenticationError(current)) return "expired";
    current = record(current)?.cause;
  }
  return "unavailable";
}
