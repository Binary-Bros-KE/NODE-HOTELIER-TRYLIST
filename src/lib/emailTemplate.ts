// One quiet, table-based email layout (renders in Gmail, Outlook and phones)
// used by every transactional email, plus its plain-text twin. Everything
// interpolated is HTML-escaped — names and notes come from website visitors.

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const safeColor = (value: string | null | undefined, fallback: string) =>
  value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

export type EmailContent = {
  hotelName: string;
  brandColor?: string | null;
  /** Small capitals above the heading, e.g. "Booking request". */
  eyebrow: string;
  heading: string;
  /** Paragraphs of plain text. */
  intro: string[];
  rows?: { label: string; value: string }[];
  button?: { label: string; url: string };
  /** Small print at the bottom (plain text). */
  footer?: string;
};

export function renderEmail(c: EmailContent): { html: string; text: string } {
  const brand = safeColor(c.brandColor, "#2F4A3E");
  const e = escapeHtml;
  const rows = (c.rows ?? []).map((r) => `
          <tr>
            <td style="padding:10px 0;border-bottom:1px solid #ece4d8;color:#7a7268;font-size:13px;width:40%;vertical-align:top">${e(r.label)}</td>
            <td style="padding:10px 0;border-bottom:1px solid #ece4d8;color:#23211d;font-size:15px;text-align:right">${e(r.value)}</td>
          </tr>`).join("");
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4ede2">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4ede2;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fbf8f3;border:1px solid #e2d8c9">
        <tr><td style="padding:28px 32px 0;font-family:Georgia,'Times New Roman',serif;font-size:20px;color:#23211d">${e(c.hotelName)}</td></tr>
        <tr><td style="padding:24px 32px 0;font-family:Arial,sans-serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#8a7346">${e(c.eyebrow)}</td></tr>
        <tr><td style="padding:8px 32px 0;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.2;color:#23211d">${e(c.heading)}</td></tr>
        <tr><td style="padding:16px 32px 0;font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#5c564e">
          ${c.intro.map((p) => `<p style="margin:0 0 12px">${e(p)}</p>`).join("")}
        </td></tr>
        ${rows ? `<tr><td style="padding:8px 32px 0;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>` : ""}
        ${c.button ? `<tr><td style="padding:28px 32px 0"><a href="${e(c.button.url)}" style="display:inline-block;background:${brand};color:#fbf8f3;font-family:Arial,sans-serif;font-size:12px;letter-spacing:2px;text-transform:uppercase;text-decoration:none;padding:14px 26px">${e(c.button.label)}</a></td></tr>` : ""}
        <tr><td style="padding:32px;font-family:Arial,sans-serif;font-size:12px;line-height:1.5;color:#8a837a">${e(c.footer ?? "")}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    c.hotelName,
    "",
    c.heading,
    "",
    ...c.intro.flatMap((p) => [p, ""]),
    ...(c.rows ?? []).map((r) => `${r.label}: ${r.value}`),
    ...(c.button ? ["", `${c.button.label}: ${c.button.url}`] : []),
    ...(c.footer ? ["", c.footer] : []),
  ].join("\n");

  return { html, text };
}
