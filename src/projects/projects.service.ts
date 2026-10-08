import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { Project, ProjectDocument } from './schemas/project.schema';
import { AppSecretsService } from '../common/secrets/app-secrets.service';
import { DEFAULT_UI_STYLE } from './ui-style-choice';

/** Project persistence and lifecycle (create/list/get/update/delete). */
@Injectable()
export class ProjectsService {
  constructor(
    @InjectModel(Project.name) private readonly projectModel: Model<ProjectDocument>,
    private readonly appSecrets: AppSecretsService,
  ) {}

  /**
   * Creates a project from the little that is known before anything has been planned.
   *
   * The database is deliberately left `unset`: nothing yet knows whether this product even has a
   * backend, and asking for a database before that is answered is asking someone to guess. It is
   * requested after planning, once the plan says one is needed. A project created before this
   * behaviour keeps whatever it was given — an explicit value is never overwritten.
   */
  async create(dto: CreateProjectDto, createdBy: string): Promise<ProjectDocument> {
    const project = await new this.projectModel({
      name: dto.name,
      description: dto.description ?? '',
      adoTarget: dto.adoTarget,
      targetRepos: dto.targetRepos ?? [],
      database: dto.database ?? 'unset',
      uiStyle: dto.uiStyle ?? DEFAULT_UI_STYLE,
      createdBy: new Types.ObjectId(createdBy),
    }).save();

    if (dto.adoPat?.trim()) {
      await this.setAdoPat(project.id as string, dto.adoPat);
      return this.findById(project.id as string);
    }
    return project;
  }

  /**
   * Stores this project's Azure DevOps token in Key Vault.
   *
   * Write-only by design: the value is never read back into a response, and the document records
   * only that one exists. A token that can create repositories and delete work items should leave
   * the vault for exactly one purpose — talking to Azure DevOps.
   */
  async setAdoPat(projectId: string, pat: string): Promise<ProjectDocument> {
    await this.appSecrets.set(projectId, 'ADO_PAT', pat.trim());
    await this.projectModel.updateOne({ _id: projectId }, { $set: { adoPatConfigured: true } });
    return this.findById(projectId);
  }

  findAll(): Promise<ProjectDocument[]> {
    return this.projectModel.find().sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<ProjectDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Project not found.');
    }
    const project = await this.projectModel.findById(id).exec();
    if (!project) {
      throw new NotFoundException('Project not found.');
    }
    return project;
  }

  async update(id: string, dto: UpdateProjectDto): Promise<ProjectDocument> {
    const project = await this.findById(id);
    if (dto.name !== undefined) project.name = dto.name;
    if (dto.description !== undefined) project.description = dto.description;
    if (dto.adoTarget !== undefined) project.adoTarget = dto.adoTarget;
    if (dto.targetRepos !== undefined) project.targetRepos = dto.targetRepos;
    if (dto.database !== undefined) project.database = dto.database;
    if (dto.uiStyle !== undefined) project.uiStyle = dto.uiStyle;
    return project.save();
  }

  async remove(id: string): Promise<void> {
    const result = await this.projectModel.deleteOne({ _id: id }).exec();
    if (result.deletedCount === 0) {
      throw new NotFoundException('Project not found.');
    }
  }
}
