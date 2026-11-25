/**
 * Square 7 Lounge — go-live reset.
 *
 * Wipes every demo/test TRANSACTIONAL row for this tenant so the real
 * business starts from a clean slate: stock quantities, the stock-movement
 * ledger, and any buying (Purchase/GoodsReceipt/StockTransfer) or selling
 * (PosOrder/Payment/Transaction) records. Deliberately does NOT touch the
 * catalog itself — Products, MenuItems, MenuItemVariants, Categories,
 * prices/costs all stay exactly as imported; only stops carrying stock and
 * history. Real opening stock goes in afterwards through the app itself
 * (Goods Received / opening-stock entry), which will write its own
 * first-real InventoryMovement.
 *
 * Audited first (separate _square7-audit.mjs run, 2026-09-15): 0 PosOrders,
 * 0 Payments, 0 Transactions, 0 Purchases, 0 GoodsReceipts, 0 StockTransfers
 * — everything this deletes is data this same import created, nothing a
 * real user entered.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: "square7" } });
const tid = tenant.id;
console.log(`Tenant: ${tenant.name} (${tid})`);

async function wipe(label, fn) {
  const { count } = await fn();
  console.log(`  ${label}: deleted ${count}`);
  return count;
}

console.log("\nSelling side:");
await wipe("PosOrder (cascades Payment, PosOrderItem, PosOrderItemAddon)", () => prisma.posOrder.deleteMany({ where: { tenantId: tid } }));
await wipe("Transaction", () => prisma.transaction.deleteMany({ where: { tenantId: tid } }));

console.log("\nBuying side:");
await wipe("GoodsReceipt (cascades GoodsReceiptItem) — before Purchase, which it Restricts", () => prisma.goodsReceipt.deleteMany({ where: { tenantId: tid } }));
await wipe("Purchase (cascades PurchaseItem, PurchaseItemMenuPriceUpdate)", () => prisma.purchase.deleteMany({ where: { tenantId: tid } }));
await wipe("PurchaseRequisition (cascades PurchaseRequisitionItem)", () => prisma.purchaseRequisition.deleteMany({ where: { tenantId: tid } }));
await wipe("StockTransfer (cascades StockTransferItem)", () => prisma.stockTransfer.deleteMany({ where: { tenantId: tid } }));

console.log("\nStock:");
await wipe("InventoryMovement", () => prisma.inventoryMovement.deleteMany({ where: { tenantId: tid } }));
await wipe("ProductStock", () => prisma.productStock.deleteMany({ where: { tenantId: tid } }));

const [products, menuItems, variants, stockRows, movementRows] = await Promise.all([
  prisma.product.count({ where: { tenantId: tid } }),
  prisma.menuItem.count({ where: { tenantId: tid } }),
  prisma.menuItemVariant.count({ where: { tenantId: tid } }),
  prisma.productStock.count({ where: { tenantId: tid } }),
  prisma.inventoryMovement.count({ where: { tenantId: tid } }),
]);
console.log(`\nCatalog kept intact: products=${products} menuItems=${menuItems} variants=${variants}`);
console.log(`Stock/ledger now empty: productStock=${stockRows} inventoryMovements=${movementRows}`);
console.log("\nReady for go-live: catalog and prices are as imported; every product shows 0 stock until real opening counts are entered through the app.");
await prisma.$disconnect();
