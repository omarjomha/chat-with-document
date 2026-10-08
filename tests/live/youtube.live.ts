import { describe, expect, it } from "vitest";

import { normalizeExtractedText } from "@/lib/ingest/normalize";
import { fetchYouTubeTranscript, YouTubeIngestError } from "@/lib/ingest/youtube";
import { parseYouTubeVideoId } from "@/lib/ingest/youtubeUrl";

/**
 * Live verification of YouTube transcript extraction.
 *
 * Not part of `npm test`: it needs the network and YouTube rate limits by IP.
 * Run it deliberately with `npm run verify:youtube`, optionally against your
 * own video:
 *
 *     npm run verify:youtube
 *     YOUTUBE_VERIFY_URL="https://youtu.be/<id>" npm run verify:youtube
 *
 * This exercises the same `fetchYouTubeTranscript` the app calls, so a pass
 * here is evidence about the shipped code rather than about a reimplementation.
 *
 * If it reports `blocked`, that is YouTube refusing this network rather than a
 * defect -- see the YouTube section of the README. Retry from a different
 * connection; a phone hotspot is usually enough.
 */

interface Expectation {
  url: string;
  /** A phrase that must appear in the transcript, to prove real content. */
  contains: string;
  /** Substring of the expected title. */
  title: string;
}

const DEFAULT_CASES: Expectation[] = [
  {
    url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    title: "Me at the zoo",
    contains: "elephants",
  },
  {
    url: "https://www.youtube.com/watch?v=aircAruvnKk",
    title: "neural network",
    contains: "neural",
  },
];

const override = process.env.YOUTUBE_VERIFY_URL;
const CASES: Expectation[] = override
  ? [{ url: override, title: "", contains: "" }]
  : DEFAULT_CASES;

function report(label: string, detail: string): void {
  console.info(`  ${label.padEnd(14)} ${detail}`);
}

describe("live YouTube transcript extraction", () => {
  for (const expectation of CASES) {
    it(`extracts a transcript from ${expectation.url}`, async () => {
      const videoId = parseYouTubeVideoId(expectation.url);
      expect(videoId, `${expectation.url} is not a YouTube link`).toBeTruthy();

      let transcript;
      try {
        transcript = await fetchYouTubeTranscript(videoId!);
      } catch (error) {
        if (error instanceof YouTubeIngestError) {
          console.error(`\n  FAILED (${error.code}): ${error.message}`);
          if (error.code === "blocked") {
            console.error(
              "  This is YouTube refusing this network, not a defect in the code.\n" +
                "  Retry from another connection, such as a phone hotspot.",
            );
          }
        }
        throw error;
      }

      const normalized = normalizeExtractedText(transcript.text);

      report("title", transcript.title);
      report(
        "chars",
        `${normalized.usedChars.toLocaleString("en-US")} (raw ${transcript.text.length.toLocaleString("en-US")})`,
      );
      report("approx tokens", `~${normalized.approxTokens.toLocaleString("en-US")}`);
      report("truncated", String(normalized.truncated));
      report("first line", normalized.text.split("\n")[0]?.slice(0, 70) ?? "");

      // Real content, not an empty or placeholder document.
      expect(transcript.text.length).toBeGreaterThan(50);
      expect(transcript.title.length).toBeGreaterThan(0);

      // No markup may survive into the text handed to the model. This is the
      // assertion that would fail if YouTube ever served a page instead of
      // captions and the content guard regressed.
      expect(transcript.text).not.toMatch(/<[a-z/!]/i);
      expect(transcript.text).not.toMatch(/&(amp|lt|gt|quot|#\d+);/);
      expect(transcript.text.toLowerCase()).not.toContain("automated queries");

      if (expectation.title) {
        expect(transcript.title.toLowerCase()).toContain(expectation.title.toLowerCase());
      }
      if (expectation.contains) {
        expect(normalized.text.toLowerCase()).toContain(expectation.contains.toLowerCase());
      }
    });
  }
});
