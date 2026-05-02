import ErrorMessage from "./ErrorMessage";
import LoadingSpinner from "./LoadingSpinner";

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
  if (isLoading) return <LoadingSpinner message={loadingMessage} />;

  if (isError) {
    return (
      <div className="text-center py-4">
        <ErrorMessage message={error?.message} />
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 text-sm bg-blue-600 hover:bg-blue-700 text-white py-1 px-3 rounded-md transition-colors"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-400 text-sm">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto transition-colors duration-300">
      <table className="min-w-full divide-y divide-slate-200 dark:divide-gray-700 transition-colors">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.header}
                className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-gray-300 uppercase tracking-wider transition-colors"
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-gray-800 transition-colors">
          {rows.map((row) => (
            <tr
              key={row[keyField]}
              className="hover:bg-slate-50 dark:hover:bg-gray-700/50 transition-colors"
            >
              {columns.map((col) => (
                <td
                  key={col.header}
                  className={`px-3 py-2 whitespace-nowrap text-sm text-slate-700 dark:text-gray-200 transition-colors ${col.tdClassName ?? ""}`}
                >
                  {col.render ? col.render(row) : col.key ? row[col.key] : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
