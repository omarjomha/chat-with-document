// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  captionUrlFor,
  fetchYouTubeTranscript,
  joinCaptionLines,
  selectCaptionTrack,
  toYouTubeIngestError,
  YouTubeIngestError,
} from "@/lib/ingest/youtube";

const CAPTION_URL = "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=srv3";

const CAPTION_XML = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">
<body><p t="0" d="100">first line</p><p t="100" d="100">second line</p></body>
</timedtext>`;

/** The real body YouTube serves when it has flagged the network. */
const SORRY_PAGE = `<!DOCTYPE html><html><head><title>Sorry...</title></head><body>
<div><h1>We're sorry...</h1><p>... but your computer or network may be sending automated
queries. To protect our users, we can't process your request right now.</p></div>
</body></html>`;

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

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html" } });
}

/** Reads the clientName out of a recorded player request. */
function clientOf(call: unknown[]): string {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string).context.client.clientName;
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

describe("captionUrlFor", () => {
  it("pins fmt=srv3 when the client supplied no format", () => {
    const url = captionUrlFor("https://www.youtube.com/api/timedtext?v=abc&lang=en");
    expect(new URL(url).searchParams.get("fmt")).toBe("srv3");
  });

  it("overrides a different format rather than appending a second one", () => {
    const url = captionUrlFor("https://www.youtube.com/api/timedtext?v=abc&fmt=json3");
    expect(new URL(url).searchParams.getAll("fmt")).toEqual(["srv3"]);
  });

  it("preserves the signature and its signed parameters", () => {
    const signed = "https://www.youtube.com/api/timedtext?v=abc&sparams=ip%2Cexpire&signature=DEAD";
    const url = new URL(captionUrlFor(signed));
    expect(url.searchParams.get("signature")).toBe("DEAD");
    expect(url.searchParams.get("sparams")).toBe("ip,expire");
  });

  it("returns an unparseable URL unchanged instead of throwing", () => {
    expect(captionUrlFor("not a url")).toBe("not a url");
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
    delete process.env.YOUTUBE_PROXY_URL;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it("asks a mobile client, which is what yields ungated caption URLs", async () => {
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

  it("pins fmt=srv3 on the caption request", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        playerBody({
          tracks: [{ baseUrl: "https://yt.test/api/timedtext?v=a", languageCode: "en" }],
        }),
      ),
    );
    fetchMock.mockResolvedValueOnce(xml(CAPTION_XML));

    await fetchYouTubeTranscript("abcdefghijk");

    expect(String(fetchMock.mock.calls[1][0])).toContain("fmt=srv3");
  });

  it("does not ask a second client once the first works", async () => {
    fetchMock.mockResolvedValueOnce(json(playerBody()));
    fetchMock.mockResolvedValueOnce(xml(CAPTION_XML));

    await fetchYouTubeTranscript("abcdefghijk");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the next client when the first is challenged", async () => {
    fetchMock.mockResolvedValueOnce(
      json(playerBody({ status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" })),
    );
    fetchMock.mockResolvedValueOnce(json(playerBody({ title: "Recovered" })));
    fetchMock.mockResolvedValueOnce(xml(CAPTION_XML));

    await expect(fetchYouTubeTranscript("abcdefghijk")).resolves.toMatchObject({
      title: "Recovered",
      text: "first line\nsecond line",
    });

    expect(clientOf(fetchMock.mock.calls[0])).toBe("ANDROID");
    expect(clientOf(fetchMock.mock.calls[1])).toBe("IOS");
  });

  it("falls back when the first client's URL is token-gated", async () => {
    fetchMock.mockResolvedValueOnce(
      json(playerBody({ tracks: [{ baseUrl: `${CAPTION_URL}&exp=xpe`, languageCode: "en" }] })),
    );
    fetchMock.mockResolvedValueOnce(json(playerBody()));
    fetchMock.mockResolvedValueOnce(xml(CAPTION_XML));

    await expect(fetchYouTubeTranscript("abcdefghijk")).resolves.toMatchObject({
      text: "first line\nsecond line",
    });
  });

  it("reports a block when every client is challenged", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(
          playerBody({ status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" }),
        ),
      )
      .mockResolvedValueOnce(
        json(
          playerBody({ status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" }),
        ),
      );

    const error = await expectCode("blocked");
    expect(error.message).toMatch(/this server's network/i);
  });

  it("reports a missing video rather than the other client's bot challenge", async () => {
    // A video that does not exist is true for every client, so it outranks a
    // refusal that only says this request was distrusted.
    fetchMock.mockResolvedValueOnce(json(playerBody({ status: "ERROR" })));
    fetchMock.mockResolvedValueOnce(
      json(playerBody({ status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" })),
    );

    await expectCode("not-found");
  });

  it("reports absent captions rather than the other client's bot challenge", async () => {
    fetchMock.mockResolvedValueOnce(json(playerBody({ tracks: [] })));
    fetchMock.mockResolvedValueOnce(
      json(playerBody({ status: "LOGIN_REQUIRED", reason: "Sign in to confirm you're not a bot" })),
    );

    await expectCode("no-captions");
  });

  /**
   * The regression that matters most. An HTML page contains <p> elements, so
   * without a content check the parser turns Google's block page into a
   * plausible transcript and the model discusses it as if it were the video.
   */
  it("refuses an HTML page served with HTTP 200 instead of parsing it", async () => {
    fetchMock.mockResolvedValueOnce(json(playerBody()));
    fetchMock.mockResolvedValueOnce(html(SORRY_PAGE));

    const error = await expectCode("blocked");
    expect(error.message).toMatch(/returned a page instead of captions/i);
    expect(error.message).not.toMatch(/automated queries/);
  });

  it("refuses any body that is not a caption document", async () => {
    fetchMock.mockResolvedValueOnce(json(playerBody()));
    fetchMock.mockResolvedValueOnce(xml("<html><p>totally not captions</p></html>"));

    await expectCode("blocked");
  });

  it("reads an empty 200 as the gated-URL refusal it is", async () => {
    fetchMock.mockResolvedValueOnce(json(playerBody()));
    fetchMock.mockResolvedValueOnce(xml(""));

    const error = await expectCode("blocked");
    expect(error.message).toMatch(/no caption data/i);
  });

  it("reports a caption document with no cues as empty", async () => {
    fetchMock.mockResolvedValueOnce(json(playerBody()));
    fetchMock.mockResolvedValueOnce(xml(`<timedtext format="3"><body></body></timedtext>`));

    await expectCode("empty");
  });

  it("maps a 429 on the caption call to a rate-limit message", async () => {
    fetchMock.mockResolvedValueOnce(json(playerBody()));
    fetchMock.mockResolvedValueOnce(html(SORRY_PAGE, 429));

    const error = await expectCode("blocked");
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

  it("reuses a recovered key for the fallback client", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 403));
    fetchMock.mockResolvedValueOnce(
      new Response('window.ytcfg={"INNERTUBE_API_KEY": "FRESH_KEY_123"}'),
    );
    fetchMock.mockResolvedValueOnce(json(playerBody({ status: "ERROR" })));
    fetchMock.mockResolvedValueOnce(json(playerBody({ status: "ERROR" })));

    await expectCode("not-found");

    // The iOS attempt must not pay for the watch page a second time.
    expect(String(fetchMock.mock.calls[3][0])).toContain("key=FRESH_KEY_123");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/watch?v="))).toHaveLength(1);
  });

  it("routes every request through YOUTUBE_PROXY_URL when one is set", async () => {
    process.env.YOUTUBE_PROXY_URL = "https://proxy.test/?url=";

    fetchMock.mockResolvedValueOnce(json(playerBody()));
    fetchMock.mockResolvedValueOnce(xml(CAPTION_XML));

    await fetchYouTubeTranscript("abcdefghijk");

    for (const [url] of fetchMock.mock.calls) {
      expect(String(url).startsWith("https://proxy.test/?url=")).toBe(true);
    }
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      encodeURIComponent("https://www.youtube.com/youtubei/v1/player"),
    );
  });

  it("ignores a malformed YOUTUBE_PROXY_URL rather than breaking ingestion", async () => {
    process.env.YOUTUBE_PROXY_URL = "not-a-url";

    fetchMock.mockResolvedValueOnce(json(playerBody()));
    fetchMock.mockResolvedValueOnce(xml(CAPTION_XML));

    await expect(fetchYouTubeTranscript("abcdefghijk")).resolves.toMatchObject({
      text: "first line\nsecond line",
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("youtube.com");
  });

  /**
   * The spec allows YouTube to be demonstrated locally, so a clone with no
   * OpenAI key must still be able to ingest a video. Reading the proxy setting
   * through the full env contract used to make this throw.
   */
  it("works with no OPENAI_API_KEY set at all", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    fetchMock.mockResolvedValueOnce(json(playerBody()));
    fetchMock.mockResolvedValueOnce(xml(CAPTION_XML));

    try {
      await expect(fetchYouTubeTranscript("abcdefghijk")).resolves.toMatchObject({
        text: "first line\nsecond line",
      });
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });

  it("falls back to a video id for a response with no title", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ playabilityStatus: { status: "OK" }, captions: playerBody().captions }),
    );
    fetchMock.mockResolvedValueOnce(xml(CAPTION_XML));

    const result = await fetchYouTubeTranscript("abcdefghijk");
    expect(result.title).toBe("YouTube video abcdefghijk");
  });

  it("surfaces YouTube's own reason for an unplayable video", async () => {
    fetchMock
      .mockResolvedValueOnce(json(playerBody({ status: "UNPLAYABLE", reason: "Members-only" })))
      .mockResolvedValueOnce(json(playerBody({ status: "UNPLAYABLE", reason: "Members-only" })));

    const error = await expectCode("unavailable");
    expect(error.message).toContain("Members-only");
  });

  it.each([
    ["AGE_VERIFICATION_REQUIRED", "unavailable"],
    ["CONTENT_CHECK_REQUIRED", "unavailable"],
    ["SOMETHING_NEW", "unavailable"],
  ])("maps playability status %s to %s", async (status, code) => {
    fetchMock
      .mockResolvedValueOnce(json(playerBody({ status })))
      .mockResolvedValueOnce(json(playerBody({ status })));

    const error = await expectCode(code);
    expect(error.message).not.toBe("");
  });

  it("reads a private video as restricted, not as a network block", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(playerBody({ status: "LOGIN_REQUIRED", reason: "This video is private" })),
      )
      .mockResolvedValueOnce(
        json(playerBody({ status: "LOGIN_REQUIRED", reason: "This video is private" })),
      );

    const error = await expectCode("unavailable");
    expect(error.message).toMatch(/private or age-restricted/i);
  });

  it("turns a network failure into a blocked error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch failed"));
    await expectCode("blocked");
  });
});
