import nodemailer from 'nodemailer';
import config from '../config/index.js';
import logger from './logger.js';

let transporter = null;

/**
 * Get or create the email transporter
 */
function getTransporter() {
  if (!transporter && config.email.user && config.email.pass) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: config.email.user,
        pass: config.email.pass,
      },
    });
  }
  return transporter;
}

/**
 * Check if email is configured
 */
export function isEmailConfigured() {
  return !!(config.email.user && config.email.pass && config.email.recipient);
}

/**
 * Send an email with an attachment
 */
export async function sendEmailWithAttachment({ to, subject, text, attachmentPath, attachmentFilename }) {
  const transport = getTransporter();

  if (!transport) {
    throw new Error('Email not configured. Set SMTP_USER and SMTP_PASS in .env');
  }

  const recipient = to || config.email.recipient;

  if (!recipient) {
    throw new Error('No email recipient specified. Set EMAIL_RECIPIENT in .env');
  }

  const mailOptions = {
    from: config.email.user,
    to: recipient,
    subject,
    text,
    attachments: attachmentPath ? [{
      filename: attachmentFilename || 'attachment',
      path: attachmentPath,
    }] : [],
  };

  const result = await transport.sendMail(mailOptions);
  logger.info(`Email sent to ${recipient}`);
  return result;
}
