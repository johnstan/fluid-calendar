import { Fragment, ReactNode } from "react";

/**
 * A small, safe Markdown subset for task descriptions. Stored as plain text so
 * it stays readable when synced to Google Tasks / Outlook. Rendered as React
 * elements only (never innerHTML), so descriptions cannot inject markup.
 *
 * Blocks:  "- [ ] todo", "- [x] done", "- item" / "* item", "1. item",
 *          "# / ## / ### heading", blank lines, paragraphs.
 *          Two spaces of indentation = one nesting level.
 * Inline:  **bold**, *italic* / _italic_, ~~strike~~, `code`,
 *          [text](https://...), bare http(s) URLs.
 */

export type MdBlock =
  | {
      kind: "check";
      line: number;
      indent: number;
      checked: boolean;
      text: string;
    }
  | { kind: "bullet"; line: number; indent: number; text: string }
  | {
      kind: "ordered";
      line: number;
      indent: number;
      marker: string;
      text: string;
    }
  | { kind: "heading"; line: number; level: number; text: string }
  | { kind: "blank"; line: number }
  | { kind: "text"; line: number; text: string };

const CHECK = /^(\s*)[-*+]\s+\[( |x|X)\]\s?(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+[.)])\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;

const indentLevel = (ws: string) =>
  Math.floor(ws.replace(/\t/g, "  ").length / 2);

export function parseMarkdownLite(text: string): MdBlock[] {
  return text.split(/\r?\n/).map((raw, line): MdBlock => {
    let m: RegExpMatchArray | null;
    if ((m = raw.match(CHECK))) {
      return {
        kind: "check",
        line,
        indent: indentLevel(m[1]),
        checked: m[2].toLowerCase() === "x",
        text: m[3],
      };
    }
    if ((m = raw.match(BULLET))) {
      return { kind: "bullet", line, indent: indentLevel(m[1]), text: m[2] };
    }
    if ((m = raw.match(ORDERED))) {
      return {
        kind: "ordered",
        line,
        indent: indentLevel(m[1]),
        marker: m[2],
        text: m[3],
      };
    }
    if ((m = raw.match(HEADING))) {
      return { kind: "heading", line, level: m[1].length, text: m[2] };
    }
    if (!raw.trim()) return { kind: "blank", line };
    return { kind: "text", line, text: raw };
  });
}

/** Flip the checkbox on a given line ("- [ ]" <-> "- [x]"). */
export function toggleChecklistLine(text: string, line: number): string {
  const lines = text.split(/\r?\n/);
  const current = lines[line];
  if (current === undefined) return text;
  const m = current.match(CHECK);
  if (!m) return text;
  const checked = m[2].toLowerCase() === "x";
  lines[line] = current.replace(/\[( |x|X)\]/, checked ? "[ ]" : "[x]");
  return lines.join("\n");
}

/** Count of checklist items and how many are done, e.g. for "2/5". */
export function checklistProgress(text: string): {
  done: number;
  total: number;
} {
  const items = parseMarkdownLite(text).filter((b) => b.kind === "check");
  return {
    total: items.length,
    done: items.filter((b) => b.kind === "check" && b.checked).length,
  };
}

// --- inline ---------------------------------------------------------------

const INLINE =
  /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]|(?<![\w*])\*[^*\s][^*]*\*(?![\w*])|(?<!\w)_[^_\s][^_]*_(?!\w))/g;

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (token.startsWith("**")) {
      out.push(<strong key={key++}>{renderInline(token.slice(2, -2))}</strong>);
    } else if (token.startsWith("~~")) {
      out.push(<s key={key++}>{renderInline(token.slice(2, -2))}</s>);
    } else if (token.startsWith("`")) {
      out.push(
        <code
          key={key++}
          className="rounded bg-muted px-1 font-mono text-[0.9em]"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("[")) {
      const m = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/)!;
      out.push(
        <a
          key={key++}
          href={m[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2"
        >
          {m[1]}
        </a>
      );
    } else if (token.startsWith("http")) {
      out.push(
        <a
          key={key++}
          href={token}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-primary underline underline-offset-2"
        >
          {token}
        </a>
      );
    } else {
      // *italic* or _italic_
      out.push(<em key={key++}>{renderInline(token.slice(1, -1))}</em>);
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// --- component ------------------------------------------------------------

interface MarkdownLiteProps {
  text: string;
  /** When set, checkboxes are clickable and report the source line. */
  onToggle?: (line: number) => void;
  className?: string;
}

export function MarkdownLite({ text, onToggle, className }: MarkdownLiteProps) {
  const blocks = parseMarkdownLite(text);
  return (
    <div className={className}>
      {blocks.map((b) => {
        switch (b.kind) {
          case "blank":
            return <div key={b.line} className="h-2" />;
          case "heading": {
            const size =
              b.level === 1
                ? "text-base"
                : b.level === 2
                  ? "text-sm"
                  : "text-[0.95em]";
            return (
              <div key={b.line} className={`${size} mt-1 font-semibold`}>
                {renderInline(b.text)}
              </div>
            );
          }
          case "check":
            return (
              <label
                key={b.line}
                className="flex items-start gap-2 py-0.5"
                style={{ paddingLeft: `${b.indent * 1.25}rem` }}
              >
                <input
                  type="checkbox"
                  checked={b.checked}
                  disabled={!onToggle}
                  onChange={() => onToggle?.(b.line)}
                  onClick={(e) => e.stopPropagation()}
                  className="mt-[0.2em] h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary disabled:cursor-default"
                />
                <span
                  className={
                    b.checked ? "text-muted-foreground line-through" : undefined
                  }
                >
                  {renderInline(b.text)}
                </span>
              </label>
            );
          case "bullet":
          case "ordered":
            return (
              <div
                key={b.line}
                className="flex gap-2 py-0.5"
                style={{ paddingLeft: `${b.indent * 1.25}rem` }}
              >
                <span className="shrink-0 text-muted-foreground">
                  {b.kind === "ordered" ? b.marker : "•"}
                </span>
                <span className="min-w-0">{renderInline(b.text)}</span>
              </div>
            );
          default:
            return (
              <Fragment key={b.line}>
                <div className="break-words">{renderInline(b.text)}</div>
              </Fragment>
            );
        }
      })}
    </div>
  );
}
