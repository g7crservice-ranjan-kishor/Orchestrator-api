import { ApiProperty } from '@nestjs/swagger';
import { Role, UserDocument } from '../schemas/user.schema';

/** Safe user projection returned by the API. Never includes the password hash. */
export class UserResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ enum: Role, isArray: true })
  roles!: Role[];

  @ApiProperty()
  disabled!: boolean;

  static fromDocument(doc: UserDocument): UserResponseDto {
    return {
      id: doc.id,
      email: doc.email,
      displayName: doc.displayName,
      roles: doc.roles,
      disabled: doc.disabled,
    };
  }
}
