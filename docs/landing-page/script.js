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

  const marqueeTrack = document.querySelector(".marquee-track");
  const marqueeGroup = marqueeTrack?.querySelector(".marquee-group");
  if (marqueeTrack && marqueeGroup) {
    const syncMarqueeDistance = () => {
      marqueeTrack.style.setProperty("--marquee-loop-distance", `${-marqueeGroup.getBoundingClientRect().width}px`);
    };
    syncMarqueeDistance();
    marqueeGroup.querySelectorAll("img").forEach((image) => image.addEventListener("load", syncMarqueeDistance));
    if ("ResizeObserver" in window) {
      new ResizeObserver(syncMarqueeDistance).observe(marqueeGroup);
    } else {
      window.addEventListener("resize", syncMarqueeDistance);
    }
  }

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
    const frameImages = [...floatingMascot.querySelectorAll(".mascot-float-frame")];
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frameIndex = Math.max(0, frameImages.findIndex((image) => image.classList.contains("is-active")));
    let frameTimer;
    let animationGeneration = 0;

    const framesReady = Promise.all(frameImages.map(async (image) => {
      if (!image.complete) {
        await new Promise((resolve) => {
          const settle = () => resolve();
          image.addEventListener("load", settle, { once: true });
          image.addEventListener("error", settle, { once: true });
        });
      }
      if (typeof image.decode === "function") await image.decode().catch(() => undefined);
    }));

    const stopMascotAnimation = () => {
      animationGeneration += 1;
      if (frameTimer !== undefined) {
        window.clearInterval(frameTimer);
        frameTimer = undefined;
      }
    };

    const startMascotAnimation = () => {
      stopMascotAnimation();
      if (frameImages.length < 2 || reducedMotion.matches || document.hidden) return;
      const generation = animationGeneration;
      framesReady.then(() => {
        if (generation !== animationGeneration || reducedMotion.matches || document.hidden) return;
        frameTimer = window.setInterval(() => {
          const previousFrame = frameImages[frameIndex];
          frameIndex = (frameIndex + 1) % frameImages.length;
          const nextFrame = frameImages[frameIndex];
          nextFrame.hidden = false;
          nextFrame.classList.add("is-active");
          previousFrame.classList.remove("is-active");
          previousFrame.hidden = true;
        }, 500);
      });
    };

    startMascotAnimation();
    document.addEventListener("visibilitychange", startMascotAnimation);
    reducedMotion.addEventListener?.("change", startMascotAnimation);
  }

  const mcpToolRows = [...document.querySelectorAll(".mcp-tool-row[data-mcp-tool]")];
  const mcpWorkbench = document.querySelector(".mcp-tool-workbench");
  const mcpTableWrap = document.querySelector(".mcp-tool-table-wrap");
  const mcpInspector = document.getElementById("mcp-tool-inspector");
  const mcpInspectorTitle = document.getElementById("mcp-inspector-title");
  const mcpParameterGrid = document.getElementById("mcp-parameter-grid");
  const mcpInspectorClose = document.querySelector(".mcp-inspector-close");
  const mcpToolSpecs = {
    uit_courses: {
      parameters: []
    },
    uit_course_contents: {
      parameters: [
        { name: "courseId", type: "number" }
      ]
    },
    uit_read_resource: {
      parameters: [
        { name: "courseId", type: "number" },
        { name: "kind", type: "select" },
        { name: "id", type: "number" },
        { name: "moduleId", type: "number" },
        { name: "filename", type: "text" }
      ]
    },
    uit_course_members: {
      parameters: [
        { name: "courseId", type: "number" },
        { name: "role", type: "select" }
      ]
    },
    uit_course_grades: {
      parameters: [
        { name: "courseId", type: "number" }
      ]
    },
    uit_download_material: {
      parameters: [
        { name: "courseId", type: "number" },
        { name: "moduleId", type: "number" },
        { name: "filename", type: "text" }
      ]
    },
    uit_submit_assignment: {
      parameters: [
        { name: "courseId", type: "number" },
        { name: "assignmentId", type: "number" },
        { name: "filePath", type: "text" }
      ]
    }
  };

  const syncMcpTableHeight = () => {
    if (!mcpWorkbench || !mcpTableWrap) return;
    mcpWorkbench.style.setProperty("--mcp-table-height", `${mcpTableWrap.getBoundingClientRect().height}px`);
  };

  syncMcpTableHeight();
  if (mcpTableWrap && "ResizeObserver" in window) {
    new ResizeObserver(syncMcpTableHeight).observe(mcpTableWrap);
  } else {
    window.addEventListener("resize", syncMcpTableHeight);
  }

  let activeMcpToolRow;
  const closeMcpInspector = () => {
    if (!mcpInspector) return;
    mcpInspector.hidden = true;
    mcpWorkbench?.classList.remove("is-inspector-open");
    mcpToolRows.forEach((row) => {
      row.classList.remove("is-selected");
      row.setAttribute("aria-expanded", "false");
    });
    activeMcpToolRow?.focus();
  };

  const openMcpInspector = (row) => {
    const toolName = row.dataset.mcpTool;
    const toolSpec = mcpToolSpecs[toolName];
    if (!mcpInspector || !mcpInspectorTitle || !mcpParameterGrid || !toolSpec) return;

    activeMcpToolRow = row;
    mcpToolRows.forEach((item) => {
      const selected = item === row;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-expanded", String(selected));
    });
    mcpInspectorTitle.textContent = toolName;
    mcpParameterGrid.replaceChildren();
    mcpParameterGrid.classList.toggle("is-multi-column", toolSpec.parameters.length >= 3);

    if (toolSpec.parameters.length === 0) {
      const noParameters = document.createElement("p");
      noParameters.className = "mcp-no-parameters";
      noParameters.textContent = "This tool has no parameters.";
      mcpParameterGrid.append(noParameters);
      mcpWorkbench?.classList.add("is-inspector-open");
      mcpInspector.hidden = false;
      return;
    }

    toolSpec.parameters.forEach((parameter) => {
      const field = document.createElement("div");
      field.className = "mcp-parameter";

      const parameterHead = document.createElement("div");
      parameterHead.className = "mcp-parameter-head";
      const parameterName = document.createElement("code");
      parameterName.className = "mcp-parameter-name";
      parameterName.textContent = parameter.name;
      const parameterMeta = document.createElement("span");
      parameterMeta.className = "mcp-parameter-meta";
      const typeName = parameter.type === "number" ? "integer" : parameter.type === "select" ? "enum" : "string";
      parameterMeta.textContent = typeName;
      parameterHead.append(parameterName, parameterMeta);
      field.append(parameterHead);
      mcpParameterGrid.append(field);
    });

    mcpWorkbench?.classList.add("is-inspector-open");
    mcpInspector.hidden = false;
  };

  mcpToolRows.forEach((row) => {
    const activate = () => openMcpInspector(row);
    row.addEventListener("click", activate);
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activate();
    });
  });
  mcpInspectorClose?.addEventListener("click", closeMcpInspector);

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

  const downloadGrid = document.querySelector(".download-grid");
  const downloadCards = downloadGrid ? [...downloadGrid.querySelectorAll(".dl-card")] : [];
  const windowsStudioMethods = document.querySelector(".windows-studio-methods");
  const windowsNativeMethod = windowsStudioMethods?.querySelector(".install-choice");
  const syncDownloadCardHeights = () => {
    if (!downloadGrid || downloadCards.length < 3 || !windowsStudioMethods || !windowsNativeMethod) return;

    downloadGrid.style.removeProperty("--download-card-height");
    const referenceCardHeight = downloadCards[0].offsetHeight;
    const nativeMethodHeight = windowsNativeMethod.offsetHeight;
    if (!nativeMethodHeight) {
      downloadGrid.style.setProperty("--download-card-height", `${referenceCardHeight}px`);
      return;
    }

    windowsStudioMethods.style.setProperty("--windows-studio-method-height", `${nativeMethodHeight}px`);
    const windowsNaturalHeight = downloadCards[downloadCards.length - 1].offsetHeight;
    const excessWindowsHeight = Math.max(0, windowsNaturalHeight - referenceCardHeight);
    const targetMethodHeight = Math.max(132, nativeMethodHeight - excessWindowsHeight);

    windowsStudioMethods.style.setProperty("--windows-studio-method-height", `${targetMethodHeight}px`);
    downloadGrid.style.setProperty("--download-card-height", `${referenceCardHeight}px`);
  };

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
      window.requestAnimationFrame(syncDownloadCardHeights);
    });
  });

  syncDownloadCardHeights();
  if (windowsNativeMethod) {
    if ("ResizeObserver" in window) {
      new ResizeObserver(() => window.requestAnimationFrame(syncDownloadCardHeights)).observe(windowsNativeMethod);
    }
    window.addEventListener("resize", () => window.requestAnimationFrame(syncDownloadCardHeights));
    document.fonts?.ready?.then(() => window.requestAnimationFrame(syncDownloadCardHeights));
  }

});
