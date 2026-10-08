import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/**
 * A project's own Azure DevOps token.
 *
 * Write-only: it goes straight to Key Vault and is never read back into any response. The project
 * document records only that one exists, so the interface can say "configured" without the value
 * ever leaving the vault.
 */
export class SetAdoPatDto {
  @ApiProperty({ description: 'Stored in Key Vault; never returned by any endpoint.' })
  @IsString()
  @MinLength(1)
  adoPat!: string;
}
