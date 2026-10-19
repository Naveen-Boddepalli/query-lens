import { useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  DOCUMENTED,
  HERMITAGE_LEVELS,
  HERMITAGE_LEVEL_LABELS,
  HERMITAGE_TESTS,
  KNOWN_DIFFERENCES,
  hermitageMatrix,
} from '../../engine/hermitage.ts';
import type { AnomalyId, EngineKind, MatrixCell } from '../../engine/hermitage.ts';
import type { IsolationLevel } from '../../engine/transactionControl.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { panelSurface } from '../../ui/primitives.ts';
import { DataView } from '../../ui/DataView.tsx';
import { StepList } from '../../ui/ScheduleStepList.tsx';
import { MATRIX_COLUMNS, matrixRows } from '../../ui/isolationTable.ts';
import { SCHEDULE_COLUMNS, scheduleRows } from '../../ui/transactionTables.ts';
import { ScrollRegion } from '../../ui/ScrollRegion.tsx';
import { writeAddressBar } from '../../ui/addressBar.ts';

/**
 * plan.md §25.4 D5: the ten Hermitage anomalies at four isolation levels, on three engines. Nothing here is a lookup:
 * each cell is a schedule that was run, judged by what its transactions saw and wrote, and every cell opens the
 * schedule that produced it. The published results sit beside the computed ones, and a cell outlined differently
 * says where the two part company.
 */

const ENGINES: { kind: EngineKind; title: string; blurb: string; reference: string }[] = [
  {
    kind: 'locks',
    title: 'Two-phase locking',
    blurb: 'Read locks held for as long as the level says; a predicate lock for each read at SERIALIZABLE.',
    reference: 'SQL Server’s locking levels',
  },
  {
    kind: 'mvcc',
    title: 'Versions and snapshots',
    blurb: 'Readers take no lock. REPEATABLE READ is snapshot isolation; SERIALIZABLE checks reads at commit.',
    reference: 'PostgreSQL',
  },
  {
    kind: 'innodb',
    title: 'InnoDB (MySQL)',
    blurb:
      'READ COMMITTED is a snapshot for each statement. REPEATABLE READ is one snapshot for plain reads and the latest committed row for writes, so a lost update gets through. SERIALIZABLE turns every read into a locking read, with next-key locks on the gaps between index keys. MySQL published only some of these cells; the rest are marked.',
    reference: 'MySQL 5.6, the cells its page ran',
  },
];

interface Selected {
  engine: EngineKind;
  test: AnomalyId;
  level: IsolationLevel;
}

function readCell(raw: string | null): Selected | null {
  if (raw === null) return null;
  const [engine, test, level] = raw.split('.');
  if (engine !== 'locks' && engine !== 'mvcc' && engine !== 'innodb') return null;
  const found = HERMITAGE_TESTS.find((t) => t.id === test);
  const lvl = HERMITAGE_LEVELS.find((l) => l === level);
  return found && lvl ? { engine, test: found.id, level: lvl } : null;
}

