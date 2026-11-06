const COLOR_MAP = {
  active: "bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-200",
  paid: "bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-200",
  succeeded: "bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-200",
  pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200",
  open: "bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200",
  paused: "bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200",
  processing: "bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200",
  inactive: "bg-red-100 text-red-800 dark:bg-red-800 dark:text-red-200",
  cancelled: "bg-red-100 text-red-800 dark:bg-red-800 dark:text-red-200",
  canceled: "bg-red-100 text-red-800 dark:bg-red-800 dark:text-red-200",
  void: "bg-red-100 text-red-800 dark:bg-red-800 dark:text-red-200",
  uncollectible: "bg-red-100 text-red-800 dark:bg-red-800 dark:text-red-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-800 dark:text-red-200",
  completed: "bg-blue-100 text-blue-800 dark:bg-blue-800 dark:text-blue-200",
  onboarded: "bg-blue-100 text-blue-800 dark:bg-blue-800 dark:text-blue-200",
  past_due: "bg-orange-100 text-orange-800 dark:bg-orange-800 dark:text-orange-200",
  unpaid: "bg-orange-100 text-orange-800 dark:bg-orange-800 dark:text-orange-200",
  none: "bg-surface text-fg-muted",
  trialing: "bg-blue-100 text-blue-800 dark:bg-blue-800 dark:text-blue-200",
  lead: "bg-purple-100 text-purple-800 dark:bg-purple-800 dark:text-purple-200",
  not_started: "bg-surface text-fg-muted",
  in_progress: "bg-yellow-100 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200",
  ready: "bg-green-100 text-green-800 dark:bg-green-800 dark:text-green-200",
};

const LABEL_MAP = {
  active: "Current",
  trialing: "Current",
  past_due: "Overdue",
  unpaid: "Overdue",
  canceled: "Canceled",
  none: "No Subscription",
  not_started: "Not started",
  in_progress: "In progress",
  ready: "Ready to charge",
};

export default function StatusBadge({ status }) {
  const normalizedStatus = typeof status === "string" ? status : "unknown";
  const label =
    LABEL_MAP[normalizedStatus] ??
    normalizedStatus.charAt(0).toUpperCase() + normalizedStatus.slice(1);

  return (
    <span
      className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${COLOR_MAP[normalizedStatus] ?? "bg-surface text-fg-muted"}`}
    >
      {label}
    </span>
  );
}
