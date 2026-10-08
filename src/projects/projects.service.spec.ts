import { NotFoundException } from '@nestjs/common';
import { ProjectsService } from './projects.service';

function mockModel(overrides: Record<string, unknown> = {}) {
  return { findById: jest.fn(), find: jest.fn(), deleteOne: jest.fn(), ...overrides };
}

/** The vault the service writes a project's own Azure DevOps token to; never read back. */
const secrets = () => ({ set: jest.fn().mockResolvedValue(undefined) });

describe('ProjectsService', () => {
  it('findById throws NotFound for an invalid id', async () => {
    const service = new ProjectsService(mockModel() as never, secrets() as never);
    await expect(service.findById('bad-id')).rejects.toThrow(NotFoundException);
  });

  it('findById throws NotFound when the project is absent', async () => {
    const model = mockModel({
      findById: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
    });
    const service = new ProjectsService(model as never, secrets() as never);
    await expect(service.findById('507f1f77bcf86cd799439011')).rejects.toThrow(NotFoundException);
  });

  it('remove throws NotFound when nothing was deleted', async () => {
    const model = mockModel({
      deleteOne: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue({ deletedCount: 0 }) }),
    });
    const service = new ProjectsService(model as never, secrets() as never);
    await expect(service.remove('507f1f77bcf86cd799439011')).rejects.toThrow(NotFoundException);
  });

  it('update applies provided fields and saves', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const doc = {
      name: 'old',
      description: 'old',
      adoTarget: { orgUrl: 'x', project: 'y', areaPath: 'z' },
      targetRepos: [],
      save,
    };
    const model = mockModel({
      findById: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) }),
    });
    const service = new ProjectsService(model as never, secrets() as never);
    await service.update('507f1f77bcf86cd799439011', { name: 'new', targetRepos: ['r1'] });
    expect(doc.name).toBe('new');
    expect(doc.targetRepos).toEqual(['r1']);
    expect(save).toHaveBeenCalled();
  });
});
