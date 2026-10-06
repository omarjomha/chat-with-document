/**
 * Builds the system instructions sent to the Realtime API when minting an
 * ephemeral client secret.
 *
 * Context is injected here, server-side, at mint time. The browser never sends
 * document text to OpenAI and never holds an API key.
 */

export interface DocumentContext {
  /** Human-readable label, e.g. a filename or video title. */
  title: string;
  /** "pdf" | "youtube" — shapes how the model refers to the source. */
  kind: DocumentKind;
  /** Extracted text, already normalised and truncated if needed. */
  text: string;
  /** True when the text was cut to fit the context window. */
  truncated: boolean;
}

export type DocumentKind = "pdf" | "youtube";

const BASE_PERSONA = [
  "You are a concise, friendly voice assistant in a spoken conversation.",
  "Keep answers short and conversational — usually one to three sentences — because the user is listening, not reading.",
  "Never read long verbatim passages aloud; summarise instead, and offer to go deeper.",
  "If the user interrupts you, stop immediately and respond to what they just said.",
].join(" ");

const NO_DOCUMENT_GUIDANCE = [
  "No document has been loaded yet.",
  "If the user asks about a specific document or video, explain that they need to upload a PDF or paste a YouTube link first, then offer to chat generally in the meantime.",
].join(" ");

function sourceNoun(kind: DocumentKind): string {
  return kind === "youtube" ? "video transcript" : "document";
}

export function buildInstructions(context?: DocumentContext): string {
  if (!context) {
    return `${BASE_PERSONA}\n\n${NO_DOCUMENT_GUIDANCE}`;
  }

  const noun = sourceNoun(context.kind);

  const grounding = [
    `The user wants to talk about a ${noun} titled "${context.title}".`,
    `Answer from the ${noun} text below as your primary source.`,
    `If the answer is not in the text, say so plainly rather than guessing — do not invent details.`,
    context.truncated
      ? `Note: the text was truncated to fit the context window, so later sections may be missing. If the user asks about something that seems to fall outside what you can see, tell them it may be in the truncated portion.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return [
    BASE_PERSONA,
    "",
    grounding,
    "",
    `--- BEGIN ${noun.toUpperCase()} ---`,
    context.text,
    `--- END ${noun.toUpperCase()} ---`,
  ].join("\n");
}
