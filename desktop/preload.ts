import { contextBridge, ipcRenderer } from "electron";

type Input = unknown;
type EventCallback = (message: unknown) => void;

contextBridge.exposeInMainWorld("uit", {
  session: {
    status: () => ipcRenderer.invoke("session:status"),
    login: (input: Input) => ipcRenderer.invoke("session:login", input),
    ssoLogin: (input: Input) => ipcRenderer.invoke("session:sso-login", input),
    logout: (input: Input) => ipcRenderer.invoke("session:logout", input)
  },
  courses: {
    list: () => ipcRenderer.invoke("courses:list"),
    link: (input: Input) => ipcRenderer.invoke("courses:link", input),
    refresh: (input: Input) => ipcRenderer.invoke("courses:refresh", input),
    contents: (courseId: Input) => ipcRenderer.invoke("course:contents", courseId),
    assignments: (courseId: Input) => ipcRenderer.invoke("course:assignments", courseId),
    announcements: (courseId: Input) => ipcRenderer.invoke("course:announcements", courseId),
    participants: (courseId: Input) => ipcRenderer.invoke("course:participants", courseId),
    grades: (courseId: Input) => ipcRenderer.invoke("course:grades", courseId),
    submission: (input: Input) => ipcRenderer.invoke("course:submission", input),
    forum: (input: Input) => ipcRenderer.invoke("course:forum", input),
    materialize: (input: Input) => ipcRenderer.invoke("course:materialize", input),
    preview: (input: Input) => ipcRenderer.invoke("course:preview", input),
    open: (input: Input) => ipcRenderer.invoke("course:open", input)
  },
  workspace: { create: (input: Input) => ipcRenderer.invoke("workspace:create", input) },
  codex: { status: () => ipcRenderer.invoke("codex:status"), models: () => ipcRenderer.invoke("codex:models") },
  agent: {
    start: (input: Input) => ipcRenderer.invoke("agent:start", input),
    send: (input: Input) => ipcRenderer.invoke("agent:send", input),
    fork: (input: Input) => ipcRenderer.invoke("agent:fork", input),
    delete: (input: Input) => ipcRenderer.invoke("agent:delete", input),
    rename: (input: Input) => ipcRenderer.invoke("agent:rename", input),
    stop: (input: Input) => ipcRenderer.invoke("agent:stop", input),
    approve: (input: Input) => ipcRenderer.invoke("agent:approve", input),
    disconnect: () => ipcRenderer.invoke("agent:disconnect"),
    releaseLock: (threadId: Input) => ipcRenderer.invoke("thread:release-lock", { threadId }),
    lockStatus: (threadId: Input) => ipcRenderer.invoke("thread:lock-status", { threadId }),
    openDesktop: (input: Input) => ipcRenderer.invoke("thread:open-desktop", input),
    readRollout: (input: Input) => ipcRenderer.invoke("thread:read-rollout", input),
    writeClipboard: (text: Input) => ipcRenderer.invoke("clipboard:write", { text }),
    onEvent: (callback: EventCallback) => {
      const listener = (_event: Electron.IpcRendererEvent, message: unknown) => callback(message);
      ipcRenderer.on("agent:event", listener);
      return () => ipcRenderer.removeListener("agent:event", listener);
    }
  },
  shell: {
    open: (target: Input) => ipcRenderer.invoke("shell:open", target),
    openExternal: (url: Input) => ipcRenderer.invoke("shell:open-external", url)
  }
});
