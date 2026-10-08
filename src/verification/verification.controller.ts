import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { VerificationService, VerificationView } from './verification.service';

/**
 * Product verification: start the whole product and report whether it works.
 *
 * Separate from the QA endpoints because it is not a test of a Story — it is a test of the product,
 * and it runs no agent at all.
 */
@ApiTags('verification')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/verification')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get()
  @ApiOperation({ summary: 'The most recent product verification for a project.' })
  @ApiOkResponse({ description: 'Its state, and the check report once it has finished.' })
  latest(@Param('projectId') projectId: string): Promise<VerificationView> {
    return this.verification.latest(projectId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start a product verification; a run already in flight is returned unchanged.',
  })
  start(@Param('projectId') projectId: string): Promise<VerificationView> {
    return this.verification.start(projectId);
  }
}
