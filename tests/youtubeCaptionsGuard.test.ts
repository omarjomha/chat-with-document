// @vitest-environment node
import { describe, expect, it } from "vitest";

import { looksLikeCaptionXml, parseCaptionXml } from "@/lib/ingest/youtubeCaptions";

/**
 * The real body YouTube serves when it has flagged the network, reproduced from
 * a response captured while developing this.
 */
const SORRY_PAGE = `<!DOCTYPE html><html><head><title>Sorry...</title></head><body>
<div><h1>We're sorry...</h1><p>... but your computer or network may be sending automated
queries. To protect our users, we can't process your request right now.</p></div>
</body></html>`;

/** An interstitial observed when a caption URL is requested on another host. */
const CONSENT_PAGE = `<!DOCTYPE html><html lang="en" dir="ltr"><head>
<meta name="viewport" content="width=device-width"/></head><body></body></html>`;

describe("looksLikeCaptionXml", () => {
  it.each([
    ['<?xml version="1.0"?><timedtext format="3"><body></body></timedtext>', "format 3"],
    ['<transcript><text start="0">hi</text></transcript>', "legacy"],
    ["  \n <timedtext>", "leading whitespace"],
    ["<TIMEDTEXT>", "uppercase"],
    ["< timedtext >", "loose whitespace in the tag"],
  ])("accepts %j (%s)", (body) => {
    expect(looksLikeCaptionXml(body)).toBe(true);
  });

  it.each([
    ["", "an empty body"],
    ["<html><body><p>words</p></body></html>", "HTML with paragraphs"],
    ['{"error":{"code":429}}', "a JSON error"],
    ["<!DOCTYPE html><html><head></head></html>", "a bare HTML document"],
    ["Sorry... plain text refusal", "plain text"],
  ])("rejects %j (%s)", (body) => {
    expect(looksLikeCaptionXml(body)).toBe(false);
  });

  it("rejects Google's block page", () => {
    expect(looksLikeCaptionXml(SORRY_PAGE)).toBe(false);
  });

  it("rejects the consent interstitial", () => {
    expect(looksLikeCaptionXml(CONSENT_PAGE)).toBe(false);
  });

  /**
   * The guard's whole reason for existing, stated as one assertion: the block
   * page really does parse into convincing speech, and this is what stops it
   * reaching the model as a transcript.
   */
  it("is what prevents the measured corruption path", () => {
    expect(parseCaptionXml(SORRY_PAGE).join(" ")).toContain("automated queries");
    expect(looksLikeCaptionXml(SORRY_PAGE)).toBe(false);
  });
});

describe("parseCaptionXml: legacy format", () => {
  const LEGACY = `<?xml version="1.0" encoding="utf-8"?><transcript>
<text start="0" dur="2.5">first legacy line</text>
<text start="2.5" dur="3">and the second</text>
</transcript>`;

  it("reads <text> cues when no <p> cues are present", () => {
    expect(parseCaptionXml(LEGACY)).toEqual(["first legacy line", "and the second"]);
  });

  it("prefers format 3 when a document somehow carries both", () => {
    const both = `<timedtext format="3"><body><p t="0">modern</p></body>
<transcript><text start="0">legacy</text></transcript></timedtext>`;
    expect(parseCaptionXml(both)).toEqual(["modern"]);
  });

  it("returns nothing for a caption document with neither cue type", () => {
    expect(parseCaptionXml('<timedtext format="3"><body></body></timedtext>')).toEqual([]);
  });
});
