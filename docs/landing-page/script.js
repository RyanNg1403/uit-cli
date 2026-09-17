document.addEventListener("DOMContentLoaded", () => {
  const nav = document.getElementById("main-nav");
  const updateNav = () => nav?.classList.toggle("is-scrolled", window.scrollY > 12);
  window.addEventListener("scroll", updateNav, { passive: true });
  updateNav();

  const themeToggle = document.getElementById("theme-toggle");
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const themeColors = { dark: "#01060e", light: "#eaf6ff" };
  const savedTheme = localStorage.getItem("uit-theme")
    || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const applyTheme = (theme) => {
    const nextTheme = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", nextTheme);
    themeMeta?.setAttribute("content", themeColors[nextTheme]);
  };
  applyTheme(savedTheme);
  themeToggle?.addEventListener("click", () => {
    const nextTheme = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    localStorage.setItem("uit-theme", nextTheme);
  });

  window.copyCommand = (text, button) => {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text).then(() => {
      button.classList.add("is-copied");
      setTimeout(() => button.classList.remove("is-copied"), 1600);
    }).catch(() => undefined);
  };

  const buttons = document.querySelectorAll(".preview-btn");
  const panels = document.querySelectorAll(".product-preview");
  const previewFrame = document.querySelector(".hero-screenshot-frame");
  const previewSwitcher = document.querySelector(".preview-switcher");
  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      const selectedPreview = button.getAttribute("data-preview");
      previewSwitcher?.setAttribute("data-active-preview", selectedPreview);
      buttons.forEach((item) => {
        const selected = item === button;
        item.classList.toggle("active", selected);
        item.setAttribute("aria-selected", String(selected));
      });
      panels.forEach((panel) => { panel.hidden = panel.id !== `preview-${selectedPreview}`; });
      if (previewFrame) previewFrame.dataset.preview = selectedPreview;
    });
  });

  const floatingMascot = document.querySelector("[data-floating-mascot]");
  if (floatingMascot) {
    const frameImage = floatingMascot.querySelector(".mascot-float-frame");
    const frames = (floatingMascot.dataset.frames || "").split(",").map((frame) => frame.trim()).filter(Boolean);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frameIndex = 0;
    let frameTimer;

    frames.slice(1).forEach((src) => {
      const preload = new Image();
      preload.src = src;
    });

    const stopMascotAnimation = () => {
      if (frameTimer !== undefined) {
        window.clearInterval(frameTimer);
        frameTimer = undefined;
      }
    };

    const startMascotAnimation = () => {
      stopMascotAnimation();
      if (!frameImage || frames.length < 2 || reducedMotion.matches || document.hidden) return;
      frameTimer = window.setInterval(() => {
        frameIndex = (frameIndex + 1) % frames.length;
        frameImage.src = frames[frameIndex];
      }, 240);
    };

    startMascotAnimation();
    document.addEventListener("visibilitychange", startMascotAnimation);
    reducedMotion.addEventListener?.("change", startMascotAnimation);
  }

  const cliCards = document.querySelectorAll(".cli-capability[data-cli-command]");
  const cliTerminalCommands = document.querySelectorAll(".cli-terminal-command[data-cli-command]");
  const setCliHighlight = (command, active) => {
    cliCards.forEach((card) => {
      card.classList.toggle("is-linked", active && card.dataset.cliCommand === command);
    });
    cliTerminalCommands.forEach((terminalCommand) => {
      terminalCommand.classList.toggle("is-highlighted", active && terminalCommand.dataset.cliCommand === command);
    });
  };
  cliCards.forEach((card) => {
    const command = card.dataset.cliCommand;
    card.addEventListener("mouseenter", () => setCliHighlight(command, true));
    card.addEventListener("mouseleave", () => setCliHighlight(command, false));
    card.addEventListener("focus", () => setCliHighlight(command, true));
    card.addEventListener("blur", () => setCliHighlight(command, false));
  });

  document.querySelectorAll(".os-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const card = tab.closest(".dl-card");
      const target = tab.dataset.osTarget;
      card?.querySelectorAll(".os-tab").forEach((item) => {
        const selected = item === tab;
        item.classList.toggle("active", selected);
        item.setAttribute("aria-selected", String(selected));
      });
      card?.querySelectorAll(".os-panel").forEach((panel) => {
        panel.hidden = panel.dataset.osPanel !== target;
      });
    });
  });

});
