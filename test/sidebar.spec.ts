import { test, expect } from "./fixtures/desktop";
import type { Page } from "playwright/test";

const STORE = "uit-studio.sidebar.v1";
const separator = (page: Page) => page.getByRole("separator", { name: "Navigation width" });
const saved = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), STORE);

test("Codex actions are distinct and hover stays inside resized sidebar", async ({ page, boot }, info) => {
  await boot();
  await page.locator('[data-view="agent"]').click();
  await page.locator("#new-project").click();
  await page.locator(".project-option").first().click();
  for (const width of [200, 248, 480]) {
    await dragTo(page, width); await page.mouse.up();
    const sidebar = (await page.locator("#sidebar").boundingBox())!;
    for (const id of [".project-new-thread", "#new-project"]) {
      const action = page.locator(id);
      await action.hover();
      const box = (await action.boundingBox())!;
      expect(box.x).toBeGreaterThan(sidebar.x);
      expect(box.x + box.width).toBeLessThan(sidebar.x + sidebar.width);
      if (id === "#new-project") expect(await action.locator("svg").count()).toBe(1);
      else await expect(action).toHaveText("+");
    }
  }
  expect(await page.locator("#new-project").evaluate((element) => element.closest(".primary-nav"))).toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#menu-toggle").click();
  await page.locator(".project-new-thread").hover();
  expect(await page.locator("#sidebar").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("codex-actions-mobile.png") });
});

async function dragTo(page: Page, width: number) {
  const box = (await separator(page).boundingBox())!;
  const startWidth = Number(await separator(page).getAttribute("aria-valuenow"));
  await page.mouse.move(box.x + 4, 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 4 + width - startWidth, 100, { steps: 8 });
}

test("pointer resize clamps width and writes storage only on release", async ({ page, boot }) => {
  await boot();
  await expect(separator(page)).toHaveAttribute("aria-orientation", "vertical");
  await dragTo(page, 360);
  await expect(page.locator("#sidebar")).toHaveCSS("width", "360px");
  expect(await saved(page)).toBeNull();
  await page.mouse.up();
  expect(await saved(page)).toEqual({ width: 360, collapsed: false });
  await dragTo(page, 600);
  await expect(separator(page)).toHaveAttribute("aria-valuenow", "480");
  await page.mouse.up();
  await dragTo(page, 120);
  await expect(separator(page)).toHaveAttribute("aria-valuenow", "200");
  await page.mouse.up();
  await page.setViewportSize({ width: 651, height: 800 });
  await dragTo(page, 480);
  await page.mouse.up();
  await expect(separator(page)).toHaveAttribute("aria-valuemax", "331");
  await expect(page.locator("#main")).toHaveCSS("width", "320px");
});

test("drag collapse remembers open width and collapsed edge expands", async ({ page, boot }) => {
  await boot();
  await dragTo(page, 350);
  await page.mouse.up();
  await dragTo(page, 119);
  await expect(page.locator("#sidebar")).toBeHidden();
  await page.mouse.up();
  expect(await saved(page)).toEqual({ width: 350, collapsed: true });
  await page.reload();
  await expect(separator(page)).toHaveAttribute("aria-valuenow", "0");
  await page.locator("#menu-toggle").click();
  await expect(page.locator("#sidebar")).toHaveCSS("width", "350px");
  await page.locator("#menu-toggle").click();
  await dragTo(page, 300);
  await page.mouse.up();
  await expect(page.locator("#sidebar")).toHaveCSS("width", "300px");
  expect(await saved(page)).toEqual({ width: 300, collapsed: false });
});

