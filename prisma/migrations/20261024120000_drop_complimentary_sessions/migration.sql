-- Host/event complimentary sessions and the host-comp / guest-spend order roles
-- are gone: a complimentary order is given to its (required) customer.
-- DropForeignKey
ALTER TABLE "PosOrder" DROP CONSTRAINT "PosOrder_complimentarySessionId_fkey";

-- DropForeignKey
ALTER TABLE "ComplimentarySession" DROP CONSTRAINT "ComplimentarySession_tenantId_fkey";

-- DropIndex
DROP INDEX "PosOrder_complimentarySessionId_idx";

-- AlterTable
ALTER TABLE "PosOrder" DROP COLUMN "complimentaryOrderRole",
DROP COLUMN "complimentarySessionId";

-- DropTable
DROP TABLE "ComplimentarySession";

-- DropEnum
DROP TYPE "ComplimentaryOrderRole";

-- DropEnum
DROP TYPE "ComplimentarySessionStatus";

