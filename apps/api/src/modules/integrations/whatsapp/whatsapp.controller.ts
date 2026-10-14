import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';

import { getTenantContext } from '../../platform/context/tenant-context.js';
import { RequiresPermission } from '../../platform/decorators/requires-permission.decorator.js';

import { WhatsappService, type SendInput, type WhatsappSettingsInput } from './whatsapp.service.js';

/**
 * 📱 إرسال الفاتورة عبر واتساب — `Form_WPF/frmInvSale.xaml` L1190 «💬 واتساب» and its
 * handler (`frmInvSale.xaml.cs` L3130-L3195), behind `Class/WhatsAppSender.cs` (267) and
 * `Class/Session.cs` (L12-L31).
 *
 * The desktop's integration was a Chrome window on the cashier's machine: no account, no
 * credential, no record. Two permissions therefore guard the two halves of what it did —
 * `tenant.settings.manage` decides *where the messages come from* (the number and the
 * token), and `sales.view` decides *who may send an invoice*: exactly who may open the
 * invoice window the desktop's menu item lived in.
 */
@Controller()
export class WhatsappController {
  constructor(private readonly whatsapp: WhatsappService) {}

  /** ⚙️ الإعدادات — the number, the token (masked) and the 📎 switch. */
  @Get('whatsapp/settings') @RequiresPermission('tenant.settings.manage')
  settings() {
    return this.whatsapp.view(getTenantContext().tenantId);
  }

  /** 💾 حفظ. */
  @Put('whatsapp/settings') @RequiresPermission('tenant.settings.manage')
  save(@Body() body: WhatsappSettingsInput) {
    return this.whatsapp.save(getTenantContext().tenantId, body ?? {});
  }

  /** 🧪 اختبار — is this number ours, and is this token good for it? */
  @Post('whatsapp/test') @RequiresPermission('tenant.settings.manage')
  test() {
    return this.whatsapp.test(getTenantContext().tenantId);
  }

  /** 💬 واتساب — the menu item on the sale invoice window. */
  @Post('whatsapp/send') @RequiresPermission('sales.view')
  send(@Body() body: SendInput) {
    return this.whatsapp.send(getTenantContext().tenantId, body ?? ({} as SendInput));
  }

  /** 📜 السجل — what the desktop never kept. */
  @Get('whatsapp/messages') @RequiresPermission('sales.view')
  messages(@Query('status') status?: string, @Query('invoiceId') invoiceId?: string, @Query('limit') limit?: string) {
    return this.whatsapp.messages(getTenantContext().tenantId, { status, invoiceId, limit });
  }
}
