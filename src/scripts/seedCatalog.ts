// Fills out the multi-location selling-point picture: new selling points
// (three named bars, a bakery, a candy shop, a housekeeping supply point),
// corrected canSellX flags per location type, bar liquor tracked in ml with
// real recipe-based cocktails/tots, and deliberately varied product/menu/
// service location-scoping so the "product/menu item at one, several, or
// every location" cases are all real, visible data — not just theory.
// Idempotent — safe to re-run; never resets stock that's already been set.
import type { LocationType, CategoryScope, OrderServeMode } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: "hotelier-demo" } });
const tid = tenant.id;

type LocFlags = { canSellRooms: boolean; canSellMenu: boolean; canSellServices: boolean; canSellProducts: boolean; serveMode: OrderServeMode };
// serveMode is just a sensible starting point per type — the owner can
// change it per location from the Locations screen at any time (e.g. a hotel
// bakery that DOES want prep time tracked would switch it to KITCHEN).
const FLAGS_BY_TYPE: Record<LocationType, LocFlags> = {
  RECEPTION: { canSellRooms: true, canSellMenu: false, canSellServices: true, canSellProducts: true, serveMode: "KITCHEN" },
  RESTAURANT: { canSellRooms: false, canSellMenu: true, canSellServices: false, canSellProducts: true, serveMode: "KITCHEN" },
  CAFE: { canSellRooms: false, canSellMenu: true, canSellServices: false, canSellProducts: true, serveMode: "DIRECT" },
  BAKERY: { canSellRooms: false, canSellMenu: true, canSellServices: false, canSellProducts: true, serveMode: "DIRECT" },
  BAR: { canSellRooms: false, canSellMenu: true, canSellServices: false, canSellProducts: true, serveMode: "DIRECT" },
  GYM: { canSellRooms: false, canSellMenu: false, canSellServices: true, canSellProducts: true, serveMode: "KITCHEN" },
  SPA: { canSellRooms: false, canSellMenu: false, canSellServices: true, canSellProducts: true, serveMode: "KITCHEN" },
  STORE: { canSellRooms: false, canSellMenu: false, canSellServices: false, canSellProducts: false, serveMode: "KITCHEN" },
  HOUSEKEEPING: { canSellRooms: false, canSellMenu: false, canSellServices: false, canSellProducts: false, serveMode: "KITCHEN" },
  SHOP: { canSellRooms: false, canSellMenu: false, canSellServices: false, canSellProducts: true, serveMode: "KITCHEN" },
};

async function upsertLocation(name: string, type: keyof typeof FLAGS_BY_TYPE) {
  const flags = FLAGS_BY_TYPE[type];
  return prisma.location.upsert({
    where: { tenantId_name: { tenantId: tid, name } },
    update: { type, ...flags },
    create: { tenantId: tid, name, type, ...flags },
  });
}

// The property originally had one generic bar — the user wants three named
// ones, so the first run renames it into "Main Bar" instead of leaving a
// fourth, orphaned "BAR & LOUNGE" location behind.
const legacyBar = await prisma.location.findFirst({ where: { tenantId: tid, name: "BAR & LOUNGE" } });
if (legacyBar) await prisma.location.update({ where: { id: legacyBar.id }, data: { name: "Main Bar" } });

await upsertLocation("Main Bar", "BAR");
await upsertLocation("Backyard Bar", "BAR");
await upsertLocation("Rooftop Bar", "BAR");
await upsertLocation("Bakery", "BAKERY");
await upsertLocation("Candy Shop", "SHOP");
await upsertLocation("Housekeeping", "HOUSEKEEPING");

// Correct canSellX on every location, old and new alike — the property's
// existing locations all wrongly defaulted every flag to true.
const allLocations = await prisma.location.findMany({ where: { tenantId: tid } });
for (const loc of allLocations) {
  const flags = FLAGS_BY_TYPE[loc.type];
  if (flags) await prisma.location.update({ where: { id: loc.id }, data: flags });
}

const locations = await prisma.location.findMany({ where: { tenantId: tid } });
function loc(name: string) {
  const found = locations.find((l) => l.name === name);
  if (!found) throw new Error(`Seed error: location "${name}" not found`);
  return found;
}
const mainBar = loc("Main Bar");
const backyardBar = loc("Backyard Bar");
const rooftopBar = loc("Rooftop Bar");
const bakery = loc("Bakery");
const candyShop = loc("Candy Shop");
const housekeeping = loc("Housekeeping");
const reception = loc("RECEPTION");
const receptionTwo = loc("Reception Two");
const restaurant = loc("RESTAURANT");
const cafe = loc("MAIN CAFE");
const gym = loc("GYMN");
const spa = loc("SPA");

