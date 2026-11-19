-- Travel time before/after calendar events (respected by the auto-scheduler)
CREATE TABLE "EventTravelTime" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "beforeMinutes" INTEGER NOT NULL DEFAULT 0,
    "afterMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventTravelTime_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventTravelTime_userId_eventKey_key" ON "EventTravelTime"("userId", "eventKey");

ALTER TABLE "EventTravelTime" ADD CONSTRAINT "EventTravelTime_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
