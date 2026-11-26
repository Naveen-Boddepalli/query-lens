/**
 * The tool workbench: one layout system for every page under /tools (docs/research/tool-layouts.md §4).
 *
 * ToolShell lays out the regions; each other component is one region or one kind of control in it. A page keeps its
 * own state and URL handling and moves its controls into these slots.
 */
export { ToolShell, type ToolShellProps } from './ToolShell.tsx';
export { ToolHeader, type ToolHeaderProps } from './ToolHeader.tsx';
export { Inspector, type InspectorProps } from './Inspector.tsx';
export { ControlGroup, type ControlGroupProps } from './ControlGroup.tsx';
export { ControlRow, type ControlRowProps } from './ControlRow.tsx';
export { hintIdFor } from './controlIds.ts';
export { Segmented, type SegmentedOption, type SegmentedProps } from './Segmented.tsx';
export { Stepper, type StepperProps } from './Stepper.tsx';
export { Switch, type SwitchProps } from './Switch.tsx';
export { ScenarioPicker, type Scenario, type ScenarioPickerProps } from './ScenarioPicker.tsx';
export { CommandBar, type Command, type CommandBarProps } from './CommandBar.tsx';
export { StagePanel, type StagePanelProps } from './StagePanel.tsx';
export { MetricStrip, type Metric } from './MetricStrip.tsx';
export { Transport, type Phase, type TransportProps } from './Transport.tsx';
export { ResponsiveTable } from './ResponsiveTable.tsx';
export { ToolSection, type ToolSectionProps } from './ToolSection.tsx';
export { CATEGORY_STAGE, stageStyle, type ToolCategory } from './toolCategory.ts';
export { useMediaQuery, WIDE } from './useMediaQuery.ts';
