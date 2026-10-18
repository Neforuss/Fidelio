(() => {
  "use strict";
  const browser = globalThis.browser || globalThis.chrome;
  if (window.__hesActive) return;
  window.__hesActive = true;

  const settings = window.__hesSettings || {};
  const baseScale = Number(settings.scale) || 3;
  const outScale = settings.mode === "fixed" ? baseScale : baseScale * devicePixelRatio;
  const adjustFirst = settings.adjust !== false;
  const initialRect = window.__hesInitialRect || null;
  window.__hesInitialRect = null;

  /* ---------- Overlay (closed shadow root so page CSS can't touch it) ---------- */

  const host = document.createElement("div");
  host.style.cssText =
    "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "closed" });
  const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const style = document.createElement("style");
  style.textContent = `
      .box{position:fixed;box-sizing:border-box;border:2px solid #2f7cf6;
        background:rgba(47,124,246,.15);display:none}
      .adjust .box{background:transparent;border:1.5px solid #fff;
        outline:1px solid rgba(0,0,0,.55);box-shadow:0 0 0 100000px rgba(0,0,0,.45);
        pointer-events:auto;cursor:move}
      .h{position:absolute;width:12px;height:12px;box-sizing:border-box;background:#fff;
        border:1.5px solid #2f7cf6;border-radius:2px;display:none;pointer-events:auto}
      .adjust .h{display:block}
      .h[data-h=nw]{left:-7px;top:-7px;cursor:nwse-resize}
      .h[data-h=n]{left:calc(50% - 6px);top:-7px;cursor:ns-resize}
      .h[data-h=ne]{right:-7px;top:-7px;cursor:nesw-resize}
      .h[data-h=e]{right:-7px;top:calc(50% - 6px);cursor:ew-resize}
      .h[data-h=se]{right:-7px;bottom:-7px;cursor:nwse-resize}
      .h[data-h=s]{left:calc(50% - 6px);bottom:-7px;cursor:ns-resize}
      .h[data-h=sw]{left:-7px;bottom:-7px;cursor:nesw-resize}
      .h[data-h=w]{left:-7px;top:calc(50% - 6px);cursor:ew-resize}
      .tag{position:fixed;display:none;font:12px/1.4 system-ui,sans-serif;color:#fff;
        background:#1b4fa8;padding:3px 7px;border-radius:4px;white-space:nowrap;
        max-width:90vw;overflow:hidden;text-overflow:ellipsis}
      .adjust .tag{display:none !important}
      .bar{position:fixed;display:none;pointer-events:auto;align-items:center;gap:2px;
        font:12.5px/1 system-ui,sans-serif;color:#fff;background:rgba(22,22,26,.95);
        border-radius:8px;padding:4px;box-shadow:0 4px 18px rgba(0,0,0,.4);white-space:nowrap}
      .adjust .bar{display:flex}
      .bar button{all:unset;cursor:pointer;padding:7px 10px;border-radius:5px;color:#fff}
      .bar button:hover{background:rgba(255,255,255,.14)}
      .bar .go{background:#2f7cf6;font-weight:600}
      .bar .go:hover{background:#4a8ff8}
      .bar label{display:flex;align-items:center;gap:5px;padding:0 6px;opacity:.9}
      .bar input{all:unset;width:36px;padding:5px 6px;border-radius:5px;
        background:rgba(255,255,255,.13);text-align:right;cursor:text}
      .size{padding:0 8px;opacity:.85;font-variant-numeric:tabular-nums}
      .sep{width:1px;align-self:stretch;background:rgba(255,255,255,.18);margin:3px 3px}
      .hint{position:fixed;left:50%;top:12px;transform:translateX(-50%);
        font:12.5px/1.4 system-ui,sans-serif;color:#fff;background:rgba(22,22,26,.9);
        padding:6px 14px;border-radius:999px;white-space:nowrap;max-width:94vw;
        overflow:hidden;text-overflow:ellipsis}
      kbd{font:inherit;background:rgba(255,255,255,.18);border-radius:3px;padding:0 4px}`;

  function h(tagName, attrs = {}, children = []) {
    const el = document.createElement(tagName);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    for (const c of children) el.append(c);
    return el;
  }
  const btn = (cls, title, text) => h("button", { class: cls, title }, [text]);
  root.append(
    style,
    h("div", { class: "wrap" }, [
      h("div", { class: "box" }, HANDLES.map((d) => h("div", { class: "h", "data-h": d }))),
      h("div", { class: "tag" }),
      h("div", { class: "bar" }, [
        h("span", { class: "size" }),
        h("span", { class: "sep" }),
        h("label", { title: "Extra space around the element" }, [
          "Padding ",
          h("input", { class: "pad", type: "number", min: "0", max: "999", value: "0" }),
          " px"
        ]),
        btn("reset", "Back to the original edges", "Reset"),
        btn("back", "Pick something else (Backspace)", "Re-pick"),
        h("span", { class: "sep" }),
        btn("cancel", "Esc", "Cancel"),
        btn("go", "Enter", "Capture")
      ]),
      h("div", { class: "hint" })
    ])
  );
  const $ = (s) => root.querySelector(s);
  const wrap = $(".wrap"), box = $(".box"), tag = $(".tag"), bar = $(".bar");
  const sizeEl = $(".size"), padInput = $(".pad"), hint = $(".hint");
  (document.body || document.documentElement).appendChild(host);

  // Plain strings are text; one-item arrays are shown as keys.
  const HINTS = {
    pick: ["Click an element · or drag to draw an area · ", ["↑"], " parent · ", ["↓"], " back · ", ["Esc"], " cancel"],
    adjust: ["Drag edges or corners · drag inside to move · ", ["Shift"], " keeps proportions · arrows nudge (", ["Alt"], " resizes) · ", ["Enter"], " capture"]
  };
  let shownHint = null;
  function showHint() {
    if (shownHint === mode) return;
    shownHint = mode;
    hint.replaceChildren(...HINTS[mode].map((p) => (typeof p === "string" ? p : h("kbd", {}, p))));
  }

  /* ---------- State (rects are in document coordinates, CSS px) ---------- */

  let mode = "pick";
  let hovered = null;
  let history = [];
  let base = null;   // what Reset/Padding work from
  let sel = null;    // current crop
  let drag = null;

  const isOurs = (e) => e.composedPath().includes(host);
  const docPoint = (e) => ({ x: e.clientX + scrollX, y: e.clientY + scrollY });

  function elRect(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  }

  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (el.classList.length) s += "." + [...el.classList].slice(0, 2).join(".");
    return s;
  }

  function fromEdges(l, t, r, b) {
    return {
      x: Math.round(Math.min(l, r)),
      y: Math.round(Math.min(t, b)),
      w: Math.max(1, Math.round(Math.abs(r - l))),
      h: Math.max(1, Math.round(Math.abs(b - t)))
    };
  }

  /* ---------- Drawing ---------- */

  function render() {
    showHint();
    let r = null;
    if (mode === "adjust" || (drag && drag.kind === "draw")) r = sel;
    else if (hovered && hovered.isConnected) r = elRect(hovered);
    if (!r) {
      box.style.display = tag.style.display = "none";
      return;
    }
    const left = r.x - scrollX, top = r.y - scrollY;
    Object.assign(box.style, {
      display: "block",
      left: left + "px",
      top: top + "px",
      width: r.w + "px",
      height: r.h + "px"
    });
    const w = Math.round(r.w), h = Math.round(r.h);
    const label = `${w}×${h} → ${Math.round(w * outScale)}×${Math.round(h * outScale)} px`;

    if (mode === "adjust") {
      sizeEl.textContent = label;
      const bw = bar.offsetWidth || 480, bh = bar.offsetHeight || 36;
      let by = top + r.h + 10;
      if (by + bh > innerHeight - 8) by = top - bh - 10;
      if (by < 8) by = innerHeight - bh - 14;
      let bx = left + r.w - bw;
      bx = Math.max(8, Math.min(bx, innerWidth - bw - 8));
      bar.style.left = bx + "px";
      bar.style.top = by + "px";
    } else {
      const name = drag && drag.kind === "draw" ? "area" : describe(hovered);
      tag.textContent = `${name}  ${label}`;
      tag.style.display = "block";
      const ty = top > 26 ? top - 24 : Math.min(top + r.h + 4, innerHeight - 24);
      tag.style.top = Math.max(2, ty) + "px";
      tag.style.left = Math.max(2, Math.min(left, innerWidth - 220)) + "px";
    }
  }

  /* ---------- Modes ---------- */

  function choose(rect) {
    base = { ...rect };
    if (!adjustFirst) return capture(base);
    mode = "adjust";
    sel = { ...base };
    padInput.value = 0;
    wrap.classList.add("adjust");
    render();
    render(); // second pass positions the bar using its real size
  }

  function backToPick() {
    mode = "pick";
    sel = null;
    drag = null;
    wrap.classList.remove("adjust");
    render();
  }

  function applyPadding() {
    const p = Math.max(0, Math.min(999, parseFloat(padInput.value) || 0));
    sel = { x: base.x - p, y: base.y - p, w: base.w + 2 * p, h: base.h + 2 * p };
    render();
  }

  function capture(r) {
    // Keep the area on the page (nothing exists above or left of the origin).
    const x = Math.max(0, r.x), y = Math.max(0, r.y);
    const width = Math.max(1, r.w - (x - r.x)), height = Math.max(1, r.h - (y - r.y));
    cleanup();
    // Wait for the overlay to disappear from the rendering before capturing.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        browser.runtime.sendMessage({
          type: "capture",
          rect: { x, y, width, height },
          dpr: devicePixelRatio
        })
      )
    );
  }

  /* ---------- Dragging ---------- */

  function applyDrag(e) {
    const p = docPoint(e);
    const dx = p.x - drag.px, dy = p.y - drag.py;

    if (drag.kind === "pending") {
      if (Math.hypot(dx, dy) < 5) return;
      drag.kind = "draw";
    }
    if (drag.kind === "draw") {
      sel = fromEdges(drag.px, drag.py, p.x, p.y);
      return render();
    }

    const s = drag.start;
    let l = s.x, t = s.y, r = s.x + s.w, b = s.y + s.h;
    const hd = drag.handle;
    if (hd === "move") {
      l += dx; r += dx; t += dy; b += dy;
    } else {
      if (hd.includes("w")) l += dx;
      if (hd.includes("e")) r += dx;
      if (hd.includes("n")) t += dy;
      if (hd.includes("s")) b += dy;
      if (e.shiftKey && hd.length === 2) {
        const ratio = s.w / s.h;
        let w = r - l, h = b - t;
        if (Math.abs(w) / ratio >= Math.abs(h)) h = Math.sign(h || 1) * Math.abs(w) / ratio;
        else w = Math.sign(w || 1) * Math.abs(h) * ratio;
        if (hd.includes("n")) t = b - h; else b = t + h;
        if (hd.includes("w")) l = r - w; else r = l + w;
      }
    }
    sel = fromEdges(l, t, r, b);
    render();
  }

  function grabPointer(e) {
    try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
  }

  // Our own UI: handles and the crop box.
  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || mode !== "adjust") return;
    const handle = e.target.closest && e.target.closest("[data-h]");
    if (!handle && e.target !== box) return;
    e.preventDefault();
    const p = docPoint(e);
    drag = { kind: "resize", handle: handle ? handle.dataset.h : "move", px: p.x, py: p.y, start: { ...sel } };
    grabPointer(e);
  });
  root.addEventListener("mousedown", (e) => {
    if (e.target === box || (e.target.closest && e.target.closest("[data-h]"))) e.preventDefault();
  });
  box.addEventListener("dblclick", () => capture(sel));

  $(".go").addEventListener("click", () => capture(sel));
  $(".cancel").addEventListener("click", cleanup);
  $(".back").addEventListener("click", backToPick);
  $(".reset").addEventListener("click", () => { padInput.value = 0; applyPadding(); });
  padInput.addEventListener("input", applyPadding);

  /* ---------- Page events ---------- */

  function block(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onPointerDown(e) {
    if (isOurs(e)) return;
    block(e);
    if (e.button !== 0) return;
    const p = docPoint(e);
    drag = { kind: "pending", px: p.x, py: p.y };
    grabPointer(e);
  }

  function onPointerMove(e) {
    if (drag) return applyDrag(e);
    if (mode !== "pick" || isOurs(e)) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== host && el !== hovered) {
      hovered = el;
      history = [];
      render();
    }
  }

  function onPointerUp(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!isOurs(e)) block(e);
    if (d.kind === "draw") return choose(sel);
    if (d.kind === "pending" && mode === "pick" && hovered) return choose(elRect(hovered));
    render();
  }

  function blockPage(e) {
    if (!isOurs(e)) block(e);
  }

  function onKey(e) {
    // Let typing in the padding box work normally.
    if (isOurs(e) && e.key !== "Escape" && e.key !== "Enter") return;

    if (e.key === "Escape") { block(e); return cleanup(); }

    if (mode === "pick") {
      if (e.key === "ArrowUp") {
        block(e);
        if (hovered && hovered.parentElement) {
          history.push(hovered);
          hovered = hovered.parentElement;
          render();
        }
      } else if (e.key === "ArrowDown") {
        block(e);
        if (history.length) { hovered = history.pop(); render(); }
      } else if (e.key === "Enter") {
        block(e);
        if (hovered) choose(elRect(hovered));
      }
      return;
    }

    // Adjust mode
    if (e.key === "Enter") { block(e); return capture(sel); }
    if (e.key === "Backspace") { block(e); return backToPick(); }
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      block(e);
      const [dx, dy] = moves[e.key];
      if (e.altKey) sel = { ...sel, w: Math.max(1, sel.w + dx), h: Math.max(1, sel.h + dy) };
      else sel = { ...sel, x: sel.x + dx, y: sel.y + dy };
      render();
    }
  }

  const BLOCKED = ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "auxclick"];

  function cleanup() {
    removeEventListener("pointerdown", onPointerDown, true);
    removeEventListener("pointermove", onPointerMove, true);
    removeEventListener("pointerup", onPointerUp, true);
    removeEventListener("keydown", onKey, true);
    removeEventListener("scroll", render, true);
    removeEventListener("resize", render, true);
    for (const t of BLOCKED) removeEventListener(t, blockPage, true);
    host.remove();
    window.__hesActive = false;
  }

  addEventListener("pointerdown", onPointerDown, true);
  addEventListener("pointermove", onPointerMove, true);
  addEventListener("pointerup", onPointerUp, true);
  addEventListener("keydown", onKey, true);
  addEventListener("scroll", render, true);
  addEventListener("resize", render, true);
  for (const t of BLOCKED) addEventListener(t, blockPage, true);

  // Started from the right-click menu: go straight to that element.
  if (initialRect) choose(initialRect);
  else render();
})();
