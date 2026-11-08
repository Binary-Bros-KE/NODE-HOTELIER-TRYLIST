import type { Prisma } from "@prisma/client";

import { prisma } from "./prisma.js";

/**
 * The rules every path that creates or edits a customer applies, so a waiter's quick
 * "new customer" can't do what the full form refuses:
 *  - an ID / passport number belongs to one customer only (blank is fine);
 *  - placeholder IDs ("000000") and phones ("0000", "8888") are refused;
 *  - a real phone is required only when the property's Super Admin has switched
 *    "Require a phone number" on (BusinessProfile.requireCustomerPhone); otherwise
 *    it may be left blank.
 * Throws { status } errors the global error handler turns into responses.
 */

type Db = Prisma.TransactionClient | typeof prisma;

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** Comparable form of an ID number: no spaces or dashes, upper-case. */
export const normalizeIdNumber = (value: string) => value.replace(/[\s-]/g, "").toUpperCase();

const isPlaceholder = (value: string) => /^(.)\1*$/.test(value); // 000000, 8888, xxxx

/** A phone that can actually be called: at least 9 digits, not one digit repeated. */
export function isRealPhone(phone: string | null | undefined) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length >= 9 && !isPlaceholder(digits.slice(-9));
}

export async function assertCustomerRules(
  db: Db,
  tenantId: string,
  input: { phone?: string | null; idNumber?: string | null },
  options: { excludeCustomerId?: string; checkPhone: boolean; checkIdNumber: boolean },
) {
  if (options.checkIdNumber && input.idNumber && input.idNumber.trim()) {
    const id = normalizeIdNumber(input.idNumber.trim());
    if (id.length < 4 || isPlaceholder(id)) throw fail(400, "Enter the customer's real ID or passport number, or leave it blank");
    // Compare normalized: "2492 4631" and "24924631" are the same ID.
    const others = await db.customer.findMany({
      where: { tenantId, idNumber: { not: null }, ...(options.excludeCustomerId ? { id: { not: options.excludeCustomerId } } : {}) },
      select: { customerNo: true, firstName: true, lastName: true, idNumber: true },
    });
    const owner = others.find((c) => c.idNumber && normalizeIdNumber(c.idNumber) === id);
    if (owner) throw fail(409, `ID number ${input.idNumber.trim()} already belongs to ${`${owner.firstName} ${owner.lastName ?? ""}`.trim()} (${owner.customerNo}) - use that customer instead`);
  }
  if (options.checkPhone) {
    const phone = String(input.phone ?? "").trim();
    const profile = await db.businessProfile.findUnique({ where: { tenantId }, select: { requireCustomerPhone: true } });
    if (profile?.requireCustomerPhone) {
      if (!isRealPhone(phone)) throw fail(400, "Please enter a valid phone number");
    } else if (phone && /^\D*0*\D*$/.test(phone)) {
      // Not required, but a row of zeros is never a number: leave it blank instead.
      throw fail(400, "Leave the phone blank if the customer has none - don't type zeros");
    }
  }
}
