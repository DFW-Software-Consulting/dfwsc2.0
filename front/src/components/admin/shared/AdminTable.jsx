import AdminCard from "./AdminCard";
import Button from "./Button";
import ErrorMessage from "./ErrorMessage";
import LoadingSpinner from "./LoadingSpinner";
import RowActions from "./RowActions";
import { useIsDesktop } from "./useMinWidth";

// Column definition: { header, key | render(row), tdClassName, actions(row) }.
// `actions` returns RowActions specs; the table shows them as buttons and the mobile
// cards show the primary one plus an overflow menu. The first column is the card title
// unless a column sets `cardTitle`. Set `cardHidden` to leave a column out of the cards.
function cellValue(col, row) {
  return col.render ? col.render(row) : col.key ? row[col.key] : null;
}

export default function AdminTable({
  columns,
  rows,
  isLoading,
  isError,
  error,
  onRetry,
  emptyMessage = "No records found.",
  keyField = "id",
  loadingMessage,
}) {
  const isDesktop = useIsDesktop();
  if (isLoading) return <LoadingSpinner message={loadingMessage} />;

  if (isError) {
    return (
      <div className="text-center py-4">
        <ErrorMessage message={error?.message} />
        {onRetry && (
          <div className="mt-3">
            <Button size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-fg-muted text-sm">{emptyMessage}</p>
      </div>
    );
  }

  if (!isDesktop) {
    const titleCol = columns.find((c) => c.cardTitle) ?? columns.find((c) => !c.actions);
    const actionsCol = columns.find((c) => c.actions);
    const fieldCols = columns.filter((c) => c !== titleCol && c !== actionsCol && !c.cardHidden);
    return (
      <ul className="grid gap-3" data-testid="admin-cards">
        {rows.map((row) => (
          <AdminCard
            key={row[keyField]}
            title={cellValue(titleCol, row)}
            fields={fieldCols.map((c) => ({
              label: c.header,
              value: cellValue(c, row) ?? "—",
              className: c.cardClassName ?? c.tdClassName,
            }))}
            actions={
              actionsCol ? <RowActions mode="card" actions={actionsCol.actions(row)} /> : null
            }
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="scroll-shade-x overflow-x-auto transition-colors duration-300">
      <table className="min-w-full divide-y divide-line transition-colors">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.header}
                className="px-3 py-2 text-left text-xs font-medium text-fg-muted uppercase tracking-wider transition-colors"
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line text-fg transition-colors">
          {rows.map((row) => (
            <tr key={row[keyField]} className="hover:bg-surface transition-colors">
              {columns.map((col) => (
                <td
                  key={col.header}
                  className={`px-3 py-2 whitespace-nowrap text-sm transition-colors ${col.tdClassName ?? ""}`}
                >
                  {col.actions ? <RowActions actions={col.actions(row)} /> : cellValue(col, row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
