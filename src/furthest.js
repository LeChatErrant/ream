// The ⚑ "Furthest · vol. 2 · ch. 200 ›" link (see furthestLink in reading.js):
// shown only while your latest spot is in an earlier chapter than the furthest
// one you'd reached, it opens that chapter at its own saved spot.
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
    h("span", { class: "furthest-link__flag" }, svg(ICON.flag)),
    h("span", { class: "furthest-link__text" }, "Furthest · ", h("b", null, furthestLabel(f, { vol }))),
    h("span", { class: "furthest-link__chev" }, svg(ICON.chevron))
  );
}
