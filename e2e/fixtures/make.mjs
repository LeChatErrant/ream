// Builds the books the end-to-end tests import: small, deterministic EPUBs and
// PDFs covering the shapes real files come in (EPUB 3 nav, EPUB 2 NCX only, no
// TOC at all, a cover image, embedded <script>) plus deliberately broken files
// (zero bytes, random bytes, a zip that isn't an EPUB). Written to
// e2e/.fixtures/ (gitignored) by the Playwright global setup, so nothing binary
// is committed and every run starts from the same files.
import JSZip from "jszip";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const xhtml = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${title}</title></head>
<body>${body}</body>
</html>`;

// Enough paragraphs that a chapter scrolls well past one phone screen.
export const para = (ch, i) =>
  `Chapter ${ch}, paragraph ${i}. The lamplighter walked the long street at dusk, counting the windows that ` +
  `glowed and the ones that stayed dark, and wondering which of them would still be lit by morning.`;
const chapterBody = (ch, title, n = 40) =>
  `<h1>${title}</h1>\n` + Array.from({ length: n }, (_, i) => `<p>${para(ch, i + 1)}</p>`).join("\n");

/**
 * An EPUB as a Buffer. `chapters`: [{ title, body? }]. `toc`: "nav" (EPUB 3),
 * "ncx" (EPUB 2 only), "none" (no navigation document at all).
 */
export async function makeEpub({
  title = "Test Book",
  author = "Ada Tester",
  chapters = [{ title: "Chapter 1" }, { title: "Chapter 2" }, { title: "Chapter 3" }],
  toc = "nav",
  cover = false,
  description = "",
  language = "en",
  extraHead = "",
} = {}) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  );
  const items = [];
  const spine = [];
  chapters.forEach((c, i) => {
    const id = `ch${i + 1}`;
    const href = `${id}.xhtml`;
    zip.file(
      `OEBPS/${href}`,
      xhtml(c.title, c.body ?? chapterBody(i + 1, c.title)).replace("</head>", `${extraHead}</head>`)
    );
    items.push(
      `<item id="${id}" href="${href}" media-type="application/xhtml+xml"${c.scripted ? ' properties="scripted"' : ""}/>`
    );
    spine.push(`<itemref idref="${id}"/>`);
  });
  if (toc === "nav") {
    const lis = chapters.map((c, i) => `<li><a href="ch${i + 1}.xhtml">${c.title}</a></li>`).join("");
    zip.file(
      "OEBPS/nav.xhtml",
      xhtml("Contents", `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${lis}</ol></nav>`)
    );
    items.push(`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);
  }
  if (toc === "ncx") {
    const points = chapters
      .map(
        (c, i) =>
          `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${c.title}</text></navLabel><content src="ch${i + 1}.xhtml"/></navPoint>`
      )
      .join("");
    zip.file(
      "OEBPS/toc.ncx",
      `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:test"/></head>
<docTitle><text>${title}</text></docTitle>
<navMap>${points}</navMap>
</ncx>`
    );
    items.push(`<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
  }
  if (cover) {
    zip.file("OEBPS/cover.png", png(120, 180, [180, 90, 60]));
    items.push(`<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>`);
  }
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${toc === "ncx" ? "2.0" : "3.0"}" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${title.replace(/\W+/g, "-")}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>${language}</dc:language>
    ${description ? `<dc:description>${description}</dc:description>` : ""}
    ${cover ? '<meta name="cover" content="cover"/>' : ""}
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>${items.join("")}</manifest>
  <spine${toc === "ncx" ? ' toc="ncx"' : ""}>${spine.join("")}</spine>
</package>`
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", mimeType: "application/epub+zip" });
}

// A solid-colour PNG (for covers).
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A text PDF with one page per entry of `pages` and, when `outline` is set, a
 * bookmark per page (so it imports with chapters). Hand-assembled with a
 * correct xref table — no PDF library needed.
 */
export function makePdf({
  title = "Test PDF",
  pages = ["Page one", "Page two", "Page three"],
  outline = true,
} = {}) {
  const objs = []; // index = object number - 1
  const add = (s) => objs.push(s) && objs.length;
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds = pages.map((text) => {
    const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`
    );
  });
  objs[pagesObj - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let outlines = null;
  if (outline) {
    outlines = add(null);
    const items = pages.map(() => add(null));
    items.forEach((id, i) => {
      objs[id - 1] =
        `<< /Title (${pages[i]}) /Parent ${outlines} 0 R /Dest [${pageIds[i]} 0 R /Fit]` +
        (i > 0 ? ` /Prev ${items[i - 1]} 0 R` : "") +
        (i < items.length - 1 ? ` /Next ${items[i + 1]} 0 R` : "") +
        " >>";
    });
    objs[outlines - 1] =
      `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items.at(-1)} 0 R /Count ${items.length} >>`;
  }
  const info = add(`<< /Title (${title}) /Author (Pat Printer) >>`);
  objs[catalog - 1] =
    `<< /Type /Catalog /Pages ${pagesObj} 0 R${outlines ? ` /Outlines ${outlines} 0 R` : ""} >>`;

  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

export const FIXTURES_DIR = new URL("../.fixtures/", import.meta.url).pathname;
export const fixture = (name) => join(FIXTURES_DIR, name);

export async function writeFixtures() {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const w = (name, data) => writeFileSync(join(FIXTURES_DIR, name), data);

  w(
    "basic.epub",
    await makeEpub({ title: "The Lamplighter", cover: true, description: "A quiet test book." })
  );
  // Opens the Soul Sea button (it shows for Shadow Slave only).
  w("shadow-slave.epub", await makeEpub({ title: "Shadow Slave", author: "Test Author" }));
  w("ncx-only.epub", await makeEpub({ title: "Old Format", toc: "ncx" }));
  w("no-toc.epub", await makeEpub({ title: "No Contents", toc: "none" }));
  w(
    "long.epub",
    await makeEpub({
      title: "Long Road",
      chapters: Array.from({ length: 30 }, (_, i) => ({ title: `Chapter ${i + 1}` })),
    })
  );
  w("vol1.epub", await makeEpub({ title: "Ember Saga Vol. 1", author: "Sam Series" }));
  w("vol2.epub", await makeEpub({ title: "Ember Saga Vol. 2", author: "Sam Series" }));
  w(
    "scripted.epub",
    await makeEpub({
      title: "Sneaky Script",
      extraHead:
        "<script>try{window.parent.__epubScriptRan=true}catch(e){}window.__epubScriptRan=true</script>",
      chapters: [
        {
          title: "Chapter 1",
          scripted: true,
          body:
            "<h1>Chapter 1</h1><p>Plain text.</p>" +
            '<img src="x" onerror="try{window.parent.__epubScriptRan=true}catch(e){}"/>' +
            "<script>try{window.parent.__epubScriptRan=true}catch(e){}</script>",
        },
        { title: "Chapter 2" },
      ],
    })
  );
  w(
    "unicode.epub",
    await makeEpub({
      title: "Élan &amp; Ünïcode “Quotes”",
      author: "Zoë Ångström",
      chapters: [
        { title: "第一章", body: "<h1>第一章</h1><p>日本語のテキスト。</p><p>עברית מימין לשמאל</p>" },
        { title: "Глава 2" },
      ],
    })
  );
  w("text.pdf", makePdf({ title: "Printed Matter", pages: ["Opening", "Middle", "Closing"] }));

  // Broken inputs: none of these may hang or wedge the app.
  w("empty.epub", Buffer.alloc(0));
  w("garbage.epub", Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)));
  const notEpub = new JSZip();
  notEpub.file("hello.txt", "just a zip");
  w("not-an-epub.epub", await notEpub.generateAsync({ type: "nodebuffer" }));
  const badOpf = new JSZip();
  badOpf.file("mimetype", "application/epub+zip");
  badOpf.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>'
  );
  badOpf.file("content.opf", "<package><this is not xml");
  w("bad-opf.epub", await badOpf.generateAsync({ type: "nodebuffer" }));
  w("broken.pdf", Buffer.from("%PDF-1.4\nthis is not really a pdf\n%%EOF"));
  w("notes.txt", Buffer.from("not a book"));
}
