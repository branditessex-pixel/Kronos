'use strict';

require('dotenv').config();
const { Resend } = require('resend');

// Construct lazily and defensively — a missing RESEND_API_KEY must NOT crash the
// bot at import time (alerts are best-effort; trading must keep running).
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
if (!resend) console.warn('[ALERTS] RESEND_API_KEY not set — email alerts disabled (trading continues).');

// Colour map per emoji — header background changes to match the alert type
const HEADER_COLOURS = {
  '✅': '#1a7a1a',   // green  — win
  '❌': '#8b0000',   // dark red — loss
  '📈': '#1a3a6e',   // navy  — trade opened
  '🛑': '#8b0000',   // dark red — halted
  '⏸️': '#7a4a00',  // amber — paused
  '🚨': '#8b0000',   // dark red — critical
  '🔒': '#1a3a6e',   // navy  — bedtime protection
  '🔧': '#555555',   // grey  — system/error
  '🚀': '#1a1a2e',   // dark navy — startup
  '⚠️': '#1a1a1a',  // dark — generic
};

/**
 * sendAlert(message, options)
 *
 * options.emoji   — emoji prefix, controls header colour and subject prefix
 * options.subject — overrides full subject line if provided
 */
// Only these two alert types actually send email — the only operational pings the
// user wants: "bot live" (🚀 startup) and "bot broken" (🔧 repeated errors). Every
// other sendAlert (trade opened/closed, halts, floor, etc.) is logged to console
// only, so no more noise. The end-of-day report goes out via sendReport(), which
// is unaffected by this gate.
const EMAIL_EMOJI_ALLOWLIST = new Set(['🚀', '🔧']);

async function sendAlert(message, { emoji = '⚠️', subject } = {}) {
  const emailSubject = subject || `${emoji} Gold Demo`;
  const headerColour = HEADER_COLOURS[emoji] || '#1a1a1a';

  if (!EMAIL_EMOJI_ALLOWLIST.has(emoji)) {
    console.log(`[alert — console only] ${emailSubject}: ${message}`);
    return;
  }

  if (!resend || !process.env.ALERT_EMAIL) {
    console.log(`[ALERT skipped — email not configured] ${emailSubject}: ${message}`);
    return;
  }

  try {
    await resend.emails.send({
      from: 'Gold Demo <noreply@branditessex.com>',
      to: process.env.ALERT_EMAIL,
      subject: emailSubject,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:${headerColour};padding:20px;border-radius:8px 8px 0 0;">
            <h2 style="color:white;margin:0;">${emailSubject}</h2>
            <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;">XAU/USD — Gold Demo Bot</p>
          </div>
          <div style="background:#f9f9f9;padding:20px;border-radius:0 0 8px 8px;">
            <p style="font-size:15px;color:#333;">${message}</p>
            <hr style="border:none;border-top:1px solid #ddd;margin:16px 0;">
            <p style="font-size:11px;color:#999;">Gold Demo Bot — branditessex.com</p>
          </div>
        </div>
      `
    });
  } catch (err) {
    console.error('Alert email failed:', err.message);
  }
}

/**
 * sendReport(subject, html) — sends a full custom HTML email body verbatim
 * (no wrapper template). Used by the comprehensive daily report. Guarded the
 * same way as sendAlert: a missing key logs and returns rather than throwing.
 */
async function sendReport(subject, html) {
  if (!resend || !process.env.ALERT_EMAIL) {
    console.log(`[REPORT skipped — email not configured] ${subject}`);
    return;
  }
  try {
    await resend.emails.send({
      from: 'Gold Demo <noreply@branditessex.com>',
      to: process.env.ALERT_EMAIL,
      subject,
      html
    });
  } catch (err) {
    console.error('Report email failed:', err.message);
  }
}

module.exports = { sendAlert, sendErrorAlert: sendAlert, sendReport };
