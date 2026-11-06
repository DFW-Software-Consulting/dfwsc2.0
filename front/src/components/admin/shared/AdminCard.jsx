/**
 * One record as a stacked card for phones: a title row, label/value pairs, then
 * an actions area. `leading` sits before the title (e.g. an expand chevron) and
 * `children` render below the actions (e.g. an expanded member list).
 */
export default function AdminCard({ title, leading, fields = [], actions, children }) {
  return (
    <li className="rounded-lg border border-line bg-card p-4 text-fg">
      <div className="flex items-start gap-2">
        {leading}
        <h4 className="min-w-0 flex-1 text-base font-semibold [overflow-wrap:anywhere] self-center">
          {title}
        </h4>
      </div>
      {fields.length > 0 && (
        <dl className="mt-3 grid grid-cols-[minmax(5.5rem,auto)_minmax(0,1fr)] items-center gap-x-4 gap-y-2 text-sm">
          {fields.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-xs font-medium uppercase tracking-wider text-fg-muted">
                {f.label}
              </dt>
              <dd className={`min-w-0 [overflow-wrap:anywhere] ${f.className ?? ""}`}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {actions && <div className="mt-4 border-t border-line pt-3">{actions}</div>}
      {children}
    </li>
  );
}
