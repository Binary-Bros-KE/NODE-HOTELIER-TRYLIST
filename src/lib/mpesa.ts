// Safaricom Daraja "M-Pesa Express" (STK Push) client. Pure HTTP plumbing —
// no Express/Prisma imports — so it can be exercised directly against
// Safaricom's sandbox from a smoke script. See the plan for the full spec
// (developer.safaricom.co.ke); summarised here:
//   1. GET  {base}/oauth/v1/generate?grant_type=client_credentials  (Basic auth)
//   2. POST {base}/mpesa/stkpush/v1/processrequest                 (push)
//   3. POST {base}/mpesa/stkpushquery/v1/query                     (poll fallback)
// The push's synchronous response only means "the phone will be prompted" —
// the real outcome arrives later at CallBackURL (see mpesa-callback.routes.ts)
// or via the query endpoint.

export type MpesaCredentials = {
  environment: "SANDBOX" | "PRODUCTION";
  accountType: "PAYBILL" | "TILL";
  shortcode: string;
  tillNumber: string | null;
  passkey: string;
  consumerKey: string;
  consumerSecret: string;
};

function baseUrl(environment: MpesaCredentials["environment"]) {
  return environment === "PRODUCTION" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
}

/** yyyymmddhhiiss in the Daraja app's own local time — Safaricom does not
 * care which timezone as long as Password/Timestamp use the same instant. */
function timestampNow(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function password(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`, "utf8").toString("base64");
}

// One token per (shortcode, environment) — tokens last ~3599s and there's no
// reason to fetch a fresh one on every push. Refreshed 60s before expiry.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(creds: MpesaCredentials): Promise<string> {
  const cacheKey = `${creds.environment}:${creds.consumerKey}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const basic = Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`, "utf8").toString("base64");
  const res = await fetch(`${baseUrl(creds.environment)}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!res.ok) throw Object.assign(new Error(`Could not authenticate with Safaricom (${res.status})`), { status: 502 });
  const body = (await res.json()) as { access_token?: string; expires_in?: string };
  if (!body.access_token) throw Object.assign(new Error("Safaricom did not return an access token"), { status: 502 });
  const expiresAt = Date.now() + (Number(body.expires_in ?? 3599) - 60) * 1000;
  tokenCache.set(cacheKey, { token: body.access_token, expiresAt });
  return body.access_token;
}

/** Kenyan MSISDN normalised to Safaricom's expected 2547XXXXXXXX / 2541XXXXXXXX form. */
export function normalizeMsisdn(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (/^254(7|1)\d{8}$/.test(digits)) return digits;
  if (/^0(7|1)\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^(7|1)\d{8}$/.test(digits)) return `254${digits}`;
  return null;
}

export type StkPushResult = { merchantRequestId: string; checkoutRequestId: string };

export async function initiateStkPush(
  creds: MpesaCredentials,
  args: { phone: string; amount: number; accountRef: string; description: string; callbackUrl: string },
): Promise<StkPushResult> {
  const token = await getAccessToken(creds);
  const timestamp = timestampNow();
  const partyB = creds.accountType === "TILL" ? (creds.tillNumber || creds.shortcode) : creds.shortcode;
  const res = await fetch(`${baseUrl(creds.environment)}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      BusinessShortCode: creds.shortcode,
      Password: password(creds.shortcode, creds.passkey, timestamp),
      Timestamp: timestamp,
      TransactionType: creds.accountType === "TILL" ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
      Amount: Math.round(args.amount),
      PartyA: args.phone,
      PartyB: partyB,
      PhoneNumber: args.phone,
      CallBackURL: args.callbackUrl,
      AccountReference: args.accountRef.slice(0, 12),
      TransactionDesc: args.description.slice(0, 13),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    MerchantRequestID?: string; CheckoutRequestID?: string; ResponseCode?: string; ResponseDescription?: string; errorMessage?: string;
  };
  if (!res.ok || body.ResponseCode !== "0" || !body.CheckoutRequestID || !body.MerchantRequestID) {
    throw Object.assign(new Error(body.errorMessage || body.ResponseDescription || "Safaricom rejected the STK push request"), { status: 502 });
  }
  return { merchantRequestId: body.MerchantRequestID, checkoutRequestId: body.CheckoutRequestID };
}

export type StkQueryResult = { resultCode: number; resultDesc: string } | null;

/** Fallback for a slow/lost callback — null means "still pending, ask again later". */
export async function queryStkStatus(creds: MpesaCredentials, checkoutRequestId: string): Promise<StkQueryResult> {
  const token = await getAccessToken(creds);
  const timestamp = timestampNow();
  const res = await fetch(`${baseUrl(creds.environment)}/mpesa/stkpushquery/v1/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      BusinessShortCode: creds.shortcode,
      Password: password(creds.shortcode, creds.passkey, timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { ResultCode?: string; ResultDesc?: string; errorCode?: string };
  // Safaricom returns errorCode "500.001.1001" (still being processed) while pending — not a real error.
  if (body.errorCode) return null;
  if (body.ResultCode === undefined) return null;
  return { resultCode: Number(body.ResultCode), resultDesc: body.ResultDesc ?? "" };
}

/** Cashier-facing phrase for a Daraja ResultCode — shown on both a poll response and the callback outcome. */
export function describeResultCode(code: number): string {
  switch (code) {
    case 0: return "Payment received";
    case 1: return "Insufficient funds in the customer's M-Pesa account";
    case 1032: return "The customer cancelled the request";
    case 1037: return "The customer's phone could not be reached";
    case 1019: return "The request expired before the customer responded";
    case 2001: return "The customer entered the wrong M-Pesa PIN";
    case 1001: return "Another request is already pending on that phone — try again shortly";
    case 17: return "Safaricom reported a system error — try again";
    default: return "The payment could not be completed";
  }
}
