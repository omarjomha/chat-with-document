import { DocumentChat } from "@/components/DocumentChat";

export default function Home() {
  return (
    /*
     * Exactly one screen tall, and the page itself never scrolls: the content
     * scrolls inside the conversation, above controls that sit below it. See
     * VoiceChat for why the page scrolling was the problem.
     *
     * The layout opts into viewport-fit=cover, which draws under the notch and
     * home indicator, so the safe-area insets have to be honoured. The top one
     * is here; the sides and bottom belong to the regions that reach them.
     */
    <main className="mx-auto flex h-dvh w-full max-w-md flex-col pt-[max(1.5rem,env(safe-area-inset-top))]">
      <DocumentChat>
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            Talk to a Document
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Upload a PDF or paste a YouTube link, then ask questions out loud.
          </p>
        </header>
      </DocumentChat>
    </main>
  );
}
