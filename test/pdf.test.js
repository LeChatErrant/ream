import { describe, it, expect } from "vitest";
import {
  pageHref,
  hrefPage,
  pdfChapters,
  pdfSections,
  sectionOfPage,
  pdfPos,
  parsePdfPos,
  nestByDepth,
  pdfTitle,
  pdfDate,
  pdfSubjects,
  usefulOutline,
  pageLines,
  headingOutline,
} from "../src/lib/pdf.js";
import { flatten, readableChapters } from "../src/lib/chapters.js";

describe("page hrefs", () => {
  it("round-trips", () => {
    expect(pageHref(12)).toBe("p12");
    expect(hrefPage("p12")).toBe(12);
    expect(hrefPage("p12#x")).toBe(12);
    expect(hrefPage("chapter1.xhtml")).toBe(null);
  });
});

describe("pdfChapters", () => {
  it("makes a chapter per bookmark, nested depth kept, cover split off", () => {
    const outline = [
      { title: "The Orchard Letters", page: 1, depth: 0 },
      { title: "1. The Mill", page: 2, depth: 1 },
      { title: "2. The Tin Box", page: 4, depth: 1 },
    ];
    expect(pdfChapters(outline, 11)).toEqual([
      { label: "The Orchard Letters", href: "p1", depth: 0 },
      { label: "1. The Mill", href: "p2", depth: 1 },
      { label: "2. The Tin Box", href: "p4", depth: 1 },
    ]);
  });
  it("puts pages before the first bookmark in a chapter of their own", () => {
    expect(pdfChapters([{ title: "Intro", page: 2 }], 9)[0]).toEqual({
      label: "Cover",
      href: "p1",
      depth: 0,
    });
    expect(readableChapters(pdfChapters([{ title: "Intro", page: 2 }], 9)).map((e) => e.label)).toEqual([
      "Intro",
    ]);
    expect(pdfChapters([{ title: "Intro", page: 4 }], 9)[0].label).toBe("Pages 1–3");
  });
  it("sorts bookmarks into page order and drops unusable ones", () => {
    const outline = [
      { title: "B", page: 5 },
      { title: "A", page: 2 },
      { title: "", page: 3 },
      { title: "Lost", page: null },
      { title: "Beyond", page: 99 },
    ];
    expect(pdfChapters(outline, 10).map((e) => e.label)).toEqual(["Cover", "A", "B"]);
  });
  it("without bookmarks: one chapter for a short PDF, ten-page chunks for a long one", () => {
    expect(pdfChapters([], 7)).toEqual([{ label: "Pages 1–7", href: "p1", depth: 0 }]);
    expect(pdfChapters([], 1)).toEqual([{ label: "Page 1", href: "p1", depth: 0 }]);
    expect(pdfChapters([], 23).length).toBe(1);
    expect(pdfChapters([], 31).map((e) => e.label)).toEqual([
      "Pages 1–10",
      "Pages 11–20",
      "Pages 21–30",
      "Page 31",
    ]);
  });
  it("normalises depths so the shallowest bookmark sits at 0", () => {
    expect(
      pdfChapters(
        [
          { title: "A", page: 1, depth: 2 },
          { title: "B", page: 2, depth: 3 },
        ],
        3
      ).map((e) => e.depth)
    ).toEqual([0, 1]);
  });
});

describe("pdfSections / sectionOfPage", () => {
  const chapters = [
    { label: "Cover", href: "p1" },
    { label: "Part", href: "p2" },
    { label: "Ch 1", href: "p2" },
    { label: "Ch 2", href: "p6" },
  ];
  it("gives one section per first page with its range", () => {
    expect(pdfSections(chapters, 9)).toEqual([
      { href: "p1", from: 1, to: 1 },
      { href: "p2", from: 2, to: 5 },
      { href: "p6", from: 6, to: 9 },
    ]);
  });
  it("always starts at page 1", () => {
    expect(pdfSections([{ href: "p3" }], 4)).toEqual([
      { href: "p1", from: 1, to: 2 },
      { href: "p3", from: 3, to: 4 },
    ]);
  });
  it("finds the section holding a page", () => {
    const s = pdfSections(chapters, 9);
    expect(sectionOfPage(s, 1).href).toBe("p1");
    expect(sectionOfPage(s, 4).href).toBe("p2");
    expect(sectionOfPage(s, 9).href).toBe("p6");
  });
});

