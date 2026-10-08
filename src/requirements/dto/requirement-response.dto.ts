import { ApiProperty } from '@nestjs/swagger';
import { RequirementDocument, RequirementStatus } from '../schemas/requirement.schema';

class AttachmentResponse {
  @ApiProperty() originalName!: string;
  @ApiProperty() contentType!: string;
  @ApiProperty() size!: number;
  @ApiProperty() url!: string;
}

/** Requirement projection returned by the API. */
export class RequirementResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty() text!: string;
  @ApiProperty({ enum: RequirementStatus }) status!: RequirementStatus;
  @ApiProperty({ type: [AttachmentResponse] }) attachments!: AttachmentResponse[];
  @ApiProperty({ description: 'When the requirement was submitted (ISO 8601).' })
  createdAt!: string;

  static fromDocument(doc: RequirementDocument): RequirementResponseDto {
    return {
      id: doc.id,
      projectId: doc.projectId.toString(),
      text: doc.text,
      status: doc.status,
      // Falls back to the ObjectId's own timestamp for the requirements written before this field
      // was exposed, so the list never shows a blank where a date belongs.
      createdAt: (doc.createdAt ?? doc._id.getTimestamp()).toISOString(),
      attachments: doc.attachments.map((a) => ({
        originalName: a.originalName,
        contentType: a.contentType,
        size: a.size,
        url: a.url,
      })),
    };
  }
}
