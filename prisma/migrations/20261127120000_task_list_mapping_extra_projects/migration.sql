-- AlterTable
ALTER TABLE "TaskListMapping" ADD COLUMN "extraProjectIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
