import type { dispatchSlipFor } from './dispatchAuto.js';

type Slip = NonNullable<Awaited<ReturnType<typeof dispatchSlipFor>>>;

/** Automatic print layouts belong to HOTELIER; the device only spools bytes. */
export function renderDispatchPrint(slip: Slip, columns: number, businessName: string): Buffer {
  const cols = Math.max(24, Math.min(64, Math.round(columns) || 42));
  const bytes: number[] = [27, 64];
  const command = (...values: number[]) => bytes.push(...values);
  const line = (text = '') => bytes.push(...Buffer.from(text, 'ascii'), 10);
  const rule = '-'.repeat(cols);
  const wrap = (text: string, width: number) => {
    const lines: string[] = [];
    let current = '';
    for (const word of text.split(/\s+/)) {
      if (current && `${current} ${word}`.length > width) { lines.push(current); current = ''; }
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
  heading(businessName.toUpperCase());
  heading(slip.kind === 'UPDATED_ORDER' ? 'UPDATED ORDER' : 'NEW ORDER', true);
  heading('STORE DISPATCH REQUEST');
  line(rule);
  line(`Request: ${slip.requestNo}`);
  line(`Order: #${slip.orderNumber}${slip.table ? ` (${slip.table})` : ''}`);
  line(`From: ${slip.from}`);
  line(`For: ${slip.to}`);
  line(`Waiter: ${slip.waiterName ?? ''}`);
  line(`Time: ${new Date(slip.requestedAt).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}`);
  const quantity = (value: number) => Number(value).toLocaleString('en-KE', { maximumFractionDigits: 3 });
  const section = (title: string, dishes: Slip['dishes']) => {
    if (!dishes.length) return;
    line(rule); heading(title); line(rule);
    for (const dish of dishes) {
      const price = `KSh ${Number(dish.totalPrice).toFixed(2)}`;
      const names = wrap(`${quantity(dish.quantity)} x ${dish.name}`.toUpperCase(), Math.max(8, cols - price.length - 1));
      command(27, 69, 1, 29, 33, 1);
      names.forEach((name, index) => line(index === 0 ? name.padEnd(cols - price.length) + price : name));
      command(29, 33, 0, 27, 69, 0);
      for (const ingredient of dish.ingredients) {
        const amount = `${quantity(ingredient.quantity)} ${ingredient.unit ?? ''}`.trim();
        wrap(ingredient.name, Math.max(8, cols - amount.length - 1)).forEach((name, index) => line(index === 0 ? name.padEnd(cols - amount.length) + amount : name));
        line('.'.repeat(cols));
      }
    }
  };
  section('ALREADY ON ORDER', slip.existingDishes);
  section(slip.kind === 'UPDATED_ORDER' ? 'UPDATED ITEMS TO DISPATCH' : 'ITEMS TO DISPATCH', slip.dishes);
  line(rule);
  line('Received by: ______________');
  line(); line(); line(); line();
  command(29, 86, 0);
  return Buffer.from(bytes);
}