describe("pdfPos", () => {
  it("round-trips and clamps", () => {
    expect(parsePdfPos(pdfPos(12, 0.35))).toEqual({ page: 12, frac: 0.35 });
    expect(parsePdfPos(pdfPos(3, 4))).toEqual({ page: 3, frac: 1 });
    expect(parsePdfPos("epubcfi(/6/4!/4)")).toBe(null);
  });
});

describe("nestByDepth", () => {
  it("rebuilds a TOC tree that flattens back to the same list", () => {
    const list = [
      { label: "A", href: "p1", depth: 0 },
      { label: "A.1", href: "p2", depth: 1 },
      { label: "A.1.a", href: "p3", depth: 2 },
      { label: "B", href: "p4", depth: 0 },
    ];
    expect(flatten(nestByDepth(list))).toEqual(list);
  });
});

describe("pdf metadata", () => {
  it("falls back to the file name for an artefact title", () => {
    expect(pdfTitle("Microsoft Word - report.docx", "Annual Report.pdf")).toBe("Annual Report");
    expect(pdfTitle("untitled", "notes.pdf")).toBe("notes");
    expect(pdfTitle("C:\\Users\\me\\draft.indd", "Playbook.pdf")).toBe("Playbook");
    expect(pdfTitle("", "x.PDF")).toBe("x");
    expect(pdfTitle("The Orchard Letters", "orchard.pdf")).toBe("The Orchard Letters");
  });
  it("reads PDF dates and keywords", () => {
    expect(pdfDate("D:20260923170823+02'00'")).toBe("2026-09-23");
    expect(pdfDate("D:2019")).toBe("2019");
    expect(pdfDate("garbage")).toBe("");
    expect(pdfSubjects("AI, SDLC; playbook")).toEqual(["AI", "SDLC", "playbook"]);
  });
});

describe("chapters from page titles", () => {
  const line = (text, size, y) => ({ text, size, y });
  it("tells useful bookmarks from leftovers", () => {
    const junk = [
      { title: "Playbook_designv2-cover", page: 1 },
      { title: "Playbook_designv2", page: 2 },
    ];
    expect(usefulOutline(junk, 54)).toBe(false);
    expect(usefulOutline(junk, 8)).toBe(true);
    expect(
      usefulOutline(
        [
          { title: "A", page: 1 },
          { title: "B", page: 9 },
          { title: "C", page: 20 },
        ],
        54
      )
    ).toBe(true);
    expect(usefulOutline([], 5)).toBe(false);
  });
  it("gathers text items into lines, top first", () => {
    const items = [
      { str: "world", x: 60, y: 700, size: 12 },
      { str: "Hello", x: 10, y: 700.5, size: 12 },
      { str: "Title", x: 10, y: 750, size: 30 },
      { str: " ", x: 0, y: 650, size: 12 },
    ];
    expect(pageLines(items)).toEqual([
      { y: 750, size: 30, text: "Title" },
      { y: 700, size: 12, text: "Hello world" },
    ]);
  });
  it("opens a chapter at each page with a big title, joining a two-line title", () => {
    const bodyText = (y) => line("Body text that runs on for a good while across the page.", 12, y);
    const pages = [
      { n: 1, lines: [] },
      { n: 2, lines: [line("What's in here", 23, 700), bodyText(600), bodyText(580)] },
      { n: 3, lines: [bodyText(700), bodyText(680)] },
      { n: 4, lines: [line("01", 112, 500)] },
      {
        n: 5,
        lines: [
          line("STAGE 1 · PLAN", 8, 760),
          line("Claude Code plan mode as", 23, 700),
          line("the default starting point", 23, 672),
          bodyText(600),
        ],
      },
      { n: 6, lines: [line("Claude Code on auto mode", 19, 700), bodyText(600), line("Claude", 19, 400)] },
    ];
    expect(headingOutline(pages)).toEqual([
      { title: "What's in here", page: 2, depth: 0 },
      { title: "Claude Code plan mode as the default starting point", page: 4, depth: 0 },
      { title: "Claude Code on auto mode", page: 6, depth: 0 },
    ]);
  });
  it("finds nothing in a document of plain text", () => {
    expect(headingOutline([{ n: 1, lines: [line("Just text here, all the same size.", 12, 700)] }])).toEqual(
      []
    );
  });
});
