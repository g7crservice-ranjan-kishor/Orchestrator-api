import { Logger } from '@nestjs/common';
import { BlobServiceClient } from '@azure/storage-blob';
import { BlobService } from './blob.service';
import { AppConfigService } from '../config/app-config.service';

/**
 * How the service decides who it is.
 *
 * Workload identity is what production uses and what the design calls for. But locally,
 * `DefaultAzureCredential` falls through to whichever account the Azure CLI is signed in to — so
 * the knowledge base silently depended on whose session happened to be active on the machine.
 * A storage account that *had* been granted access to one person still refused every write,
 * because the API was quietly asking as somebody else. A connection string makes the identity
 * explicit, which is the entire reason it is supported at all.
 */

const config = (over: Partial<Record<string, string | undefined>> = {}) =>
  ({
    blobContainer: 'orchestrator',
    blobAccountUrl: undefined,
    blobConnectionString: undefined,
    azureClientId: undefined,
    ...over,
  }) as unknown as AppConfigService;

/** A syntactically valid string; the account does not have to exist to construct a client. */
const CONNECTION_STRING =
  'DefaultEndpointsProtocol=https;AccountName=example;AccountKey=' +
  Buffer.from('not-a-real-key').toString('base64') +
  ';EndpointSuffix=core.windows.net';

describe('BlobService credentials', () => {
  it('is not configured without a container', () => {
    expect(new BlobService(config({ blobContainer: undefined })).isConfigured).toBe(false);
  });

  it('is not configured when neither way in is given', () => {
    expect(new BlobService(config()).isConfigured).toBe(false);
  });

  it('uses workload identity when an account URL is given', () => {
    const service = new BlobService(
      config({ blobAccountUrl: 'https://example.blob.core.windows.net' }),
    );
    expect(service.isConfigured).toBe(true);
  });

  it('uses a connection string when one is given', () => {
    expect(new BlobService(config({ blobConnectionString: CONNECTION_STRING })).isConfigured).toBe(
      true,
    );
  });

  /**
   * Someone who sets a connection string has said what they want. Letting the account URL win
   * would leave them with the ambient-identity problem they set it to escape, and no sign of why.
   */
  it('prefers the connection string when both are set', () => {
    const spy = jest.spyOn(BlobServiceClient, 'fromConnectionString');
    const service = new BlobService(
      config({
        blobConnectionString: CONNECTION_STRING,
        blobAccountUrl: 'https://example.blob.core.windows.net',
      }),
    );
    expect(service.isConfigured).toBe(true);
    expect(spy).toHaveBeenCalledWith(CONNECTION_STRING);
    spy.mockRestore();
  });

  /** A key that never expires and covers the whole account should not pass without comment. */
  it('says out loud that a key is in use', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    new BlobService(config({ blobConnectionString: CONNECTION_STRING }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('BLOB_CONNECTION_STRING'));
    warn.mockRestore();
  });

  /** Workload identity is the ordinary path and must not be nagged about. */
  it('says nothing of the sort when workload identity is used', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    new BlobService(config({ blobAccountUrl: 'https://example.blob.core.windows.net' }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
