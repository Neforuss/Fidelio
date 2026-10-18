"use strict";

const browser = globalThis.browser || globalThis.chrome;

const DEFAULTS = { scale: 3, mode: "relative", saveAs: false, copy: false, adjust: true };
const $ = (id) => document.getElementById(id);
let timer;

async function load() {
  const s = Object.assign({}, DEFAULTS, await browser.storage.local.get(DEFAULTS));
  $("scale").value = s.scale;
  document.querySelector(`input[name=mode][value=${s.mode}]`).checked = true;
  $("saveAs").checked = s.saveAs;
  $("copy").checked = s.copy;
  $("adjust").checked = s.adjust;
}

async function save() {
  let scale = parseFloat($("scale").value);
  if (!isFinite(scale)) scale = DEFAULTS.scale;
  scale = Math.min(8, Math.max(1, scale));
  await browser.storage.local.set({
    scale,
    mode: document.querySelector("input[name=mode]:checked").value,
    saveAs: $("saveAs").checked,
    copy: $("copy").checked,
    adjust: $("adjust").checked
  });
  $("saved").textContent = "Saved";
  clearTimeout(timer);
  timer = setTimeout(() => ($("saved").textContent = ""), 1200);
}

load();
document.addEventListener("change", save);
