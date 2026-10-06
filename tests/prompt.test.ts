import { describe, expect, it } from "vitest";

import { buildInstructions, type DocumentContext } from "@/lib/prompt";

const baseContext: DocumentContext = {
  title: "Quarterly Report",
  kind: "pdf",
  text: "Revenue grew 12% year over year.",
  truncated: false,
};

describe("buildInstructions", () => {
  it("tells the model no document is loaded when context is absent", () => {
    const instructions = buildInstructions();

    expect(instructions).toContain("No document has been loaded");
    expect(instructions).not.toContain("BEGIN");
  });

  it("embeds the document text between explicit delimiters", () => {
    const instructions = buildInstructions(baseContext);

    expect(instructions).toContain("--- BEGIN DOCUMENT ---");
    expect(instructions).toContain("Revenue grew 12% year over year.");
    expect(instructions).toContain("--- END DOCUMENT ---");
  });

  it("includes the title so the model can refer to the source", () => {
    expect(buildInstructions(baseContext)).toContain("Quarterly Report");
  });

  it("calls a YouTube source a video transcript rather than a document", () => {
    const instructions = buildInstructions({ ...baseContext, kind: "youtube" });

    expect(instructions).toContain("video transcript");
    expect(instructions).toContain("--- BEGIN VIDEO TRANSCRIPT ---");
  });

  it("warns the model when the text was truncated", () => {
    const instructions = buildInstructions({ ...baseContext, truncated: true });

    expect(instructions).toContain("truncated");
  });

  it("omits the truncation warning when the full text fits", () => {
    expect(buildInstructions(baseContext)).not.toContain("was truncated");
  });

  it("instructs the model not to invent answers", () => {
    expect(buildInstructions(baseContext)).toMatch(/not in the text/i);
  });
});
