import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditAction, AuditLog, AuditLogDocument } from './schemas/audit-log.schema';
import { AuthenticatedUser } from '../auth/types/authenticated-user';

/** The actor for an audit entry — an authenticated user, or the system for automated actions. */
export interface AuditActor {
  actorId: string | null;
  actorEmail: string;
}

export interface AppendAuditInput {
  actor: AuditActor;
  action: AuditAction;
  entityType: string;
  entityId: string;
  projectId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit trail. Records every gate approval, mutating action, and the ADO push with
 * actor + timestamp. Exposes append + read only; the schema itself blocks updates/deletes so the
 * trail is immutable (WORKFLOW.md §5).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@InjectModel(AuditLog.name) private readonly auditModel: Model<AuditLogDocument>) {}

  /** Derives an {@link AuditActor} from the authenticated principal (or system when absent). */
  static actorFrom(user?: AuthenticatedUser | null): AuditActor {
    return user
      ? { actorId: user.userId, actorEmail: user.email }
      : { actorId: null, actorEmail: 'system' };
  }

  /** Appends one entry. Never throws into the caller's flow — auditing must not break the action. */
  async append(input: AppendAuditInput): Promise<AuditLogDocument | null> {
    try {
      return await new this.auditModel({
        actorId: input.actor.actorId ? new Types.ObjectId(input.actor.actorId) : null,
        actorEmail: input.actor.actorEmail,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        projectId: input.projectId ? new Types.ObjectId(input.projectId) : null,
        metadata: input.metadata ?? {},
      }).save();
    } catch (err) {
      this.logger.error(
        `Failed to append audit entry '${input.action}': ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Most-recent-first audit entries, optionally scoped to a project. */
  list(projectId?: string, limit = 200): Promise<AuditLogDocument[]> {
    const filter = projectId ? { projectId: new Types.ObjectId(projectId) } : {};
    return this.auditModel.find(filter).sort({ createdAt: -1 }).limit(limit).exec();
  }
}
