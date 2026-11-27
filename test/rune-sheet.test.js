import { describe, it, expect } from "vitest";
import { readSheet, descText, sameName } from "../src/lib/rune-sheet.js";

const read = (lines, x) =>
  readSheet(
    lines.map((t) => ({ t })),
    x
  );

describe("readSheet", () => {
  it("pairs a listed name with its description despite the book's typos", () => {
    const { lists } = read(
      [
        "Memory Enchantments: [Mendacious Coffer], [Locomotive Chifonnier].",
        "[Locomotive Chiffonnier] Enchantment Description: [This Memory can move around.]",
      ],
      { name: "Covetous Coffer", kind: "memory" }
    );
    expect(lists[0].names[1]).toMatchObject({
      name: "Locomotive Chiffonnier",
      text: "This Memory can move around.",
    });
  });

  it("reads a list the book trails off or garbles", () => {
    const { lists } = read(
      [
        "Enchantments: [Blessing of Mind], (Blessing of Soul],",
        '[Blessing of Dusk] Enchantment Description: "Dusk."',
      ],
      { name: "Shroud" }
    );
    expect(lists[0].names.map((n) => n.name)).toEqual([
      "Blessing of Mind",
      "Blessing of Soul",
      "Blessing of Dusk",
    ]);
    expect(
      read(["Memory Enchantments: [Legacy of Twilight], [Royal Promise]..."], { name: "Crown" }).lists[0]
        .names
    ).toHaveLength(2);
  });

  it("keeps a Shadow's own description apart from an ability named like it", () => {
    const { epigraph, lists } = read(
      [
        "Shadow Description: [This beautiful steed.]",
        "Shadow Abilities: [Nightmare].",
        '[Nightmare] Ability Description: "This Shadow can create nightmares."',
      ],
      { name: "Nightmare", kind: "shadow" }
    );
    expect(epigraph.text).toBe("This beautiful steed.");
    expect(lists[0].names[0].text).toBe("This Shadow can create nightmares.");
  });

  it("rebuilds each description from its paragraphs", () => {
    const paras = [
      { t: "Memory Description:" },
      { t: "[A long tale,", cont: true },
      { t: "told over two paragraphs.]", cont: true },
    ];
    const { epigraph } = readSheet(paras, { name: "X", kind: "memory" });
    expect(descText(epigraph.src.map((r) => ({ ...r, t: paras[r.i].t })))).toBe(epigraph.text);
  });
});

describe("sameName", () => {
  it("allows a typo in a long name, not in a short one", () => {
    expect(sameName("Prince of the Underwolrd", "Prince of the Underworld")).toBe(true);
    expect(sameName("Ember", "Amber")).toBe(false);
    expect(sameName("Blessing of Mind", "Blessing of Soul")).toBe(false);
  });
});

import { tidyStory } from "../src/lib/rune-sheet.js";
describe("tidyStory", () => {
  const names = ["Bound", "Mercy of Shadow", "Shadow Flame", "Chain", "Weakening Curse"];
  it("drops an opening quote nothing closes", () => {
    expect(tidyStory("“The [Bound] enchantment was self-explanatory.", names)).toBe(
      "The [Bound] enchantment was self-explanatory."
    );
    expect(tidyStory("it had another use. “The (Weakening Curse] was it.", names)).toBe(
      "It had another use. The [Weakening Curse] was it."
    );
  });
  it("keeps real dialogue", () => {
    expect(tidyStory("“Let's hope no one ever sees these runes.\"", names)).toBe(
      "“Let's hope no one ever sees these runes.\""
    );
    expect(tidyStory("He said, “Go.” Then left.", names)).toBe("He said, “Go.” Then left.");
  });
  it("mends the brackets of listed names", () => {
    expect(tidyStory("The (Mercy of Shadow] enhanced it.", names)).toBe("The [Mercy of Shadow] enhanced it.");
    expect(tidyStory("with the [Shadow Flamel, he could", names)).toBe("With the [Shadow Flame], he could");
    expect(tidyStory("The [Chain.]", names)).toBe("The [Chain].");
    expect(tidyStory("[Bound], [Chain] and [Mercy of Shadow]", names)).toBe(
      "[Bound], [Chain] and [Mercy of Shadow]"
    );
  });
});