test("separator keyboard resize, collapse and expand keep a usable tab order", async ({ page, boot }) => {
  await boot();
  await separator(page).focus();
  await page.keyboard.press("ArrowRight");
  await expect(separator(page)).toHaveAttribute("aria-valuenow", "258");
  await page.keyboard.press("ArrowLeft");
  await expect(separator(page)).toHaveAttribute("aria-valuenow", "248");
  await page.keyboard.press("Home");
  await expect(separator(page)).toBeFocused();
  await expect(page.locator("#sidebar")).toHaveAttribute("inert", "");
  await page.keyboard.press("Tab");
  await expect(page.locator("#menu-toggle")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(separator(page)).toBeFocused();
  await page.keyboard.press("End");
  await expect(separator(page)).toHaveAttribute("aria-valuenow", "248");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await expect(separator(page)).toHaveAttribute("aria-valuenow", "248");
});

for (const modifier of ["Meta", "Control"]) {
  test(`${modifier}+B toggles without stealing main focus and skips dialogs`, async ({ page, boot }) => {
    await boot();
    await page.locator("#course-search").focus();
    await page.keyboard.press(`${modifier}+b`);
    await expect(page.locator("#sidebar")).toBeHidden();
    await expect(page.locator("#course-search")).toBeFocused();
    await page.keyboard.press(`${modifier}+b`);
    await expect(page.locator("#sidebar")).toBeVisible();
    await page.locator("#account-button").click();
    const focus = await page.evaluate(() => document.activeElement?.id);
    await page.keyboard.press(`${modifier}+b`);
    await expect(page.locator("#login-modal")).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe(focus);
    await expect(page.locator("#sidebar")).toBeVisible();
    await page.locator("#close-login").click();
    await page.locator("#appearance").focus();
    await page.keyboard.press(`${modifier}+b`);
    await expect(page.locator("#menu-toggle")).toBeFocused();
  });
}

test("desktop navigation does not collapse and long course names stay within the rail", async ({ page, boot }) => {
  await boot();
  await separator(page).focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  await page.locator(".project-name").first().evaluate((element) => { element.textContent = "LongCourseName".repeat(80); });
  expect(await page.locator("#course-nav").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.nav-item[data-view="agent"]').click();
  await expect(page.locator("#sidebar")).toBeVisible();
  await expect(page.locator("#menu-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(separator(page)).toHaveAttribute("aria-valuenow", "200");
});

for (const width of [375, 650]) {
  test(`mobile ${width}px overlay traps select focus and closes on navigation`, async ({ page, boot }) => {
    await page.setViewportSize({ width, height: 800 });
    await boot();
    await expect(separator(page)).toBeHidden();
    await expect(page.locator("#sidebar")).toHaveAttribute("inert", "");
    await page.locator("#menu-toggle").click();
    await expect(page.locator("#sidebar")).toHaveCSS("width", "280px");
    await expect(page.locator("#close-sidebar")).toBeFocused();
    await expect(page.locator("#main")).toHaveAttribute("inert", "");
    await page.locator("#appearance").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#account-button")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#close-sidebar")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#account-button")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#menu-toggle")).toBeFocused();
    await page.keyboard.press("Control+b");
    await page.locator('.nav-item[data-view="agent"]').click();
    await expect(page.locator("#sidebar")).toBeHidden();
    await expect(page.locator("#main")).not.toHaveAttribute("inert", "");
    await page.locator("#menu-toggle").click();
    await page.locator("#sidebar-scrim").click({ position: { x: width - 10, y: 100 } });
    await expect(page.locator("#sidebar")).toBeHidden();
    expect(await saved(page)).toBeNull();
  });
}

test("breakpoints preserve desktop state and clear mobile focus/inert", async ({ page, boot }) => {
  await boot();
  await dragTo(page, 420);
  await page.mouse.up();
  await page.setViewportSize({ width: 651, height: 800 });
  await expect(separator(page)).toHaveAttribute("aria-valuenow", "331");
  await page.setViewportSize({ width: 650, height: 800 });
  await page.locator("#menu-toggle").click();
  await page.locator("#appearance").focus();
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(page.locator("#main")).not.toHaveAttribute("inert", "");
  await expect(page.locator("#menu-toggle")).toBeFocused();
  await expect(separator(page)).toHaveAttribute("aria-valuenow", "420");
  await page.locator("#menu-toggle").click();
  await page.setViewportSize({ width: 650, height: 800 });
  await page.locator("#menu-toggle").click();
  await expect(page.locator("#sidebar")).toHaveCSS("width", "280px");
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect(page.locator("#sidebar")).toBeHidden();
  await expect(page.locator("#sidebar-scrim")).toBeHidden();
  expect(await saved(page)).toEqual({ width: 420, collapsed: true });
});

test("cancelled pointer capture restores layout without persisting", async ({ page, boot }) => {
  await boot();
  await dragTo(page, 400);
  await separator(page).evaluate((element) => {
    element.dispatchEvent(new PointerEvent("lostpointercapture"));
  });
  await page.mouse.up();
  await expect(separator(page)).toHaveAttribute("aria-valuenow", "248");
  expect(await saved(page)).toBeNull();
  await expect(page.locator("#app")).not.toHaveClass(/sidebar-dragging/);
});

for (const value of ["{broken", '{"width":"300","collapsed":true}', '{"width":9999,"collapsed":false}']) {
  test(`startup validates saved state ${value}`, async ({ page, boot }) => {
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: STORE, value });
    await boot();
    await expect(separator(page)).toHaveAttribute("aria-valuenow", value.includes("9999") ? "480" : "248");
    await expect(page.locator("#sidebar")).toBeVisible();
  });
}

test("storage read and write failures leave navigation usable", async ({ page, boot }) => {
  await page.addInitScript((key) => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (name) {
      if (name === key) throw new DOMException("Storage denied", "SecurityError");
      return get.call(this, name);
    };
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException("Storage full", "QuotaExceededError");
      return set.call(this, name, value);
    };
  }, STORE);
  await boot();
  await dragTo(page, 320);
  await page.mouse.up();
  await expect(separator(page)).toHaveAttribute("aria-valuenow", "320");
  await page.keyboard.press("Control+b");
  await expect(page.locator("#sidebar")).toBeHidden();
  await page.locator("#menu-toggle").click();
  await expect(page.locator("#sidebar")).toHaveCSS("width", "320px");
});
