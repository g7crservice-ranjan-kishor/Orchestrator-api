import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Request to start a Developer run for one approved ADO Task. */
export class StartDevelopmentDto {
  @ApiProperty({ description: 'The Azure DevOps Task work-item id to implement.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  workItemId!: string;

  @ApiProperty({
    description: "Target Azure Repos repository (one of the project's target repos).",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  repo!: string;
}
