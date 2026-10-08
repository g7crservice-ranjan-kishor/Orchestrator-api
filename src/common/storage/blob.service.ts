import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../config/app-config.service';

/** Metadata for a stored blob returned to callers (never the storage credentials). */
export interface StoredBlob {
  blobName: string;
  originalName: string;
  contentType: string;
  size: number;
  url: string;
}

/**
 * Uploads attachments/artifacts to Azure Blob Storage using Workload Identity — no account keys
 * (ENVIRONMENT_CONFIGURATION.md §4). Requires `BLOB_ACCOUNT_URL` + `BLOB_CONTAINER`; if unset the
 * service reports unavailable rather than failing silently.
 */
@Injectable()
export class BlobService {
  private readonly logger = new Logger(BlobService.name);
  private container?: ContainerClient;

  /*
   * Two ways in, and the order matters.
   *
   * **Workload identity** is the one that is meant to be used, and the only one a deployed
   * environment gets: nothing long-lived is stored, access is granted and revoked in Azure, and
   * there is no key that can be pasted into a chat window and live for ever.
   *
   * **A connection string** exists for local development, where that is genuinely awkward.
   * `DefaultAzureCredential` falls through to whichever account the Azure CLI happens to be
   * signed in to — so on a shared machine the knowledge base silently depends on whose session
   * is active, which is how a storage account that *had* been granted access still refused every
   * write. A connection string makes the identity explicit instead of ambient.
   *
   * It is checked first, because someone who sets one has said what they want. It is also logged
   * loudly: a key in an environment file is a credential that does not expire, grants the whole
   * account rather than one container, and cannot be attributed to a person afterwards.
   */
  constructor(config: AppConfigService) {
    const containerName = config.blobContainer;
    const connectionString = config.blobConnectionString;
    const accountUrl = config.blobAccountUrl;

    if (!containerName) {
      this.logger.warn('Blob storage not configured (BLOB_CONTAINER absent).');
      return;
    }

    if (connectionString) {
      this.logger.warn(
        'Blob storage is using BLOB_CONNECTION_STRING. An account key grants full access to the ' +
          'whole storage account, never expires, and cannot be traced to a person. Use workload ' +
          'identity outside local development.',
      );
      this.container =
        BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
      return;
    }

    if (accountUrl) {
      const credential = new DefaultAzureCredential(
        config.azureClientId ? { managedIdentityClientId: config.azureClientId } : {},
      );
      this.container = new BlobServiceClient(accountUrl, credential).getContainerClient(
        containerName,
      );
      return;
    }

    this.logger.warn(
      'Blob storage not configured (neither BLOB_CONNECTION_STRING nor BLOB_ACCOUNT_URL is set).',
    );
  }

  get isConfigured(): boolean {
    return this.container !== undefined;
  }

  /** Uploads a buffer under a unique key within the given prefix; returns its metadata. */
  async upload(
    prefix: string,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number },
  ): Promise<StoredBlob> {
    if (!this.container) {
      throw new ServiceUnavailableException('Attachment storage is not configured.');
    }
    const blobName = `${prefix}/${randomUUID()}-${file.originalname}`;
    const block = this.container.getBlockBlobClient(blobName);
    await block.uploadData(file.buffer, {
      blobHTTPHeaders: { blobContentType: file.mimetype },
    });
    return {
      blobName,
      originalName: file.originalname,
      contentType: file.mimetype,
      size: file.size,
      url: block.url,
    };
  }

  /*
   * Text documents, addressed by a key the caller chooses.
   *
   * Separate from {@link upload}, which invents a unique name because two people may attach two
   * files called `notes.pdf` to the same requirement. A knowledge base is the opposite: its
   * documents are addressed *by name* — a prompt says "read conventions.md" — so writing the same
   * name twice must replace the document rather than leave two.
   */

  /** Writes (or replaces) a text document at `key`. */
  async putText(key: string, text: string): Promise<void> {
    if (!this.container) {
      throw new ServiceUnavailableException('Document storage is not configured.');
    }
    const block = this.container.getBlockBlobClient(key);
    const body = Buffer.from(text, 'utf8');
    await block.uploadData(body, {
      blobHTTPHeaders: { blobContentType: 'text/markdown; charset=utf-8' },
    });
  }

  /** Reads a text document, or null when it is not there. */
  async getText(key: string): Promise<string | null> {
    if (!this.container) {
      throw new ServiceUnavailableException('Document storage is not configured.');
    }
    try {
      const buffer = await this.container.getBlockBlobClient(key).downloadToBuffer();
      return buffer.toString('utf8');
    } catch (err) {
      // Absent is an ordinary answer for a knowledge base that has not been written yet.
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw err;
    }
  }

  /** Every blob key under `prefix`, in the order Azure returns them. */
  async list(prefix: string): Promise<string[]> {
    if (!this.container) {
      throw new ServiceUnavailableException('Document storage is not configured.');
    }
    const keys: string[] = [];
    for await (const blob of this.container.listBlobsFlat({ prefix })) {
      keys.push(blob.name);
    }
    return keys;
  }

  /** Removes a document. Absent is success — the caller wanted it gone. */
  async removeText(key: string): Promise<void> {
    if (!this.container) return;
    await this.container.getBlockBlobClient(key).deleteIfExists();
  }
}