async function upsertCategory(scope: CategoryScope, name: string) {
  const existing = await prisma.category.findFirst({ where: { tenantId: tid, scope, parentId: null, name } });
  if (existing) return existing;
  return prisma.category.create({ data: { tenantId: tid, scope, name, parentId: null, level: 1 } });
}

const catSpirits = await upsertCategory("BAR", "Spirits");
const catCocktails = await upsertCategory("BAR", "Cocktails");
const catBeer = await upsertCategory("BAR", "Beer & Cider");
await upsertCategory("BAR", "Soft Drinks & Mixers");
const catToiletries = await upsertCategory("STORE", "Toiletries & Wellness");
const catSnacks = await upsertCategory("STORE", "Snacks & Beverages");
const catGifts = await upsertCategory("STORE", "Gifts & Sundries");
const catBarStock = await upsertCategory("STORE", "Bar Stock");

async function upsertProduct(data: { name: string; categoryId: string; unit: string; sellingPrice?: number; unitCost?: number }) {
  const existing = await prisma.product.findFirst({ where: { tenantId: tid, name: data.name } });
  if (existing) return existing;
  return prisma.product.create({ data: { tenantId: tid, categoryId: data.categoryId, name: data.name, unit: data.unit, sellsDirectly: data.sellingPrice != null, sellingPrice: data.sellingPrice, unitCost: data.unitCost } });
}

// Sets opening stock exactly once — a re-run never resets stock that's
// already been distributed, sold, or adjusted since the first seed.
async function setOpeningStock(productId: string, locationId: string, quantity: number) {
  const existing = await prisma.productStock.findFirst({ where: { tenantId: tid, productId, locationId } });
  if (existing) return;
  await prisma.$transaction([
    prisma.productStock.create({ data: { tenantId: tid, productId, locationId, quantity } }),
    prisma.inventoryMovement.create({ data: { tenantId: tid, productId, locationId, type: "OPENING_STOCK", quantity, balanceBefore: 0, balanceAfter: quantity, note: "Seed data — opening stock" } }),
  ]);
}

// ---------- Retail products: deliberately varied location overlap ----------
const bottledWater = await upsertProduct({ name: "Bottled Water 500ml", categoryId: catSnacks.id, unit: "Bottle", sellingPrice: 100 });
const bodyLotion = await upsertProduct({ name: "Body Lotion 200ml", categoryId: catToiletries.id, unit: "Bottle", sellingPrice: 450 });
const energyBar = await upsertProduct({ name: "Energy Bar", categoryId: catSnacks.id, unit: "Each", sellingPrice: 150 });
const scentedCandle = await upsertProduct({ name: "Scented Candle", categoryId: catToiletries.id, unit: "Each", sellingPrice: 800 });
const candyPack = await upsertProduct({ name: "Assorted Candy Pack", categoryId: catSnacks.id, unit: "Pack", sellingPrice: 200 });
const postcardSet = await upsertProduct({ name: "Postcard Set", categoryId: catGifts.id, unit: "Pack", sellingPrice: 250 });
const chargerCable = await upsertProduct({ name: "Phone Charger Cable", categoryId: catGifts.id, unit: "Each", sellingPrice: 500 });
await upsertProduct({ name: "Sunscreen SPF50", categoryId: catToiletries.id, unit: "Bottle", sellingPrice: 600 }); // catalogued, no stock anywhere yet

await setOpeningStock(bottledWater.id, reception.id, 50);
await setOpeningStock(bottledWater.id, gym.id, 40);
await setOpeningStock(bottledWater.id, spa.id, 30);
await setOpeningStock(bottledWater.id, candyShop.id, 60);

await setOpeningStock(bodyLotion.id, spa.id, 25);
await setOpeningStock(bodyLotion.id, gym.id, 15);

await setOpeningStock(energyBar.id, gym.id, 60);
await setOpeningStock(scentedCandle.id, spa.id, 20);
await setOpeningStock(candyPack.id, candyShop.id, 100);

await setOpeningStock(postcardSet.id, reception.id, 40);
await setOpeningStock(postcardSet.id, candyShop.id, 40);

await setOpeningStock(chargerCable.id, reception.id, 20);

// ---------- Bar liquor/mixers: tracked in ml so tots/cocktails can draw fractional amounts ----------
const rum = await upsertProduct({ name: "White Rum", categoryId: catBarStock.id, unit: "Millilitres" });
const vodka = await upsertProduct({ name: "Vodka", categoryId: catBarStock.id, unit: "Millilitres" });
const whiskey = await upsertProduct({ name: "Whiskey", categoryId: catBarStock.id, unit: "Millilitres" });
const gin = await upsertProduct({ name: "Gin", categoryId: catBarStock.id, unit: "Millilitres" });
const tonicWater = await upsertProduct({ name: "Tonic Water", categoryId: catBarStock.id, unit: "Millilitres" });
const sodaWater = await upsertProduct({ name: "Soda Water", categoryId: catBarStock.id, unit: "Millilitres" });
const sugarSyrup = await upsertProduct({ name: "Sugar Syrup", categoryId: catBarStock.id, unit: "Millilitres" });
const freshLime = await upsertProduct({ name: "Fresh Lime", categoryId: catBarStock.id, unit: "Each" });
const tuskerLager = await upsertProduct({ name: "Tusker Lager", categoryId: catBarStock.id, unit: "Each" });

