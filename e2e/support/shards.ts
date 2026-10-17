import type { Reporter } from '@playwright/test/reporter';

/**
 * CI runs the e2e job as shards (`--shard=i/3`). Playwright's own sharding gives each shard a contiguous run of the
 * tests in file order, counted in tests, which is fair only when tests cost about the same. Here they do not: the
 * axe audits come first in file order, and each test of `auditStates.spec.ts` (it walks a page's controls and scans
 * after every one) costs three or four ordinary tests, so the shard that got all of that file ran about twice as
 * long as the other two.
 *
 * This deals the tests out in turn instead, so every shard gets its share of every file, and it stays even as files
 * grow. A `test.describe` block is dealt as one unit, so a block that is made serial stays in one shard. It is a
 * reporter only because `preprocess` is where Playwright lets a run take over sharding. A `--reporter` on the
 * command line replaces the configured reporters, this one with them, and Playwright's own split applies again:
 * every test still runs once, just in different shards.
 */
export default class RoundRobinShards implements Reporter {
  preprocess({ config, suite, testRun }: Parameters<NonNullable<Reporter['preprocess']>>[0]): Promise<void> {
    const shard = config.shard;
    if (shard) {
      testRun.skipSharding();
      const units = suite.suites.flatMap((project) => project.suites.flatMap((file) => file.entries()));
      units.forEach((unit, i) => {
        if (i % shard.total !== shard.current - 1) testRun.exclude(unit);
      });
    }
    return Promise.resolve();
  }

  printsToStdio(): boolean {
    return false;
  }
}
