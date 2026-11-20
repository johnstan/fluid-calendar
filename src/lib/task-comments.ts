import { z } from "zod";

export const MAX_COMMENT_LENGTH = 10_000;

export const commentBodySchema = z.object({
  body: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Comment is empty").max(MAX_COMMENT_LENGTH)),
});

export interface TaskCommentDTO {
  id: string;
  taskId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}
