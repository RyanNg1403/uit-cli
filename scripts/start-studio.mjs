import { runStudioWebLauncher } from "../dist/studio-web-launcher.js";
import { openSystemTarget } from "../dist/studio-web-server.js";

console.log("Starting UIT Studio...");
await runStudioWebLauncher(process.argv.slice(2), {
  openTarget: async (url) => {
    console.log(`Open UIT Studio: ${url}`);
    console.log("If the browser does not open automatically, copy the link above. Run npm run web again for a fresh link.");
    await openSystemTarget(url);
  }
});
