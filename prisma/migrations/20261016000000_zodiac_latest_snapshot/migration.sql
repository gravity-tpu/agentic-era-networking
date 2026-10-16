-- CreateTable
CREATE TABLE IF NOT EXISTS "ZodiacLatestSnapshot" (
    "id" TEXT NOT NULL,
    "timestampMs" BIGINT NOT NULL,
    "source" TEXT NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZodiacLatestSnapshot_pkey" PRIMARY KEY ("id")
);
