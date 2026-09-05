(() => {
  const key = "uit-studio.appearance";
  const system = matchMedia("(prefers-color-scheme: dark)");
  const valid = (value) => ["system", "light", "dark"].includes(value);
  let preference = "system";
  try {
    const saved = localStorage.getItem(key);
    if (valid(saved)) preference = saved;
  } catch { /* System appearance remains available when storage is blocked. */ }

  function apply() {
    document.documentElement.dataset.theme = preference === "system" ? (system.matches ? "dark" : "light") : preference;
  }
  // Runs before the stylesheet/body so a saved theme is applied before first paint.
  apply();
  system.addEventListener("change", apply);
  window.addEventListener("storage", (event) => {
    if (event.key !== key && event.key !== null) return;
    preference = valid(event.newValue) ? event.newValue : "system";
    apply();
    const select = document.querySelector("#appearance");
    if (select) select.value = preference;
  });
  document.addEventListener("DOMContentLoaded", () => {
    const select = document.querySelector("#appearance");
    const status = document.querySelector("#appearance-status");
    select.value = preference;
    select.addEventListener("change", () => {
      preference = valid(select.value) ? select.value : "system";
      apply();
      try {
        localStorage.setItem(key, preference);
        status.textContent = "";
      } catch {
        status.textContent = "Appearance changed for this window, but could not be saved.";
      }
    });
  });
})();
