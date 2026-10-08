import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RequirementsService } from './requirements.service';
import { RequirementsController } from './requirements.controller';
import { Requirement, RequirementSchema } from './schemas/requirement.schema';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Requirement.name, schema: RequirementSchema }]),
    ProjectsModule,
  ],
  controllers: [RequirementsController],
  providers: [RequirementsService],
  exports: [RequirementsService],
})
export class RequirementsModule {}
