(() => {
  const storageKey = "uit-studio.sidebar.v1";
  const app = document.getElementById("app");
  const sidebar = document.getElementById("sidebar");
  const main = document.getElementById("main");
  const handle = document.getElementById("sidebar-resize");
  const menu = document.getElementById("menu-toggle");
  const close = document.getElementById("close-sidebar");
  const scrim = document.getElementById("sidebar-scrim");
  const mobile = matchMedia("(max-width: 650px)");
  let width = 248;
  let collapsed = false;
  let mobileOpen = false;
  let drag = null;

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && Number.isFinite(saved.width) && typeof saved.collapsed === "boolean") {
      width = Math.min(480, Math.max(200, saved.width));
      collapsed = saved.collapsed;
    }
  } catch { /* Navigation remains usable when storage is unavailable. */ }

  const maxWidth = () => Math.min(480, Math.max(200, window.innerWidth - 320));
  const clampWidth = (value) => Math.round(Math.min(maxWidth(), Math.max(200, value)));
  const hasDialog = () => !!document.querySelector("dialog[open], [aria-modal='true']:not([hidden])");

  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify({ width, collapsed })); }
    catch { /* Keep the current layout even if it cannot be saved. */ }
  }

  function render() {
    const open = mobile.matches ? mobileOpen : !collapsed;
    const visibleWidth = collapsed ? 0 : clampWidth(width);
    app.style.setProperty("--sidebar-width", `${visibleWidth}px`);
    app.classList.toggle("sidebar-collapsed", collapsed);
    app.classList.toggle("nav-open", mobile.matches && mobileOpen);
    main.inert = mobile.matches && mobileOpen;
    sidebar.inert = !open;
    sidebar.setAttribute("aria-hidden", String(!open));
    scrim.hidden = !mobile.matches || !mobileOpen;
    scrim.tabIndex = -1;
    menu.setAttribute("aria-expanded", String(open));
    menu.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    handle.hidden = mobile.matches;
    handle.setAttribute("aria-valuemax", String(maxWidth()));
    handle.setAttribute("aria-valuenow", String(visibleWidth));
    handle.setAttribute("aria-valuetext", collapsed ? "Collapsed" : `${visibleWidth} pixels`);
    if (!hasDialog() && ((!open && sidebar.contains(document.activeElement)) ||
      (mobile.matches && document.activeElement === handle))) menu.focus();
  }

  function setMobileOpen(open) {
    if (!mobile.matches || (open && hasDialog())) return;
    const wasOpen = mobileOpen;
    mobileOpen = !!open;
    render();
    if (!hasDialog()) {
      if (mobileOpen && !wasOpen) close.focus();
      else if (!mobileOpen && wasOpen) menu.focus();
    }
  }

  function toggle() {
    if (hasDialog()) return;
    if (mobile.matches) setMobileOpen(!mobileOpen);
    else {
      collapsed = !collapsed;
      render();
      persist();
    }
  }

  function finishDrag(cancelled = false) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (cancelled) { width = previous.width; collapsed = previous.collapsed; }
    else if (collapsed) width = previous.width;
    app.classList.remove("sidebar-dragging");
    if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
    render();
    if (!cancelled) persist();
  }

  handle.addEventListener("pointerdown", (event) => {
    if (mobile.matches || event.button !== 0 || !event.isPrimary || hasDialog() || drag) return;
    event.preventDefault();
    drag = { id: event.pointerId, x: event.clientX, start: collapsed ? 0 : clampWidth(width), width, collapsed };
    handle.setPointerCapture(event.pointerId);
    handle.focus();
    app.classList.add("sidebar-dragging");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const next = drag.start + event.clientX - drag.x;
    collapsed = next < 120;
    if (!collapsed) width = clampWidth(next);
    render();
  });
  handle.addEventListener("pointerup", (event) => { if (drag?.id === event.pointerId) finishDrag(); });
  handle.addEventListener("pointercancel", (event) => { if (drag?.id === event.pointerId) finishDrag(true); });
  handle.addEventListener("lostpointercapture", () => finishDrag(true));
  handle.addEventListener("keydown", (event) => {
    if (mobile.matches || hasDialog() || drag) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") collapsed = true;
    else if (event.key === "End" || (collapsed && event.key === "ArrowRight")) collapsed = false;
    else if (!collapsed) width = clampWidth(clampWidth(width) + (event.key === "ArrowRight" ? 10 : -10));
    render();
    persist();
  });

  menu.addEventListener("click", toggle);
  close.addEventListener("click", () => setMobileOpen(false));
  scrim.addEventListener("click", () => setMobileOpen(false));
  document.addEventListener("keydown", (event) => {
    if (hasDialog() || event.isComposing || event.defaultPrevented) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "b") {
      event.preventDefault();
      if (!event.repeat && !drag) toggle();
      return;
    }
    if (!mobile.matches || !mobileOpen) return;
    if (event.key === "Escape") { event.preventDefault(); setMobileOpen(false); }
    if (event.key === "Tab") {
      const controls = [...sidebar.querySelectorAll("button, a[href], input, select, textarea, [tabindex]")]
        .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") &&
          !element.closest("[inert]") && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
      const first = controls[0];
      const last = controls.at(-1);
      if (!sidebar.contains(document.activeElement) ||
        (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    }
  });

  mobile.addEventListener("change", () => {
    const wasOpen = mobileOpen;
    mobileOpen = false;
    finishDrag(true);
    render();
    if (wasOpen && !hasDialog()) menu.focus();
  });
  window.addEventListener("resize", () => { finishDrag(true); render(); });
  window.uitSidebar = { setMobileOpen, closeMobile: () => setMobileOpen(false), toggle };
  render();
})();
