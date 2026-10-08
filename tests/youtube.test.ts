// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchYouTubeTranscript,
  joinCaptionLines,
  selectCaptionTrack,
  toYouTubeIngestError,
  YouTubeIngestError,
} from "@/lib/ingest/youtube";
import { resetServerEnvCache } from "@/lib/env";

const CAPTION_URL = "https://www.youtube.com/api/timedtext?v=abc&lang=en";

const CAPTION_XML = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">
<body><p t="0" d="100">first line</p><p t="100" d="100">second line</p></body>
</timedtext>`;

/** Builds a minimal Android player response. */
function playerBody(
  overrides: {
    status?: string;
    reason?: string;
    title?: string;
    tracks?: { baseUrl?: string; languageCode?: string; kind?: string }[];
  } = {},
) {
  return {
    playabilityStatus: { status: overrides.status ?? "OK", reason: overrides.reason },
    videoDetails: { title: overrides.title ?? "A talk" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: overrides.tracks ?? [{ baseUrl: CAPTION_URL, languageCode: "en" }],
      },
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/xml" } });
}

describe("joinCaptionLines", () => {
  it("joins caption cards one per line", () => {
    expect(joinCaptionLines(["hello there", "general kenobi"])).toBe("hello there\ngeneral kenobi");
  });

  it("drops blank and whitespace-only cards", () => {
    expect(joinCaptionLines(["one", "", "   ", "two"])).toBe("one\ntwo");
  });

  it("collapses the repeats that rolling auto-captions produce", () => {
    expect(joinCaptionLines(["a line", "a line", "a line", "next"])).toBe("a line\nnext");
  });

  it("keeps a repeat that is genuinely said again later", () => {
    expect(joinCaptionLines(["yes", "no", "yes"])).toBe("yes\nno\nyes");
  });

  it("returns an empty string for an empty transcript", () => {
    expect(joinCaptionLines([])).toBe("");
  });
});

describe("selectCaptionTrack", () => {
  const written = { baseUrl: "w", languageCode: "en" };
  const auto = { baseUrl: "a", languageCode: "en", kind: "asr" };
  const frenchWritten = { baseUrl: "fr", languageCode: "fr" };
  const frenchAuto = { baseUrl: "fra", languageCode: "fr", kind: "asr" };

  it("prefers a written English track over every alternative", () => {
    expect(selectCaptionTrack([frenchAuto, auto, frenchWritten, written])).toBe(written);
  });

  it("falls back to auto-generated English before another language", () => {
    expect(selectCaptionTrack([frenchWritten, auto])).toBe(auto);
  });

  it("prefers a written track when no English exists", () => {
    expect(selectCaptionTrack([frenchAuto, frenchWritten])).toBe(frenchWritten);
  });

  it("takes whatever is left rather than nothing", () => {
    expect(selectCaptionTrack([frenchAuto])).toBe(frenchAuto);
  });

  it("treats en-GB and en-US as English", () => {
    const gb = { baseUrl: "gb", languageCode: "en-GB" };
    expect(selectCaptionTrack([frenchWritten, gb])).toBe(gb);
  });

  it("ignores tracks with no URL to fetch", () => {
    expect(selectCaptionTrack([{ languageCode: "en" }, frenchAuto])).toBe(frenchAuto);
  });

  it("returns undefined when there are no tracks", () => {
    expect(selectCaptionTrack([])).toBeUndefined();
  });
});

describe("toYouTubeIngestError", () => {
  it("passes an already-classified error straight through", () => {
    const original = new YouTubeIngestError("empty", "nothing here");
    expect(toYouTubeIngestError(original)).toBe(original);
  });

  it.each(["fetch failed", "connect ETIMEDOUT 142.250.0.1:443", "socket hang up ECONNRESET"])(
    "treats the network failure %j as a block",
    (message) => {
      expect(toYouTubeIngestError(new Error(message)).code).toBe("blocked");
    },
  );

  it("falls back to unknown and logs anything it cannot place", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(toYouTubeIngestError(new Error("totally novel failure")).code).toBe("unknown");
    expect(logged).toHaveBeenCalled();
  });

  it("handles a thrown non-Error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(toYouTubeIngestError("just a string").code).toBe("unknown");
  });
});

describe("fetchYouTubeTranscript", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENAI_API_KEY = "sk-test";
    delete process.env.YOUTUBE_PROXY_URL;
    resetServerEnvCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetServerEnvCache();
  });

  async function expectCode(code: string): Promise<YouTubeIngestError> {
    const error = await fetchYouTubeTranscript("abcdefghijk").catch((caught) => caught);
    expect(error).toBeInstanceOf(YouTubeIngestError);
    expect((error as YouTubeIngestError).code).toBe(code);
    return error as YouTubeIngestError;
  }

  it("returns the title and joined transcript", async () => {
    fetchMock.mockResolvedValueOnce(json(playerBody({ title: "Neural networks" })));
    fetchMock.mockResolvedValueOnce(xml(CAPTION_XML));

    await expect(fetchYouTubeTranscript("abcdefghijk")).resolves.toEqual({
      title: "Neural networks",
      text: "first line\nsecond line",
    });
  });

  it("asks the Android client, which is what yields ungated caption URLs", async () => {
    fetchMock.mockResolvedValueOnce(json(playerBody()));
    fetchMock.mockResolvedValueOnce(xml(CAPTION_XML));

    await fetchYouTubeTranscript("abcdefghijk");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/youtubei/v1/player");
    expect(JSON.parse(init.body as string)).toMatchObject({
      context: { client: { clientName: "ANDROID" } },
      videoId: "abcdefghijk",
    });
  });

  it("falls back to a video id for a response with no title", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ playabilityStatus: { status: "OK" }, captions: playerBody().captions }),
    );
    fetchMock.mockResolvedValueOnce(xml(CAPTION_XML));

    const result = await fetchYouTubeTranscript("abcdefghijk");
    expect(result.title).toBe("YouTube video abcdefghijk");
  });

  it.each([
    ["ERROR", "not-found"],
    ["LOGIN_REQUIRED", "unavailable"],
    ["AGE_VERIFICATION_REQUIRED", "unavailable"],
    ["CONTENT_CHECK_REQUIRED", "unavailable"],
    ["UNPLAYABLE", "unavailable"],
    ["SOMETHING_NEW", "unavailable"],
  ])("maps playability status %s to %s", async (status, code) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json(playerBody({ status })));

    const error = await expectCode(code);
    expect(error.message).not.toBe("");
  });

  /**
   * LOGIN_REQUIRED is overloaded: a restricted video, or YouTube bot-checking
   * the server's IP. Observed on Vercel for an ordinary public video, so the
   * two must not share a message.
   */
  it.each([
    "Sign in to confirm you're not a bot",
    "Sign in to confirm you are not a bot",
    "This helps protect our community. Learn more. Unusual traffic detected",
    "Automated requests detected",
  ])("reads LOGIN_REQUIRED with reason %j as a network block", async (reason) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json(playerBody({ status: "LOGIN_REQUIRED", reason })));

    const error = await expectCode("blocked");
    expect(error.message).toMatch(/this server's network/i);
    expect(error.message).toMatch(/YOUTUBE_PROXY_URL/);
  });

  it.each(["This video is private", "This video is available to members only", undefined])(
    "still reads LOGIN_REQUIRED with reason %j as a restricted video",
    async (reason) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      fetchMock.mockResolvedValueOnce(json(playerBody({ status: "LOGIN_REQUIRED", reason })));

      const error = await expectCode("unavailable");
      expect(error.message).toMatch(/private or age-restricted/i);
    },
  );

  it("logs YouTube's own wording so a refusal can be diagnosed", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      json(playerBody({ status: "LOGIN_REQUIRED", reason: "This video is private" })),
    );

    await expectCode("unavailable");

    expect(warned).toHaveBeenCalledWith(
      expect.stringContaining("LOGIN_REQUIRED This video is private"),
    );
  });

  it("surfaces YouTube's own reason for an unplayable video", async () => {
    fetchMock.mockResolvedValueOnce(
      json(playerBody({ status: "UNPLAYABLE", reason: "Members-only content" })),
    );

    const error = await expectCode("unavailable");
    expect(error.message).toContain("Members-only content");
  });

  it("reports a video with no caption tracks", async () => {
    fetchMock.mockResolvedValueOnce(json(playerBody({ tracks: [] })));
    await expectCode("no-captions");
  });

  it("reports a video whose captions block is missing entirely", async () => {
    fetchMock.mockResolvedValueOnce(json({ playabilityStatus: { status: "OK" } }));
    await expectCode("no-captions");
  });

  it("refuses a caption URL flagged as needing a Proof-of-Origin token", async () => {
    fetchMock.mockResolvedValueOnce(
      json(playerBody({ tracks: [{ baseUrl: `${CAPTION_URL}&exp=xpe`, languageCode: "en" }] })),
    );

    const error = await expectCode("blocked");
    expect(error.message).toMatch(/verified browser session/i);
    // The caption URL must not be fetched once we know it is gated.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports an empty caption body as empty, not as a transcript", async () => {
    fetchMock.mockResolvedValueOnce(json(playerBody()));
    fetchMock.mockResolvedValueOnce(xml(""));

    await expectCode("empty");
  });

  it.each([
    ["the player call", 0],
    ["the caption call", 1],
  ])("maps a 429 on %s to a rate-limit message", async (_label, failAt) => {
    if (failAt === 0) {
      fetchMock.mockResolvedValueOnce(json({}, 429));
    } else {
      fetchMock.mockResolvedValueOnce(json(playerBody()));
      fetchMock.mockResolvedValueOnce(xml("", 429));
    }

    const error = await expectCode("blocked");
    // Deliberately not "try again in a few minutes": this block is an
    // automated-queries flag against the whole IP and lasts hours.
    expect(error.message).toMatch(/blocked this server's network/i);
    expect(error.message).toMatch(/few hours/i);
  });

  it("retries with a scraped key when the constant one is rejected", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 400));
    fetchMock.mockResolvedValueOnce(
      new Response('window.ytcfg={"INNERTUBE_API_KEY": "FRESH_KEY_123"}'),
    );
    fetchMock.mockResolvedValueOnce(json(playerBody()));
    fetchMock.mockResolvedValueOnce(xml(CAPTION_XML));

    await expect(fetchYouTubeTranscript("abcdefghijk")).resolves.toMatchObject({
      text: "first line\nsecond line",
    });

    expect(String(fetchMock.mock.calls[1][0])).toContain("/watch?v=abcdefghijk");
    expect(String(fetchMock.mock.calls[2][0])).toContain("key=FRESH_KEY_123");
  });

  it("gives up when the watch page yields no key either", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 403));
    fetchMock.mockResolvedValueOnce(new Response("<html>no key here</html>"));

    vi.spyOn(console, "error").mockImplementation(() => {});
    await expectCode("unknown");
  });

  it("reports a blocked watch page during key recovery", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 403));
    fetchMock.mockResolvedValueOnce(new Response("denied", { status: 429 }));

    await expectCode("blocked");
  });

  it("routes every request through YOUTUBE_PROXY_URL when one is set", async () => {
    process.env.YOUTUBE_PROXY_URL = "https://proxy.test/?url=";
    resetServerEnvCache();

    fetchMock.mockResolvedValueOnce(json(playerBody()));
    fetchMock.mockResolvedValueOnce(xml(CAPTION_XML));

    await fetchYouTubeTranscript("abcdefghijk");

    for (const [url] of fetchMock.mock.calls) {
      expect(String(url).startsWith("https://proxy.test/?url=")).toBe(true);
    }
    // The real target must survive, percent-encoded, as the proxy's argument.
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      encodeURIComponent("https://www.youtube.com/youtubei/v1/player"),
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain(encodeURIComponent(CAPTION_URL));
  });

  it("turns a network failure into a blocked error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch failed"));
    await expectCode("blocked");
  });
});
