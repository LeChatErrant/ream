// The "Back to ch. 200 ›" chip (see furthestLink in reading.js): shown only
// while your latest spot is in an earlier chapter than the furthest one you'd
// reached, it opens that chapter at its own saved spot. One look everywhere
// it appears (Continue card, info page, volume sheet).
import { h, svg, ICON } from "./dom.js";
import { furthestLabel } from "./reading.js";
import { openBook } from "./reader.js";

export function furthestButton(f, cls, { vol = true, before } = {}) {
  return h(
    "button",
    {
      class: "furthest-link " + cls,
      onclick: () => {
        const go = () => openBook(f.book.id, { atHref: f.href });
        if (before) before(go);
        else go();
      },
    },
    h("span", { class: "furthest-link__text" }, "Back to ", h("b", null, furthestLabel(f, { vol }))),
    h("span", { class: "furthest-link__chev" }, svg(ICON.chevron))
  );
}
