import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Role } from './schemas/user.schema';

/** Administrator-only user management. Guarded by the global JWT guard plus a role check. */
@ApiTags('users')
@ApiBearerAuth('access-token')
@UseGuards(RolesGuard)
@Roles(Role.Administrator)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a user (Administrator only).' })
  @ApiOkResponse({ type: UserResponseDto })
  async create(@Body() dto: CreateUserDto): Promise<UserResponseDto> {
    const doc = await this.users.create(dto);
    return UserResponseDto.fromDocument(doc);
  }

  @Get()
  @ApiOperation({ summary: 'List all users.' })
  @ApiOkResponse({ type: UserResponseDto, isArray: true })
  async findAll(): Promise<UserResponseDto[]> {
    const docs = await this.users.findAll();
    return docs.map(UserResponseDto.fromDocument);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a user by id.' })
  @ApiOkResponse({ type: UserResponseDto })
  async findOne(@Param('id') id: string): Promise<UserResponseDto> {
    const doc = await this.users.findById(id);
    return UserResponseDto.fromDocument(doc);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a user.' })
  @ApiOkResponse({ type: UserResponseDto })
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto): Promise<UserResponseDto> {
    const doc = await this.users.update(id, dto);
    return UserResponseDto.fromDocument(doc);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a user.' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.users.remove(id);
  }
}
