# Talk to a Document

Upload a PDF or paste a YouTube link, then hold a spoken conversation about it. Built on the
OpenAI Realtime API over WebRTC, as a single mobile-first Next.js app deployed on Vercel.

- **Live app:** https://chat-with-document-pi.vercel.app
- **Repository:** https://github.com/omarjomha/chat-with-document

| Capability                                   | Deployed                                                                | Local |
| -------------------------------------------- | ----------------------------------------------------------------------- | ----- |
| PDF upload (up to 25 MB) and text extraction | ✅                                                                      | ✅    |
| YouTube transcript ingestion                 | ❌ (see [below](#the-deployed-path-attempted-and-it-fails-differently)) | ✅    |
| Collapsible preview of the extracted text    | ✅                                                                      | ✅    |
| Live voice conversation with barge-in        | ✅                                                                      | ✅    |
| Live transcript of the conversation          | ✅                                                                      | ✅    |
| Text chat fallback when there is no mic      | ✅                                                                      | ✅    |
| Automatic recovery from a dropped connection | ✅                                                                      | ✅    |

YouTube blocks anonymous caption requests from datacentre IPs, which the spec anticipates. The
YouTube path is demonstrated locally, and the reasons, the failure modes and the ready-made proxy
hook are documented in [YouTube transcripts](#youtube-transcripts-how-and-what-it-cost-to-find).

## Getting started

Requires Node.js 20.9 or later, the minimum for Next.js 16.

```bash
cp .env.example .env.local   # then add your OpenAI key
npm install
npm run dev
```

Open http://localhost:3000. Voice needs microphone permission, which browsers only grant over
HTTPS or on `localhost`. To use it from a phone, see [Testing on a phone](#testing-on-a-phone).

### Environment

| Variable                | Required | Notes                                                                                                                                                |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`        | yes      | Server-side only. `src/lib/env.ts` imports `server-only`, so a client component that reached for it would fail the build rather than leak it.        |
| `OPENAI_REALTIME_MODEL` | no       | Defaults to `gpt-realtime-2.1`.                                                                                                                      |
| `OPENAI_REALTIME_VOICE` | no       | Defaults to `marin`.                                                                                                                                 |
| `BLOB_READ_WRITE_TOKEN` | no       | Injected by Vercel. Without it the session store falls back to memory, which is fine locally and wrong in production — see `src/lib/store/types.ts`. |
| `CRON_SECRET`           | no       | Production only. Authenticates the daily cleanup cron; without it the cron route refuses to run.                                                     |
| `YOUTUBE_PROXY_URL`     | no       | Egress prefix for YouTube requests, for deployments whose IPs YouTube throttles. The target URL is appended percent-encoded.                         |

No YouTube or Google API key is needed. See below for why.

### Checks

```bash
npm run test             # Vitest, ~270 tests, never touches the network
npm run typecheck        # tsc --noEmit
npm run lint
npm run build
npm run verify:youtube   # live check against the real YouTube API (see below)
```

## Technical overview

### Stack, and why

- **Next.js 16 (App Router) + React 19 + TypeScript.** One project serves the UI and the API
  routes, so there is one deploy, one set of environment variables, and types shared across the
  boundary — the realtime event types are used by both the token route and the browser client.
- **Vercel.** Serverless Node functions for the API, Vercel Blob for storage, and a daily cron for
  cleanup, all without separate infrastructure. Configuration lives in `vercel.ts`.
- **OpenAI Realtime API over WebRTC.** WebRTC carries audio peer-to-peer between the browser and
  OpenAI, with echo cancellation and jitter buffering handled by the browser. The server never
  relays audio, which keeps functions short-lived and cheap.
- **`unpdf`** for server-side PDF extraction: a serverless-friendly build of pdf.js with no native
  dependencies.
- **No YouTube library.** Captions are read with about 100 lines of `fetch`, after the library
  route proved dead — see the YouTube section.
- **`zod`** validates the server environment and every request body. **Tailwind CSS 4** for
  styling. **Vitest + Testing Library** for tests.

The runtime dependency list is seven packages.

### Architecture

```
browser ──upload──▶ Vercel Blob ──▶ /api/ingest/pdf ──┐
                                                      ├──▶ normalise ──▶ session store
browser ──paste───▶ /api/ingest/youtube ──────────────┘                        │
                                                                               ▼
browser ◀── ephemeral client secret ── /api/realtime/token ◀── instructions + document text
   │
   └── WebRTC (audio + `oai-events` data channel) ──▶ OpenAI Realtime API
```

```
src/
  app/            page and API routes (ingest, realtime token, sessions, cron)
  components/     UI: source picker, uploader, preview, voice chat, controls, transcript
  lib/
    ingest/       PDF and YouTube extraction, normalisation, session creation, transcript cache
    realtime/     WebRTC client, typed event protocol, session hook, reconnect, transcript pacing
    store/        SessionStore interface with memory and Blob implementations
    security/     origin check and rate limiter
    prompt.ts     builds the session instructions from the document
    env.ts        zod-validated server environment
tests/            unit and integration tests, plus one opt-in live test
```

**Both sources converge on one function.** `createSession` normalises, truncates, stores and
returns the text. Nothing downstream of it knows or cares whether the text came from a PDF or a
video.

**Context is injected server-side at mint time.** When the user starts a voice chat, the browser
sends only a session id. The server loads the document, builds the instructions, and mints a
short-lived client secret with those instructions already applied. The browser never holds an API
key and never sends the document to OpenAI, so the session is grounded before it connects.

**PDFs go straight to Blob storage.** Vercel caps function request bodies at 4.5 MB and the spec
requires 25 MB, so the browser uploads directly to Blob with a server-signed token, which also
drives a real progress bar. The server then fetches and parses the file, so extraction stays
server-side, and deletes it on every outcome.

**A session store, not module memory.** Vercel functions do not share memory between invocations,
so the in-memory storage the spec allows would silently lose documents in production. A small
`SessionStore` interface uses memory locally and Vercel Blob in production, selected by whether
Blob credentials exist. Sessions expire after two hours, enforced on read. They are swept on
ingest and by a daily cron that also removes abandoned uploads.

### Realtime voice

- **Barge-in.** Server-side voice activity detection cancels the model's reply the moment the user
  starts talking. The interrupted reply is sealed in the transcript, so late deltas cannot regrow
  it or snap it back to the full, unspoken text. A "Stop talking" button does the same for anyone who
  would rather tap.
- **Transcript order follows the conversation, not arrival.** The user's speech is transcribed
  asynchronously, and the transcript often resolves after the answer has started. Each turn
  reserves its slot when the server announces it, anchored on `previous_item_id`, so questions
  always sit above their answers (`src/lib/realtime/turnOrder.ts`).
- **Text keeps pace with the voice.** Transcript text arrives at generation speed, much faster than
  speech, so it is revealed at a steady speaking rate. Queued replies are revealed one at a time
  (`src/lib/realtime/reveal.ts`).
- **Recovery from poor networks.** A disconnected peer gets five seconds to heal on its own. Past
  that, the client rebuilds the session with a fresh token and a fresh peer connection, and replays
  the recent conversation, so the model still knows what was said. It makes four attempts over
  about fifteen seconds and waits for the browser's `online` event when the device is offline. The
  status pill shows Reconnecting throughout (`src/lib/realtime/reconnect.ts`).
- **Text fallback.** If the microphone is denied, missing, or blocked by an insecure origin, the
  user gets a specific message and can switch to text chat on the same session and the same
  document.

### Ingestion edge cases

PDFs: encrypted, corrupt, empty, and image-only (scanned) files each get a specific error. A
document that extracts mostly unmappable glyphs is flagged as unreadable instead of being passed to
the model as noise. When some pages have no text layer, the user is told how many. Text past the
context budget (360k characters, about 90k tokens of the model's 128k window) is truncated with a
visible notice, since the spec waives chunking.

YouTube: every common link shape is accepted, including `youtu.be`, Shorts, live, embed and
privacy-enhanced embed links, any `youtube.com` subdomain, and links pasted without a scheme or
with a timestamp. Invalid links are rejected in the browser before any
request is sent. Server-side failures map to distinct codes and statuses, listed under
[Error cases](#error-cases).

### Security

- The OpenAI key exists only on the server. The browser gets an ephemeral client secret, scoped to
  one Realtime session.
- The token and ingest routes reject cross-origin browser requests and are rate-limited per client
  (ten per ten minutes), since each mint opens a billed session.
- The PDF routes only act on paths inside the upload folder, so a crafted request cannot point
  extraction, and the deletion that follows it, at a stored session or cached transcript.
- The cron route refuses to run without `CRON_SECRET`.
- Uploaded files and sessions are short-lived and deleted by the app, since Blob has no TTL of its
  own.

### Testing

Unit and integration tests cover the pure logic directly: event parsing, transcript ordering and
pacing, reconnect timing, normalisation, prompt building, and the rate limiter. They also exercise
the API routes and key UI behaviour, including barge-in, a network drop mid-answer, and the YouTube
input. PDF tests generate real PDFs in memory. YouTube tests run against recorded responses,
including the HTML block page that once parsed into a fake transcript. One opt-in live test checks
the real YouTube endpoint.

## Trade-offs

- **The whole document goes into the instructions.** There is no retrieval layer, which the spec
  waives. This is simple and gives the model full context. The cost is bounded by prompt caching:
  the document is a static prefix, so after the first turn it is billed at the cached rate. The
  limit is the context window, handled by truncating with a visible notice.
- **Rate limiting is per function instance.** It stops one script in a loop at no infrastructure
  cost. A distributed attacker would need shared state or the Vercel firewall to stop.
- **Blob as a key-value store.** It is already part of the platform and needs no provisioning. A
  real database would be the next step for anything beyond short-lived sessions.
- **The transcript pacing is an estimate.** The API exposes no word timings, so the reveal runs at
  a fixed speaking rate, tuned slightly fast. Text a little ahead of the voice reads like captions,
  while text lagging behind it reads as broken.
- **Deployed YouTube needs a proxy.** The code path is wired through `YOUTUBE_PROXY_URL`, but no
  proxy is configured, so YouTube is demonstrated locally.

## YouTube transcripts: how, and what it cost to find

YouTube ingestion works, server-side, with no API key and no browser — but only via one specific
route, and the obvious routes are all dead. Worth recording, because the failure mode is silent.

**The trick: ask a mobile client.** YouTube gates the _web_ client's caption URLs behind a
Proof-of-Origin token minted by its BotGuard attestation runtime, and marks a gated URL with
`exp=xpe`. Fetching one returns **HTTP 200 with a zero-length body** — a refusal dressed as a
success, which is what makes this expensive to diagnose. The Android and iOS InnerTube clients are
served caption URLs _without_ that flag, and those fetch normally.

So the whole path is three plain `fetch` calls, in `src/lib/ingest/youtube.ts`:

1. `POST /youtubei/v1/player` with a mobile client context → the caption tracklist.
2. Pick a track (human-written over auto-generated, English first).
3. `GET` the track's `baseUrl` with `fmt=srv3` pinned → `timedtext format="3"` XML → parse to lines.

Measured client support, same IP, same moment: Android and iOS both return `OK` with ungated URLs;
`ANDROID_VR`, `ANDROID_MUSIC`, `ANDROID_CREATOR` and `TVHTML5` return `LOGIN_REQUIRED`; `WEB` and
`MWEB` return `UNPLAYABLE`; the embedded players return `ERROR`. Hence exactly two clients are
tried, in that order.

### Two guards worth knowing about

**Clients are tried in turn.** Android first, then iOS. They are refused independently — a Vercel
egress IP got `LOGIN_REQUIRED` from Android while a residential IP got `OK` from both — so one
extra request is the difference between working and not when YouTube sours on one of them. When
every client fails, the _most definitive_ refusal is reported rather than whichever was last: a
video that does not exist, or demonstrably has no captions, is true regardless of which client
asked, so those outrank a bot challenge that only says this request was distrusted.

Note the limit of this: it helps when the **player** call is refused. It does not help when
`/api/timedtext` itself is IP-blocked, because both clients' caption URLs point at that same
endpoint.

**Caption responses are validated before parsing.** This fixes a measured, silent corruption path.
Requesting a caption URL can return HTTP 200 with an HTML page — an interstitial, a consent screen,
or Google's "your computer or network may be sending automated queries" page. HTML contains `<p>`
elements, and the caption parser reads `<p>` elements, so that page parses into a convincing fake
transcript:

```
["... but your computer or network may be sending automated queries.
  To protect our users, we can't process your request right now."]
```

The model would then discuss Google's error message as though it were the video. Requiring a
timed-text root element (`<timedtext>` or `<transcript>`) before parsing is a cheap, total defence,
since every real caption document has one and no HTML page does. A 200 that is not a caption
document is reported as `blocked`, never as content.

### Verifying it against live YouTube

`npm test` never touches the network. To check the real thing:

```bash
npm run verify:youtube
YOUTUBE_VERIFY_URL="https://youtu.be/<id>" npm run verify:youtube   # your own video
```

This calls the same `fetchYouTubeTranscript` the app uses, so a pass is evidence about the shipped
code rather than about a reimplementation. It prints the title, character and token counts, and the
first line, and asserts that no markup or HTML entity survived into the text.

If it reports `blocked`, that is YouTube refusing your network, not a defect — retry from another
connection, since a phone hotspot is usually enough.

**Last confirmed working: 2026-10-08**, from a laptop on a phone hotspot. The same check from the
development machine's home connection was refused at the same time, which is the clearest statement
of what this limitation actually is: per-connection IP reputation, not a defect and not a
per-machine problem. Devices behind one router share a public IP, so a second machine on the same
wifi is refused too — and IPv6 on that connection was refused as well, whole delegated prefix,
which rules out NAT as the explanation.

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
- **Ingestion does not depend on the OpenAI key.** `getServerEnv()` validates the whole contract at
  once, which is right for the Realtime route — it cannot work without a key. But reading the
  optional proxy setting through the same accessor meant a missing `OPENAI_API_KEY` broke transcript
  extraction too. Since the spec allows YouTube to be demonstrated locally, a clone with no OpenAI
  key can now still ingest a video; `getYouTubeProxyUrl()` reads that one variable on its own.
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

## Testing on a phone

Two constraints shape local testing on a phone. **The microphone needs a secure context**:
browsers only expose `getUserMedia` over HTTPS or on `localhost`, so `http://<laptop-ip>:3000`
loads, but only text chat works. **YouTube ingestion needs an unblocked network**, as described
above. Pick one of these two setups.

### Option A: Cloudflare tunnel (simplest)

```bash
npm run dev:tunnel                 # builds, starts the server, prints a trycloudflare.com URL
npm run dev:tunnel -- --skip-build # reuse the previous build
```

Requires [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
The tunnel dials out from the laptop, so the phone can be on any network, cellular included, and
Cloudflare's certificate is one iOS already trusts. A tunnel only affects inbound traffic, so
YouTube requests still leave from the laptop's own connection.

### Option B: phone hotspot and dev HTTPS

1. Turn on the phone's hotspot and connect the **laptop** to it. The laptop's traffic then leaves
   over cellular, which YouTube has not flagged.
2. Find the laptop's address on the hotspot: `ipconfig` on Windows, `ipconfig getifaddr en0` on
   macOS. An iPhone hotspot uses `172.20.10.x`. Ignore `169.254.*` and virtual adapters. Next's
   startup banner has been seen printing the wrong adapter.
3. Run `npm run dev:https -- -H <laptop-ip>`. The `-H` matters: Next's generated certificate
   otherwise covers only `localhost`, and iOS Safari often refuses a name mismatch outright.
4. On the phone, open `https://<laptop-ip>:3000` (scheme and port both required) and accept the
   certificate warning. If the mic is still refused, trust the generated CA from `certificates/`
   under Settings → General → VPN & Device Management, then enable it under Settings → General →
   About → Certificate Trust Settings.

The `allowedDevOrigins` entries in `next.config.ts` make step 4 work. Without them the page renders
normally but nothing is clickable: the dev server refuses the dev-only endpoints the React client
needs during hydration, and the only clue is a cross-origin message in the console.

**Last confirmed working: 2026-10-08.** On an iPhone on its own hotspot, against the tethered laptop,
a YouTube link was ingested and a spoken conversation held about it.

## Troubleshooting voice

If voice fails, two `curl` probes separate a configuration fault from a network one:

```bash
# 1. Does our own route mint a secret? 200 = key present and accepted.
curl -sk -X POST https://localhost:3000/api/realtime/token \
  -H 'Content-Type: application/json' -d '{}'

# 2. Does OpenAI accept that secret? Deliberately invalid SDP body.
TOKEN=$(curl -sk -X POST https://localhost:3000/api/realtime/token \
  -H 'Content-Type: application/json' -d '{}' | sed -E 's/.*"value":"([^"]*)".*/\1/')
curl -s -X POST https://api.openai.com/v1/realtime/calls \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/sdp' -d 'not-a-real-sdp'
```

A `500` from the first probe almost always means `.env.local` is missing. For the second, a
`400 invalid_offer` is the **pass**: the credential was accepted and only the garbage SDP was
rejected, which also proves the connection can reach `api.openai.com`. A `401` means the token was
refused. If both pass and voice still fails, suspect ICE: a network that blocks STUN leaves the
connection in Connecting until the 15-second timeout reports it.

## AI usage

I used Claude Code (Anthropic's agentic coding tool) to write all of the code in this repository,
and I reviewed the code before deployment.

How the work was structured:

- **A plan first.** The spec was turned into a staged plan (`docs/PLAN.md`), ordered by risk. Voice
  shipped first against a hardcoded context, since it was the hardest part and the one that had to
  be proven on a real phone. Ingestion was layered on after.
- **Small, focused commits.** The history is kept as single-purpose commits with descriptive
  messages, so each change is easy to follow on its own.
- **Verified on real devices.** Each stage was tested on a phone against the running app, and what
  that turned up drove the fixes in the history.
- **Measured, not assumed.** The current Realtime API was checked against live OpenAI
  documentation, and the YouTube investigation recorded above tested each approach instead of
  trusting it.
