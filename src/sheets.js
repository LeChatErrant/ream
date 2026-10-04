// =========================================================================
// Sheets — the small dismissable layers raised over a route: the ⋯ action
// sheet and the three promise-returning prompts (duplicate-suggestion, confirm,
// name). Each prompt resolves a value: the hide fn (run when the layer is torn
// down, whether by a button, the scrim, or the phone's Back) resolves with
// whatever `result` holds at that point — the positive buttons set it before
// dismissing, so a plain dismiss (Back/scrim) always resolves the negative
// default.
// =========================================================================
import { h, WIDE } from "./dom.js";
import { el } from "./dom.js";
import { armOverlay, closeOverlay } from "./router.js";

export function hideActionSheet() {
  el.actionSheet.hidden = true;
  el.actionCard.innerHTML = "";
}
// On a phone this is a bottom sheet. On a wide screen, raised from a button
// (`anchor`) or a right-click point (`at`: { x, y }), it is a small popover
// menu placed right there instead — no Cancel row; a click outside or Escape
// dismisses it. Without either it is a centred dialog.
export function showActionSheet(actions, { anchor = null, at = null } = {}) {
  const card = el.actionCard;
  card.innerHTML = "";
  for (const a of actions) {
    card.append(
      h(
        "button",
        {
          class: "action-item" + (a.danger ? " action-item--danger" : ""),
          // `now` actions run inside the tap itself: a file picker or share sheet
          // must open from a user gesture (iOS refuses it once the menu has closed).
          onclick: a.now
            ? () => {
                a.onClick();
                closeOverlay();
              }
            : () => closeOverlay(a.onClick),
        },
        a.label
      )
    );
  }
  card.append(h("button", { class: "action-item action-item--cancel", onclick: () => closeOverlay() }, "Cancel"));
  const popover = WIDE.matches && !!(anchor || at);
  el.actionSheet.classList.toggle("sheet--popover", popover);
  card.style.left = card.style.top = "";
  el.actionSheet.hidden = false;
  if (popover) placePopover(card, anchor, at);
  armOverlay(hideActionSheet);
}

// Position the popover card next to its anchor (below, right edges aligned) or
// at the pointer, flipped to stay inside the viewport.
function placePopover(card, anchor, at) {
  const gap = 6;
  const margin = 8;
  const w = card.offsetWidth;
  const ht = card.offsetHeight;
  let x;
  let y;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    x = r.right - w;
    y = r.bottom + gap;
    if (y + ht > innerHeight - margin) y = r.top - gap - ht;
  } else {
    x = at.x;
    y = at.y;
    if (x + w > innerWidth - margin) x = at.x - w;
    if (y + ht > innerHeight - margin) y = at.y - ht;
  }
  const clamp = (v, max) => Math.max(margin, Math.min(v, max - margin));
  card.style.left = clamp(x, innerWidth - w) + "px";
  card.style.top = clamp(y, innerHeight - ht) + "px";
}

export function showSuggestSheet(name, count) {
  return new Promise((resolve) => {
    el.suggestBody.textContent =
      count > 2
        ? `${count} books share the same title and author. Group them as “${name}”?`
        : `Same title and author in the .epub metadata. Group them as “${name}”?`;
    let result = false;
    const hide = () => {
      el.suggestSheet.hidden = true;
      el.suggestGroup.onclick = el.suggestKeep.onclick = el.suggestScrim.onclick = null;
      resolve(result);
    };
    el.suggestSheet.hidden = false;
    armOverlay(hide);
    el.suggestGroup.onclick = () => { result = true; closeOverlay(); };
    el.suggestKeep.onclick = () => closeOverlay();
    el.suggestScrim.onclick = () => closeOverlay();
  });
}
export function showConfirmSheet(title, body, confirmLabel) {
  return new Promise((resolve) => {
    el.confirmTitle.textContent = title;
    el.confirmBody.textContent = body;
    el.confirmOk.textContent = confirmLabel || "Delete";
    let result = false;
    const hide = () => {
      el.confirmSheet.hidden = true;
      el.confirmOk.onclick = el.confirmCancel.onclick = el.confirmScrim.onclick = null;
      resolve(result);
    };
    el.confirmSheet.hidden = false;
    armOverlay(hide);
    el.confirmOk.onclick = () => { result = true; closeOverlay(); };
    el.confirmCancel.onclick = () => closeOverlay();
    el.confirmScrim.onclick = () => closeOverlay();
  });
}
export function showNameSheet(title, prefill, confirmLabel) {
  return new Promise((resolve) => {
    el.nameTitle.textContent = title;
    el.nameConfirm.textContent = confirmLabel || "Save";
    el.nameInput.value = prefill || "";
    let result = null;
    const hide = () => {
      el.nameSheet.hidden = true;
      el.nameConfirm.onclick = el.nameCancel.onclick = el.nameScrim.onclick = el.nameInput.onkeydown = null;
      resolve(result);
    };
    el.nameSheet.hidden = false;
    armOverlay(hide);
    setTimeout(() => el.nameInput.focus(), 30);
    const confirm = () => { result = el.nameInput.value.trim() || prefill; closeOverlay(); };
    el.nameConfirm.onclick = confirm;
    el.nameCancel.onclick = () => closeOverlay();
    el.nameScrim.onclick = () => closeOverlay();
    el.nameInput.onkeydown = (e) => {
      if (e.key === "Enter") confirm();
      if (e.key === "Escape") closeOverlay();
    };
  });
}
