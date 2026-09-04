export function Steps({ children }: { children: React.ReactNode }) {
  return (
    <div className="docs-steps border-l-2 border-edge pl-6 my-6 space-y-6">
      {children}
    </div>
  );
}

export function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 my-6">
      {children}
    </div>
  );
}

export function Card({ title, icon, children }: { title: string; icon?: string; children: React.ReactNode }) {
  return (
    <div className="cell rounded-lg border border-edge bg-surface-2 p-4">
      <h3 className="text-body font-semibold text-ink flex items-center gap-2">
        {icon && <span>{icon}</span>}
        {title}
      </h3>
      <div className="mt-2 text-label text-ink-dim">
        {children}
      </div>
    </div>
  );
}
