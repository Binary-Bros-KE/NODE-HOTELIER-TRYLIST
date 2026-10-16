import nodemailer from "nodemailer";

import { env } from "../config/env.js";

// Outgoing email through whichever SMTP service .env names. Sending is fire-
// and-forget: a slow or failing mail server never delays or fails the request
// that triggered the email — failures are logged and that's it.

const transporter = env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM_ADDRESS
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    })
  : null;

export const mailConfigured = () => transporter !== null;

export type OutgoingMail = {
  to: string;
  /** Shown as the sender's name, e.g. the hotel — the address is always MAIL_FROM_ADDRESS. */
  fromName: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
};

export function sendMail(mail: OutgoingMail): void {
  if (!transporter) return;
  transporter
    .sendMail({
      // Quotes and angle brackets stripped from the display name so it can't break the header.
      from: { name: mail.fromName.replace(/["<>\r\n]/g, "").slice(0, 80), address: env.MAIL_FROM_ADDRESS! },
      to: mail.to,
      replyTo: mail.replyTo ?? undefined,
      subject: mail.subject.replace(/[\r\n]+/g, " ").slice(0, 200),
      html: mail.html,
      text: mail.text,
    })
    .catch((error: unknown) => console.error(`Email to ${mail.to} failed:`, error instanceof Error ? error.message : error));
}
