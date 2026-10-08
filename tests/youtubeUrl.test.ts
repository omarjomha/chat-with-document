import { describe, expect, it } from "vitest";

import { parseYouTubeVideoId, watchUrl } from "@/lib/ingest/youtubeUrl";

const ID = "dQw4w9WgXcQ";

describe("parseYouTubeVideoId", () => {
  it.each([
    ["canonical watch", `https://www.youtube.com/watch?v=${ID}`],
    ["no www", `https://youtube.com/watch?v=${ID}`],
    ["http", `http://www.youtube.com/watch?v=${ID}`],
    ["no scheme", `youtube.com/watch?v=${ID}`],
    ["mobile", `https://m.youtube.com/watch?v=${ID}`],
    ["music", `https://music.youtube.com/watch?v=${ID}`],
    ["short link", `https://youtu.be/${ID}`],
    ["shorts", `https://www.youtube.com/shorts/${ID}`],
    ["embed", `https://www.youtube.com/embed/${ID}`],
    ["nocookie embed", `https://www.youtube-nocookie.com/embed/${ID}`],
    ["live", `https://www.youtube.com/live/${ID}`],
    ["legacy /v/", `https://www.youtube.com/v/${ID}`],
  ])("parses a %s URL", (_label, url) => {
    expect(parseYouTubeVideoId(url)).toBe(ID);
  });

  it.each([
    ["a playlist and index", `https://www.youtube.com/watch?v=${ID}&list=PL123&index=4`],
    ["a timestamp before the id", `https://www.youtube.com/watch?t=30&v=${ID}`],
    ["tracking parameters", `https://youtu.be/${ID}?si=abc123&t=42`],
    ["a shorts timestamp", `https://www.youtube.com/shorts/${ID}?feature=share`],
  ])("ignores %s", (_label, url) => {
    expect(parseYouTubeVideoId(url)).toBe(ID);
  });

  it("tolerates surrounding whitespace from a paste", () => {
    expect(parseYouTubeVideoId(`  https://youtu.be/${ID}\n`)).toBe(ID);
  });

  it("keeps a trailing slash from breaking the path split", () => {
    expect(parseYouTubeVideoId(`https://www.youtube.com/shorts/${ID}/`)).toBe(ID);
  });

  it.each([
    ["empty input", ""],
    ["whitespace only", "   "],
    ["not a URL at all", "what is this"],
    ["a bare video id", ID],
    ["another video site", `https://vimeo.com/watch?v=${ID}`],
    ["a lookalike host", `https://youtube.com.evil.test/watch?v=${ID}`],
    ["a YouTube channel", "https://www.youtube.com/@someone"],
    ["a watch URL with no id", "https://www.youtube.com/watch"],
    ["a watch URL with a short id", "https://www.youtube.com/watch?v=tooshort"],
    ["a watch URL with an overlong id", `https://www.youtube.com/watch?v=${ID}XYZ`],
    ["an id with illegal characters", "https://www.youtube.com/watch?v=abc!defghij"],
    ["a short link with a path", `https://youtu.be/embed/${ID}`],
    ["a javascript URL", `javascript:alert(1)//youtube.com/watch?v=${ID}`],
  ])("rejects %s", (_label, input) => {
    expect(parseYouTubeVideoId(input)).toBeNull();
  });
});

describe("watchUrl", () => {
  it("builds a canonical watch link", () => {
    expect(watchUrl(ID)).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });
});
