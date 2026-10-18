"use strict";

// Chrome has no scaled capture API like Firefox's tabs.captureTab, so this
// briefly attaches the DevTools protocol, renders the page at a higher device
// scale factor (real re-rendering, not upscaling), captures the area, and detaches.

// mode "relative": output = scale × the screen's normal resolution (devicePixelRatio)
// mode "fixed":    output = scale device pixels per CSS pixel, regardless of screen
const DEFAULTS = { scale: 3, mode: "relative", saveAs: false, copy: false, adjust: true };

const MAX_SIDE = 16384;
const MAX_PIXELS = 120e6;

async function getSettings() {
  try {
    return Object.assign({}, DEFAULTS, await chrome.storage.local.get(DEFAULTS));
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title,
    message
  });
}

function effectiveScale(settings, dpr) {
  const s = Number(settings.scale) || 3;
  return settings.mode === "fixed" ? s : s * (Number(dpr) || 1);
}

/* ---------- Starting the picker ---------- */

async function startPicker(tab) {
  const settings = await getSettings();
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (s) => { window.__hesSettings = s; },
      args: [settings]
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["picker.js"] });
  } catch (e) {
    notify(
      "Can't screenshot this page",
      "Chrome doesn't let extensions run on its own pages (chrome:// pages, the New Tab page, the Web Store)."
    );
  }
}

chrome.action.onClicked.addListener((tab) => startPicker(tab));

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== "start-picker") return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) startPicker(tab);
});

/* ---------- Right-click menu ---------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "hes-element",
      title: "Screenshot an element in high resolution",
      contexts: ["all"]
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "hes-element" && tab) startPicker(tab);
});

/* ---------- Capturing ---------- */

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "capture" && sender.tab) {
    capture(sender.tab, msg).catch((e) => notify("Screenshot failed", String(e.message || e)));
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns base64 PNG of the document-coordinate rect, rendered at `scale`
// device pixels per CSS pixel.
async function renderPng(tabId, { x, y, width, height }, scale) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "Emulation.setDeviceMetricsOverride", {
      width: 0,
      height: 0,
      deviceScaleFactor: scale,
      mobile: false
    });
    await sleep(150); // let the page repaint (and pick up sharper responsive images)
    const { data } = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "png",
      clip: { x, y, width, height, scale: 1 },
      captureBeyondViewport: true,
      fromSurface: true
    });
    return data;
  } finally {
    try { await chrome.debugger.sendCommand(target, "Emulation.clearDeviceMetricsOverride"); } catch (e) {}
    try { await chrome.debugger.detach(target); } catch (e) {}
  }
}

async function capture(tab, { rect, dpr }) {
  const settings = await getSettings();
  let scale = effectiveScale(settings, dpr);

  // Snap outward to whole CSS pixels so no edge gets clipped.
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  const width = Math.max(1, Math.ceil(rect.x + rect.width) - x);
  const height = Math.max(1, Math.ceil(rect.y + rect.height) - y);

  const limit = Math.min(MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
  if (scale > limit) {
    const reduced = Math.floor(limit * 100) / 100;
    notify("Element is very large", `Captured at ${reduced}× instead of ${scale}× to stay within Chrome's image size limit.`);
    scale = reduced;
  }

  const data = await renderPng(tab.id, { x, y, width, height }, scale);
  const dataUrl = "data:image/png;base64," + data;

  if (settings.copy) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (url) => {
          try {
            const blob = await (await fetch(url)).blob();
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            return "";
          } catch (e) {
            return String(e && e.message || e);
          }
        },
        args: [dataUrl]
      });
      if (res && res.result) notify("Couldn't copy to clipboard", res.result);
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

  await chrome.downloads.download({ url: dataUrl, filename, saveAs: !!settings.saveAs });
}
