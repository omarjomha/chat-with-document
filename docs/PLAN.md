# Implementation Plan — Talk to a Document or YouTube Video

Ground truth is `docs/Talk to a Document.pdf`. Where this plan and the spec disagree, the spec wins.

## 1. Approach

One Next.js app on Vercel serving both UI and API. The browser never sees an OpenAI key: the
server mints a short-lived client secret and injects the document text as session instructions at
mint time, so document context is applied server-side before the browser ever connects.

Build order is driven by risk — voice is the hardest part and the thing that must be verified on a
real phone, so it ships first against a hardcoded context. Ingestion is layered on after.

## 2. Verified API facts

Checked against live OpenAI docs on 2026-10-05 (older tutorials describe a retired flow):

| Step | Endpoint |
|---|---|
| Mint ephemeral secret (server) | `POST https://api.openai.com/v1/realtime/client_secrets` |
| SDP exchange (browser) | `POST https://api.openai.com/v1/realtime/calls`, `Content-Type: application/sdp` |

- Model: `gpt-realtime-2.1` — **128k context window**, 32k max output.
- Pricing: text input **$4.00/M uncached, $0.40/M cached** (audio $32.00/$0.40). Document text is
  injected as *text* instructions, not audio, and is a static prefix that never changes within a
  session — so it caches after the first turn. A 90k-token document costs roughly $0.36 on turn one
  and ~$0.036 per turn after, which is what makes `MAX_CONTEXT_CHARS` of 360k defensible.
- Mint body: `{ session: { type: "realtime", model, instructions, audio: { output: { voice } } } }`
- Ephemeral key is at `response.value`.
- Send `OpenAI-Safety-Identifier` on the mint request.

## 3. Architecture

```
app/
  page.tsx                          source picker -> preview -> voice chat
  api/
    realtime/token/route.ts         POST {sessionId?} -> ephemeral secret (instructions injected here)
    ingest/pdf/upload/route.ts      Vercel Blob client-upload token handshake
    ingest/pdf/route.ts             POST {blobUrl} -> extract -> store -> return preview
    ingest/youtube/route.ts         POST {url} -> transcript -> store -> return preview
components/
  SourcePicker · PdfUploader · YouTubeInput · TranscriptPreview (collapsible)
  VoiceChat · TranscriptFeed · SessionControls · ConnectionStatus · TextFallbackInput
lib/
  realtime/  client.ts · events.ts (typed event unions) · useRealtimeSession.ts
  ingest/    pdf.ts (unpdf) · youtube.ts (youtubei.js) · normalize.ts
  store/     types.ts · memory.ts · blob.ts · index.ts
  prompt.ts · env.ts (zod-validated)
```

**Why a session store.** Vercel functions are stateless between invocations, so the spec's
"in-memory is sufficient" would silently drop documents in production. A ~20-line `SessionStore`
interface keeps in-memory for local dev and Blob-backed for prod, swappable by env.

**Why direct-to-Blob upload.** Vercel caps serverless request bodies at 4.5MB; the spec requires
25MB PDFs. The browser uploads straight to Blob with a server-signed token, then the server fetches
and parses it — extraction stays server-side as the spec requires.

## 4. Constants

| Name | Value | Rationale |
|---|---|---|
| `MAX_PDF_BYTES` | 25 MB | Spec |
| `MAX_CONTEXT_CHARS` | 360,000 (~90k tokens) | Leaves ~38k of the 128k window for conversation + output |
| Mobile target | 390 px | Spec |

Over `MAX_CONTEXT_CHARS`, truncate and show a visible banner stating how much was used. Spec
explicitly waives chunking and summarization.

## 5. Environment

| Var | Scope | Notes |
|---|---|---|
| `OPENAI_API_KEY` | server | Never client-exposed |
| `OPENAI_REALTIME_MODEL` | server | Default `gpt-realtime-2.1` |
| `OPENAI_REALTIME_VOICE` | server | Default `marin` |
| `BLOB_READ_WRITE_TOKEN` | server | Auto-injected by Vercel |
| `YOUTUBE_PROXY_URL` | server, optional | Bonus attempt for deployed YouTube |

`.env.local` is gitignored; `.env.example` is committed.

---

## Stage 1 — Realtime voice, verified on your phone

Hardcoded placeholder context. No ingestion yet. **This is the stage you verify by phone.**

