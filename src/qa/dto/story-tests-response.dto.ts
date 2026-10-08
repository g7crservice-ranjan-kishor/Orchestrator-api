import { ApiProperty } from '@nestjs/swagger';
import { StoryTestCase, StoryTests, TestTabOutcome } from '../qa-test-tab';

/** One Test Case row on the Story Test tab (read-only projection). */
export class StoryTestCaseDto implements StoryTestCase {
  @ApiProperty({ description: 'Test Case work-item id.' })
  testCaseId!: number;

  @ApiProperty({ description: 'Test Case title.' })
  title!: string;

  @ApiProperty({ description: 'Test Case work-item state (e.g. Design/Ready/Closed).' })
  state!: string;

  @ApiProperty({
    enum: ['Passed', 'Failed', 'Blocked', 'NotRun'],
    description:
      'Latest recorded test-point outcome (NotRun when none / Test Results unavailable).',
  })
  outcome!: TestTabOutcome;
}

/** A Story's Test Cases + latest outcomes for the Test tab (Phase 3, one-directional). */
export class StoryTestsResponseDto implements StoryTests {
  @ApiProperty({ description: 'Story (Product Backlog Item) work-item id.' })
  storyId!: number;

  @ApiProperty({ type: [StoryTestCaseDto], description: "The Story's Test Cases and outcomes." })
  testCases!: StoryTestCaseDto[];

  static fromStoryTests(s: StoryTests): StoryTestsResponseDto {
    return { storyId: s.storyId, testCases: s.testCases };
  }
}
