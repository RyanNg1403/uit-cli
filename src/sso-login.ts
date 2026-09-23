import { saveLegacyBrowserSession, saveSsoSession, type MoodleBrowserSessionData } from "./config.js";
import { MoodleBrowserLoginService } from "./moodle-browser-login.js";
import { out, loading } from "./output.js";

export type SsoLoginLauncher = (baseUrl: string) => Promise<MoodleBrowserSessionData>;

async function defaultBrowserLogin(baseUrl: string, authType: "sso" | "legacy"): Promise<MoodleBrowserSessionData> {
  const portalName = authType === "sso" ? "UIT SSO" : "UIT Legacy";
  loading(`Opening browser for ${portalName} login...`);
  const service = new MoodleBrowserLoginService({
    onStatus: (message) => {
      if (!message.startsWith("Opening bundled Chromium")) console.error(message);
    }
  });
  return authType === "sso" ? service.login(baseUrl) : service.loginLegacy(baseUrl);
}

export function defaultSsoLauncher(baseUrl: string): Promise<MoodleBrowserSessionData> {
  return defaultBrowserLogin(baseUrl, "sso");
}

export type LegacyLoginLauncher = (baseUrl: string) => Promise<MoodleBrowserSessionData>;

export function defaultLegacyLauncher(baseUrl: string): Promise<MoodleBrowserSessionData> {
  return defaultBrowserLogin(baseUrl, "legacy");
}

export async function cmdLoginSso(
  args: { url?: string },
  launcher: SsoLoginLauncher = defaultSsoLauncher
): Promise<MoodleBrowserSessionData> {
  const baseUrl = (args.url || "https://courses.uit.edu.vn").replace(/\/+$/, "");
  const sessionData = await launcher(baseUrl);

  saveSsoSession(sessionData);

  out({
    status: "ok",
    auth: "sso",
    user_id: sessionData.userId,
    site: baseUrl
  });

  console.error(`\n✓ Successfully signed in via SSO as user ID ${sessionData.userId}.`);
  return sessionData;
}

export async function cmdLoginLegacy(
  args: { url: string },
  launcher: LegacyLoginLauncher = defaultLegacyLauncher
): Promise<MoodleBrowserSessionData> {
  const baseUrl = args.url.replace(/\/+$/, "");
  const sessionData = await launcher(baseUrl);
  saveLegacyBrowserSession(sessionData);

  out({
    status: "ok",
    auth: "legacy-session",
    user_id: sessionData.userId,
    site: baseUrl
  });

  console.error(`\n✓ Successfully signed in to UIT Legacy as user ID ${sessionData.userId}.`);
  return sessionData;
}
