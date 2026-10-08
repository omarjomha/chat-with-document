import { DocumentChat } from "@/components/DocumentChat";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-4 py-6">
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
