import type { ReactNode } from 'react';
import { stageStyle, type ToolCategory } from './toolCategory.ts';

export interface ToolShellProps {
  /** Sets `--stage`, so the stage panel, stage-toned controls and the transport share the family's hue. */
  category: ToolCategory;
  /** `ToolHeader`. */
  header: ReactNode;
  /** `Inspector`: every parameter and the scenario picker. Omit for a tool with nothing to configure. */
  inspector?: ReactNode;
  /** `CommandBar`: the operations, above what they act on. */
  command?: ReactNode;
  /** `MetricStrip`. */
  metrics?: ReactNode;
  /** `StagePanel`: the visualization. */
  stage: ReactNode;
  /** One live line saying what the current step did. Announced politely. */
  narration?: ReactNode;
  /** `Transport`, on step-based tools. Sticks to the bottom while the stage scrolls. */
  transport?: ReactNode;
  /** The deep dive: `ToolSection`s below the live model. */
  children?: ReactNode;
}

/**
 * The tool workbench (docs/research/tool-layouts.md §4.1): header, then an inspector rail beside the stage column
 * from `lg` up, then the deep dive. Below `lg` the regions stack in reading order: inspector (collapsed to its
 * summary), command bar, metrics, stage, narration, transport.
 *
 * Every region is a slot rather than a prop bag, so a page keeps its own state and URL handling and only moves its
 * controls into place.
 */
export function ToolShell({ category, header, inspector, command, metrics, stage, narration, transport, children }: ToolShellProps) {
  return (
    <div className="flex min-w-0 flex-col gap-(--tool-gap)" style={stageStyle(category)} data-tool-shell="">
      {header}
      <div
        className={
          inspector
            ? 'grid min-w-0 gap-(--tool-gap) lg:grid-cols-[var(--tool-rail)_minmax(0,1fr)] lg:items-start'
            : 'flex min-w-0 flex-col'
        }
      >
        {inspector}
        <div className="flex min-w-0 flex-col gap-(--tool-gap)">
          {command}
          {metrics}
          {stage}
          {narration !== undefined && (
            <p role="status" className="min-h-[1.45em] text-body text-ink">
              {narration}
            </p>
          )}
          {transport}
        </div>
      </div>
      {children}
    </div>
  );
}
