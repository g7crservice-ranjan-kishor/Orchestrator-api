import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BlobService } from '../common/storage/blob.service';
import { ProjectsService } from '../projects/projects.service';
import { CreateRequirementDto } from './dto/create-requirement.dto';
import { Requirement, RequirementDocument } from './schemas/requirement.schema';

/** Uploaded file shape (subset of Express.Multer.File used here). */
export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

/**
 * Requirement intake: create a text requirement linked to a project and attach uploaded documents
 * (stored in Blob). Verifies the project exists before writing.
 */
@Injectable()
export class RequirementsService {
  constructor(
    @InjectModel(Requirement.name) private readonly model: Model<RequirementDocument>,
    private readonly projects: ProjectsService,
    private readonly blob: BlobService,
  ) {}

  async create(
    projectId: string,
    dto: CreateRequirementDto,
    createdBy: string,
  ): Promise<RequirementDocument> {
    await this.projects.findById(projectId); // 404 if the project does not exist
    return new this.model({
      projectId: new Types.ObjectId(projectId),
      text: dto.text,
      createdBy: new Types.ObjectId(createdBy),
    }).save();
  }

  listForProject(projectId: string): Promise<RequirementDocument[]> {
    if (!Types.ObjectId.isValid(projectId)) {
      return Promise.resolve([]);
    }
    return this.model
      .find({ projectId: new Types.ObjectId(projectId) })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findById(id: string): Promise<RequirementDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Requirement not found.');
    }
    const doc = await this.model.findById(id).exec();
    if (!doc) {
      throw new NotFoundException('Requirement not found.');
    }
    return doc;
  }

  /** Uploads an attachment to Blob and appends its metadata to the requirement. */
  async addAttachment(id: string, file: UploadedFile): Promise<RequirementDocument> {
    const requirement = await this.findById(id);
    const stored = await this.blob.upload(`requirements/${id}`, file);
    requirement.attachments.push(stored);
    return requirement.save();
  }
}