await setOpeningStock(rum.id, mainBar.id, 3000);
await setOpeningStock(rum.id, backyardBar.id, 2000);
await setOpeningStock(rum.id, rooftopBar.id, 1500);

await setOpeningStock(vodka.id, mainBar.id, 2500);
await setOpeningStock(vodka.id, rooftopBar.id, 1800);
// Deliberately no Vodka at Backyard Bar — demonstrates a two-of-three spread.

await setOpeningStock(whiskey.id, mainBar.id, 2250);
// Whiskey only at Main Bar.

await setOpeningStock(gin.id, backyardBar.id, 1400);
await setOpeningStock(tonicWater.id, backyardBar.id, 4000);
// Gin & Tonic ingredients only at Backyard Bar — the drink is Backyard-exclusive.

await setOpeningStock(sodaWater.id, mainBar.id, 5000);
await setOpeningStock(sodaWater.id, backyardBar.id, 4500);
await setOpeningStock(sodaWater.id, rooftopBar.id, 4000);

await setOpeningStock(sugarSyrup.id, mainBar.id, 2000);
await setOpeningStock(sugarSyrup.id, backyardBar.id, 1800);
await setOpeningStock(sugarSyrup.id, rooftopBar.id, 1500);

await setOpeningStock(freshLime.id, mainBar.id, 100);
await setOpeningStock(freshLime.id, backyardBar.id, 80);
await setOpeningStock(freshLime.id, rooftopBar.id, 60);

await setOpeningStock(tuskerLager.id, mainBar.id, 48);
await setOpeningStock(tuskerLager.id, backyardBar.id, 36);
await setOpeningStock(tuskerLager.id, rooftopBar.id, 24);

// ---------- Recipes: the actual bar-inventory answer — fractional, multi-ingredient, reusing Kitchen's mechanism ----------
async function upsertRecipe(name: string, ingredients: { productId: string; quantity: number }[]) {
  let recipe = await prisma.recipe.findFirst({ where: { tenantId: tid, name } });
  if (!recipe) recipe = await prisma.recipe.create({ data: { tenantId: tid, name } });
  await prisma.recipeIngredient.deleteMany({ where: { recipeId: recipe.id } });
  await prisma.recipeIngredient.createMany({ data: ingredients.map((i) => ({ recipeId: recipe.id, productId: i.productId, quantity: i.quantity })) });
  return recipe;
}

const mojitoRecipe = await upsertRecipe("Mojito", [
  { productId: rum.id, quantity: 50 },
  { productId: sodaWater.id, quantity: 100 },
  { productId: freshLime.id, quantity: 1 },
  { productId: sugarSyrup.id, quantity: 20 },
]);
const ginTonicRecipe = await upsertRecipe("Gin & Tonic", [
  { productId: gin.id, quantity: 40 },
  { productId: tonicWater.id, quantity: 150 },
]);
const whiskeyTotRecipe = await upsertRecipe("Whiskey Tot", [{ productId: whiskey.id, quantity: 25 }]);
const vodkaTotRecipe = await upsertRecipe("Vodka Tot", [{ productId: vodka.id, quantity: 25 }]);

// ---------- Bar menu items: one whole-unit, two single-ingredient tots, two multi-ingredient cocktails ----------
const menuCategoryCache = new Map<string, string>();
async function menuCategoryIdFor(name: string): Promise<string> {
  const cached = menuCategoryCache.get(name);
  if (cached) return cached;
  const mc = await prisma.menuCategory.upsert({
    where: { tenantId_name: { tenantId: tid, name } },
    update: {},
    create: { tenantId: tid, name },
  });
  menuCategoryCache.set(name, mc.id);
  return mc.id;
}
async function upsertMenuItem(data: { category: { id: string; name: string }; name: string; description?: string; price: number; productId?: string; recipeId?: string }) {
  const menuCategoryId = await menuCategoryIdFor(data.category.name);
  const base = { categoryId: data.category.id, menuCategoryId, price: data.price, productId: data.productId ?? null, recipeId: data.recipeId ?? null };
  let item = await prisma.menuItem.findFirst({ where: { tenantId: tid, name: data.name } });
  if (!item) item = await prisma.menuItem.create({ data: { tenantId: tid, name: data.name, description: data.description, temperature: "OTHER", ...base } });
  else item = await prisma.menuItem.update({ where: { id: item.id }, data: base });
  return item;
}
async function scopeMenuItem(id: string, locationIds: string[]) {
  await prisma.menuItem.update({ where: { id }, data: { locations: { set: locationIds.map((locationId) => ({ id: locationId })) } } });
}

