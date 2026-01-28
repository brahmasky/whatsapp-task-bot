import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import config from '../../config/index.js';
import logger from '../../utils/logger.js';

/**
 * TPG Automation Service
 * Handles login, SMS verification, and invoice download from TPG MyAccount.
 */
export class TPGService {
  constructor() {
    this.browser = null;
    this.page = null;
  }

  /**
   * Initialize the browser
   */
  async initialize() {
    logger.info('Initializing browser...');

    this.browser = await chromium.launch({
      headless: config.playwright.headless,
      slowMo: config.playwright.headless ? 0 : 500,
    });

    this.page = await this.browser.newPage();

    await this.page.setViewportSize({ width: 1280, height: 720 });
    await this.page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    });

    logger.info('Browser initialized');
  }

  /**
   * Perform initial login (username/password) and trigger SMS code
   * @param {object} credentials - { username, password }
   * @returns {Promise<{needsSMS: boolean}>}
   */
  async login(credentials) {
    logger.info('Navigating to TPG MyAccount...');

    await this.page.goto('https://www.tpg.com.au/myaccount', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await this.page.waitForTimeout(5000);

    // Fill username
    const usernameSelectors = [
      'input[name="username"]',
      'input[name="email"]',
      'input[type="email"]',
      'input[id*="username"]',
      'input[id*="email"]',
    ];

    let usernameEntered = false;
    for (const selector of usernameSelectors) {
      try {
        await this.page.fill(selector, credentials.username, { timeout: 3000 });
        usernameEntered = true;
        break;
      } catch (error) {
        continue;
      }
    }

    if (!usernameEntered) {
      throw new Error('Could not find username field');
    }

    // Fill password
    const passwordSelectors = [
      'input[name="password"]',
      'input[type="password"]',
      'input[id*="password"]',
    ];

    let passwordEntered = false;
    for (const selector of passwordSelectors) {
      try {
        await this.page.fill(selector, credentials.password, { timeout: 3000 });
        passwordEntered = true;
        break;
      } catch (error) {
        continue;
      }
    }

    if (!passwordEntered) {
      throw new Error('Could not find password field');
    }

    // Submit login
    await this.page.waitForTimeout(2000);

    const submitSelectors = [
      '#button',
      'input[value="Log in"]',
      'input[type="submit"]',
      'button[type="submit"]',
      'input[name="password"]',
    ];

    let submitted = false;
    for (const selector of submitSelectors) {
      try {
        // Check if already on SMS page
        let isOnSMSPage = false;
        try {
          isOnSMSPage = await this.page.evaluate(() => {
            return document.querySelector('#btnSendCode') !== null;
          });
        } catch (error) {
          if (error.message.includes('Execution context was destroyed')) {
            submitted = true;
            break;
          }
        }

        if (isOnSMSPage) {
          submitted = true;
          break;
        }

        if (selector === 'input[name="password"]') {
          await this.page.press(selector, 'Enter');
          submitted = true;
          break;
        } else {
          await this.page.click(selector, { timeout: 5000 });
          submitted = true;
          break;
        }
      } catch (error) {
        try {
          const isOnSMSPage = await this.page.evaluate(() => {
            return document.querySelector('#btnSendCode') !== null;
          });
          if (isOnSMSPage) {
            submitted = true;
            break;
          }
        } catch (evalError) {
          if (evalError.message.includes('Execution context was destroyed')) {
            submitted = true;
            break;
          }
        }
        continue;
      }
    }

    await this.page.waitForTimeout(5000);

    // Look for "Send Code" button
    const sendCodeSelectors = [
      '#btnSendCode',
      'button:has-text("Send code")',
      'button.ui-button:has-text("Send code")',
      'button:has-text("Send Code")',
      'button:has-text("Send SMS")',
    ];

    let sendCodeFound = false;
    for (const selector of sendCodeSelectors) {
      try {
        const buttonExists = await this.page.$(selector);
        if (buttonExists) {
          await this.page.click(selector, { timeout: 3000 });
          sendCodeFound = true;
          logger.info('SMS code request sent');
          break;
        }
      } catch (error) {
        continue;
      }
    }

    if (!sendCodeFound) {
      // Check if SMS input field is already present
      const smsFieldExists = await this.page.evaluate(() => {
        const smsIndicators = [
          'input[name*="code"]',
          'input[name*="verification"]',
          'input[name*="sms"]',
          'input[id*="code"]',
          'input[id*="verification"]',
        ];
        return smsIndicators.some(selector => document.querySelector(selector) !== null);
      });

      if (smsFieldExists) {
        return { needsSMS: true };
      } else {
        const pageInfo = await this.page.evaluate(() => ({
          url: window.location.href,
          title: document.title,
        }));
        logger.warn('No Send Code button found', pageInfo);
        return { needsSMS: false };
      }
    }

    // Wait for SMS to be sent
    await this.page.waitForTimeout(5000);
    return { needsSMS: true };
  }

  /**
   * Complete SMS verification with the provided code
   * @param {string} smsCode - The 6-digit SMS code
   */
  async completeSMS(smsCode) {
    logger.info('Entering SMS verification code...');

    if (smsCode.length !== 6) {
      throw new Error('SMS code must be exactly 6 digits');
    }

    const digits = smsCode.split('');

    // Fill each digit field
    for (let i = 0; i < 6; i++) {
      const digitId = `#digit-${i + 1}`;
      const digit = digits[i];

      try {
        const fieldExists = await this.page.$(digitId);
        if (!fieldExists) {
          throw new Error(`Field ${digitId} not found`);
        }

        await this.page.fill(digitId, '');
        await this.page.waitForTimeout(100);
        await this.page.fill(digitId, digit);
        await this.page.waitForTimeout(200);
      } catch (error) {
        throw new Error(`Could not enter digit ${i + 1}: ${error.message}`);
      }
    }

    logger.info('All digits entered');

    await this.page.waitForTimeout(1000);

    // Click Verify button
    const verifySelectors = [
      '#btnSendCode',
      'button:has-text("Verify")',
      'button[type="submit"]',
    ];

    let verified = false;
    for (const selector of verifySelectors) {
      try {
        const isEnabled = await this.page.evaluate((sel) => {
          const btn = document.querySelector(sel);
          return btn && !btn.disabled;
        }, selector);

        if (isEnabled) {
          await this.page.click(selector, { timeout: 5000 });
          verified = true;
          break;
        }
      } catch (error) {
        continue;
      }
    }

    if (!verified) {
      throw new Error('Could not click Verify button');
    }

    // Wait for verification to complete
    try {
      await Promise.race([
        this.page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
        this.page.waitForFunction(() => {
          return !document.querySelector('#digit-1') || window.location.href.includes('account');
        }, { timeout: 15000 }).catch(() => {}),
        this.page.waitForSelector('a[href*="account"], a[href*="invoice"]', { timeout: 15000 }).catch(() => {}),
      ]);

      await this.page.waitForTimeout(3000);
      logger.info('Login completed');
    } catch (error) {
      logger.warn('Verification wait timeout, continuing...');
    }
  }

  /**
   * Navigate to invoices page and download the latest invoice
   * @returns {Promise<{pdfPath: string, invoiceInfo: object}>}
   */
  async downloadInvoice() {
    logger.info('Navigating to invoices page...');

    await this.page.goto('https://cyberstore.tpg.com.au/your_account/index.php?function=accountdocs', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    await this.page.waitForTimeout(3000);

    // Find latest invoice
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = String(now.getMonth() + 1).padStart(2, '0');

    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const previousYear = prevDate.getFullYear();
    const previousMonth = String(prevDate.getMonth() + 1).padStart(2, '0');

    logger.info(`Looking for invoices from ${currentYear}-${currentMonth} or ${previousYear}-${previousMonth}...`);

    const invoiceData = await this.page.evaluate(({ currentYear, currentMonth, previousYear, previousMonth }) => {
      const invoices = [];
      const tableRows = Array.from(document.querySelectorAll('table tr'));

      tableRows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length >= 7) {
          const invoiceNumber = cells[0]?.textContent?.trim();
          const dateText = cells[4]?.textContent?.trim();
          const amountText = cells[6]?.textContent?.trim();

          if (invoiceNumber && dateText && amountText && invoiceNumber.startsWith('I')) {
            const amountMatch = amountText.match(/\$(\d+\.\d{2})/);
            const dateMatch = dateText.match(/(\d{4})-(\d{2})-(\d{2})/);

            if (amountMatch && dateMatch) {
              const amount = parseFloat(amountMatch[1]);
              const year = dateMatch[1];
              const month = dateMatch[2];

              const linkElement = cells[0].querySelector('a');

              const isCurrentMonth = (year == currentYear && month == currentMonth);
              const isPreviousMonth = (year == previousYear && month == previousMonth);

              if (amount > 0 && (isCurrentMonth || isPreviousMonth) && linkElement) {
                invoices.push({
                  invoiceNumber,
                  date: dateText,
                  amount,
                  href: linkElement.href,
                });
              }
            }
          }
        }
      });

      return invoices.sort((a, b) => new Date(b.date) - new Date(a.date));
    }, { currentYear, currentMonth, previousYear, previousMonth });

    if (invoiceData.length === 0) {
      throw new Error(`No invoices found for ${currentYear}-${currentMonth} or ${previousYear}-${previousMonth}`);
    }

    const latestInvoice = invoiceData[0];
    logger.info(`Found invoice: ${latestInvoice.invoiceNumber} - ${latestInvoice.date} - $${latestInvoice.amount.toFixed(2)}`);

    // Navigate to invoice and generate PDF
    await this.page.goto(latestInvoice.href, { waitUntil: 'networkidle' });
    await this.page.waitForTimeout(3000);

    // Ensure downloads directory exists
    const downloadsDir = path.join(process.cwd(), 'downloads');
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }

    const yearMonth = latestInvoice.date.slice(0, 7);
    const pdfPath = path.join(downloadsDir, `TPG_Invoice_${yearMonth}.pdf`);

    await this.page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20px',
        right: '20px',
        bottom: '20px',
        left: '20px',
      },
    });

    logger.success('PDF generated successfully');

    return {
      pdfPath,
      invoiceInfo: latestInvoice,
    };
  }

  /**
   * Cleanup - close the browser
   */
  async cleanup() {
    if (this.browser) {
      logger.info('Closing browser...');
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }
}
