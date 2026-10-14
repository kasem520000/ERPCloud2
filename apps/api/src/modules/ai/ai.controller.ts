import { Body, Controller, Get, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError, errorCodes } from '@erp/contracts';

import { getTenantContext } from '../platform/context/tenant-context.js';
import { RequiresPermission } from '../platform/decorators/requires-permission.decorator.js';

import { AiService, type ChatResult } from './ai.service.js';

/**
 * `/api/v1/ai/*` — PHASE_08.
 *
 * `POST /ai/chat` answers as server-sent events unless the caller asks for JSON.
 * The stream is the guarded answer, never a raw model token that failed the
 * figure check.
 */
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('skills')
  @RequiresPermission('ai.assistant.use')
  skills() {
    return { data: this.ai.skills() };
  }

  @Get('conversations')
  @RequiresPermission('ai.assistant.use')
  async conversations() {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.ai.listConversations(tenantId, userId) };
  }

  @Get('conversations/:id')
  @RequiresPermission('ai.assistant.use')
  async conversation(@Param('id') id: string) {
    const { tenantId, userId } = getTenantContext();
    return { data: await this.ai.readConversation(tenantId, userId, id) };
  }

  @Get('suggestions')
  @RequiresPermission('ai.assistant.use')
  async suggestions() {
    const { tenantId } = getTenantContext();
    return { data: await this.ai.listSuggestions(tenantId) };
  }

  @Post('suggest')
  @RequiresPermission('ai.assistant.use')
  async suggest() {
    const { tenantId } = getTenantContext();
    return { data: await this.ai.suggest(tenantId) };
  }

  @Get('settings')
  @RequiresPermission('ai.assistant.use')
  async readSettings() {
    return { data: await this.ai.settingsView(getTenantContext().tenantId) };
  }

  @Put('settings')
  @RequiresPermission('ai.settings.manage')
  async updateSettings(@Body() body: Record<string, unknown>) {
    return { data: await this.ai.updateSettings(getTenantContext().tenantId, body ?? {}) };
  }

  @Post('settings/test')
  @RequiresPermission('ai.settings.manage')
  async testSettings() {
    return { data: await this.ai.testConnection(getTenantContext().tenantId) };
  }

  @Post('chat')
  @RequiresPermission('ai.assistant.use')
  async chat(
    @Body() body: { message?: string; conversationId?: string; stream?: boolean },
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const accept = String(request.headers.accept ?? '');
    const stream = body?.stream !== false && !accept.includes('application/json');
    try {
      const { tenantId, userId } = getTenantContext();
      const result = await this.ai.chat(tenantId, userId, body ?? {});
      if (!stream) {
        response.status(200).json({ data: result });
        return;
      }
      writeStream(response, result, this.ai);
    } catch (error) {
      writeFailure(response, error);
    }
  }
}

function writeStream(response: Response, result: ChatResult, ai: AiService): void {
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders?.();
  void (async () => {
    for await (const event of ai.streamOf(result)) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
  })().catch((error: unknown) => writeFailure(response, error));
}

function writeFailure(response: Response, error: unknown): void {
  const domain = error instanceof DomainError ? error : new DomainError(errorCodes.INTERNAL, 'تعذر إكمال الإجابة', 500);
  if (response.headersSent) {
    response.write(`event: error\ndata: ${JSON.stringify({ message: domain.message, code: domain.code })}\n\n`);
    response.end();
    return;
  }
  response.status(domain.status).json({
    code: domain.code,
    title: domain.message,
    detail: domain.message,
    status: domain.status,
  });
}
