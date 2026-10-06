"use client";

import { useState, type FormEvent } from "react";

interface TextChatInputProps {
  disabled: boolean;
  onSend: (text: string) => void;
}

export function TextChatInput({ disabled, onSend }: TextChatInputProps) {
  const [value, setValue] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <label htmlFor="text-chat-input" className="sr-only">
        Type a message
      </label>
      <input
        id="text-chat-input"
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={disabled}
        placeholder="Type a question…"
        autoComplete="off"
        // 16px font size stops iOS Safari from zooming the viewport on focus.
        className="h-12 min-w-0 flex-1 rounded-xl border border-slate-300 px-4 text-base text-slate-900 placeholder:text-slate-400 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
      />
      <button
        type="submit"
        disabled={disabled || value.trim().length === 0}
        className="h-12 shrink-0 rounded-xl bg-slate-900 px-5 text-sm font-semibold text-white transition active:scale-[0.99] disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
      >
        Send
      </button>
    </form>
  );
}
