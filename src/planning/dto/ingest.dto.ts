import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { BacklogItemType } from '../schemas/draft.schema';

/** One clarifying question, with what it is about and what rides on the answer. */
export class ClarificationItemDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  question!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({ required: false, description: 'What goes wrong if nobody answers.' })
  @IsOptional()
  @IsString()
  why?: string;

  @ApiProperty({ required: false, description: 'What will be assumed if it is left unanswered.' })
  @IsOptional()
  @IsString()
  assumption?: string;
}

/**
 * EM run → clarifying questions.
 *
 * Two shapes, and both are accepted on purpose. `items` is what a current worker sends, carrying
 * the category and the reasoning. `questions` is the bare list older images send, and a worker
 * image can outlive a backend deploy by days — refusing it would silently lose every question
 * from a pod that is still perfectly able to ask good ones.
 */
export class IngestClarificationsDto {
  @ApiProperty({ type: [String], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  questions?: string[];

  @ApiProperty({ type: [ClarificationItemDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ClarificationItemDto)
  items?: ClarificationItemDto[];
}

/** EM run → plan.md content. */
export class IngestPlanDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  markdown!: string;
}

/** One item in an ingested backlog.json. */
export class IngestBacklogItemDto {
  @ApiProperty() @IsString() @MinLength(1) id!: string;
  /** Absent on a correction, which carries only the id and the fields being changed. */
  @ApiProperty({ enum: BacklogItemType, required: false })
  @IsOptional()
  @IsEnum(BacklogItemType)
  type?: BacklogItemType;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MinLength(1) title?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() description?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() acceptanceCriteria?: string;
  @ApiProperty({ required: false, nullable: true }) @IsOptional() @IsString() parentId?:
    string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() repo?: string | null;
  @ApiProperty({ required: false }) @IsOptional() @IsString() sprint?: string | null;

  /**
   * Ids this item needs to exist first.
   *
   * Without it nothing can check ordering across the tree — a Settings toggle scheduled a sprint
   * before the Settings drawer it lives in is not a parent/child mistake, so only the stated
   * dependency catches it. Absent means "the agent said nothing", which the correction merge
   * reads as "keep what is there"; `[]` means "depends on nothing".
   */
  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dependsOn?: string[];
}

/** SM run → backlog.json. */
export class IngestBacklogDto {
  @ApiProperty({ type: [IngestBacklogItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IngestBacklogItemDto)
  items!: IngestBacklogItemDto[];
}
