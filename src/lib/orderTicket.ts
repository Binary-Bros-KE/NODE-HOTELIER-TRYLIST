import type { Prisma } from "@prisma/client";

import { prisma } from "./prisma.js";
import { employeeName } from "./dispatch.js";

/**
 * Counter order tickets. At a COUNTER-mode location with orderTicketAutoPrint
 * on, every waiter action that changes what the counter has to hand over
 * queues a ticket on the location's default printer: a new order, a round
 * added, a line changed or removed, an approved cancellation. The barman works
 * from these - they are not receipts (no prices, no totals).
 *
 * A ticket is a snapshot of the change at that moment (PrintJob.ticket), so a
 * later edit or a reprint never changes what an earlier ticket said.
 */

export type TicketLine = { name: string; variant: string | null; addons: string[]; quantity: number };
export type OrderTicket = {
  event: "NEW" | "UPDATED" | "CANCELLED";
  orderNumber: number;
  table: string | null;
  location: string | null;
  waiter: string | null;
  // Who made this change, when it isn't the waiter who rang the order up.
  changedBy: string | null;
  at: string;
  notes: string | null;
  added: TicketLine[]; // new lines, or extra quantity on a line already there
  changed: { from: TicketLine; to: TicketLine }[]; // fewer, or a different variant / add-ons
  removed: TicketLine[];
  onOrder: TicketLine[]; // the rest of the order, untouched
};

type TicketItem = {
  id: string;
  quantity: number;
  menuItem: { name: string } | null;
  product?: { name: string } | null;
  variant: { name: string } | null;
  addons: { quantity: number; addon: { name: string } }[];
};

type TicketOrder = {
  id: string;
  orderNumber: number;
  locationId: string | null;
  createdBy: string | null;
  notes: string | null;
  table: { label: string } | null;
  location: { name: string; serveMode: string; orderTicketAutoPrint: boolean } | null;
};

function lineOf(item: TicketItem): TicketLine {
  return {
    name: item.menuItem?.name ?? item.product?.name ?? "Item",
    variant: item.variant?.name ?? null,
    addons: item.addons.map((a) => (a.quantity > 1 ? `${a.addon.name} x${a.quantity}` : a.addon.name)).sort(),
    quantity: item.quantity,
  };
}

const shape = (line: TicketLine) => `${line.name}|${line.variant ?? ""}|${line.addons.join(",")}`;

/** What a change did to the order's lines, matched by line id. */
export function diffLines(before: TicketItem[], after: TicketItem[]) {
  const was = new Map(before.map((item) => [item.id, lineOf(item)]));
  const added: TicketLine[] = [];
  const changed: OrderTicket["changed"] = [];
  const onOrder: TicketLine[] = [];
  for (const item of after) {
    const now = lineOf(item);
    const then = was.get(item.id);
    was.delete(item.id);
    if (!then) added.push(now);
    else if (shape(then) !== shape(now) || now.quantity < then.quantity) changed.push({ from: then, to: now });
    else if (now.quantity > then.quantity) added.push({ ...now, quantity: now.quantity - then.quantity });
    else onOrder.push(now);
  }
  return { added, changed, removed: [...was.values()], onOrder };
}

/**
 * Queues the ticket for a change, when the order's location prints them.
 * Never throws: a waiter's sale must not fail because the counter printer
 * couldn't be reached. `before` is omitted for a new order; for a
 * cancellation, `after` is what is being called off.
 */
export async function queueOrderTicket(args: {
  tenantId: string;
  order: TicketOrder;
  event: OrderTicket["event"];
  before?: TicketItem[];
  after: TicketItem[];
  by: string | undefined;
}) {
  try {
    const { order } = args;
    if (!order.locationId || order.location?.serveMode !== "COUNTER" || !order.location.orderTicketAutoPrint) return null;

    const diff = args.event === "UPDATED"
      ? diffLines(args.before ?? [], args.after)
      : { added: args.event === "NEW" ? args.after.map(lineOf) : [], changed: [], removed: args.event === "CANCELLED" ? args.after.map(lineOf) : [], onOrder: [] };
    if (!diff.added.length && !diff.changed.length && !diff.removed.length) return null;

    const printer = await prisma.printer.findFirst({
      where: { tenantId: args.tenantId, locationId: order.locationId, isActive: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true },
    });
    if (!printer) return null;

    const waiter = await employeeName(prisma, args.tenantId, order.createdBy);
    const by = args.by && args.by !== order.createdBy ? await employeeName(prisma, args.tenantId, args.by) : null;
    const ticket: OrderTicket = {
      event: args.event,
      orderNumber: order.orderNumber,
      table: order.table?.label ?? null,
      location: order.location?.name ?? null,
      waiter,
      changedBy: by,
      at: new Date().toISOString(),
      notes: order.notes,
      ...diff,
    };
    return await prisma.printJob.create({
      data: {
        tenantId: args.tenantId, locationId: order.locationId, printerId: printer.id, orderId: order.id,
        kind: "ORDER_TICKET", ticket: ticket as unknown as Prisma.InputJsonValue, requestedBy: args.by ?? null,
      },
      select: { id: true },
    });
  } catch (error) {
    console.error("[order-ticket] could not queue a ticket for order", args.order.id, error);
    return null;
  }
}

