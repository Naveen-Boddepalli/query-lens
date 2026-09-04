import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar.tsx';

/**
 * Layout for the /stages section — sidebar + page content.
 *
 * The sidebar lists all pipeline stages grouped by category. On mobile
 * it stacks above the content; on desktop it sits as a fixed-width column
 * to the left, matching the React Flow docs layout.
 */
export function StagesLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <Sidebar />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
