import { chromium } from "playwright";
import { saveSsoSession, type SsoSessionData } from "./config.js";
import { out, loading, CliError } from "./output.js";

export type SsoLoginLauncher = (baseUrl: string) => Promise<SsoSessionData>;

export async function defaultSsoLauncher(baseUrl: string): Promise<SsoSessionData> {
  let browser;
  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: false,
      args: ["--window-size=980,760"]
    });
  } catch (error) {
    throw new CliError(
      `Could not open Google Chrome for SSO login: ${(error as Error).message}\n` +
      `Install Google Chrome, run UIT Studio on your desktop, or use ` +
      `'uit login --token <token>'.`
    );
  }

  loading("Opening browser for UIT SSO login...");
  console.error("Please sign in with your UIT account in the browser window.");

  const context = await browser.newContext({
    viewport: { width: 980, height: 760 }
  });
  const page = await context.newPage();

  let ssoSession: SsoSessionData | null = null;
  const startTime = Date.now();
  const timeoutMs = 5 * 60 * 1000; // 5 minutes

  try {
    await page.goto(`${baseUrl}/login/index.php`, { waitUntil: "domcontentloaded", timeout: 60000 });

    while (!ssoSession) {
      if (Date.now() - startTime > timeoutMs) {
        throw new CliError("SSO login timed out. Please try again.");
      }

      if (page.isClosed() || !browser.isConnected()) {
        throw new CliError("SSO login window was closed before login completed.");
      }

      const currentUrl = page.url();
      try {
        const parsed = new URL(currentUrl);
        const base = new URL(baseUrl);

        if (parsed.origin === base.origin && !parsed.pathname.startsWith("/login")) {
          const identity = await page.evaluate(() => {
            const cfg = (window as any).M?.cfg || {};
            return {
              sesskey: String(cfg.sesskey || ""),
              userId: Number(cfg.userId || cfg.userid || 0)
            };
          }).catch(() => null);

          if (identity?.sesskey && identity.userId > 0) {
            const cookies = await context.cookies(baseUrl);
            ssoSession = {
              baseUrl,
              userId: identity.userId,
              sesskey: identity.sesskey,
              cookies: cookies.map((c) => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                secure: c.secure,
                httpOnly: c.httpOnly
              })),
              savedAt: Date.now()
            };
            break;
          }
        }
      } catch {
        // Ignored during OAuth redirects
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  if (!ssoSession) {
    throw new CliError("Failed to capture SSO session.");
  }

  return ssoSession;
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
