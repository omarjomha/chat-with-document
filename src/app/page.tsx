import { DocumentChat } from "@/components/DocumentChat";

export default function Home() {
  return (
    // The layout opts into viewport-fit=cover, which draws under the notch and
    // home indicator, so the safe-area insets have to be honoured here.
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 pt-[max(1.5rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
          Talk to a Document
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Upload a PDF or paste a YouTube link, then ask questions out loud.
        </p>
      </header>

      <DocumentChat />
    </main>
  );
}
