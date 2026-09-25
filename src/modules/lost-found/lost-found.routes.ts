import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { nextLostFoundNo } from "../../lib/sequence.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { HousekeepingError, loadActor } from "../../lib/housekeeping.js";

export const lostFoundRouter = Router();
lostFoundRouter.use(requireModule("HOUSEKEEPING"));

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());

const createSchema = z.object({
  itemName: z.string().trim().min(1).max(120),
  description: optionalText(500),
  roomId: optionalId,
  locationNote: optionalText(120),
  foundAt: z.coerce.date().optional(),
  notes: optionalText(500),
});
const updateSchema = partialNoDefaults(createSchema);
const collectSchema = z.object({ collectedByName: z.string().trim().min(1).max(120), collectedByContact: optionalText(60) });

const listSchema = z.object({
  status: z.enum(["UNCLAIMED", "COLLECTED", "ALL"]).optional(),
  search: optionalText(120),
});

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const itemInclude = {
  room: { select: { id: true, number: true } },
  foundByEmployee: { select: { id: true, firstName: true, lastName: true } },
  collectedByEmployee: { select: { id: true, firstName: true, lastName: true } },
} as const;

async function assertRoomInTenant(roomId: string, tid: string) {
  const room = await prisma.room.findFirst({ where: { id: roomId, tenantId: tid }, select: { id: true } });
  if (!room) throw Object.assign(new Error("Choose a room from this property"), { status: 400 });
}

async function requireSupervisor(req: { tenantId?: string; userId?: string }) {
  const actor = await loadActor(req.tenantId, req.userId);
  if (!actor.isManager) throw new HousekeepingError("Only a supervisor can change recorded lost and found items", 403);
  return actor;
}

// Collected items sink out of the default view entirely — the frontend must
// explicitly ask for status=COLLECTED or ALL to see them, per the brief
// ("not fetched by API until the user explicitly requests them").
lostFoundRouter.get("/", async (req, res) => {
  const query = listSchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid filters", details: query.error.flatten() }); return; }
  const { status, search } = query.data;
  const tid = tenantId(req);
  const statusFilter = status === "ALL" ? undefined : status ?? "UNCLAIMED";
  const items = await prisma.lostFoundItem.findMany({
    where: {
      tenantId: tid,
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(search
        ? { OR: [
            { itemNo: { contains: search, mode: "insensitive" } },
            { itemName: { contains: search, mode: "insensitive" } },
            { description: { contains: search, mode: "insensitive" } },
            { collectedByName: { contains: search, mode: "insensitive" } },
          ] }
        : {}),
    },
    include: itemInclude,
    orderBy: [{ status: "asc" }, { foundAt: "desc" }],
  });
  const unclaimedCount = await prisma.lostFoundItem.count({ where: { tenantId: tid, status: "UNCLAIMED" } });
  res.json({ items, summary: { unclaimed: unclaimedCount } });
});

lostFoundRouter.post("/", async (req, res) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid item", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  if (data.data.roomId) await assertRoomInTenant(data.data.roomId, tid);
  const itemNo = await nextLostFoundNo(tid);
  const item = await prisma.lostFoundItem.create({
    data: { tenantId: tid, itemNo, foundBy: req.userId, ...data.data },
    include: itemInclude,
  });
  res.status(201).json({ item });
});

lostFoundRouter.patch("/:id", async (req, res) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid item", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try { await requireSupervisor(req); } catch (error) { res.status(error instanceof HousekeepingError ? error.status : 500).json({ error: error instanceof Error ? error.message : "Not allowed" }); return; }
  if (data.data.roomId) await assertRoomInTenant(data.data.roomId, tid);
  const updated = await prisma.lostFoundItem.updateMany({ where: { id: req.params.id, tenantId: tid }, data: data.data });
  if (!updated.count) { res.status(404).json({ error: "Item not found" }); return; }
  const item = await prisma.lostFoundItem.findUniqueOrThrow({ where: { id: req.params.id }, include: itemInclude });
  res.json({ item });
});

lostFoundRouter.patch("/:id/collect", async (req, res) => {
  const data = collectSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid collection details", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try { await requireSupervisor(req); } catch (error) { res.status(error instanceof HousekeepingError ? error.status : 500).json({ error: error instanceof Error ? error.message : "Not allowed" }); return; }
  const existing = await prisma.lostFoundItem.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!existing) { res.status(404).json({ error: "Item not found" }); return; }
  if (existing.status !== "UNCLAIMED") { res.status(409).json({ error: "This item has already been marked as collected" }); return; }
  const item = await prisma.lostFoundItem.update({
    where: { id: existing.id },
    data: { status: "COLLECTED", collectedAt: new Date(), collectedBy: req.userId, ...data.data },
    include: itemInclude,
  });
  res.json({ item });
});

lostFoundRouter.patch("/:id/reopen", async (req, res) => {
  const tid = tenantId(req);
  try { await requireSupervisor(req); } catch (error) { res.status(error instanceof HousekeepingError ? error.status : 500).json({ error: error instanceof Error ? error.message : "Not allowed" }); return; }
  const existing = await prisma.lostFoundItem.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!existing) { res.status(404).json({ error: "Item not found" }); return; }
  if (existing.status !== "COLLECTED") { res.status(409).json({ error: "This item is not marked as collected" }); return; }
  const item = await prisma.lostFoundItem.update({
    where: { id: existing.id },
    data: { status: "UNCLAIMED", collectedAt: null, collectedBy: null, collectedByName: null, collectedByContact: null },
    include: itemInclude,
  });
  res.json({ item });
});

lostFoundRouter.delete("/:id", async (req, res) => {
  try { await requireSupervisor(req); } catch (error) { res.status(error instanceof HousekeepingError ? error.status : 500).json({ error: error instanceof Error ? error.message : "Not allowed" }); return; }
  const deleted = await prisma.lostFoundItem.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req) } });
  if (!deleted.count) { res.status(404).json({ error: "Item not found" }); return; }
  res.status(204).send();
});
