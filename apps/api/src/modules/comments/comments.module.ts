import { Module } from '@nestjs/common';

import { EmailModule } from '../email/email.module.js';
import { PlatformModule } from '../platform/index.js';

import { CommentsController } from './comments.controller.js';
import { CommentsService } from './comments.service.js';

@Module({
  imports: [PlatformModule, EmailModule],
  controllers: [CommentsController],
  providers: [CommentsService],
})
export class CommentsModule {}
