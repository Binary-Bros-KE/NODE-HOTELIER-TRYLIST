import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { nextCustomerNo } from "../../lib/sequence.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { resolveActorLocation } from "../../lib/location.js";

export const customersRouter = Router();
customersRouter.use(requireModule("CUSTOMERS"));

const customerTypes = ["PERSONAL", "BUSINESS"] as const;
const customerStatuses = ["ACTIVE", "INACTIVE", "BLOCKED"] as const;
const genders = ["MALE", "FEMALE", "OTHER"] as const;
const preferredLanguages = ["ENGLISH", "SWAHILI", "OTHER"] as const;
const contactMethods = ["PHYSICAL", "CALL", "WHATSAPP", "EMAIL"] as const;
const currencies = ["KES", "UGX", "TZS", "USD"] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalEmail = z.preprocess(blankToUndefined, z.email().optional());
const optionalDate = z.preprocess(blankToUndefined, z.coerce.date().optional());
const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) => z.preprocess(blankToUndefined, z.enum(values).optional());

// Only first name + phone are required — everything else here just builds a
// fuller customer profile over time, not something any sale depends on.
const createSchema = z.object({
  customerType: z.enum(customerTypes).default("PERSONAL"),
  firstName: z.string().trim().min(1).max(60),
  lastName: optionalText(60),
  email: optionalEmail,
  phone: z.string().trim().min(1).max(30),

  nationality: optionalText(60),
  idNumber: optionalText(40),
  occupation: optionalText(80),
  gender: optionalEnum(genders),
  dob: optionalDate,

  carModel: optionalText(60),
  carRegistration: optionalText(30),
  carColour: optionalText(30),

  status: z.enum(customerStatuses).default("ACTIVE"),
  address: optionalText(255),
  notes: optionalText(2000),

  businessName: optionalText(150),
  registrationNumber: optionalText(60),
  kraPin: optionalText(20),
  contactPerson: optionalText(80),
  billingPhone: optionalText(30),
  billingEmail: optionalEmail,
  website: optionalText(150),

  preferredLanguage: optionalEnum(preferredLanguages),
  preferredCurrency: optionalEnum(currencies),
  contactMethod: optionalEnum(contactMethods),
  marketingConsent: z.boolean().default(false),
  loyaltyPoints: z.coerce.number().int().min(0).default(0),

  emergencyContactName: optionalText(80),
  emergencyContactRelationship: optionalText(60),
  emergencyContactPhone: optionalText(30),
});
const updateSchema = partialNoDefaults(createSchema);

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const listSchema = z.object({
  search: optionalText(120),
  status: optionalEnum(customerStatuses),
  customerType: optionalEnum(customerTypes),
});

const auditInclude = {
  createdByEmployee: { select: { id: true, firstName: true, lastName: true } },
  updatedByEmployee: { select: { id: true, firstName: true, lastName: true } },
  location: { select: { id: true, name: true } },
} satisfies Prisma.CustomerInclude;

customersRouter.get("/", async (req, res) => {
  const query = listSchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid query" }); return; }
  const { search, status, customerType } = query.data;

  const customers = await prisma.customer.findMany({
    where: {
      tenantId: tenantId(req),
      status,
      customerType,
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: "insensitive" } },
              { lastName: { contains: search, mode: "insensitive" } },
              { phone: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
              { customerNo: { contains: search, mode: "insensitive" } },
              { businessName: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: auditInclude,
    orderBy: { createdAt: "desc" },
  });
  res.json({ customers });
});

customersRouter.get("/:id", async (req, res) => {
  const customer = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: auditInclude });
  if (!customer) { res.status(404).json({ error: "Customer not found" }); return; }
  res.json({ customer });
});

/** The customer's credit statement: every balance movement newest-first,
 * plus their current balance and how many times / how much they've taken on
 * credit. */
customersRouter.get("/:id/credit-entries", async (req, res) => {
  const tid = tenantId(req);
  const customer = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, balance: true } });
  if (!customer) { res.status(404).json({ error: "Customer not found" }); return; }
  const [entries, credits] = await Promise.all([
    prisma.customerCreditEntry.findMany({
      where: { tenantId: tid, customerId: customer.id },
      orderBy: { createdAt: "desc" },
      include: { order: { select: { orderNumber: true } } },
    }),
    prisma.customerCreditEntry.aggregate({
      where: { tenantId: tid, customerId: customer.id, type: "CREDIT" },
      _sum: { amount: true },
      _count: true,
    }),
  ]);
  res.json({
    balance: customer.balance,
    entries,
    creditCount: credits._count,
    totalCreditTaken: credits._sum.amount ?? 0,
  });
});

customersRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid customer", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const customerNo = await nextCustomerNo(tid);
    const locationId = await resolveActorLocation(tid, req.userId);
    const customer = await prisma.customer.create({ data: { tenantId: tid, customerNo, createdBy: req.userId, locationId, ...data.data }, include: auditInclude });
    res.status(201).json({ customer });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A customer with this number already exists — try again" }); return; }
    next(error);
  }
});

customersRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid customer", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    // A business record has no personal surname — if the form just flipped
    // this customer to BUSINESS, drop any lastName left over from before so
    // it can't linger and show up next to the business name everywhere the
    // app renders "firstName lastName".
    const clearLastName = data.data.customerType === "BUSINESS" ? { lastName: null } : {};
    const updated = await prisma.customer.updateMany({ where: { id: req.params.id, tenantId: tid }, data: { ...data.data, ...clearLastName, updatedBy: req.userId } });
    if (!updated.count) { res.status(404).json({ error: "Customer not found" }); return; }
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: req.params.id }, include: auditInclude });
    res.json({ customer });
  } catch (error) {
    next(error);
  }
});

customersRouter.delete("/:id", async (req, res, next) => {
  const tid = tenantId(req);
  try {
    const deleted = await prisma.customer.deleteMany({ where: { id: req.params.id, tenantId: tid } });
    if (!deleted.count) { res.status(404).json({ error: "Customer not found" }); return; }
    res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") { res.status(409).json({ error: "This customer has reservations on file and can't be deleted" }); return; }
    next(error);
  }
});
