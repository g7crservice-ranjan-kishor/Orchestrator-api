import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectResponseDto } from './dto/project-response.dto';
import { SetAdoPatDto } from './dto/set-ado-pat.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';

@ApiTags('projects')
@ApiBearerAuth('access-token')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a project with its ADO target and target repos.' })
  @ApiOkResponse({ type: ProjectResponseDto })
  async create(
    @Body() dto: CreateProjectDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ProjectResponseDto> {
    const doc = await this.projects.create(dto, user.userId);
    return ProjectResponseDto.fromDocument(doc);
  }

  @Get()
  @ApiOperation({ summary: 'List all projects.' })
  @ApiOkResponse({ type: ProjectResponseDto, isArray: true })
  async findAll(): Promise<ProjectResponseDto[]> {
    const docs = await this.projects.findAll();
    return docs.map(ProjectResponseDto.fromDocument);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a project by id.' })
  @ApiOkResponse({ type: ProjectResponseDto })
  async findOne(@Param('id') id: string): Promise<ProjectResponseDto> {
    return ProjectResponseDto.fromDocument(await this.projects.findById(id));
  }

  @Put(':id/ado-pat')
  @ApiOperation({
    summary:
      "Set or rotate this project's Azure DevOps token. Stored in Key Vault, never returned.",
  })
  @ApiOkResponse({ type: ProjectResponseDto })
  async setAdoPat(@Param('id') id: string, @Body() dto: SetAdoPatDto): Promise<ProjectResponseDto> {
    return ProjectResponseDto.fromDocument(await this.projects.setAdoPat(id, dto.adoPat));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a project.' })
  @ApiOkResponse({ type: ProjectResponseDto })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
  ): Promise<ProjectResponseDto> {
    return ProjectResponseDto.fromDocument(await this.projects.update(id, dto));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a project.' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.projects.remove(id);
  }
}
