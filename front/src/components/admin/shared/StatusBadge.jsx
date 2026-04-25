const COLOR_MAP = {
  active: "bg-green-800 text-green-200",
  paid: "bg-green-800 text-green-200",
  succeeded: "bg-green-800 text-green-200",
  pending: "bg-yellow-800 text-yellow-200",
  open: "bg-yellow-800 text-yellow-200",
  paused: "bg-yellow-800 text-yellow-200",
  processing: "bg-yellow-800 text-yellow-200",
  inactive: "bg-red-800 text-red-200",
  cancelled: "bg-red-800 text-red-200",
  canceled: "bg-red-800 text-red-200",
  void: "bg-red-800 text-red-200",
  uncollectible: "bg-red-800 text-red-200",
  failed: "bg-red-800 text-red-200",
  completed: "bg-blue-800 text-blue-200",
  onboarded: "bg-blue-800 text-blue-200",
  past_due: "bg-orange-800 text-orange-200",
  unpaid: "bg-orange-800 text-orange-200",
  trialing: "bg-blue-800 text-blue-200",
  lead: "bg-purple-800 text-purple-200",
};

export default function StatusBadge({ status }) {
  return (
    <span
      className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${COLOR_MAP[status] ?? "bg-gray-700 text-gray-200"}`}
    >
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
