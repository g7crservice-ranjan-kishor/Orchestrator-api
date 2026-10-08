import { Module } from '@nestjs/common';
import { KnowledgeBaseService } from './knowledge-base.service';
import { BlobModule } from '../common/storage/blob.module';

/**
 * A project's knowledge base, stored in Blob under the project's own id.
 *
 * Exported rather than kept private because three things need it: the push (which seeds it), the
 * run context (which grounds every agent with it), and the API the person edits it through.
 */
@Module({
  imports: [BlobModule],
  providers: [KnowledgeBaseService],
  exports: [KnowledgeBaseService],
})
export class KnowledgeBaseModule {}