export function IsolationToolPage() {
  const { pathname } = useLocation();
  const matrices = useMemo(
    () => ({ locks: hermitageMatrix('locks'), mvcc: hermitageMatrix('mvcc'), innodb: hermitageMatrix('innodb') }),
    [],
  );
  const [selected, setSelected] = useState<Selected>(() => {
    const fromUrl = readCell(new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('c'));
    return fromUrl ?? { engine: 'mvcc', test: 'G2-item', level: 'repeatable-read' };
  });

  const cell: MatrixCell | undefined = matrices[selected.engine].find(
    (c) => c.test === selected.test && c.level === selected.level,
  );
  const test = HERMITAGE_TESTS.find((t) => t.id === selected.test)!;
  const documented = DOCUMENTED[selected.engine][selected.level][selected.test];
  const known = KNOWN_DIFFERENCES.find(
    (d) => d.engine === selected.engine && d.level === selected.level && d.test === selected.test,
  );

  function choose(next: Selected) {
    setSelected(next);
    const params = new URLSearchParams();
    params.set('c', `${next.engine}.${next.test}.${next.level}`);
    // On a click rather than from an effect: an untouched matrix keeps a bare URL.
    writeAddressBar(params.toString(), pathname);
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Isolation matrix">
        Ten anomalies from the Hermitage suite, each a fixed schedule of three transactions, run at four isolation
        levels on three engines (plan.md §25.4 D5). A <strong>—</strong> means the anomaly <em>happened</em> in that
        schedule at that level; a <strong>✓</strong> means it did not. Every cell was computed by running the schedule
        and checking what its transactions saw and wrote, and opens the run. The tables are held against what
        PostgreSQL, SQL Server and MySQL publish — for MySQL only the cells its page ran; the{' '}
        <Link to="/tools/schedule" className="underline underline-offset-2 hover:text-ink">
          transaction schedules
        </Link>{' '}
        tool is where you build your own.
      </PageHeader>

      <DataView
        caption="Every anomaly at every isolation level on all three engines, with the published result beside each"
        columns={MATRIX_COLUMNS}
        rows={matrixRows(matrices)}
        keyOf={(r, i) => `${String(i)}-${r.anomaly}`}
      >
        <div className="flex flex-col gap-4">
        {ENGINES.map((engine) => (
          <div key={engine.kind} className={`${panelSurface} p-4`}>
            <h2 className="text-body font-semibold text-ink">{engine.title}</h2>
            <p className="mb-2 text-label text-ink-dim">
              {engine.blurb} Compared with {engine.reference}.
            </p>
            <ScrollRegion label={`Which anomalies can occur, by isolation level, under ${engine.title}`} className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left text-label">
                <caption className="sr-only">
                  Which anomalies can occur, by isolation level, under {engine.title}
                </caption>
                <thead>
                  <tr className="text-ink-dim">
                    <th scope="col" className="py-1 pr-3 font-medium">Anomaly</th>
                    {HERMITAGE_LEVELS.map((level) => (
                      <th key={level} scope="col" className="px-2 py-1 text-center font-medium">
                        {HERMITAGE_LEVEL_LABELS[level]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {HERMITAGE_TESTS.map((t) => (
                    <tr key={t.id}>
                      <th scope="row" className="py-0.5 pr-3 font-normal text-ink">
                        <span className="font-mono">{t.id}</span> <span className="text-ink-dim">{t.name}</span>
                      </th>
                      {HERMITAGE_LEVELS.map((level) => {
                        const c = matrices[engine.kind].find((x) => x.test === t.id && x.level === level)!;
                        const published = DOCUMENTED[engine.kind][level][t.id];
                        const differs = published !== null && c.occurred !== published;
                        const isSelected =
                          selected.engine === engine.kind && selected.test === t.id && selected.level === level;
                        return (
                          <td key={level} className="px-1 py-0.5 text-center">
                            <button
                              type="button"
                              onClick={() => { choose({ engine: engine.kind, test: t.id, level }); }}
                              aria-pressed={isSelected}
                              aria-label={`${t.id} at ${HERMITAGE_LEVEL_LABELS[level]}, ${engine.title}: ${
                                c.occurred ? 'can occur' : 'prevented'
                              }${differs ? ', differs from the published result' : ''}${
                                published === null ? ', no published result' : ''
                              }`}
                              className={`w-full rounded-md border px-2 py-1 font-mono ${
                                isSelected ? 'border-accent' : differs ? 'border-dashed border-ink-dim' : 'border-edge'
                              } ${c.occurred ? 'text-evict' : 'text-hit'}`}
                            >
                              {c.occurred ? '—' : '✓'}
                              {differs ? '*' : ''}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </div>
        ))}
        </div>
      </DataView>

      {cell && (
        <div className={`${panelSurface} p-4`} aria-label="The schedule behind the selected cell" role="region">
          <h2 className="text-body font-semibold text-ink">
            <span className="font-mono">{test.id}</span> {test.name} at {HERMITAGE_LEVEL_LABELS[selected.level]},{' '}
            {ENGINES.find((e) => e.kind === selected.engine)!.title}
          </h2>
          <p className="mt-1 text-label text-ink-dim">{test.means}</p>
          <p className="mt-2 text-label text-ink" role="status">
            {cell.occurred ? 'It happened.' : 'It did not happen.'}{' '}
            {documented === null ? (
              'Nothing was published for this cell, so it is not held against a result.'
            ) : (
              <>
                The published result is that it {documented ? 'can occur' : 'is prevented'} at this level
                {cell.occurred === documented ? ', which agrees.' : '.'}
              </>
            )}
          </p>
          {known && <p className="mt-1 text-label text-ink-dim">{known.why}</p>}
          <div className="mt-3">
            <DataView
              caption="The schedule behind the selected cell, one row for each thing that happened"
              columns={SCHEDULE_COLUMNS}
              rows={scheduleRows(cell.result.steps)}
              keyOf={(r, i) => `${String(i)}-${String(r.n)}`}
            >
              <StepList steps={cell.result.steps} />
            </DataView>
          </div>
        </div>
      )}
    </div>
  );
}
