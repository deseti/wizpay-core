import { collectDns } from './dns';
describe('read-only bounded DNS preparation', () => {
  it('collects A/AAAA/CNAME chains through injected resolver without production contacts', async () => {
    const query = jest.fn((name: string, type: string) =>
      Promise.resolve(
        type === 'CNAME' && name === 'app.fixture.test'
          ? ['api.fixture.test']
          : type === 'A'
            ? ['192.0.2.10']
            : [],
      ),
    );
    const result = await collectDns(
      ['app.fixture.test', 'api.fixture.test'],
      query,
    );
    expect(result.resolutionComplete).toBe(true);
    expect(result.namesChecked).toBe(2);
    expect(query).toHaveBeenCalledTimes(6);
    expect(
      query.mock.calls.every(([name]) => name.endsWith('.fixture.test')),
    ).toBe(true);
  });
  it('DNS timeout/failure, invalid name or unresolved host cannot count as success', async () => {
    expect(
      (await collectDns(['bad/secret'], () => Promise.resolve([])))
        .resolutionComplete,
    ).toBe(false);
    expect(
      (await collectDns(['api.fixture.test'], () => Promise.resolve([])))
        .resolutionComplete,
    ).toBe(false);
    expect(
      (
        await collectDns(['api.fixture.test'], () =>
          Promise.reject(new Error('no secret output')),
        )
      ).resolutionComplete,
    ).toBe(false);
  });
  it('cycles and excessive CNAME expansion fail closed', async () => {
    const cyclic = (name: string, type: string) =>
      Promise.resolve(type === 'CNAME' ? [name] : []);
    expect(
      (await collectDns(['app.fixture.test'], cyclic)).resolutionComplete,
    ).toBe(false);
    const expanded = await collectDns(['app.fixture.test'], (name, type) =>
      Promise.resolve(type === 'CNAME' ? ['x.' + name] : ['192.0.2.10']),
    );
    expect(expanded.resolutionComplete).toBe(false);
    expect(expanded.namesChecked).toBe(16);
  });
});
