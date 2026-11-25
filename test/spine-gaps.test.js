import { describe, it, expect } from "vitest";
import { spineGaps, fillSpineGaps, sectionTitle, stepEntry } from "../src/lib/chapters.js";
import { cleanTitle, cleanAuthor, paragraphSizing, chapterTextSize } from "../src/lib/text.js";

const sp = (href, title, linear = true) => ({ href, title, linear });

describe("spineGaps / fillSpineGaps", () => {
  it("leaves a TOC that covers the spine alone", () => {
    const toc = [
      { label: "One", href: "a.html", depth: 0 },
      { label: "Two", href: "b.html#x", depth: 0 },
    ];
    const spine = [sp("cover.html"), sp("a.html"), sp("b.html")];
    expect(spineGaps(toc, spine)).toEqual([]);
    expect(fillSpineGaps(toc, spine)).toEqual(toc);
  });

  it("keeps an unlisted cover/title page before the first entry out", () => {
    const toc = [{ label: "One", href: "a.html", depth: 0 }];
    expect(spineGaps(toc, [sp("cover.html"), sp("title.html"), sp("a.html")])).toEqual([]);
  });

  it("adds every later unlisted document, named by its own title, in spine order", () => {
    const toc = [{ label: "Start", href: "s0.html", depth: 0 }];
    const spine = [
      sp("s0.html"),
      sp("s1.html", "Stage 1 · Plan"),
      sp("s2.html", "Getting Started"),
      sp("s3.html", "Stage 2 · Design"),
    ];
    expect(fillSpineGaps(toc, spine).map((e) => [e.label, e.href, !!e.spine])).toEqual([
      ["Start", "s0.html", false],
      ["Stage 1 · Plan", "s1.html", true],
      ["Getting Started", "s2.html", true],
      ["Stage 2 · Design", "s3.html", true],
    ]);
  });

  it("names a title-less spill-over file after the chapter it continues, at its depth", () => {
    const toc = [
      { label: "Part I", href: "p1.html", depth: 0 },
      { label: "Chapter 5: Exile", href: "c5.html", depth: 1 },
      { label: "Chapter 6", href: "c6.html", depth: 1 },
    ];
    const spine = [sp("p1.html"), sp("c5.html"), sp("c5b.html", ""), sp("c5c.html", ""), sp("c6.html")];
    expect(fillSpineGaps(toc, spine).map((e) => [e.label, e.href, e.depth])).toEqual([
      ["Part I", "p1.html", 0],
      ["Chapter 5: Exile", "c5.html", 1],
      ["Chapter 5: Exile (continued)", "c5b.html", 1],
      ["Chapter 5: Exile (continued)", "c5c.html", 1],
      ["Chapter 6", "c6.html", 1],
    ]);
  });

  it("skips non-linear documents", () => {
    const toc = [{ label: "One", href: "a.html", depth: 0 }];
    expect(spineGaps(toc, [sp("a.html"), sp("notes.html", "", false), sp("b.html")])).toEqual([2]);
  });

  it("gives a book with no TOC every spine document", () => {
    const spine = [sp("a.html", "Alpha"), sp("b.html", "")];
    expect(fillSpineGaps([], spine).map((e) => e.label)).toEqual(["Alpha", "Alpha (continued)"]);
  });
});

describe("sectionTitle", () => {
  it("closes up letter-spaced display type and title-cases it", () => {
    expect(sectionTitle("STAG E   3   ·   B U I L D")).toBe("Stage 3 · Build");
    expect(sectionTitle("G E T T I N G   STA RT E D")).toBe("Getting Started");
    expect(sectionTitle("WO R K E D   E X A M P L E")).toBe("Worked Example");
    expect(sectionTitle("C LO S I N G")).toBe("Closing");
    expect(sectionTitle("R E F E R E N C E")).toBe("Reference");
  });
  it("doesn't mistake a title with short words for letter-spacing", () => {
    expect(sectionTitle("I Am A Cat")).toBe("I Am A Cat");
    expect(sectionTitle("A to Z of It")).toBe("A to Z of It");
  });
  it("keeps an ordinary title as written", () => {
    expect(sectionTitle("  Closing thoughts \n")).toBe("Closing thoughts");
    expect(sectionTitle("Chapter 12: The Sea of Souls")).toBe("Chapter 12: The Sea of Souls");
  });
  it("rejects a paragraph (too long to be a title)", () => {
    expect(
      sectionTitle(
        "He walked on for a long while, until the road ran out and the night came down around him."
      )
    ).toBe("");
    expect(sectionTitle("   ")).toBe("");
  });
});

