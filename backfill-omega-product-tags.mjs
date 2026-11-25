/**
 * Omega Gardens — tag every product with the operations it belongs to.
 *
 *   BAR            alcohol and bar stock (beer, spirits, wines, tots, cigarettes)
 *   RESTAURANT     cold drinks and wine glasses the kitchen sells too
 *   STORE          food stuffs and kitchen ingredients
 *   HOUSEKEEPING   room amenities (soap, lotion, tissue, sachets, water bottles)
 *   RECEPTION      guest medicines (Panadol, Maramoja)
 *
 * Tags come from the product's category and name, never from stock. Run with
 * DRY_RUN=1 to print the plan only.
 */
import { PrismaPg } from "@prisma/adapter-pg";
import pkg from "@prisma/client";
const { PrismaClient } = pkg;
import dotenv from "dotenv";
dotenv.config();
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const DRY = process.env.DRY_RUN === "1";

const tid = (await prisma.tenant.findUniqueOrThrow({ where: { slug: "omega" } })).id;
const products = await prisma.product.findMany({
  where: { tenantId: tid },
  select: { id: true, name: true, tags: true, category: { select: { name: true, scope: true } } },
  orderBy: { name: "asc" },
});

const BAR_CATEGORIES = new Set(["beer", "whiskey", "gin", "vodka", "rum", "tequila", "cognac", "brandy", "liqueur", "wines", "cigarettes"]);
const COLD_DRINK = /(DELMONTE|KERINGET|REDBULL|REDBUL|SODA|COKE|MINERAL WATER|MINUTE MAID|JUICE|LEMONADE|TONIC|GUARANA|HEINEKEN NON|PINACO|SOFT DRINK)/i;
const ALCOHOL = /(WINE|WHISKY|WHISKEY|VODKA|GIN\b|RUM\b|BRANDY|COGNAC|TOT\b|TOTS\b|BEER|CAN\b|BALOZI|TUSKER|PILSNER|GUINESS|GUINNESS|SNAPP|SMIRNOFF|JAMESON|JACK|JW |J\/W|GILBEY|VICEROY|RICHOT|MARTEL|HENNESSY|HENESSY|REMY|BAILEY|AMARULA|KHALUA|MALIBU|CHIVAS|GLEN|SINGLE|BULLEIT|BALLENTINE|CAMINO|CUERVO|CUEVO|TANQUER|BEEFEATER|MONKEY|VAT|WILLIAM|CAPTAIN|BACARDI|MYERS|ZAPPA|MARTIN|SHERIDAN|SHERIDENT|CELLAR|FOUR COUSIN|NAMAQUA|ROBERTSON|NEDERBURG|FRONTERA|KAGORLUX|DROSTY|DROSTDY|CHAMDOR|4TH|AMOR|KISS ME|CRUZ|FLIRT|HENDRICK|CARIBIA|JOHN BARR|TIA MARIA|GRANT|SOUTHERN COMFORT|TRIPLE SEC|JAGER|SCOTTISH|FAMOUS|FAMOUSE|HUNTER|KINGFISHER|DESPARADO|GUINNESS|HEINEKEN|WHITE CAP|GUARANA|SAINT ANN|GATO|SUMMIT|MOET|COURVOISIER)/i;
const ROOM_AMENITY = /(SOAP|LOTION|TISSUE|SERVIETTE|TOWEL|SLIPPER|SHAMPOO|HANGER|WATER BOTTLE|SUGAR SACHET|COFFEE SACHET|CHOCOLATE SACHET|CHOCOLATE SATCHET|GUEST|HANDWASH)/i;
const MEDICINE = /(PANADOL|MARAMOJA|ENO\b|PAINKILLER)/i;

function tagsFor(p) {
  const cat = (p.category?.name ?? "").toLowerCase();
  const scope = p.category?.scope ?? "";
  const n = p.name;
  if (MEDICINE.test(n)) return ["RECEPTION"];
  if (cat === "room amenities" || (ROOM_AMENITY.test(n) && !/PCT|PACKET/i.test(n))) {
    return /MINERAL WATER/i.test(n) ? ["BAR", "RESTAURANT", "HOUSEKEEPING"] : ["HOUSEKEEPING"];
  }
  if (/\bTOTS?\b/i.test(n)) return ["BAR"];
  if (cat === "soft drinks" || (COLD_DRINK.test(n) && !ALCOHOL.test(n.replace(/MINERAL WATER|SODA|TONIC/gi, "")))) {
    return /MINERAL WATER/i.test(n) ? ["BAR", "RESTAURANT", "HOUSEKEEPING"] : ["BAR", "RESTAURANT"];
  }
  if (cat === "wine glass" || /WINE GLASS/i.test(n)) return ["RESTAURANT"];
  if (BAR_CATEGORIES.has(cat) || (scope === "BAR" && cat !== "soft drinks") || ALCOHOL.test(n)) return ["BAR"];
  return ["STORE"];
}

const plan = products.map((p) => ({ p, tags: tagsFor(p) }));
const byTag = {};
for (const { p, tags } of plan) for (const t of tags) (byTag[t] ??= []).push(p.name);
for (const [t, names] of Object.entries(byTag)) console.log(`${t} (${names.length}): ${names.join(", ")}\n`);
console.log(`Total products: ${products.length}`);

if (!DRY) {
  let changed = 0;
  for (const { p, tags } of plan) {
    const same = tags.length === p.tags.length && tags.every((t) => p.tags.includes(t));
    if (same) continue;
    await prisma.product.update({ where: { id: p.id }, data: { tags } });
    changed++;
  }
  console.log(`Updated ${changed} products.`);
} else {
  console.log("DRY RUN - nothing written.");
}
await prisma.$disconnect();
