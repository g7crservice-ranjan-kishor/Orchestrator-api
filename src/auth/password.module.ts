import { Module } from '@nestjs/common';
import { PasswordService } from './password.service';

/** Standalone hashing provider shared by users and auth (keeps the two modules acyclic). */
@Module({
  providers: [PasswordService],
  exports: [PasswordService],
})
export class PasswordModule {}