describe("cleanTitle / cleanAuthor", () => {
  it("drops an asset-id prefix and a duplicate-download suffix", () => {
    expect(cleanTitle("6aba736348bdf4f08183f463 AI Native SDLC Playbook designv2 (1)")).toBe(
      "AI Native SDLC Playbook designv2"
    );
    expect(cleanTitle("6aba736348bdf4f08183f463_AI_Native_Playbook")).toBe("AI Native Playbook");
  });
  it("leaves normal titles alone", () => {
    expect(cleanTitle("Shadow Slave Vol. 2")).toBe("Shadow Slave Vol. 2");
    expect(cleanTitle("Catch-22")).toBe("Catch-22");
    expect(cleanTitle("1984")).toBe("1984");
  });
  it("treats placeholder authors as none", () => {
    expect(cleanAuthor("Unknown")).toBe("");
    expect(cleanAuthor(" unknown author ")).toBe("");
    expect(cleanAuthor("Guiltythree")).toBe("Guiltythree");
  });
});

describe("paragraphSizing / chapterTextSize", () => {
  const r = (size, text) => ({ size, text });
  const plain = { text: 18, base: 18 };
  it("finds the size most of the chapter's text is set in", () => {
    expect(
      chapterTextSize([[r(48, "Title")], [r(24, "A long paragraph of text.")], [r(24, "Another one.")]])
    ).toBe(24);
  });
  it("evens out sizes that switch mid-word", () => {
    expect(
      paragraphSizing([r(18, "Cla"), r(20, "u"), r(18, "de C"), r(20, "o"), r(18, "de is great")], plain)
    ).toBe("even");
  });
  it("leaves real typography alone", () => {
    expect(paragraphSizing([r(54, "T"), r(14, "HE MORNING"), r(18, " was cold and grey.")], plain)).toBe(
      null
    );
    expect(paragraphSizing([r(18, "Plain text with "), r(18, "a span"), r(18, " inside.")], plain)).toBe(
      null
    );
    expect(paragraphSizing([r(14, "A small caption.")], plain)).toBe(null);
  });
  it("reads short display type as a heading, long display type as text", () => {
    const ctx = { text: 24, base: 18 };
    expect(paragraphSizing([r(48, "What"), r(40, "'"), r(48, " s in here")], ctx)).toBe("heading");
    expect(
      paragraphSizing(
        [
          r(
            40,
            "Engineers start Claude Code sessions in plan mode, give Claude the approved spec and review."
          ),
        ],
        ctx
      )
    ).toBe("even");
  });
  it("brings text the book scaled up through spans back to the reader's size", () => {
    expect(paragraphSizing([r(24, "Each play covers:")], { text: 24, base: 18 })).toBe("even");
    expect(
      paragraphSizing([r(28, "Nothing is implemented without an accepted plan.")], { text: 24, base: 18 })
    ).toBe(null);
  });
});

describe("stepEntry", () => {
  const list = [
    { label: "Title", href: "h0.html#a" },
    { label: "Preface", href: "h0.html#b" },
    { label: "Book I", href: "h0.html#c" },
    { label: "Book I (continued)", href: "h1.html" },
    { label: "Book II", href: "h2.html#d" },
    { label: "Notes", href: "h2.html#e" },
  ];
  it("steps by document, landing on its first entry", () => {
    expect(stepEntry(list, "h0.html", 1).label).toBe("Book I (continued)");
    expect(stepEntry(list, "h1.html", 1).label).toBe("Book II");
    expect(stepEntry(list, "h2.html", -1).label).toBe("Book I (continued)");
    expect(stepEntry(list, "h1.html", -1).label).toBe("Title");
  });
  it("stops at the ends", () => {
    expect(stepEntry(list, "h0.html", -1)).toBe(null);
    expect(stepEntry(list, "h2.html", 1)).toBe(null);
    expect(stepEntry([], "x.html", 1)).toBe(null);
  });
  it("steps from the start for a page outside the list", () => {
    expect(stepEntry(list, "cover.html", 1).label).toBe("Book I (continued)");
  });
});
