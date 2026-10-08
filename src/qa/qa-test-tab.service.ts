import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AdoClientService } from '../ado/ado-client.service';
import { ProjectsService } from '../projects/projects.service';
import { buildStoryTests, latestOutcomeByCase, StoryTests, TestCaseRef } from './qa-test-tab';

/**
 * Read-only Test-tab projection for a Story (ARCHITECTURE.md §4B, D-021): its linked Test Cases and
 * their latest recorded outcome. One-directional — reads from Azure DevOps (Work Item REST for the
 * Cases, Test Results REST for outcomes) and never writes back. The **work-item state** remains the
 * authoritative pass/fail signal; outcomes here are supporting evidence and degrade to `NotRun` when
 * the Test Results API returns nothing (D-020).
 */
@Injectable()
export class QaTestTabService {
  private readonly logger = new Logger(QaTestTabService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly ado: AdoClientService,
  ) {}

  /** Returns the Story's Test Cases + latest outcomes. Throws 400 for a non-numeric story id. */
  async getStoryTests(projectId: string, storyId: string): Promise<StoryTests> {
    const id = Number(storyId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException(`'${storyId}' is not a valid Azure DevOps work item id.`);
    }
    const project = await this.projects.findById(projectId); // 404 if unknown
    const adoProject = project.adoTarget.project;

    const caseIds = await this.ado.for(projectId).queryLinkedTestCaseIds(adoProject, id);
    if (caseIds.length === 0) {
      return { storyId: id, testCases: [] };
    }
    const workItems = await this.ado
      .for(projectId)
      .getWorkItemsBatch(caseIds, ['System.Title', 'System.State']);
    const cases: TestCaseRef[] = workItems.map((wi) => ({
      testCaseId: wi.id,
      title: String(wi.fields['System.Title'] ?? ''),
      state: String(wi.fields['System.State'] ?? ''),
    }));

    const results = await this.fetchOutcomesSafe(adoProject, caseIds, projectId);
    return buildStoryTests(id, cases, latestOutcomeByCase(results));
  }

  /**
   * Best-effort outcome fetch: a failure of the Test Results REST API (shape/permission/absence)
   * must not fail the tab, so it degrades to no outcomes (all Cases show `NotRun`). The authoritative
   * signal is the work-item state, which the board reads independently.
   */
  private async fetchOutcomesSafe(adoProject: string, caseIds: number[], owner: string) {
    try {
      return await this.ado.for(owner).queryTestResultsForCases(adoProject, caseIds);
    } catch (err) {
      this.logger.warn(`Test Results unavailable for story tests: ${(err as Error).message}`);
      return [];
    }
  }
}