- Scaffold Next.js 15 / React 19 / TS strict / Tailwind v4; ESLint + Prettier; Vitest.
- `POST /api/realtime/token` — zod-validated, mints the client secret, returns only the ephemeral
  value and expiry.
- `lib/realtime/client.ts` — `RTCPeerConnection`, mic track via `getUserMedia`, remote audio to an
  `<audio>` element, `oai-events` data channel.
- `lib/realtime/events.ts` — typed unions for the events we consume (transcript deltas, speech
  start/stop, response lifecycle, errors).
- `useRealtimeSession` hook — state machine: `idle → connecting → live → closed | error`.
- UI: Start/Stop, mute toggle, connection status, live transcript feed, text-fallback input when
  `getUserMedia` is unavailable or denied.
- Deploy to Vercel; you open the HTTPS URL on your phone.

**Exit criteria (you verify):** speak a question on your phone, hear a spoken answer, see both sides
in the live transcript, interrupt the model mid-answer and have it stop, mute and stop work.

## Stage 2 — PDF ingestion + context injection

- Blob client-upload handshake; reject >25MB and non-PDF before upload.
- `lib/ingest/pdf.ts` via `unpdf`; `normalize.ts` for whitespace collapse, char/token estimate,
  truncation.
- Store extracted text; render collapsible preview with page/char count and truncation banner.
- `prompt.ts` builds instructions grounding the model in the text and telling it to say when the
  answer isn't in the document.
- Token route loads the session's text and injects it at mint time.

**Exit criteria:** upload a real PDF on the deployed app, see extracted text in the preview, ask a
question about a specific detail by voice, get a correct spoken answer.

## Stage 3 — YouTube ingestion

- Parse `watch?v=`, `youtu.be`, `/shorts/`, `/embed/`, extra query params.
- `youtubei.js` transcript fetch, reusing Stage 2's normalize/store/inject path.
- Distinct errors for: invalid URL, video not found, private/age-gated, no captions available,
  cloud-IP block.
- Optional `YOUTUBE_PROXY_URL` as the deployed-path bonus attempt.

**Exit criteria:** works locally for certain (spec accepts a local demo). Deployed path attempted
via proxy; outcome documented honestly in the README either way.

## Stage 4 — Hardening, tests, README

- **Tune the transcript reveal rate.** With `SPEECH_CHARS_PER_SECOND = 18` the voice still trails
  the text somewhat. Unknown whether the drift accumulates over a long answer or is a constant
  offset — measure that first, since the fix differs: a constant offset means lowering the rate, while
  accumulating drift means the rate itself is wrong and may need deriving from audio rather than a
  constant. Observed 2026-10-07.


- **Abuse protection before going public.** Deployment Protection covers development,
  but the spec requires an unauthenticated public URL for graders. Needs a per-IP rate limit on
  `/api/realtime/token`, a same-origin check, and Deployment Protection switched off at submission.
- ~~Session TTL in Blob.~~ **Done** (implemented alongside Stage 2): 2h expiry checked on read,
  swept on ingest, deleted explicitly on Replace/pagehide, with a daily cron backstop.


- Poor-network resilience: ICE disconnect detection, reconnect with backoff, surfaced status
  (spec's review script tests this explicitly).
- Edge cases: scanned/image-only PDF with no text layer, encrypted PDF, corrupt file, empty
  transcript, oversized text.
- Tests (Vitest): URL parsing, normalization/truncation, prompt construction, store
  implementations, zod schemas, token-route error paths with a mocked OpenAI.
- Mobile polish pass at 390px; loading/error/empty states throughout.
- README: setup, env config, technical overview, trade-offs, YouTube limitation, AI-use notes
  (spec requires all of these).

## 6. Risks

| Risk | Mitigation |
|---|---|
| YouTube blocks Vercel IPs | Expected by spec; local demo + documented limitation, proxy as bonus |
| Realtime API shape shifts | Verified against live docs today; pinned model in env |
| iOS Safari audio autoplay | Attach audio element and resume context inside the user's tap gesture |
| Scanned PDFs yield no text | Detect empty extraction, show actionable error (no OCR — out of scope) |
| Blob free-tier limits | Small files, short TTL; delete blob after extraction |

## 7. Open items

- Vercel CLI is installed but **not logged in** — needs an interactive `vercel login` from you.
- `OPENAI_API_KEY` to be placed in `.env.local` (never committed).
