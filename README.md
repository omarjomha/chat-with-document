# Talk to a Document

Upload a PDF or paste a YouTube link, then hold a spoken conversation about it. Built on the
OpenAI Realtime API, deployed as a single Next.js app on Vercel.

## Getting started

```bash
cp .env.example .env.local   # then add your OpenAI key
npm install
npm run dev
```

Open http://localhost:3000. Voice needs microphone permission, which browsers only grant over
HTTPS or on `localhost`.

### Environment

| Variable                | Required | Notes                                                                                                                                                |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`        | yes      | Server-side only. `src/lib/env.ts` imports `server-only`, so a client component that reached for it would fail the build rather than leak it.        |
| `OPENAI_REALTIME_MODEL` | no       | Defaults to `gpt-realtime-2.1`.                                                                                                                      |
| `OPENAI_REALTIME_VOICE` | no       | Defaults to `marin`.                                                                                                                                 |
| `BLOB_READ_WRITE_TOKEN` | no       | Injected by Vercel. Without it the session store falls back to memory, which is fine locally and wrong in production — see `src/lib/store/types.ts`. |
| `YOUTUBE_PROXY_URL`     | no       | Egress prefix for YouTube requests, for deployments whose IPs YouTube throttles. The target URL is appended percent-encoded.                         |

No YouTube or Google API key is needed. See below for why.

### Checks

```bash
npm run test        # Vitest
npm run typecheck   # tsc --noEmit
npm run lint
npm run build
```

## How it works

```
browser ──upload──▶ Vercel Blob ──▶ /api/ingest/pdf ──┐
                                                      ├──▶ normalise ──▶ session store
browser ──paste───▶ /api/ingest/youtube ──────────────┘                        │
                                                                               ▼
browser ◀── ephemeral client secret ── /api/realtime/token ◀── instructions + document text
   │
   └── WebRTC (audio + `oai-events` data channel) ──▶ OpenAI Realtime API
