import { ApiProperty, PartialType } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { BacklogItemType } from '../schemas/draft.schema';

/** Create a backlog card. */
export class CreateBacklogItemDto {
  @ApiProperty({ enum: BacklogItemType })
  @IsEnum(BacklogItemType)
  type!: BacklogItemType;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  title!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  acceptanceCriteria?: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  parentId?: string | null;

  @ApiProperty({ required: false, minimum: 1, maximum: 4 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  priority?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  repo?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  sprint?: string;
}

/** Partial update of a backlog card. */
export class UpdateBacklogItemDto extends PartialType(CreateBacklogItemDto) {
  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  dependsOn?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  order?: number;
}

/** Re-parent + reorder a card in one move (Kanban drag). */
export class MoveBacklogItemDto {
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  parentId?: string | null;

  @ApiProperty()
  @IsInt()
  @Min(0)
  order!: number;
}
