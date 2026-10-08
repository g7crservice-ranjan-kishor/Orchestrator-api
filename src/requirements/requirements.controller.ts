import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirementsService, type UploadedFile as UploadedFileType } from './requirements.service';
import { CreateRequirementDto } from './dto/create-requirement.dto';
import { RequirementResponseDto } from './dto/requirement-response.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';

/** Max attachment size accepted by the intake API (10 MiB). */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

@ApiTags('requirements')
@ApiBearerAuth('access-token')
@Controller()
export class RequirementsController {
  constructor(private readonly requirements: RequirementsService) {}

  @Post('projects/:projectId/requirements')
  @ApiOperation({ summary: 'Submit a text requirement for a project.' })
  @ApiOkResponse({ type: RequirementResponseDto })
  async create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateRequirementDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RequirementResponseDto> {
    const doc = await this.requirements.create(projectId, dto, user.userId);
    return RequirementResponseDto.fromDocument(doc);
  }

  @Get('projects/:projectId/requirements')
  @ApiOperation({ summary: 'List requirements for a project.' })
  @ApiOkResponse({ type: RequirementResponseDto, isArray: true })
  async list(@Param('projectId') projectId: string): Promise<RequirementResponseDto[]> {
    const docs = await this.requirements.listForProject(projectId);
    return docs.map(RequirementResponseDto.fromDocument);
  }

  @Post('requirements/:id/attachments')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Attach a document (uploaded to Blob) to a requirement.' })
  @ApiOkResponse({ type: RequirementResponseDto })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES } }))
  async addAttachment(
    @Param('id') id: string,
    @UploadedFile() file: UploadedFileType | undefined,
  ): Promise<RequirementResponseDto> {
    if (!file) {
      throw new BadRequestException('A file is required (multipart field "file").');
    }
    const doc = await this.requirements.addAttachment(id, file);
    return RequirementResponseDto.fromDocument(doc);
  }
}
