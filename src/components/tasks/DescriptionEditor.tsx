"use client";

import { useRef, useState } from "react";

import {
  BsListCheck,
  BsListUl,
  BsTypeBold,
  BsTypeStrikethrough,
} from "react-icons/bs";

import { Textarea } from "@/components/ui/textarea";

import { MarkdownLite, toggleChecklistLine } from "@/lib/markdown-lite";
import { cn } from "@/lib/utils";

interface DescriptionEditorProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
}

/**
 * Task description with light formatting. Stored as plain Markdown so it stays
 * readable in Google Tasks / Outlook; "Preview" renders it with clickable
 * checkboxes.
 */
export function DescriptionEditor({
  id,
  value,
  onChange,
}: DescriptionEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<"write" | "preview">(
    value.trim() ? "preview" : "write"
  );

  const restoreSelection = (start: number, end: number) =>
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(start, end);
    });

  /** Wrap the selection, e.g. **bold** */
  const wrap = (marker: string) => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const selected = value.slice(s, e) || "text";
    onChange(value.slice(0, s) + marker + selected + marker + value.slice(e));
    restoreSelection(s + marker.length, s + marker.length + selected.length);
  };

  /** Prefix every selected line, e.g. "- [ ] " */
  const prefixLines = (prefix: string) => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    const lineEndIdx = value.indexOf("\n", e);
    const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const block = value.slice(lineStart, lineEnd);
    const updated = block
      .split("\n")
      .map((line) =>
        line.startsWith(prefix) ? line.slice(prefix.length) : prefix + line
      )
      .join("\n");
    onChange(value.slice(0, lineStart) + updated + value.slice(lineEnd));
    restoreSelection(lineStart, lineStart + updated.length);
  };

  /** Continue a list/checklist on Enter, end it on an empty item */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    const el = e.currentTarget;
    const pos = el.selectionStart;
    if (pos !== el.selectionEnd) return;
    const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
    const line = value.slice(lineStart, pos);
    const m = line.match(/^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+[.)] )(.*)$/);
    if (!m) return;
    e.preventDefault();
    if (!m[3].trim()) {
      // empty item: end the list
      onChange(value.slice(0, lineStart) + value.slice(pos));
      restoreSelection(lineStart, lineStart);
      return;
    }
    let marker = m[2].replace(/\[[xX]\]/, "[ ]");
    const num = marker.match(/^(\d+)([.)]) $/);
    if (num) marker = `${Number(num[1]) + 1}${num[2]} `;
    const insert = "\n" + m[1] + marker;
    onChange(value.slice(0, pos) + insert + value.slice(pos));
    restoreSelection(pos + insert.length, pos + insert.length);
  };

  const tool =
    "inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40";

  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-0.5 border-b px-1 py-0.5">
        <button
          type="button"
          className={cn(
            "rounded px-2 py-1 text-xs",
            mode === "write" ? "bg-muted font-medium" : "text-muted-foreground"
          )}
          onClick={() => setMode("write")}
        >
          Write
        </button>
        <button
          type="button"
          className={cn(
            "rounded px-2 py-1 text-xs",
            mode === "preview"
              ? "bg-muted font-medium"
              : "text-muted-foreground"
          )}
          onClick={() => setMode("preview")}
        >
          Preview
        </button>
        <div className="mx-1 h-4 w-px bg-border" />
        <button
          type="button"
          className={tool}
          title="Bold"
          disabled={mode !== "write"}
          onClick={() => wrap("**")}
        >
          <BsTypeBold className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={tool}
          title="Strikethrough"
          disabled={mode !== "write"}
          onClick={() => wrap("~~")}
        >
          <BsTypeStrikethrough className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={tool}
          title="Checklist"
          disabled={mode !== "write"}
          onClick={() => prefixLines("- [ ] ")}
        >
          <BsListCheck className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={tool}
          title="Bullet list"
          disabled={mode !== "write"}
          onClick={() => prefixLines("- ")}
        >
          <BsListUl className="h-4 w-4" />
        </button>
      </div>
      {mode === "write" ? (
        <Textarea
          id={id}
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={5}
          placeholder="Notes, links, or a checklist: - [ ] first step"
          className="resize-y rounded-none border-0 focus-visible:ring-0"
        />
      ) : (
        <div
          className="max-h-64 min-h-[5rem] cursor-text overflow-y-auto px-3 py-2 text-sm"
          onDoubleClick={() => setMode("write")}
          title="Double-click to edit"
        >
          {value.trim() ? (
            <MarkdownLite
              text={value}
              onToggle={(line) => onChange(toggleChecklistLine(value, line))}
            />
          ) : (
            <span className="text-muted-foreground">No description</span>
          )}
        </div>
      )}
    </div>
  );
}
