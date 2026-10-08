import { ApiProperty } from '@nestjs/swagger';
import { AdoTargetDto } from './ado-target.dto';
import { ProjectDocument } from '../schemas/project.schema';
import { DATABASE_IDS, DEFAULT_DATABASE, DatabaseChoice } from '../database-choice';
import { DEFAULT_UI_STYLE, UI_STYLE_IDS, UiStyleChoice } from '../ui-style-choice';

/** Project projection returned by the API. */
export class ProjectResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ type: AdoTargetDto })
  adoTarget!: AdoTargetDto;

  @ApiProperty({ type: [String] })
  targetRepos!: string[];

  @ApiProperty({ enum: DATABASE_IDS })
  database!: DatabaseChoice;

  @ApiProperty({ enum: UI_STYLE_IDS })
  uiStyle!: UiStyleChoice;

  /**
   * Whether this project has its own Azure DevOps token — never the token.
   *
   * A credential that can create repositories and delete work items has one legitimate destination,
   * and a JSON response is not it. The interface needs to know only whether one is configured.
   */
  @ApiProperty()
  adoPatConfigured!: boolean;

  static fromDocument(doc: ProjectDocument): ProjectResponseDto {
    return {
      id: doc.id,
      name: doc.name,
      description: doc.description,
      adoTarget: {
        orgUrl: doc.adoTarget.orgUrl,
        project: doc.adoTarget.project,
        areaPath: doc.adoTarget.areaPath,
      },
      targetRepos: doc.targetRepos,
      database: doc.database ?? DEFAULT_DATABASE,
      uiStyle: doc.uiStyle ?? DEFAULT_UI_STYLE,
      adoPatConfigured: Boolean(doc.adoPatConfigured),
    };
  }
}
