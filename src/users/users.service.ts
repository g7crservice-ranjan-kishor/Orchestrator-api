import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PasswordService } from '../auth/password.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { Role, User, UserDocument } from './schemas/user.schema';

/**
 * User persistence and lifecycle. Passwords are hashed via {@link PasswordService} before storage;
 * the service never returns or logs the hash.
 */
@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly passwords: PasswordService,
  ) {}

  async create(dto: CreateUserDto): Promise<UserDocument> {
    const existing = await this.userModel.findOne({ email: dto.email.toLowerCase() }).exec();
    if (existing) {
      throw new ConflictException('A user with this email already exists.');
    }
    const passwordHash = await this.passwords.hash(dto.password);
    const created = new this.userModel({
      email: dto.email.toLowerCase(),
      displayName: dto.displayName,
      passwordHash,
      roles: dto.roles ?? [Role.Administrator],
    });
    return created.save();
  }

  findAll(): Promise<UserDocument[]> {
    return this.userModel.find().exec();
  }

  async findById(id: string): Promise<UserDocument> {
    const user = await this.userModel.findById(id).exec();
    if (!user) {
      throw new NotFoundException('User not found.');
    }
    return user;
  }

  /** Case-insensitive lookup by email; returns null if not found (used by auth). */
  findByEmail(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() }).exec();
  }

  async update(id: string, dto: UpdateUserDto): Promise<UserDocument> {
    const user = await this.findById(id);
    if (dto.displayName !== undefined) {
      user.displayName = dto.displayName;
    }
    if (dto.roles !== undefined) {
      user.roles = dto.roles;
    }
    if (dto.disabled !== undefined) {
      user.disabled = dto.disabled;
    }
    if (dto.password !== undefined) {
      user.passwordHash = await this.passwords.hash(dto.password);
    }
    return user.save();
  }

  async remove(id: string): Promise<void> {
    const result = await this.userModel.deleteOne({ _id: id }).exec();
    if (result.deletedCount === 0) {
      throw new NotFoundException('User not found.');
    }
  }

  /** Records a failed login and locks the account once the threshold is reached. */
  async registerFailedLogin(id: string, maxAttempts: number, lockMs: number): Promise<void> {
    const user = await this.userModel.findById(id).exec();
    if (!user) {
      return;
    }
    user.failedLoginAttempts += 1;
    if (user.failedLoginAttempts >= maxAttempts) {
      user.lockedUntil = new Date(Date.now() + lockMs);
      user.failedLoginAttempts = 0;
    }
    await user.save();
  }

  /** Clears failed-login state after a successful authentication. */
  async registerSuccessfulLogin(id: string): Promise<void> {
    await this.userModel
      .updateOne({ _id: id }, { $set: { failedLoginAttempts: 0, lockedUntil: null } })
      .exec();
  }
}
