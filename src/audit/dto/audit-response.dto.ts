import { ApiProperty } from '@nestjs/swagger';
import { AuditAction, AuditLogDocument } from '../schemas/audit-log.schema';

/** One audit entry projected for the admin UI. */
export class AuditEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true }) actorId!: string | null;
  @ApiProperty() actorEmail!: string;
  @ApiProperty({ enum: AuditAction }) action!: AuditAction;
  @ApiProperty() entityType!: string;
  @ApiProperty() entityId!: string;
  @ApiProperty({ nullable: true }) projectId!: string | null;
  @ApiProperty({ additionalProperties: true }) metadata!: Record<string, unknown>;
  @ApiProperty() createdAt!: string;

  static fromDocument(doc: AuditLogDocument): AuditEntryDto {
    return {
      id: doc.id,
      actorId: doc.actorId ? doc.actorId.toString() : null,
      actorEmail: doc.actorEmail,
      action: doc.action,
      entityType: doc.entityType,
      entityId: doc.entityId,
      projectId: doc.projectId ? doc.projectId.toString() : null,
      metadata: doc.metadata,
      // createdAt is added by timestamps; present at runtime though not on the class type.
      createdAt: (doc as unknown as { createdAt: Date }).createdAt.toISOString(),
    };
  }
}