/** ESC/POS bytes for a ticket - the server owns the layout, the device only spools it. */
export function renderOrderTicketPrint(ticket: OrderTicket, columns: number, businessName: string): Buffer {
  const cols = Math.max(24, Math.min(64, Math.round(columns) || 42));
  const bytes: number[] = [27, 64];
  const command = (...values: number[]) => bytes.push(...values);
  // Thermal printers here speak plain ASCII; anything else would print as junk.
  const line = (text = "") => bytes.push(...Buffer.from(text.normalize("NFKD").replace(/[^\x20-\x7e]/g, ""), "ascii"), 10);
  const rule = "-".repeat(cols);
  const wrap = (text: string, width: number) => {
    const lines: string[] = [];
    let current = "";
    for (const word of text.split(/\s+/)) {
      if (current && `${current} ${word}`.length > width) { lines.push(current); current = ""; }
      current = current ? `${current} ${word}` : word;
    }
    if (current) lines.push(current);
    return lines;
  };
  const heading = (text: string, large = false) => {
    command(27, 97, 1, 27, 69, 1, 29, 33, large ? 17 : 0);
    line(text);
    command(29, 33, 0, 27, 69, 0, 27, 97, 0);
  };
  const qty = (n: number) => Number(n).toLocaleString("en-KE", { maximumFractionDigits: 3 });
  const describe = (l: TicketLine) => [l.name, l.variant ? `(${l.variant})` : ""].filter(Boolean).join(" ");
  // An item line in double height so the counter can read it at a glance; add-ons beneath.
  const item = (text: string, addons: string[] = []) => {
    command(27, 69, 1, 29, 33, 1);
    wrap(text.toUpperCase(), cols).forEach((part) => line(part));
    command(29, 33, 0, 27, 69, 0);
    for (const addon of addons) wrap(`  + ${addon}`, cols).forEach((part) => line(part));
  };
  const section = (title: string) => { line(rule); heading(title); line(rule); };

  const title = ticket.event === "NEW" ? "NEW ORDER"
    : ticket.event === "CANCELLED" ? "ORDER CANCELLED"
    : ticket.changed.length || ticket.removed.length ? "ORDER CHANGED" : "ADDED TO ORDER";
  heading(businessName.toUpperCase());
  heading(title, true);
  heading("COUNTER ORDER TICKET");
  line(rule);
  line(`Order: #${ticket.orderNumber}`);
  line(`Table: ${ticket.table ?? "Takeaway"}`);
  if (ticket.location) line(`Counter: ${ticket.location}`);
  line(`Waiter: ${ticket.waiter ?? ""}`);
  if (ticket.changedBy) line(`Changed by: ${ticket.changedBy}`);
  line(`Time: ${new Date(ticket.at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}`);

  if (ticket.event === "CANCELLED") {
    section("DO NOT SERVE");
    for (const l of ticket.removed) item(`${qty(l.quantity)} x ${describe(l)}`, l.addons);
  } else {
    if (ticket.added.length) {
      section(ticket.event === "NEW" ? "ITEMS" : "ADD");
      for (const l of ticket.added) item(`${ticket.event === "NEW" ? "" : "+"}${qty(l.quantity)} x ${describe(l)}`, l.addons);
    }
    if (ticket.changed.length) {
      section("CHANGE");
      for (const c of ticket.changed) {
        line(`WAS: ${qty(c.from.quantity)} x ${describe(c.from)}${c.from.addons.length ? ` + ${c.from.addons.join(", ")}` : ""}`);
        item(`NOW: ${qty(c.to.quantity)} x ${describe(c.to)}`, c.to.addons);
      }
    }
    if (ticket.removed.length) {
      section("REMOVE - DO NOT SERVE");
      for (const l of ticket.removed) item(`${qty(l.quantity)} x ${describe(l)}`, l.addons);
    }
    if (ticket.onOrder.length) {
      section("ALREADY ON ORDER");
      for (const l of ticket.onOrder) wrap(`${qty(l.quantity)} x ${describe(l)}${l.addons.length ? ` + ${l.addons.join(", ")}` : ""}`, cols).forEach((part) => line(part));
    }
  }
  if (ticket.notes) { line(rule); wrap(`Note: ${ticket.notes}`, cols).forEach((part) => line(part)); }
  line(rule);
  heading("Order ticket - not a receipt");
  line(); line(); line(); line();
  command(29, 86, 0);
  return Buffer.from(bytes);
}
