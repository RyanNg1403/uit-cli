import { saveSsoSession, type SsoSessionData } from "./config.js";
import { StudioSsoService } from "./studio-sso.js";
import { out, loading } from "./output.js";

export type SsoLoginLauncher = (baseUrl: string) => Promise<SsoSessionData>;

export async function defaultSsoLauncher(baseUrl: string): Promise<SsoSessionData> {
  loading("Opening browser for UIT SSO login...");
  const service = new StudioSsoService({
    onStatus: (message) => {
      if (!message.startsWith("Opening bundled Chromium")) console.error(message);
    }
  });
  return service.login(baseUrl);
}

export async function cmdLoginSso(
  args: { url?: string },
  launcher: SsoLoginLauncher = defaultSsoLauncher
): Promise<SsoSessionData> {
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
