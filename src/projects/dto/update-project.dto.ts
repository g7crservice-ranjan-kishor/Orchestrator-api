import { PartialType } from '@nestjs/swagger';
import { CreateProjectDto } from './create-project.dto';

/** Partial update for a project (all fields optional). */
export class UpdateProjectDto extends PartialType(CreateProjectDto) {}
