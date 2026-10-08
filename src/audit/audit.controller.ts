import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { AuditEntryDto } from './dto/audit-response.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Role } from '../users/schemas/user.schema';

/** Read-only audit trail viewer (Administrator only). The log is append-only; there is no write API. */
@ApiTags('audit')
@ApiBearerAuth('access-token')
@UseGuards(RolesGuard)
@Roles(Role.Administrator)
@Controller()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('audit')
  @ApiOperation({ summary: 'List audit entries (most recent first).' })
  @ApiOkResponse({ type: AuditEntryDto, isArray: true })
  async list(@Query('projectId') projectId?: string): Promise<AuditEntryDto[]> {
    const docs = await this.audit.list(projectId);
    return docs.map(AuditEntryDto.fromDocument);
  }

  @Get('projects/:projectId/audit')
  @ApiOperation({ summary: 'List audit entries for a project.' })
  @ApiOkResponse({ type: AuditEntryDto, isArray: true })
  async listForProject(@Param('projectId') projectId: string): Promise<AuditEntryDto[]> {
    const docs = await this.audit.list(projectId);
    return docs.map(AuditEntryDto.fromDocument);
  }
}
