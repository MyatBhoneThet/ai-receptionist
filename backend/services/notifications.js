import nodemailer from 'nodemailer';
import twilio from 'twilio';
import { getNotificationSettings } from './appSettings.js';

const smtpEnabled = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const twilioEnabled = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);

const mailer = smtpEnabled
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  : null;

const smsClient = twilioEnabled
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

export function formatWebhookPayload({ type, booking, isVip, provider = 'slack' }) {
  const title = isVip ? 'VIP Booking' : `Booking ${type}`;
  const bodyLines = [
    `*${title}*`,
    `Name: ${booking?.reservation_name || 'Guest'}`,
    `Type: ${booking?.service_type || '-'}`,
    `Date: ${booking?.date || '-'}`,
    `Time: ${booking?.start_time || '-'}`,
    `Status: ${booking?.status || type}`,
  ];

  const text = bodyLines.join('\n');

  if (provider === 'teams') {
    return {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      summary: title,
      themeColor: isVip ? 'E67E22' : '2F80ED',
      title,
      sections: [
        {
          text: bodyLines.join('<br>'),
        },
      ],
    };
  }

  // Slack-compatible block message
  return {
    text: title,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
    ],
  };
}

async function sendStaffWebhook(payload, url) {
  if (!url) return { sent: false, reason: 'STAFF_WEBHOOK_URL not set' };
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { sent: true };
}

async function sendEmail(to, subject, text, html) {
  if (!mailer) return { sent: false, reason: 'SMTP not configured' };
  await mailer.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  });
  return { sent: true };
}

async function sendSms(to, body) {
  if (!smsClient) return { sent: false, reason: 'Twilio not configured' };
  await smsClient.messages.create({
    from: process.env.TWILIO_FROM,
    to,
    body,
  });
  return { sent: true };
}

export async function notifyBooking({
  type,
  toEmail,
  toPhone,
  booking,
  isVip,
  businessId,
  allowEnvFallback = !businessId,
}) {
  const notificationSettings = await getNotificationSettings(businessId, { allowEnvFallback });
  const subjectMap = {
    confirm: 'Your booking is confirmed',
    remind: 'Upcoming booking reminder',
    cancel: 'Your booking was cancelled',
    staff_vip: 'VIP booking alert',
    waitlist_open: 'A spot just opened up',
  };

  const subject = subjectMap[type] || 'Booking update';
  const text = `Booking for ${booking?.reservation_name || 'guest'} on ${booking?.date} at ${booking?.start_time || ''}. Status: ${booking?.status || type}.`;
  const html = `<p>${text}</p>`;

  const results = {};
  if (toEmail) results.email = await sendEmail(toEmail, subject, text, html);
  if (toPhone) results.sms = await sendSms(toPhone, text);
  if (isVip && (notificationSettings.alert_email)) {
    results.staff = await sendEmail(
      notificationSettings.alert_email,
      'VIP booking alert',
      text,
      html
    );
  }
  if (notificationSettings.webhook_url) {
    const webhookUrl = notificationSettings.webhook_url;
    const webhookPayload = formatWebhookPayload({
      type,
      booking,
      isVip,
      provider: notificationSettings.provider || 'slack',
    });
    results.staff_webhook = await sendStaffWebhook(webhookPayload, webhookUrl);
  }
  return results;
}

export const notificationsHealth = {
  emailEnabled: smtpEnabled,
  smsEnabled: twilioEnabled,
};
