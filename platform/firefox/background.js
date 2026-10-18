"use strict";

// mode "relative": output = scale × the screen's normal resolution (devicePixelRatio)
// mode "fixed":    output = scale device pixels per CSS pixel, regardless of screen
const DEFAULTS = { scale: 3, mode: "relative", saveAs: false, copy: false, adjust: true };

// Firefox can't draw arbitrarily large snapshots; stay safely inside its limits.
const MAX_SIDE = 16384;
const MAX_PIXELS = 120e6;

async function getSettings() {
  try {
    return Object.assign({}, DEFAULTS, await browser.storage.local.get(DEFAULTS));
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function notify(title, message) {
  browser.notifications.create({
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/icon-128.png"),
    title,
    message
  });
}

function effectiveScale(settings, dpr) {
  const s = Number(settings.scale) || 3;
  return settings.mode === "fixed" ? s : s * (Number(dpr) || 1);
}

/* ---------- Starting the picker ---------- */

async function startPicker(tab, initialRectCode) {
  const settings = await getSettings();
  try {
    await browser.tabs.executeScript(tab.id, {
      code: `window.__hesSettings = ${JSON.stringify(settings)};`
    });
    if (initialRectCode) {
      const [found] = await browser.tabs.executeScript(tab.id, { code: initialRectCode });
      if (!found) return;
    }
    await browser.tabs.executeScript(tab.id, { file: "picker.js" });
  } catch (e) {
    notify(
      "Can't screenshot this page",
      "Firefox doesn't let extensions run on built-in pages (about: pages, the add-ons site, reader view)."
    );
  }
}

browser.browserAction.onClicked.addListener((tab) => startPicker(tab));

browser.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "start-picker") return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) startPicker(tab);
});

/* ---------- Right-click menu ---------- */

function menuTitle(settings) {
  const n = Number(settings.scale) || 3;
  return settings.mode === "fixed"
    ? `Screenshot this element at ${n}×`
    : `Screenshot this element at ${n}× quality`;
}

getSettings().then((settings) => {
  browser.menus.create({
    id: "hes-element",
    title: menuTitle(settings),
    contexts: ["all"]
  });
});

browser.storage.onChanged.addListener(async () => {
  browser.menus.update("hes-element", { title: menuTitle(await getSettings()) });
});

// Runs inside the page: measures the right-clicked element for the picker.
function setTarget(targetId) {
  if (window.__hesActive) return false;
  const el = browser.menus.getTargetElement(targetId);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  window.__hesInitialRect = { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  return true;
}

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "hes-element") return;
  if (info.frameId) {
    notify("Element is inside a frame", "Elements inside embedded frames can't be captured yet. Try opening the frame in its own tab.");
    return;
  }
  startPicker(tab, `(${setTarget})(${JSON.stringify(info.targetElementId)});`);
});

/* ---------- Capturing ---------- */

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "capture" && sender.tab) {
    capture(sender.tab, msg).catch((e) =>
      notify("Screenshot failed", String(e.message || e))
    );
  }
});

async function capture(tab, { rect, dpr }) {
  const settings = await getSettings();
  let scale = effectiveScale(settings, dpr);

  // Snap outward to whole CSS pixels so no edge gets clipped.
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  const width = Math.max(1, Math.ceil(rect.x + rect.width) - x);
  const height = Math.max(1, Math.ceil(rect.y + rect.height) - y);

  // Reduce scale only if the result would exceed what Firefox can render.
  const maxBySide = MAX_SIDE / Math.max(width, height);
  const maxByArea = Math.sqrt(MAX_PIXELS / (width * height));
  const limit = Math.min(maxBySide, maxByArea);
  if (scale > limit) {
    const reduced = Math.floor(limit * 100) / 100;
    notify(
      "Element is very large",
      `Captured at ${reduced}× instead of ${scale}× to stay within Firefox's image size limit.`
    );
    scale = reduced;
  }

  // Firefox renders the region fresh at this scale (not upscaled), including
  // parts of the element that are scrolled out of view.
  const dataUrl = await browser.tabs.captureTab(tab.id, {
    format: "png",
    rect: { x, y, width, height },
    scale
  });
  const blob = await (await fetch(dataUrl)).blob();

  if (settings.copy) {
    try {
      await browser.clipboard.setImageData(await blob.arrayBuffer(), "png");
    } catch (e) {
      notify("Couldn't copy to clipboard", String(e.message || e));
    }
  }

  let host = "page";
  try { host = new URL(tab.url).hostname.replace(/^www\./, "") || "page"; } catch (e) {}
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const scaleLabel = String(Math.round(scale * 100) / 100);
  const filename = `Element Screenshots/${host}_${stamp}@${scaleLabel}x.png`.replace(/[:*?"<>|]/g, "_");

  const url = URL.createObjectURL(blob);
  try {
    await browser.downloads.download({ url, filename, saveAs: !!settings.saveAs });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}
