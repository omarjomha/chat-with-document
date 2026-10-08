import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SourcePicker } from "@/components/SourcePicker";
import { YouTubeInput } from "@/components/YouTubeInput";

const VALID = "https://youtu.be/dQw4w9WgXcQ";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("YouTubeInput", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a non-YouTube link without touching the network", async () => {
    const user = userEvent.setup();
    render(<YouTubeInput disabled={false} onIngested={vi.fn()} />);

    await user.type(screen.getByLabelText("YouTube video link"), "https://vimeo.com/12345");
    await user.click(screen.getByRole("button", { name: "Load transcript" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not a YouTube video link/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands the ingested session up on success", async () => {
    const onIngested = vi.fn();
    fetchMock.mockResolvedValue(jsonResponse({ sessionId: "s1", kind: "youtube", title: "Talk" }));

    const user = userEvent.setup();
    render(<YouTubeInput disabled={false} onIngested={onIngested} />);

    await user.type(screen.getByLabelText("YouTube video link"), VALID);
    await user.click(screen.getByRole("button", { name: "Load transcript" }));

    await waitFor(() =>
      expect(onIngested).toHaveBeenCalledWith({
        sessionId: "s1",
        kind: "youtube",
        title: "Talk",
      }),
    );
  });

  it("shows the server's own wording when ingestion fails", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "That video has no captions.", code: "no-captions" }, 422),
    );

    const user = userEvent.setup();
    render(<YouTubeInput disabled={false} onIngested={vi.fn()} />);

    await user.type(screen.getByLabelText("YouTube video link"), VALID);
    await user.click(screen.getByRole("button", { name: "Load transcript" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That video has no captions.");
  });

  it("stays submittable after a failure so the user can try another link", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Nope." }, 502));

    const user = userEvent.setup();
    render(<YouTubeInput disabled={false} onIngested={vi.fn()} />);

    await user.type(screen.getByLabelText("YouTube video link"), VALID);
    await user.click(screen.getByRole("button", { name: "Load transcript" }));

    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Load transcript" })).toBeEnabled();
  });

  it("cannot be submitted empty", () => {
    render(<YouTubeInput disabled={false} onIngested={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Load transcript" })).toBeDisabled();
  });
});

describe("SourcePicker", () => {
  it("opens on the PDF tab", () => {
    render(<SourcePicker disabled={false} onIngested={vi.fn()} />);

    expect(screen.getByRole("tab", { name: "PDF" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Choose a PDF")).toBeInTheDocument();
  });

  it("swaps in the YouTube form when its tab is chosen", async () => {
    const user = userEvent.setup();
    render(<SourcePicker disabled={false} onIngested={vi.fn()} />);

    await user.click(screen.getByRole("tab", { name: "YouTube" }));

    expect(screen.getByLabelText("YouTube video link")).toBeInTheDocument();
    expect(screen.queryByText("Choose a PDF")).not.toBeInTheDocument();
  });

  it("clears a stale error when the user switches tabs and back", async () => {
    const user = userEvent.setup();
    render(<SourcePicker disabled={false} onIngested={vi.fn()} />);

    await user.click(screen.getByRole("tab", { name: "YouTube" }));
    await user.type(screen.getByLabelText("YouTube video link"), "nonsense");
    await user.click(screen.getByRole("button", { name: "Load transcript" }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("tab", { name: "PDF" }));
    await user.click(screen.getByRole("tab", { name: "YouTube" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
