import type { DnsRecord } from './decommission';
export type DnsQuery = (
  name: string,
  type: DnsRecord['type'],
) => Promise<string[]>;
/** Bounded read-only collector, injectable for offline tests; no resolver invoked at import. */
export async function collectDns(names: string[], query: DnsQuery) {
  const pending = [...new Set(names)];
  const visited = new Set<string>();
  const records: DnsRecord[] = [];
  let complete = true;
  while (pending.length && visited.size < 16) {
    const name = pending.shift()!;
    if (visited.has(name)) continue;
    if (!/^(?=.{1,253}$)(?:[a-z0-9-]+\.)+[a-z0-9-]+$/.test(name)) {
      complete = false;
      break;
    }
    visited.add(name);
    let answerCount = 0;
    for (const type of ['A', 'AAAA', 'CNAME'] as const) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answers = await Promise.race([
          query(name, type),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('DNS_TIMEOUT')), 3000);
          }),
        ]);
        if (
          !Array.isArray(answers) ||
          answers.length > 32 ||
          answers.some((value) => typeof value !== 'string')
        ) {
          complete = false;
          continue;
        }
        answerCount += answers.length;
        records.push({ name, type, answers, active: true });
        if (type === 'CNAME')
          for (const target of answers) {
            const normalized = target.toLowerCase().replace(/\.$/, '');
            if (!visited.has(normalized)) pending.push(normalized);
          }
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (!['ENODATA', 'ENOTFOUND'].includes(code ?? '')) complete = false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (!answerCount) complete = false;
  }
  function cycles(name: string, ancestors: Set<string>): boolean {
    if (ancestors.has(name)) return true;
    const next = new Set(ancestors);
    next.add(name);
    return records
      .filter((record) => record.name === name && record.type === 'CNAME')
      .some((record) =>
        record.answers.some((answer) =>
          cycles(answer.toLowerCase().replace(/\.$/, ''), next),
        ),
      );
  }
  if ([...visited].some((name) => cycles(name, new Set()))) complete = false;
  return {
    records,
    resolutionComplete: complete && pending.length === 0,
    namesChecked: visited.size,
  };
}
