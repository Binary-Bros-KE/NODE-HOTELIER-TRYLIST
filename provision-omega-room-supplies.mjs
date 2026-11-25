/**
 * Omega Gardens Hotel and Spa — room consumables + fixed room assets, from
 * the client's "room assets.txt". Applies to Standard/Superior/Deluxe rooms
 * (42 rooms); the Conference Room is skipped.
 *
 * Consumables: Products at the Main Store; each room type gets a maximum
 * (RoomConsumableStandard) and each room gets its own starting count
 * (RoomConsumableStock) — recorded straight into the rooms, no store
 * deduction (the client reconciles by manual review). Shelf lives approved
 * by the client: coffee/chocolate sachets 180 days, sugar sachets/bottled
 * water/lotion 365 days; soap, tissue, serviettes don't expire.
 *
 * Fixed assets: one Asset row per item per room (+ an "Opening quantity"
 * RECEIPT movement, exactly as POST /assets does), quantity 1 unless the
 * list says otherwise. Fridge only in Superior + Deluxe (15 rooms).
 *
 * Idempotent: products/categories/standards by name; room stock and assets
 * are only created when missing, never overwritten.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } });
const tid = tenant.id;
const mainStore = await prisma.location.findFirstOrThrow({ where: { tenantId: tid, name: "Main Store" } });
const housekeeping = await prisma.location.findFirst({ where: { tenantId: tid, type: "HOUSEKEEPING" } });
console.log(`Tenant: ${tenant.name} | Main Store ok | Housekeeping location: ${housekeeping ? housekeeping.name : "NOT FOUND"}`);

const { recordStockMovement } = await import("./dist/lib/stockLedger.js");
const { nextAssetNo } = await import("./dist/lib/sequence.js");

// ---------- units
async function ensureUnit(name) {
  const existing = await prisma.unitOfMeasure.findFirst({ where: { tenantId: tid, name } });
  return existing ?? prisma.unitOfMeasure.create({ data: { tenantId: tid, name, measurementKind: "EACH" } });
}
const piece = await ensureUnit("Piece");
const pair = await ensureUnit("Pair");

// ---------- products
const tissueOld = await prisma.product.findFirst({ where: { tenantId: tid, name: "Tissue 1 Pc" } });
if (tissueOld && !(await prisma.product.findFirst({ where: { tenantId: tid, name: "Tissue Paper" } }))) {
  await prisma.product.update({ where: { id: tissueOld.id }, data: { name: "Tissue Paper" } });
  console.log('Renamed "Tissue 1 Pc" -> "Tissue Paper"');
}

let amenities = await prisma.category.findFirst({ where: { tenantId: tid, scope: "STORE", parentId: null, name: "Room Amenities" } });
if (!amenities) amenities = await prisma.category.create({ data: { tenantId: tid, scope: "STORE", name: "Room Amenities", parentId: null, level: 1 } });

for (const name of ["Guest Soap", "Lotion", "Serviettes"]) {
  if (await prisma.product.findFirst({ where: { tenantId: tid, name } })) continue;
  const product = await prisma.product.create({ data: { tenantId: tid, categoryId: amenities.id, name, unit: "pc", unitCost: null, sellsDirectly: false } });
  await prisma.$transaction((tx) => recordStockMovement(tx, { tenantId: tid, productId: product.id, locationId: mainStore.id, type: "OPENING_STOCK", quantity: 0, note: "Room amenity product created for room supplies — cost/stock to be filled in" }));
  console.log(`Created product: ${name}`);
}

const SHELF = { "Coffee Sachets": 180, "Chocolate Sachets 10 Gms": 180, "Sugar Sachets": 365, "Mineral Water 500 Ml": 365, Lotion: 365 };
const productIdByName = {};
const CONSUMABLES = [
  // [product name, max per room, starting per room]
  ["Tissue Paper", 1, 1],
  ["Chocolate Sachets 10 Gms", 4, 1],
  ["Coffee Sachets", 4, 1],
  ["Sugar Sachets", 6, 3],
  ["Guest Soap", 2, 1],
  ["Mineral Water 500 Ml", 2, 1],
  ["Lotion", 2, 1],
  ["Serviettes", 10, 5],
];
for (const [name] of CONSUMABLES) {
  const p = await prisma.product.findFirstOrThrow({ where: { tenantId: tid, name } });
  productIdByName[name] = p.id;
  if (SHELF[name]) await prisma.product.update({ where: { id: p.id }, data: { isPerishable: true, shelfLifeDays: SHELF[name] } });
}
console.log("Shelf lives set:", JSON.stringify(SHELF));

// ---------- room types + rooms in scope
const roomTypes = await prisma.roomType.findMany({ where: { tenantId: tid, name: { in: ["Standard", "Superior", "Deluxe"] } }, include: { rooms: { select: { id: true, number: true } } } });
const rooms = roomTypes.flatMap((t) => t.rooms.map((r) => ({ ...r, typeName: t.name })));
console.log(`Rooms in scope: ${rooms.length} (${roomTypes.map((t) => `${t.name}:${t.rooms.length}`).join(", ")})`);

// ---------- maximums per room type
for (const t of roomTypes) {
  for (const [name, max] of CONSUMABLES) {
    await prisma.roomConsumableStandard.upsert({
      where: { tenantId_roomTypeId_productId: { tenantId: tid, roomTypeId: t.id, productId: productIdByName[name] } },
      create: { tenantId: tid, roomTypeId: t.id, productId: productIdByName[name], quantity: max },
      update: { quantity: max },
    });
  }
}
console.log(`Maximums set: ${roomTypes.length} room types x ${CONSUMABLES.length} products`);

// ---------- starting stock in every room
const now = new Date();
let stockCreated = 0;
for (const room of rooms) {
  for (const [name, , start] of CONSUMABLES) {
    const productId = productIdByName[name];
    const existing = await prisma.roomConsumableStock.findUnique({ where: { tenantId_roomId_productId: { tenantId: tid, roomId: room.id, productId } } });
    if (existing) continue;
    await prisma.roomConsumableStock.create({ data: { tenantId: tid, roomId: room.id, productId, quantity: start, firstPlacedAt: now, lastReplacedAt: now } });
    stockCreated++;
  }
}
console.log(`Room consumable stock rows created: ${stockCreated}`);

// ---------- fixed assets
const CATEGORY_NAMES = ["Furniture", "Linen & Soft Furnishings", "Electricals & Appliances", "Room Accessories"];
const assetCategory = {};
for (const name of CATEGORY_NAMES) {
  assetCategory[name] = (await prisma.category.findFirst({ where: { tenantId: tid, scope: "ASSETS", parentId: null, name } }))
    ?? (await prisma.category.create({ data: { tenantId: tid, scope: "ASSETS", name, parentId: null, level: 1 } }));
}

// [name, category, quantity, unit, superior/deluxe only]
const ASSETS = [
  ["Bed", "Furniture", 1], ["Mattress", "Furniture", 1], ["Cupboard", "Furniture", 2], ["Wardrobe", "Furniture", 1],
  ["Chair", "Furniture", 1], ["Dressing Mirror", "Furniture", 1],
  ["Bedsheets", "Linen & Soft Furnishings", 2], ["Pillows", "Linen & Soft Furnishings", 2], ["Throw Pillows & Covers", "Linen & Soft Furnishings", 2],
  ["Bed Runner", "Linen & Soft Furnishings", 1], ["Bath Towel", "Linen & Soft Furnishings", 2], ["Curtain", "Linen & Soft Furnishings", 1],
  ["Floor Mats", "Linen & Soft Furnishings", 3], ["Slippers", "Linen & Soft Furnishings", 2, "Pair"],
  ["Television", "Electricals & Appliances", 1], ["Telephone", "Electricals & Appliances", 1], ["Hot Kettle", "Electricals & Appliances", 1],
  ["Iron Box", "Electricals & Appliances", 1], ["Hair Dryer", "Electricals & Appliances", 1], ["Fridge", "Electricals & Appliances", 1, "Piece", true],
  ["Dustbin", "Room Accessories", 1], ["Wall Art", "Room Accessories", 1], ["Hangers", "Room Accessories", 5],
  ["Water Glass", "Room Accessories", 1], ["Tea Cup", "Room Accessories", 2], ["Iron Board", "Room Accessories", 1],
];

let assetsCreated = 0;
for (const room of rooms) {
  for (const [name, cat, quantity, unitName = "Piece", upperOnly = false] of ASSETS) {
    if (upperOnly && room.typeName === "Standard") continue;
    if (await prisma.asset.findFirst({ where: { tenantId: tid, roomId: room.id, name } })) continue;
    const assetNo = await nextAssetNo(tid);
    await prisma.$transaction(async (tx) => {
      const created = await tx.asset.create({ data: { tenantId: tid, assetNo, categoryId: assetCategory[cat].id, name, unitId: unitName === "Pair" ? pair.id : piece.id, quantity, roomId: room.id } });
      await tx.assetMovement.create({ data: { tenantId: tid, assetId: created.id, type: "RECEIPT", quantity, note: "Opening quantity" } });
    });
    assetsCreated++;
  }
}
console.log(`Room assets created: ${assetsCreated}`);

const [assets, fridges, stocks, standards] = await Promise.all([
  prisma.asset.count({ where: { tenantId: tid, roomId: { not: null } } }),
  prisma.asset.count({ where: { tenantId: tid, name: "Fridge" } }),
  prisma.roomConsumableStock.count({ where: { tenantId: tid } }),
  prisma.roomConsumableStandard.count({ where: { tenantId: tid } }),
]);
console.log(`Totals now: room assets=${assets} (fridges=${fridges}) roomConsumableStock=${stocks} standards=${standards}`);
await prisma.$disconnect();
