import { Global, Module } from '@nestjs/common';
import { BlobService } from './blob.service';

/** Global Blob storage access (Workload Identity). */
@Global()
@Module({
  providers: [BlobService],
  exports: [BlobService],
})
export class BlobModule {}
