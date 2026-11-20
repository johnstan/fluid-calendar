"use client";

import { useEffect, useState } from "react";

import { HiPencil, HiTrash } from "react-icons/hi";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import {
  differenceInMinutes,
  format,
  isThisYear,
  isToday,
  newDate,
} from "@/lib/date-utils";
import { MarkdownLite, toggleChecklistLine } from "@/lib/markdown-lite";
import { TaskCommentDTO } from "@/lib/task-comments";

function formatCommentTime(iso: string): string {
  const date = newDate(iso);
  const minutes = differenceInMinutes(newDate(), date);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (isToday(date)) return `Today ${format(date, "HH:mm")}`;
  return format(date, isThisYear(date) ? "d MMM, HH:mm" : "d MMM yyyy, HH:mm");
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return res.json();
}

/**
 * Comment thread for a task: notes, ideas and follow-ups, in the same
 * Markdown as descriptions. Saved immediately, independent of the task form.
 */
export function TaskComments({ taskId }: { taskId: string }) {
  const [comments, setComments] = useState<TaskCommentDTO[] | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const base = `/api/tasks/${encodeURIComponent(taskId)}/comments`;

  useEffect(() => {
    let cancelled = false;
    setComments(null);
    request<TaskCommentDTO[]>(base)
      .then((list) => !cancelled && setComments(list))
      .catch(() => !cancelled && setComments([]));
    return () => {
      cancelled = true;
    };
  }, [base]);

  const post = async () => {
    if (!draft.trim() || posting) return;
    setPosting(true);
    try {
      const created = await request<TaskCommentDTO>(base, {
        method: "POST",
        body: JSON.stringify({ body: draft }),
      });
      setComments((c) => [...(c ?? []), created]);
      setDraft("");
    } catch (error) {
      toast.error("Couldn't add comment", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setPosting(false);
    }
  };

  const save = async (id: string, body: string) => {
    const previous = comments;
    setComments((c) => c?.map((x) => (x.id === id ? { ...x, body } : x)) ?? c);
    try {
      const updated = await request<TaskCommentDTO>(`${base}/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
      setComments((c) => c?.map((x) => (x.id === id ? updated : x)) ?? c);
      return true;
    } catch (error) {
      setComments(previous);
      toast.error("Couldn't save comment", {
        description: error instanceof Error ? error.message : undefined,
      });
      return false;
    }
  };

  const remove = async (id: string) => {
    const previous = comments;
    setComments((c) => c?.filter((x) => x.id !== id) ?? c);
    try {
      await request(`${base}/${id}`, { method: "DELETE" });
    } catch (error) {
      setComments(previous);
      toast.error("Couldn't delete comment", {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  };

  // Cmd/Ctrl+Enter submits; keep Enter for new lines and stop it reaching
  // the task form (which would submit the whole task)
  const onKeyDown =
    (submit: () => void, cancel?: () => void) =>
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      e.stopPropagation();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape" && cancel) {
        e.preventDefault();
        cancel();
      }
    };

  return (
    <div className="space-y-2">
      <Label>
        Comments
        {comments && comments.length > 0 && (
          <span className="ml-1 font-normal text-muted-foreground">
            ({comments.length})
          </span>
        )}
      </Label>

      {comments === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        comments.length > 0 && (
          <ul className="space-y-2">
            {comments.map((c) => (
              <li
                key={c.id}
                className="group rounded-md border border-border bg-muted/30 px-3 py-2"
              >
                <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {formatCommentTime(c.createdAt)}
                    {c.updatedAt !== c.createdAt && " · edited"}
                  </span>
                  {editingId !== c.id && (
                    <span className="flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      <button
                        type="button"
                        title="Edit comment"
                        aria-label="Edit comment"
                        onClick={() => {
                          setEditingId(c.id);
                          setEditText(c.body);
                        }}
                        className="rounded p-0.5 hover:bg-muted hover:text-foreground"
                      >
                        <HiPencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Delete comment"
                        aria-label="Delete comment"
                        onClick={() => remove(c.id)}
                        className="rounded p-0.5 hover:bg-muted hover:text-destructive"
                      >
                        <HiTrash className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  )}
                </div>
                {editingId === c.id ? (
                  <div className="space-y-2">
                    <Textarea
                      value={editText}
                      autoFocus
                      rows={3}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={onKeyDown(
                        async () => {
                          if (editText.trim() && (await save(c.id, editText))) {
                            setEditingId(null);
                          }
                        },
                        () => setEditingId(null)
                      )}
                      className="text-sm"
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={!editText.trim()}
                        onClick={async () => {
                          if (await save(c.id, editText)) setEditingId(null);
                        }}
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <MarkdownLite
                    text={c.body}
                    className="text-sm"
                    onToggle={(line) =>
                      save(c.id, toggleChecklistLine(c.body, line))
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        )
      )}

      <div className="space-y-2">
        <Textarea
          value={draft}
          rows={2}
          placeholder="Add a comment, idea or next step…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown(post)}
          className="text-sm"
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Supports - [ ] checklists, **bold**, ~~strike~~ · ⌘↵ to post
          </span>
          <Button
            type="button"
            size="sm"
            disabled={!draft.trim() || posting}
            onClick={post}
          >
            {posting ? "Posting…" : "Comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}
