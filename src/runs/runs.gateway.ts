import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TokenService } from '../auth/token.service';
import { SessionsService } from '../auth/sessions/sessions.service';
import { RunEventDto } from './dto/run-event.dto';

/** Room name for a run's event stream. */
const runRoom = (runId: string): string => `run:${runId}`;

/**
 * Relays run events to the UI over WebSocket (Socket.IO), authenticated by the user's access token
 * on the handshake and confirmed against an active session (DEVELOPMENT_GUIDELINES §3). Clients
 * subscribe to a specific run; the backend emits `run-event` into that run's room. No Redis in
 * Milestone 1 — a single backend instance relays in-process.
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class RunsGateway implements OnGatewayConnection {
  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionsService,
  ) {}

  /** Authenticates the socket on connect; disconnects unauthenticated clients. */
  async handleConnection(client: Socket): Promise<void> {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      (client.handshake.query?.token as string | undefined);
    if (!token) {
      client.disconnect(true);
      return;
    }
    try {
      const claims = await this.tokens.verifyAccessToken(token);
      const session = await this.sessions.findActive(claims.sid);
      if (!session) {
        client.disconnect(true);
        return;
      }
      client.data.userId = claims.sub;
    } catch {
      client.disconnect(true);
    }
  }

  /** Subscribes the client to a run's event stream. */
  @SubscribeMessage('subscribe')
  subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: { runId: string }): void {
    if (client.data.userId && body?.runId) {
      void client.join(runRoom(body.runId));
    }
  }

  /** Emits an event to all UI clients subscribed to this run. */
  relay(runId: string, event: RunEventDto): void {
    this.server?.to(runRoom(runId)).emit('run-event', { runId, ...event });
  }
}
