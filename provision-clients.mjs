/**
 * Data-agent provisioning for the three TEST tenants:
 *   Coffee (coffee) · Omega Gardens Hotel and Spa (omega) · Club Homeland (club)
 *
 * Adds, idempotently (safe to re-run — never resets stock already set):
 *   - a TEST-INIT plan (KES 2,000 / mo, 5 branch / 10 users / 10 devices)
 *   - each tenant + its bootstrap (modules, roles, departments, SYSTEM/1234
 *     login, payment methods, business profile, Main Store) if missing
 *   - the locations requested per tenant, with correct canSell / servesDirectly
 *   - a Counter table for every sellable location + dining tables for F&B ones
 *   - menu: restaurant food, alcoholic drinks (ml-tracked recipes), pastries,
 *     cafe drinks — each scoped to the locations that should sell it
 *   - retail products (water, decor/vases, lotions, gifts, snacks) with opening
 *     stock spread across locations
 *   - real bar stock (spirits & mixers in ml, beers by the bottle) at every bar
 *
 * Run against whichever database DATABASE_URL points at:
 *   DATABASE_URL="postgresql://..." node provision-clients.mjs           # all three
 *   DATABASE_URL="postgresql://..." node provision-clients.mjs omega     # just one
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { randomBytes, scryptSync } from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const dbUrl = process.env.DATABASE_URL || "";
if (!dbUrl) {
  console.error("DATABASE_URL is not set. Pass it inline or put it in NODE/.env");
  process.exit(1);
}
console.log("Target DB:", dbUrl.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@"));

const onlySlug = (process.argv[2] || "").trim().toLowerCase() || null;
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }) });

function hashSecret(secret) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(secret, salt, 64).toString("hex")}`;
}

// ------------------------------------------------------------------ bootstrap
const MODULE_KEYS = ["PRODUCTS", "STORE", "POS", "KITCHEN", "ROOMS", "RESERVATIONS", "HOUSEKEEPING", "HR", "REPORTS", "CUSTOMERS"];
const ALL_SECTIONS = ["OVERVIEW", "RECEPTION", "HOUSEKEEPING", "SALES", "KITCHEN", "SERVICE_CENTER", "INVENTORY", "TEAM", "FINANCE", "REPORTS", "SYSTEM"];
const SYSTEM_ROLES = [
  { name: "Super Admin", description: "Full access to every section of the workspace.", allowedSections: ALL_SECTIONS },
  { name: "Manager", description: "Oversees daily operations across the property.", allowedSections: ALL_SECTIONS },
  { name: "Receptionist", description: "Front desk check-in, reservations, and guest billing.", allowedSections: ["OVERVIEW", "RECEPTION"] },
  { name: "Chef", description: "Kitchen orders, menu, and recipes.", allowedSections: ["OVERVIEW", "KITCHEN"] },
  { name: "Waiter", description: "Point of sale, tables, and orders.", allowedSections: ["OVERVIEW", "SALES"] },
  { name: "Housekeeping", description: "Room tasks and cleanliness tracking.", allowedSections: ["OVERVIEW", "HOUSEKEEPING"] },
  { name: "Storekeeper", description: "Inventory, stock, and supplier records.", allowedSections: ["OVERVIEW", "INVENTORY"] },
  { name: "Accountant", description: "Finance, expenses, and reports.", allowedSections: ["OVERVIEW", "FINANCE", "REPORTS"] },
];
const DEFAULT_DEPARTMENTS = ["Reception", "Housekeeping", "Kitchen", "Sales", "Service Center", "Inventory", "Finance", "Management", "Maintenance", "Security"];
const SYSTEM_PAYMENT_METHODS = [
  { name: "Cash", code: "CASH", requiresReference: false, sortOrder: 0 },
  { name: "M-Pesa", code: "MPESA", requiresReference: true, sortOrder: 1 },
  { name: "Card", code: "CARD", requiresReference: true, sortOrder: 2 },
  { name: "Bank Transfer", code: "BANK_TRANSFER", requiresReference: true, sortOrder: 3 },
  { name: "Cheque", code: "CHEQUE", requiresReference: true, sortOrder: 4 },
];

async function provisionBootstrap(tenantId, businessName, businessType, currency) {
  for (const moduleKey of MODULE_KEYS) {
    await prisma.module.upsert({ where: { key: moduleKey }, update: {}, create: { key: moduleKey, name: moduleKey.replace("_", " ") } });
    await prisma.tenantModule.upsert({ where: { tenantId_moduleKey: { tenantId, moduleKey } }, update: { isEnabled: true }, create: { tenantId, moduleKey, isEnabled: true } });
  }
  for (const role of SYSTEM_ROLES) {
    await prisma.role.upsert({
      where: { tenantId_name: { tenantId, name: role.name } },
      update: { description: role.description, allowedSections: role.allowedSections, isSystemRole: true },
      create: { tenantId, name: role.name, description: role.description, allowedSections: role.allowedSections, isSystemRole: true },
    });
  }
  for (const name of DEFAULT_DEPARTMENTS) {
    await prisma.department.upsert({ where: { tenantId_name: { tenantId, name } }, update: {}, create: { tenantId, name } });
  }
  const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: "Super Admin" } } });
  const managementDept = await prisma.department.findUniqueOrThrow({ where: { tenantId_name: { tenantId, name: "Management" } } });
  await prisma.employee.upsert({
    where: { tenantId_employeeCode: { tenantId, employeeCode: "SYSTEM" } },
    update: {},
    create: {
      tenantId, employeeCode: "SYSTEM", pin: hashSecret("1234"),
      firstName: "System", lastName: "Administrator", phone: "0000000000",
      departmentId: managementDept.id, jobTitle: "System Administrator",
      dateHired: new Date(), salaryAmount: 0, roleId: superAdminRole.id, status: "ACTIVE",
    },
  });
  await prisma.location.upsert({
    where: { tenantId_name: { tenantId, name: "Main Store" } },
    update: {},
    create: { tenantId, name: "Main Store", type: "STORE", isActive: true, canSellRooms: false, canSellMenu: false, canSellServices: false, canSellProducts: false },
  });
  await prisma.cafeSettings.upsert({ where: { tenantId }, update: {}, create: { tenantId, cafeName: businessName, currency } });
  await prisma.businessProfile.upsert({
    where: { tenantId }, update: {},
    create: { tenantId, businessName, businessType, currency },
  });
  for (const method of SYSTEM_PAYMENT_METHODS) {
    await prisma.paymentMethod.upsert({ where: { tenantId_code: { tenantId, code: method.code } }, update: {}, create: { tenantId, ...method, isSystem: true } });
  }
}

async function ensurePlan() {
  return prisma.plan.upsert({
    where: { name: "TEST-INIT" },
    update: {},
    create: { name: "TEST-INIT", billingType: "MONTHLY", currency: "KES", monthlyPrice: 2000, supportLevel: "Standard", maxBranches: 5, maxUsers: 10, maxDevices: 10, isActive: true },
  });
}

async function findOrCreateTenant({ name, slug, businessType, currency, planId }) {
  let tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        name, slug, licenseStatus: "TRIAL", planId,
        subscriptionPlan: "TEST-INIT", maxBranches: 5, maxUsers: 10, maxDevices: 10,
        nextDueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    console.log(`  + created tenant "${name}" (${slug})`);
  } else {
    console.log(`  = tenant "${tenant.name}" (${slug}) already exists — adding data only`);
  }
  await provisionBootstrap(tenant.id, name, businessType, currency);
  return tenant;
}

// ------------------------------------------------------------------ helpers
const FLAGS_BY_TYPE = {
  RECEPTION: { canSellRooms: true, canSellMenu: false, canSellServices: true, canSellProducts: true, servesDirectly: false },
  RESTAURANT: { canSellRooms: false, canSellMenu: true, canSellServices: false, canSellProducts: true, servesDirectly: false },
  CAFE: { canSellRooms: false, canSellMenu: true, canSellServices: false, canSellProducts: true, servesDirectly: true },
  BAKERY: { canSellRooms: false, canSellMenu: true, canSellServices: false, canSellProducts: true, servesDirectly: true },
  BAR: { canSellRooms: false, canSellMenu: true, canSellServices: false, canSellProducts: true, servesDirectly: true },
  STORE: { canSellRooms: false, canSellMenu: false, canSellServices: false, canSellProducts: false, servesDirectly: false },
};

function upsertLocation(tid, name, type) {
  const flags = FLAGS_BY_TYPE[type];
  return prisma.location.upsert({
    where: { tenantId_name: { tenantId: tid, name } },
    update: { type, ...flags },
    create: { tenantId: tid, name, type, ...flags },
  });
}

function storeOf(tid) {
  return prisma.location.findFirst({ where: { tenantId: tid, name: "Main Store" } });
}

async function upsertTable(tid, label, locationId, capacity, area) {
  return prisma.table.upsert({
    where: { tenantId_label: { tenantId: tid, label } },
    update: {},
    create: { tenantId: tid, label, locationId, capacity, area },
  });
}

async function tablesFor(tid, loc, diningTables) {
  await upsertTable(tid, `${loc.name} — Counter`, loc.id, 1, loc.name);
  for (let i = 1; i <= diningTables; i++) await upsertTable(tid, `${loc.name} — T${i}`, loc.id, 4, loc.name);
}

async function upsertCategory(tid, scope, name) {
  const existing = await prisma.category.findFirst({ where: { tenantId: tid, scope, parentId: null, name } });
  if (existing) return existing;
  return prisma.category.create({ data: { tenantId: tid, scope, name, parentId: null, level: 1 } });
}

function menuCat(tid, name) {
  return prisma.menuCategory.upsert({ where: { tenantId_name: { tenantId: tid, name } }, update: {}, create: { tenantId: tid, name } });
}

async function upsertProduct(tid, { name, categoryId, unit, sellingPrice, unitCost }) {
  const existing = await prisma.product.findFirst({ where: { tenantId: tid, name } });
  if (existing) return existing;
  return prisma.product.create({ data: { tenantId: tid, categoryId, name, unit, sellingPrice, unitCost } });
}

// Sets opening stock exactly once — a re-run never resets stock already
// distributed, sold, or adjusted since the first pass.
async function setOpeningStock(tid, productId, locationId, quantity) {
  if (!locationId) return;
  const existing = await prisma.productStock.findFirst({ where: { tenantId: tid, productId, locationId } });
  if (existing) return;
  await prisma.$transaction([
    prisma.productStock.create({ data: { tenantId: tid, productId, locationId, quantity } }),
    prisma.inventoryMovement.create({ data: { tenantId: tid, productId, locationId, type: "OPENING_STOCK", quantity, balanceBefore: 0, balanceAfter: quantity, note: "Data-agent seed — opening stock" } }),
  ]);
}

async function upsertRecipe(tid, name, ingredients) {
  let recipe = await prisma.recipe.findFirst({ where: { tenantId: tid, name } });
  if (!recipe) recipe = await prisma.recipe.create({ data: { tenantId: tid, name } });
  await prisma.recipeIngredient.deleteMany({ where: { recipeId: recipe.id } });
  await prisma.recipeIngredient.createMany({ data: ingredients.map((i) => ({ recipeId: recipe.id, productId: i.productId, quantity: i.quantity })) });
  return recipe;
}

async function upsertMenuItem(tid, { menuCategoryId, categoryId, name, description, price, productId, recipeId, temperature, locationIds }) {
  const data = { menuCategoryId, categoryId: categoryId ?? null, price, productId: productId ?? null, recipeId: recipeId ?? null, temperature: temperature ?? "OTHER" };
  let item = await prisma.menuItem.findFirst({ where: { tenantId: tid, name } });
  if (!item) item = await prisma.menuItem.create({ data: { tenantId: tid, name, description: description ?? null, ...data } });
  else item = await prisma.menuItem.update({ where: { id: item.id }, data });
  if (locationIds) await prisma.menuItem.update({ where: { id: item.id }, data: { locations: { set: locationIds.map((id) => ({ id })) } } });
  return item;
}

// ------------------------------------------------------------------ bar catalog
async function ensureBarCatalog(tid) {
  const cat = await upsertCategory(tid, "STORE", "Bar Stock");
  const ml = (name) => upsertProduct(tid, { name, categoryId: cat.id, unit: "Millilitres" });
  const bottle = (name) => upsertProduct(tid, { name, categoryId: cat.id, unit: "Bottle" });
  const p = {};
  p.whiskey = await ml("Whiskey");
  p.vodka = await ml("Vodka");
  p.gin = await ml("Gin");
  p.rum = await ml("White Rum");
  p.brandy = await ml("Brandy");
  p.tequila = await ml("Tequila");
  p.redWine = await ml("Red Wine");
  p.whiteWine = await ml("White Wine");
  p.tonic = await ml("Tonic Water");
  p.soda = await ml("Soda Water");
  p.cola = await ml("Cola");
  p.oj = await ml("Orange Juice");
  p.ginger = await ml("Ginger Ale");
  p.syrup = await ml("Sugar Syrup");
  p.lime = await upsertProduct(tid, { name: "Fresh Lime", categoryId: cat.id, unit: "Each" });
  p.tusker = await bottle("Tusker Lager");
  p.whitecap = await bottle("White Cap Lager");
  p.guinness = await bottle("Guinness Stout");
  p.balozi = await bottle("Balozi Lager");
  p.savanna = await bottle("Savanna Dry Cider");
  return p;
}

async function ensureBarRecipes(tid, p) {
  const r = {};
  r.whiskeyTot = await upsertRecipe(tid, "Whiskey Tot", [{ productId: p.whiskey.id, quantity: 25 }]);
  r.vodkaTot = await upsertRecipe(tid, "Vodka Tot", [{ productId: p.vodka.id, quantity: 25 }]);
  r.ginTot = await upsertRecipe(tid, "Gin Tot", [{ productId: p.gin.id, quantity: 25 }]);
  r.rumTot = await upsertRecipe(tid, "Rum Tot", [{ productId: p.rum.id, quantity: 25 }]);
  r.brandyTot = await upsertRecipe(tid, "Brandy Tot", [{ productId: p.brandy.id, quantity: 25 }]);
  r.tequilaShot = await upsertRecipe(tid, "Tequila Shot", [{ productId: p.tequila.id, quantity: 25 }]);
  r.mojito = await upsertRecipe(tid, "Mojito", [
    { productId: p.rum.id, quantity: 50 }, { productId: p.soda.id, quantity: 100 },
    { productId: p.lime.id, quantity: 1 }, { productId: p.syrup.id, quantity: 20 },
  ]);
  r.gt = await upsertRecipe(tid, "Gin & Tonic", [{ productId: p.gin.id, quantity: 40 }, { productId: p.tonic.id, quantity: 150 }]);
  r.whiskeySour = await upsertRecipe(tid, "Whiskey Sour", [
    { productId: p.whiskey.id, quantity: 50 }, { productId: p.syrup.id, quantity: 20 }, { productId: p.lime.id, quantity: 1 },
  ]);
  r.screwdriver = await upsertRecipe(tid, "Screwdriver", [{ productId: p.vodka.id, quantity: 50 }, { productId: p.oj.id, quantity: 150 }]);
  r.cubaLibre = await upsertRecipe(tid, "Cuba Libre", [
    { productId: p.rum.id, quantity: 50 }, { productId: p.cola.id, quantity: 150 }, { productId: p.lime.id, quantity: 1 },
  ]);
  r.redWineGlass = await upsertRecipe(tid, "Red Wine (Glass 150ml)", [{ productId: p.redWine.id, quantity: 150 }]);
  r.whiteWineGlass = await upsertRecipe(tid, "White Wine (Glass 150ml)", [{ productId: p.whiteWine.id, quantity: 150 }]);
  return r;
}

async function ensureBarMenu(tid, p, r, barLocIds) {
  const cSpirits = await upsertCategory(tid, "BAR", "Spirits");
  const cCocktails = await upsertCategory(tid, "BAR", "Cocktails");
  const cBeer = await upsertCategory(tid, "BAR", "Beer & Cider");
  const cWine = await upsertCategory(tid, "BAR", "Wine");
  const mcSpirits = await menuCat(tid, "Spirits");
  const mcCocktails = await menuCat(tid, "Cocktails");
  const mcBeer = await menuCat(tid, "Beer & Cider");
  const mcWine = await menuCat(tid, "Wine");
  const rows = [
    [cSpirits, mcSpirits, "Whiskey Tot (25ml)", 350, null, r.whiskeyTot.id],
    [cSpirits, mcSpirits, "Vodka Tot (25ml)", 300, null, r.vodkaTot.id],
    [cSpirits, mcSpirits, "Gin Tot (25ml)", 300, null, r.ginTot.id],
    [cSpirits, mcSpirits, "Rum Tot (25ml)", 300, null, r.rumTot.id],
    [cSpirits, mcSpirits, "Brandy Tot (25ml)", 350, null, r.brandyTot.id],
    [cSpirits, mcSpirits, "Tequila Shot (25ml)", 400, null, r.tequilaShot.id],
    [cCocktails, mcCocktails, "Mojito", 650, null, r.mojito.id],
    [cCocktails, mcCocktails, "Gin & Tonic", 600, null, r.gt.id],
    [cCocktails, mcCocktails, "Whiskey Sour", 700, null, r.whiskeySour.id],
    [cCocktails, mcCocktails, "Screwdriver", 600, null, r.screwdriver.id],
    [cCocktails, mcCocktails, "Cuba Libre", 650, null, r.cubaLibre.id],
    [cWine, mcWine, "House Red Wine (Glass)", 500, null, r.redWineGlass.id],
    [cWine, mcWine, "House White Wine (Glass)", 500, null, r.whiteWineGlass.id],
    [cBeer, mcBeer, "Tusker Lager (Bottle)", 250, p.tusker.id, null],
    [cBeer, mcBeer, "White Cap (Bottle)", 250, p.whitecap.id, null],
    [cBeer, mcBeer, "Guinness (Bottle)", 300, p.guinness.id, null],
    [cBeer, mcBeer, "Balozi (Bottle)", 250, p.balozi.id, null],
    [cBeer, mcBeer, "Savanna Dry Cider (Bottle)", 350, p.savanna.id, null],
  ];
  for (const [cat, mc, name, price, productId, recipeId] of rows) {
    await upsertMenuItem(tid, { menuCategoryId: mc.id, categoryId: cat.id, name, price, productId, recipeId, locationIds: barLocIds });
  }
}

async function stockBar(tid, p, locId, level) {
  const base = {
    whiskey: 3000, vodka: 2500, gin: 2000, rum: 2000, brandy: 1500, tequila: 1000,
    redWine: 3000, whiteWine: 3000, tonic: 4000, soda: 5000, cola: 5000, oj: 3000,
    ginger: 3000, syrup: 2000, lime: 100,
    tusker: 48, whitecap: 36, guinness: 24, balozi: 36, savanna: 24,
  };
  const scale = level === "full" ? 1 : level === "most" ? 0.6 : 0.35;
  const skip = level === "lite"
    ? new Set(["brandy", "tequila", "whiteWine", "ginger", "savanna", "balozi"])
    : level === "most" ? new Set(["tequila"]) : new Set();
  for (const [k, qty] of Object.entries(base)) {
    if (skip.has(k)) continue;
    await setOpeningStock(tid, p[k].id, locId, Math.max(1, Math.round(qty * scale)));
  }
}

// ------------------------------------------------------------------ food / pastry / cafe menus
async function ensureFoodMenu(tid, locIds) {
  const cat = await upsertCategory(tid, "RESTAURANT", "Kitchen");
  const mc = await menuCat(tid, "Restaurant");
  const rows = [
    ["Beef Burger & Fries", 850], ["Chicken Wings (6pc)", 700], ["Fish & Chips", 950],
    ["Grilled Chicken (¼)", 650], ["Beef Samosa (2pc)", 200], ["Nyama Choma (½ kg)", 1200],
    ["Pilau with Kachumbari", 550], ["Ugali & Sukuma Wiki", 300], ["Chicken Caesar Salad", 700],
    ["Vegetable Spring Rolls", 450],
  ];
  for (const [name, price] of rows) await upsertMenuItem(tid, { menuCategoryId: mc.id, categoryId: cat.id, name, price, locationIds: locIds });
}

async function ensurePastryMenu(tid, locIds) {
  const cat = await upsertCategory(tid, "RESTAURANT", "Bakery");
  const mc = await menuCat(tid, "Pastries");
  const rows = [
    ["Butter Croissant", 250], ["Almond Croissant", 300], ["Chocolate Muffin", 280],
    ["Blueberry Muffin", 300], ["Cinnamon Roll", 320], ["Danish Pastry", 350],
    ["Glazed Doughnut", 180], ["Buttermilk Scone", 200], ["Carrot Cake Slice", 400],
    ["Sourdough Loaf", 650],
  ];
  for (const [name, price] of rows) await upsertMenuItem(tid, { menuCategoryId: mc.id, categoryId: cat.id, name, price, locationIds: locIds });
}

async function ensureCafeMenu(tid, locIds) {
  const cat = await upsertCategory(tid, "RESTAURANT", "Cafe");
  const mcHot = await menuCat(tid, "Hot Drinks");
  const mcCold = await menuCat(tid, "Cold Drinks");
  const hot = [["Espresso", 200], ["Americano", 250], ["Cappuccino", 300], ["Caffè Latte", 320], ["Flat White", 320], ["Masala Chai", 200], ["Hot Chocolate", 300]];
  const cold = [["Iced Latte", 350], ["Cold Brew", 350], ["Mango Smoothie", 450], ["Fresh Lemonade", 250], ["Iced Tea", 250]];
  for (const [name, price] of hot) await upsertMenuItem(tid, { menuCategoryId: mcHot.id, categoryId: cat.id, name, price, temperature: "HOT", locationIds: locIds });
  for (const [name, price] of cold) await upsertMenuItem(tid, { menuCategoryId: mcCold.id, categoryId: cat.id, name, price, temperature: "COLD", locationIds: locIds });
}

// ------------------------------------------------------------------ retail products
async function standardRetail(tid) {
  const cW = await upsertCategory(tid, "STORE", "Water & Beverages");
  const cT = await upsertCategory(tid, "STORE", "Toiletries & Wellness");
  const cD = await upsertCategory(tid, "STORE", "Decor & Homeware");
  const cG = await upsertCategory(tid, "STORE", "Gifts & Sundries");
  const cS = await upsertCategory(tid, "STORE", "Snacks");
  const mk = (categoryId, name, unit, sellingPrice) => upsertProduct(tid, { name, categoryId, unit, sellingPrice });
  return {
    water500: await mk(cW.id, "Bottled Water 500ml", "Bottle", 100),
    water1l: await mk(cW.id, "Bottled Water 1L", "Bottle", 150),
    sparkling: await mk(cW.id, "Sparkling Water 750ml", "Bottle", 250),
    sodaCan: await mk(cW.id, "Soda Can 330ml", "Can", 120),
    energy: await mk(cW.id, "Energy Drink 250ml", "Can", 250),
    vase: await mk(cD.id, "Decorative Ceramic Vase", "Each", 2500),
    centerpiece: await mk(cD.id, "Table Centerpiece Decor", "Each", 1800),
    candle: await mk(cD.id, "Scented Candle", "Each", 800),
    diffuser: await mk(cD.id, "Reed Diffuser", "Each", 1200),
    wallArt: await mk(cD.id, "Framed Wall Art", "Each", 3500),
    lotion: await mk(cT.id, "Body Lotion 200ml", "Bottle", 450),
    sanitizer: await mk(cT.id, "Hand Sanitizer 100ml", "Bottle", 200),
    sunscreen: await mk(cT.id, "Sunscreen SPF50", "Bottle", 600),
    lipBalm: await mk(cT.id, "Lip Balm", "Each", 250),
    soap: await mk(cT.id, "Lavender Bar Soap", "Each", 150),
    toothbrush: await mk(cT.id, "Travel Toothbrush Kit", "Each", 300),
    postcard: await mk(cG.id, "Postcard Set", "Pack", 250),
    magnet: await mk(cG.id, "Souvenir Fridge Magnet", "Each", 300),
    keychain: await mk(cG.id, "Branded Keychain", "Each", 350),
    charger: await mk(cG.id, "Phone Charger Cable", "Each", 500),
    umbrella: await mk(cG.id, "Compact Umbrella", "Each", 1200),
    towel: await mk(cG.id, "Beach Towel", "Each", 1500),
    nuts: await mk(cS.id, "Assorted Nuts Pack", "Pack", 350),
    crisps: await mk(cS.id, "Potato Crisps", "Pack", 150),
    choc: await mk(cS.id, "Chocolate Bar", "Each", 200),
    gum: await mk(cS.id, "Chewing Gum", "Pack", 100),
    biscuits: await mk(cS.id, "Shortbread Biscuits", "Pack", 250),
  };
}

// ------------------------------------------------------------------ per-tenant builds
async function buildCoffee(planId) {
  console.log("\n### Coffee (coffee)");
  const t = await findOrCreateTenant({ name: "Coffee", slug: "coffee", businessType: "CAFE", currency: "KES", planId });
  const tid = t.id;
  const cafe = await upsertLocation(tid, "Main Cafe", "CAFE");
  const store = await storeOf(tid);
  await tablesFor(tid, cafe, 6);

  await ensureCafeMenu(tid, [cafe.id]);
  await ensurePastryMenu(tid, [cafe.id]);
  await ensureFoodMenu(tid, [cafe.id]);

  const rp = await standardRetail(tid);
  const S = (prod, loc, qty) => setOpeningStock(tid, prod.id, loc?.id, qty);
  await S(rp.water500, cafe, 60); await S(rp.water500, store, 150);
  await S(rp.water1l, cafe, 24); await S(rp.sparkling, cafe, 20);
  await S(rp.sodaCan, cafe, 48); await S(rp.energy, cafe, 24);
  await S(rp.candle, cafe, 12); await S(rp.vase, cafe, 5); await S(rp.diffuser, cafe, 8);
  await S(rp.lotion, cafe, 15); await S(rp.sanitizer, cafe, 30); await S(rp.lipBalm, cafe, 20);
  await S(rp.magnet, cafe, 40); await S(rp.keychain, cafe, 30); await S(rp.postcard, cafe, 25); await S(rp.charger, cafe, 10);
  await S(rp.nuts, cafe, 25); await S(rp.crisps, cafe, 40); await S(rp.choc, cafe, 50); await S(rp.gum, cafe, 40); await S(rp.biscuits, cafe, 20);
  // Framed Wall Art, Sunscreen, Beach Towel, Umbrella deliberately catalogued with no stock yet.
}

async function buildOmega(planId) {
  console.log("\n### Omega Gardens Hotel and Spa (omega)");
  const t = await findOrCreateTenant({ name: "Omega Gardens Hotel and Spa", slug: "omega", businessType: "HOTEL", currency: "KES", planId });
  const tid = t.id;
  const backyard = await upsertLocation(tid, "Backyard Bar", "BAR");
  const reception = await upsertLocation(tid, "Reception", "RECEPTION");
  const bakery = await upsertLocation(tid, "Bakery", "BAKERY");
  const store = await storeOf(tid);
  await tablesFor(tid, backyard, 5);
  await tablesFor(tid, bakery, 3);
  await tablesFor(tid, reception, 0);

  // Fold in any bars/restaurants this tenant already had (Main Bar, Rooftop
  // Bar, Main Reastaurant) so the alcohol menu + stock and the food menu land
  // at every relevant selling point, not just the ones added here.
  const existingBars = await prisma.location.findMany({ where: { tenantId: tid, type: "BAR" } });
  const existingRestaurants = await prisma.location.findMany({ where: { tenantId: tid, type: "RESTAURANT" } });
  const allBars = existingBars; // upsertLocation above already ensured Backyard Bar is in this set
  for (const b of allBars) await tablesFor(tid, b, b.id === backyard.id ? 0 : 4);
  for (const rst of existingRestaurants) await tablesFor(tid, rst, 6);

  const p = await ensureBarCatalog(tid);
  const r = await ensureBarRecipes(tid, p);
  await ensureBarMenu(tid, p, r, allBars.map((b) => b.id));
  const stockLevels = ["full", "most", "lite"];
  for (let i = 0; i < allBars.length; i++) {
    const b = allBars[i];
    await stockBar(tid, p, b.id, b.id === backyard.id ? "full" : stockLevels[Math.min(i, stockLevels.length - 1)]);
  }

  await ensurePastryMenu(tid, [bakery.id]);
  await ensureFoodMenu(tid, [...allBars.map((b) => b.id), ...existingRestaurants.map((x) => x.id)]);

  const rp = await standardRetail(tid);
  const S = (prod, loc, qty) => setOpeningStock(tid, prod.id, loc?.id, qty);
  await S(rp.water500, reception, 60); await S(rp.water500, backyard, 40); await S(rp.water500, bakery, 30); await S(rp.water500, store, 200);
  await S(rp.water1l, reception, 30); await S(rp.water1l, store, 100);
  await S(rp.sparkling, reception, 20); await S(rp.sodaCan, backyard, 48); await S(rp.sodaCan, bakery, 24); await S(rp.energy, backyard, 24);
  await S(rp.vase, reception, 8); await S(rp.centerpiece, reception, 6); await S(rp.candle, reception, 15); await S(rp.diffuser, reception, 10); await S(rp.wallArt, store, 5);
  await S(rp.lotion, reception, 25); await S(rp.sanitizer, reception, 40); await S(rp.sunscreen, reception, 20); await S(rp.lipBalm, reception, 30);
  await S(rp.soap, store, 100); await S(rp.toothbrush, reception, 20);
  await S(rp.postcard, reception, 40); await S(rp.magnet, reception, 50); await S(rp.keychain, reception, 40); await S(rp.charger, reception, 15);
  await S(rp.umbrella, reception, 12); await S(rp.towel, reception, 15);
  await S(rp.nuts, backyard, 30); await S(rp.crisps, backyard, 40); await S(rp.choc, bakery, 30); await S(rp.gum, reception, 50); await S(rp.biscuits, bakery, 20);
}

async function buildClub(planId) {
  console.log("\n### Club Homeland (club)");
  const t = await findOrCreateTenant({ name: "Club Homeland", slug: "club", businessType: "CLUB", currency: "KES", planId });
  const tid = t.id;
  const bc1 = await upsertLocation(tid, "Bar Counter 1", "BAR");
  const bc2 = await upsertLocation(tid, "Bar Counter 2", "BAR");
  const bc3 = await upsertLocation(tid, "Bar Counter 3", "BAR");
  const store = await storeOf(tid);
  for (const bc of [bc1, bc2, bc3]) await tablesFor(tid, bc, 3);

  const p = await ensureBarCatalog(tid);
  const r = await ensureBarRecipes(tid, p);
  await ensureBarMenu(tid, p, r, [bc1.id, bc2.id, bc3.id]);
  await stockBar(tid, p, bc1.id, "full");
  await stockBar(tid, p, bc2.id, "most");
  await stockBar(tid, p, bc3.id, "lite");

  await ensureFoodMenu(tid, [bc1.id, bc2.id, bc3.id]);

  const rp = await standardRetail(tid);
  const S = (prod, loc, qty) => setOpeningStock(tid, prod.id, loc?.id, qty);
  for (const bc of [bc1, bc2, bc3]) {
    await S(rp.water500, bc, 48); await S(rp.sodaCan, bc, 48); await S(rp.energy, bc, 24);
    await S(rp.nuts, bc, 30); await S(rp.crisps, bc, 40); await S(rp.choc, bc, 30); await S(rp.gum, bc, 50);
  }
  await S(rp.water500, store, 300);
  await S(rp.candle, bc1, 10); await S(rp.diffuser, bc1, 6);
  await S(rp.magnet, bc1, 30); await S(rp.keychain, bc1, 30); await S(rp.lipBalm, bc1, 20);
}

// ------------------------------------------------------------------ summary
async function summarise(slug) {
  const t = await prisma.tenant.findUnique({ where: { slug } });
  if (!t) return;
  const [locs, tables, menu, prods, stock, recipes] = await Promise.all([
    prisma.location.count({ where: { tenantId: t.id } }),
    prisma.table.count({ where: { tenantId: t.id } }),
    prisma.menuItem.count({ where: { tenantId: t.id } }),
    prisma.product.count({ where: { tenantId: t.id } }),
    prisma.productStock.count({ where: { tenantId: t.id } }),
    prisma.recipe.count({ where: { tenantId: t.id } }),
  ]);
  console.log(`  ${t.name.padEnd(34)} locations=${locs}  tables=${tables}  menuItems=${menu}  products=${prods}  stockRows=${stock}  recipes=${recipes}`);
}

// ------------------------------------------------------------------ run
try {
  const plan = await ensurePlan();
  console.log(`Plan: ${plan.name} (${plan.id})`);
  if (!onlySlug || onlySlug === "coffee") await buildCoffee(plan.id);
  if (!onlySlug || onlySlug === "omega") await buildOmega(plan.id);
  if (!onlySlug || onlySlug === "club") await buildClub(plan.id);
  console.log("\n--- Summary ---");
  for (const slug of ["coffee", "omega", "club"]) {
    if (!onlySlug || onlySlug === slug) await summarise(slug);
  }
  console.log("\nDone.");
} catch (e) {
  console.error("\nFAILED:", e);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
