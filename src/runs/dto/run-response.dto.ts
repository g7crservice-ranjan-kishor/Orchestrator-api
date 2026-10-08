import { ApiProperty } from '@nestjs/swagger';
import { JobDocument } from '../../jobs/schemas/job.schema';
import { JobState } from '../../jobs/job-state';

/** Run projection for the monitor (Run Result persisted on the job on completion). */
export class RunResponseDto {
  @ApiProperty() runId!: string;
  @ApiProperty() role!: string;
  @ApiProperty({ enum: JobState }) state!: JobState;
  @ApiProperty({ nullable: true }) workItemId!: string | null;
  @ApiProperty() attempts!: number;
  @ApiProperty({ nullable: true, additionalProperties: true }) result!: JobDocument['result'];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;

  static fromDocument(doc: JobDocument): RunResponseDto {
    const withTimestamps = doc as unknown as { createdAt: Date; updatedAt: Date };
    return {
      runId: doc.runId,
      role: doc.role,
      state: doc.state,
      workItemId: doc.workItemId,
      attempts: doc.attempts,
      result: doc.result,
      createdAt: withTimestamps.createdAt.toISOString(),
      updatedAt: withTimestamps.updatedAt.toISOString(),
    };
  }
}