```

The browser never holds an API key and never sends the document to OpenAI. The server mints a
short-lived client secret and injects the document as session instructions at mint time, so context
is applied before the browser connects.

PDFs are uploaded straight to Blob storage with a server-signed token because Vercel caps function
request bodies at 4.5 MB and the spec requires 25 MB; the server then fetches and parses the blob,
so extraction stays server-side.

Both sources converge on `createSession`, which normalises, truncates, stores and returns the text.
Nothing downstream of that knows or cares which source it came from.

## YouTube transcripts: how, and what it cost to find

YouTube ingestion works, server-side, with no API key and no browser — but only via one specific
route, and the obvious routes are all dead. Worth recording, because the failure mode is silent.

**The trick: ask the Android client.** YouTube gates the _web_ client's caption URLs behind a
Proof-of-Origin token minted by its BotGuard attestation runtime, and marks a gated URL with
`exp=xpe`. Fetching one returns **HTTP 200 with a zero-length body** — a refusal dressed as a
success, which is what makes this expensive to diagnose. The Android InnerTube client
(`clientName: "ANDROID"`) is served caption URLs _without_ that flag, and those fetch normally.

So the whole path is three plain `fetch` calls, in `src/lib/ingest/youtube.ts`:

1. `POST /youtubei/v1/player` with the Android client context → the caption tracklist.
2. Pick a track (human-written over auto-generated, English first).
3. `GET` the track's `baseUrl` → `timedtext format="3"` XML → parse to lines.

### What did not work

Recorded so nobody re-walks it. All measured 2026-10-07 from a residential connection:

| Attempt                                                                            | Result                                                      |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `youtubei.js` `get_transcript`                                                     | `400 FAILED_PRECONDITION`, every video, every client type   |
| Web-client caption URLs                                                            | `200`, empty body                                           |
| Minting a PO token in **jsdom**                                                    | BotGuard rejects the runtime (`APF:Failed`)                 |
| Minting a PO token in **real Chrome**                                              | Succeeds — 796-char token — and still returns an empty body |
| Caption URL + token × `{fmt=json3, c=WEB, potc=1}` × visitor-bound and video-bound | `200`, empty, all six                                       |
| **YouTube's own player** in headless _and_ headful Chrome                          | Empty body, zero captions rendered                          |

The dead end was assuming the PO token was the gate. It is a gate on the web client's URLs, but
minting a valid one does not open them — and the Android client never needed one. The `exp=xpe`
check in `youtube-transcript-api` was the clue that reframed it.

`src/lib/ingest/youtube.ts` still checks for `exp=xpe` and reports it as `blocked` with a clear
message, so if YouTube ever extends the requirement to the Android client the app says so instead
of returning an empty transcript.

### Trade-offs taken here

- **Unofficial endpoint, deliberately.** There is no official way to read captions for a video you
  do not own — the YouTube Data API only serves the authenticated owner's videos. The Android client
  version is pinned in one named constant and is the first thing to bump if it breaks.
- **No dependency.** This replaced `youtubei.js` (4 packages, needed `serverExternalPackages`) with
  about 100 lines of `fetch` and a regex parser. Fewer moving parts, and full control of the error
  messages.
- **The InnerTube key is a constant, with a recovery path.** The public web key has been stable for
  years, so paying for a ~1 MB watch-page fetch on every ingest to scrape it would be wasteful. If
  the key is ever rejected, the code scrapes a fresh one from the watch page and retries once.
- **IP blocking is the real operational risk, and it is worse than the spec suggests.** The spec
  warns that YouTube blocks cloud provider IPs. It blocks residential ones too: a few dozen requests
  while developing this drew Google's "your computer or network may be sending automated queries"
  page on a home connection, as an HTTP `429`, and it outlasted a 12-minute poll and was still in
  force hours later. It is a network-level block, not a per-minute rate limit, and the error message
  says so rather than suggesting a quick retry. `YOUTUBE_PROXY_URL` is the workaround, and on a
  deployment with shared egress IPs it should be considered necessary rather than optional.

### The deployed path: attempted, and it fails differently

The spec treats deployed YouTube ingestion as a bonus. It was attempted and it does not work, but it
is worth recording _how_ it fails, because it is not the same failure as a throttled local machine.

On a Vercel preview, the player call succeeds and returns `LOGIN_REQUIRED` with a
sign-in-to-confirm-you-are-not-a-bot reason -- for "Me at the zoo", a video that is neither private
nor age-gated. YouTube is challenging the datacentre IP, not describing the video. Locally the same
code instead draws a `429` on the caption fetch once the IP is flagged. Two different defences, same
root cause: YouTube does not want anonymous servers reading captions.

This is why `LOGIN_REQUIRED` is not reported as "this video is private" (see
`fromPlayabilityStatus`): on a cloud deployment that message would send you hunting a problem with
the video that does not exist. The bot challenge reports as `blocked` and names the actual fix.

`YOUTUBE_PROXY_URL` is that fix -- pointing the InnerTube calls at a non-datacentre egress. It is
wired and ready; it is unset here because it needs a proxy to point at.

### Transcript caching

Every avoided request to YouTube is a real reduction in block risk, and repeat requests for the same
video are the easy ones to avoid -- a reviewer testing the same link twice, a reload, two people
trying the example video. So a successful fetch is cached by video id in
`src/lib/ingest/transcriptCache.ts`, mirroring the session store: in-memory locally, Vercel Blob
where credentials exist.

Three decisions worth stating:

- **Only successes are cached.** Caching a block would turn a transient outage into a week-long one.
- **The TTL is a week**, far longer than a session's two hours. Captions for a published video do not
  change, and a cached transcript is public content rather than the user's own upload, so it carries
  none of the privacy weight that keeps sessions short-lived.
- **Neither cache failure can fail an ingest.** A read that throws falls through to a live fetch; a
  write that throws has already served the user. The cache is an optimisation, never a dependency.

Lapsed entries are swept by the daily cron alongside sessions. Unlike sessions they are not swept on
ingest -- surviving between visits is the entire point.

### Error cases

Each gets its own HTTP status and message rather than a generic failure:

| Code          | Status | Cause                                                                       |
| ------------- | ------ | --------------------------------------------------------------------------- |
| `invalid-url` | 400    | Not a YouTube video link (checked in the browser too, before any request)   |
| `not-found`   | 404    | Video does not exist or was removed                                         |
| `unavailable` | 403    | Private, age-restricted, members-only, or region-locked                     |
| `no-captions` | 422    | Video has no caption tracks                                                 |
| `empty`       | 422    | Captions fetched but contained nothing                                      |
| `blocked`     | 502    | Rate-limited, refused, or newly token-gated — our problem, not the caller's |
