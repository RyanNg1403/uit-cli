(() => {
  if (window.uit) return;

  const methods = {
    session: {
      status: "session:status",
      login: "session:login",
      ssoLogin: "session:sso-login",
      logout: "session:logout",
    },
    courses: {
      list: "courses:list",
      link: "courses:link",
      refresh: "courses:refresh",
      contents: "course:contents",
      assignments: "course:assignments",
      announcements: "course:announcements",
      participants: "course:participants",
      avatar: "course:avatar",
      grades: "course:grades",
      submission: "course:submission",
      forum: "course:forum",
      materialize: "course:materialize",
      preview: "course:preview",
      open: "course:open",
    },
    workspace: { create: "workspace:create" },
    codex: { status: "codex:status", models: "codex:models" },
    agent: {
      start: "agent:start",
      send: "agent:send",
      fork: "agent:fork",
      delete: "agent:delete",
      rename: "agent:rename",
      stop: "agent:stop",
      approve: "agent:approve",
      disconnect: "agent:disconnect",
      openDesktop: "thread:open-desktop",
      readRollout: "thread:read-rollout",
    },
    shell: { open: "shell:open", openExternal: "shell:open-external" },
  };

  let csrfToken = "";
  let ready;
  const eventListeners = new Set();
  let eventSource;

  function responseError(payload, fallback) {
    const message = payload && payload.error && typeof payload.error.message === "string" ? payload.error.message : fallback;
    return new Error(message);
  }

  async function fetchJson(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", ...options });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`UIT Studio returned an invalid response (${response.status}).`);
    }
    if (!response.ok) throw responseError(payload, `UIT Studio request failed (${response.status}).`);
    return payload;
  }

  async function authenticate() {
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    const params = new URLSearchParams(hash);
    const bootstrap = params.get("bootstrap");
    if (bootstrap && params.size === 1) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      const payload = await fetchJson("/api/session/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: bootstrap }),
      });
      if (typeof payload.csrfToken !== "string" || payload.csrfToken.length < 32) throw new Error("UIT Studio returned an invalid browser session.");
      csrfToken = payload.csrfToken;
      return;
    }
    const payload = await fetchJson("/api/session/csrf");
    if (typeof payload.csrfToken !== "string" || payload.csrfToken.length < 32) throw new Error("UIT Studio returned an invalid CSRF token.");
    csrfToken = payload.csrfToken;
  }

  ready = authenticate();

  async function rpc(method, input) {
    await ready;
    const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrfToken };
    const body = { method };
    if (input !== undefined) body.input = input;
    const payload = await fetchJson("/api/rpc", { method: "POST", headers, body: JSON.stringify(body) });
    if (payload.ok !== true) throw responseError(payload, "UIT Studio could not complete the request.");
    return payload.result;
  }

  function connectEvents() {
    ready.then(() => {
      if (eventSource || eventListeners.size === 0) return;
      eventSource = new EventSource("/api/events", { withCredentials: true });
      eventSource.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          eventListeners.forEach((listener) => listener(message));
        } catch {
          // Ignore malformed event frames. RPC remains the authoritative path.
        }
      };
      eventSource.onerror = () => {
        // EventSource preserves Last-Event-ID and reconnects with browser-managed backoff.
      };
    }).catch(() => undefined);
  }

  const bridge = {};
  Object.entries(methods).forEach(([namespace, namespaceMethods]) => {
    bridge[namespace] = {};
    Object.entries(namespaceMethods).forEach(([name, method]) => {
      bridge[namespace][name] = (input) => rpc(method, input);
    });
  });
  bridge.agent.releaseLock = (threadId) => rpc("thread:release-lock", { threadId });
  bridge.agent.lockStatus = (threadId) => rpc("thread:lock-status", { threadId });
  bridge.agent.writeClipboard = async (text) => {
    try {
      if (navigator.clipboard && window.isSecureContext !== false) {
        await navigator.clipboard.writeText(text);
        return { success: true };
      }
    } catch {
      // Fall through to the native clipboard adapter in the local server.
    }
    return rpc("clipboard:write", { text });
  };
  bridge.agent.onEvent = (listener) => {
    eventListeners.add(listener);
    connectEvents();
    return () => eventListeners.delete(listener);
  };
  window.uit = bridge;
})();
