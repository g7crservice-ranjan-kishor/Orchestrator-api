import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ApprovalService } from './approval.service';
import { ApprovalController } from './approval.controller';
import { AuditModule } from '../audit/audit.module';
import { Draft, DraftSchema } from '../planning/schemas/draft.schema';

/**
 * Approval + ADO-target-confirmation gate. Exports {@link ApprovalService} so the ADO push module
 * can call the static pre-write guard; imports {@link AuditModule} to record gate transitions.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: Draft.name, schema: DraftSchema }]), AuditModule],
  controllers: [ApprovalController],
  providers: [ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalModule {}
