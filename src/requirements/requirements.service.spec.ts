import { NotFoundException } from '@nestjs/common';
import { RequirementsService } from './requirements.service';
import { ProjectsService } from '../projects/projects.service';
import { BlobService } from '../common/storage/blob.service';

describe('RequirementsService', () => {
  const blob = { upload: jest.fn() } as unknown as BlobService;

  it('create verifies the project exists (propagates NotFound)', async () => {
    const projects = {
      findById: jest.fn().mockRejectedValue(new NotFoundException('Project not found.')),
    } as unknown as ProjectsService;
    const model = jest.fn() as unknown as never;
    const service = new RequirementsService(model, projects, blob);
    await expect(
      service.create('507f1f77bcf86cd799439011', { text: 'a valid requirement' }, 'u1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('addAttachment uploads to Blob and appends metadata', async () => {
    const attachments: unknown[] = [];
    const save = jest.fn().mockResolvedValue(undefined);
    const requirement = { attachments, save };
    const model = {
      findById: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(requirement) }),
    };
    (blob.upload as jest.Mock).mockResolvedValue({
      blobName: 'requirements/1/x-file.pdf',
      originalName: 'file.pdf',
      contentType: 'application/pdf',
      size: 123,
      url: 'https://blob/x',
    });
    const service = new RequirementsService(model as never, {} as ProjectsService, blob);
    await service.addAttachment('507f1f77bcf86cd799439011', {
      buffer: Buffer.from('x'),
      originalname: 'file.pdf',
      mimetype: 'application/pdf',
      size: 123,
    });
    expect(blob.upload).toHaveBeenCalled();
    expect(attachments).toHaveLength(1);
    expect(save).toHaveBeenCalled();
  });

  it('findById throws NotFound for an invalid id', async () => {
    const service = new RequirementsService(
      { findById: jest.fn() } as never,
      {} as ProjectsService,
      blob,
    );
    await expect(service.findById('bad')).rejects.toThrow(NotFoundException);
  });
});
