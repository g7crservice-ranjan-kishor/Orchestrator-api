import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AdoProvisioningService,
  PreflightResult,
  ProjectConfiguration,
} from './ado-provisioning.service';
import { CreateProjectDto } from '../projects/dto/create-project.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ApplyConfigurationDto, EnsureRepositoriesDto, PreflightDto } from './dto/provisioning.dto';
import { ProjectResponseDto } from '../projects/dto/project-response.dto';

/**
 * Setting a project up in Azure DevOps: checking the token, and creating what the product needs.
 *
 * Lives in the ADO module rather than the projects module because it needs both, and the projects
 * module must not depend on this one.
 */
@ApiTags('ado')
@ApiBearerAuth('access-token')
@Controller()
export class AdoProvisioningController {
  constructor(private readonly provisioning: AdoProvisioningService) {}

  @Post('ado/preflight')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check an organization URL and token, and list what they can see.',
    description:
      'Answers whether the token works before anything is stored. The token is used for this ' +
      'request only: it is not saved, logged, or returned.',
  })
  async preflight(@Body() dto: PreflightDto): Promise<PreflightResult> {
    return this.provisioning.preflight(dto.orgUrl, dto.pat, dto.project ?? null);
  }

  @Post('ado/projects')
  @ApiOperation({
    summary: 'Create a project and set it up in Azure DevOps.',
    description:
      'Stores the project token and creates the area path if it is missing. Setup steps that ' +
      'could not be completed come back as warnings; the project is still created.',
  })
  async create(
    @Body() dto: CreateProjectDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ProjectResponseDto & { warnings: string[] }> {
    const { project, warnings } = await this.provisioning.provisionProject(dto, user.userId);
    return { ...ProjectResponseDto.fromDocument(project), warnings };
  }

  @Post('projects/:projectId/provisioning/area-path')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Create the project's area path in Azure DevOps if it is missing." })
  async areaPath(@Param('projectId') projectId: string): Promise<{ areaPath: string }> {
    return { areaPath: await this.provisioning.ensureAreaPath(projectId) };
  }

  @Get('projects/:projectId/provisioning/configuration')
  @ApiOperation({
    summary: 'What the plan says the project still has to be configured with.',
  })
  async configuration(@Param('projectId') projectId: string): Promise<ProjectConfiguration> {
    return this.provisioning.configuration(projectId);
  }

  @Post('projects/:projectId/provisioning/configuration')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record the database and create the repositories the plan calls for.',
    description:
      'Answers whether the plan now needs regenerating — changing the database after planning ' +
      'makes the existing plan wrong.',
  })
  async applyConfiguration(
    @Param('projectId') projectId: string,
    @Body() dto: ApplyConfigurationDto,
  ): Promise<ProjectResponseDto & { replanNeeded: boolean }> {
    const { project, replanNeeded } = await this.provisioning.applyConfiguration(projectId, dto);
    return { ...ProjectResponseDto.fromDocument(project), replanNeeded };
  }

  @Post('projects/:projectId/provisioning/repositories')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create the named repositories if missing and record their clone URLs.',
  })
  async repositories(
    @Param('projectId') projectId: string,
    @Body() dto: EnsureRepositoriesDto,
  ): Promise<ProjectResponseDto> {
    const project = await this.provisioning.ensureRepositories(projectId, dto.names);
    return ProjectResponseDto.fromDocument(project);
  }
}
