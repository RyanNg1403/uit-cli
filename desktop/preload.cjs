const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("uit", {
  session: {
    status: () => ipcRenderer.invoke("session:status"),
    login: (input) => ipcRenderer.invoke("session:login", input),
    ssoLogin: (input) => ipcRenderer.invoke("session:sso-login", input),
    logout: (input) => ipcRenderer.invoke("session:logout", input)
  },
  courses: {
    list: () => ipcRenderer.invoke("courses:list"),
    link: (input) => ipcRenderer.invoke("courses:link", input),
    refresh: (input) => ipcRenderer.invoke("courses:refresh", input),
    contents: (courseId) => ipcRenderer.invoke("course:contents", courseId),
    assignments: (courseId) => ipcRenderer.invoke("course:assignments", courseId),
    announcements: (courseId) => ipcRenderer.invoke("course:announcements", courseId),
    participants: (courseId) => ipcRenderer.invoke("course:participants", courseId),
    grades: (courseId) => ipcRenderer.invoke("course:grades", courseId),
    submission: (input) => ipcRenderer.invoke("course:submission", input),
    forum: (input) => ipcRenderer.invoke("course:forum", input),
    materialize: (input) => ipcRenderer.invoke("course:materialize", input),
    preview: (input) => ipcRenderer.invoke("course:preview", input),
    open: (input) => ipcRenderer.invoke("course:open", input)
  },
  workspace: { create: (input) => ipcRenderer.invoke("workspace:create", input) },
  codex: { status: () => ipcRenderer.invoke("codex:status"), models: () => ipcRenderer.invoke("codex:models") },
  agent: {
    start: (input) => ipcRenderer.invoke("agent:start", input),
    send: (input) => ipcRenderer.invoke("agent:send", input),
    fork: (input) => ipcRenderer.invoke("agent:fork", input),
    delete: (input) => ipcRenderer.invoke("agent:delete", input),
    rename: (input) => ipcRenderer.invoke("agent:rename", input),
    stop: (input) => ipcRenderer.invoke("agent:stop", input),
    approve: (input) => ipcRenderer.invoke("agent:approve", input),
    disconnect: () => ipcRenderer.invoke("agent:disconnect"),
    releaseLock: (threadId) => ipcRenderer.invoke("thread:release-lock", { threadId }),
    lockStatus: (threadId) => ipcRenderer.invoke("thread:lock-status", { threadId }),
    openDesktop: (input) => ipcRenderer.invoke("thread:open-desktop", input),
    readRollout: (threadId) => ipcRenderer.invoke("thread:read-rollout", { threadId }),
    writeClipboard: (text) => ipcRenderer.invoke("clipboard:write", { text }),
    onEvent: (callback) => {
      const listener = (_event, message) => callback(message);
      ipcRenderer.on("agent:event", listener);
      return () => ipcRenderer.removeListener("agent:event", listener);
    }
  },
  shell: {
    open: (target) => ipcRenderer.invoke("shell:open", target),
    openExternal: (url) => ipcRenderer.invoke("shell:open-external", url)
  }
});
