// ============================================================
// MailService — sends transactional emails via SMTP
// Uses Nodemailer — swap transport for Resend/Mailgun in prod
// ============================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: config.get('SMTP_HOST', 'smtp.mailtrap.io'),
      port: config.get<number>('SMTP_PORT', 587),
      auth: {
        user: config.get('SMTP_USER'),
        pass: config.get('SMTP_PASS'),
      },
    });
  }

  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const appUrl = this.config.get('FRONTEND_URL', 'http://localhost:3000');
    const verifyUrl = `${appUrl}/verify-email?token=${token}`;

    await this.transporter.sendMail({
      from: this.config.get('EMAIL_FROM', 'noreply@sms-saas.com'),
      to: email,
      subject: 'Verify your SMS-SaaS account',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2563eb;">Welcome to SMS-SaaS! 🚀</h2>
          <p>Please verify your email address by clicking the button below:</p>
          <a href="${verifyUrl}"
             style="display:inline-block; background:#2563eb; color:#fff;
                    padding:12px 24px; border-radius:8px; text-decoration:none;
                    font-weight:600; margin: 16px 0;">
            Verify Email
          </a>
          <p style="color:#666; font-size:14px;">
            Link expires in 24h. If you didn't create an account, ignore this email.
          </p>
          <p style="color:#999; font-size:12px;">
            Or copy this URL: ${verifyUrl}
          </p>
        </div>
      `,
    });

    this.logger.log(`Verification email sent to ${email}`);
  }
}
