// @vitest-environment node
import { describe, expect, it } from "vitest";

import { decodeEntities, parseCaptionXml } from "@/lib/ingest/youtubeCaptions";

/** A human-written track: plain text in each paragraph. */
const WRITTEN = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">
<body>
<p t="4220" d="1180">This is a 3.</p>
<p t="6060" d="4653">It&#39;s sloppily written &amp; rendered.</p>
</body>
</timedtext>`;

/**
 * An auto-generated track, copied in shape from a real response: per-word `<s>`
 * elements and empty `a="1"` paragraphs for the rolling on-screen effect.
 */
const AUTO = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">
<head><ws id="0"/><wp id="0"/></head>
<body>
<w t="0" id="1" wp="1" ws="1"/>
<p t="0" d="2510" w="1">[Music]</p>
<p t="4390" w="1" a="1">
</p>
<p t="4400" d="4159" w="1"><s ac="0">This</s><s t="399" ac="0"> is</s><s t="560" ac="0"> a</s><s t="800" ac="0"> three.</s></p>
<p t="6869" d="1690" w="1" a="1">
</p>
<p t="6879" d="4561" w="1"><s ac="0">and</s><s t="241" ac="0"> rendered</s><s t="561" ac="0"> at</s></p>
</body>
</timedtext>`;

describe("decodeEntities", () => {
  it.each([
    ["It&#39;s", "It's"],
    ["a &amp; b", "a & b"],
    ["&lt;tag&gt;", "<tag>"],
    ["&quot;quoted&quot;", '"quoted"'],
    ["&apos;", "'"],
    ["&#x27;", "'"],
    ["&#x1F600;", "\u{1F600}"],
  ])("decodes %s", (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });

  it("is case-insensitive for named entities", () => {
    expect(decodeEntities("&AMP;")).toBe("&");
  });

  it("leaves an unknown entity alone rather than dropping it", () => {
    expect(decodeEntities("&notareal;")).toBe("&notareal;");
  });

  it("leaves an out-of-range code point alone", () => {
    expect(decodeEntities("&#x110000;")).toBe("&#x110000;");
  });

  it("passes plain text through untouched", () => {
    expect(decodeEntities("nothing to do here")).toBe("nothing to do here");
  });
});

describe("parseCaptionXml", () => {
  it("reads a human-written track", () => {
    expect(parseCaptionXml(WRITTEN)).toEqual(["This is a 3.", "It's sloppily written & rendered."]);
  });

  it("reassembles per-word segments from an auto-generated track", () => {
    // Each <s> carries its own leading space, so concatenation must not add one.
    expect(parseCaptionXml(AUTO)).toEqual(["[Music]", "This is a three.", "and rendered at"]);
  });

  it("drops the empty rollup placeholders", () => {
    expect(parseCaptionXml(AUTO)).not.toContain("");
  });

  it("ignores the head and the stray <w> element", () => {
    const lines = parseCaptionXml(AUTO);
    expect(lines.some((line) => line.includes("ws") || line.includes("wp"))).toBe(false);
  });

  it("collapses newlines inside a paragraph into single spaces", () => {
    const xml = `<body><p t="0">line one\n   line two</p></body>`;
    expect(parseCaptionXml(xml)).toEqual(["line one line two"]);
  });

  it("returns nothing for a track with no paragraphs", () => {
    expect(
      parseCaptionXml(`<?xml version="1.0"?><timedtext format="3"><body></body></timedtext>`),
    ).toEqual([]);
  });

  it("returns nothing for an empty body, which is how YouTube refuses", () => {
    expect(parseCaptionXml("")).toEqual([]);
  });

  it("decodes entities that span the whole paragraph", () => {
    expect(parseCaptionXml(`<body><p>&amp;&amp;</p></body>`)).toEqual(["&&"]);
  });
});