const mojito = await upsertMenuItem({ category: catCocktails, name: "Mojito", description: "White rum, soda, fresh lime, mint sugar syrup", price: 650, recipeId: mojitoRecipe.id });
await scopeMenuItem(mojito.id, [mainBar.id, backyardBar.id, rooftopBar.id]);

const ginTonic = await upsertMenuItem({ category: catCocktails, name: "Gin & Tonic", description: "London dry gin over tonic and ice", price: 600, recipeId: ginTonicRecipe.id });
await scopeMenuItem(ginTonic.id, [backyardBar.id]);

const whiskeyTot = await upsertMenuItem({ category: catSpirits, name: "Whiskey Tot (25ml)", price: 350, recipeId: whiskeyTotRecipe.id });
await scopeMenuItem(whiskeyTot.id, [mainBar.id]);

const vodkaTot = await upsertMenuItem({ category: catSpirits, name: "Vodka Tot (25ml)", price: 300, recipeId: vodkaTotRecipe.id });
await scopeMenuItem(vodkaTot.id, [mainBar.id, rooftopBar.id]);

const tuskerBottle = await upsertMenuItem({ category: catBeer, name: "Tusker Lager (Bottle)", price: 250, productId: tuskerLager.id });
await scopeMenuItem(tuskerBottle.id, [mainBar.id, backyardBar.id, rooftopBar.id]);

// ---------- Re-scope existing Restaurant-category menu items for variety ----------
async function scopeExistingMenuItem(name: string, locationIds: string[]) {
  const item = await prisma.menuItem.findFirst({ where: { tenantId: tid, name } });
  if (!item) return;
  await scopeMenuItem(item.id, locationIds);
}
await scopeExistingMenuItem("Butter Croissant", [bakery.id, restaurant.id]);
await scopeExistingMenuItem("Blueberry Muffin", [bakery.id]);
await scopeExistingMenuItem("Chocolate Cake Slice", [restaurant.id]);
await scopeExistingMenuItem("Cold Brew", [cafe.id, restaurant.id]);
await scopeExistingMenuItem("Iced Latte", [cafe.id, restaurant.id]);
await scopeExistingMenuItem("Mango Smoothie", [cafe.id, restaurant.id]);
await scopeExistingMenuItem("Fresh Lemonade", [cafe.id, restaurant.id]);
// Americano, Cappuccino, Espresso, Masala Tea, Caffè Latte deliberately left
// unscoped — the "sellable everywhere" control case.

// ---------- Re-scope existing Services ----------
async function scopeService(name: string, locationIds: string[]) {
  const service = await prisma.service.findFirst({ where: { tenantId: tid, name } });
  if (!service) return;
  await prisma.service.update({ where: { id: service.id }, data: { locations: { set: locationIds.map((id) => ({ id })) } } });
}
await scopeService("60-Minute Massage", [spa.id]);
await scopeService("Extra Bed", [reception.id, receptionTwo.id]);
await scopeService("Laundry — Shirt", [housekeeping.id]);
// Airport Transfer, BREAKFAST, LUNCH left unscoped (property-wide).

// ---------- Tables: scope the existing dine-in tables to Restaurant, and give every
// counter-service location (bars, cafe, bakery — none of which had a table of
// their own) a default counter table. Table.label is unique per tenant, so
// each gets its own name; the POS auto-selects whichever one starts with
// "Counter" for the current location. ----------
await prisma.table.updateMany({ where: { tenantId: tid, label: { in: ["T1", "T2", "T3", "T4", "P1", "P2"] }, locationId: null }, data: { locationId: restaurant.id } });

async function upsertCounterTable(locationName: string, locationId: string) {
  const label = `Counter — ${locationName}`;
  const existing = await prisma.table.findFirst({ where: { tenantId: tid, label } });
  if (existing) return existing;
  return prisma.table.create({ data: { tenantId: tid, label, locationId } });
}
await upsertCounterTable("Main Bar", mainBar.id);
await upsertCounterTable("Backyard Bar", backyardBar.id);
await upsertCounterTable("Rooftop Bar", rooftopBar.id);
await upsertCounterTable("Cafe", cafe.id);
await upsertCounterTable("Bakery", bakery.id);

console.log("Catalog seeded: locations corrected, bar recipes wired, retail products distributed with varied overlap.");
await prisma.$disconnect();
