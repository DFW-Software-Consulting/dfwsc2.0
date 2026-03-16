export default function LoadingSpinner({ message = "Loading...", size = "md" }) {
  const isSmall = size === "sm";
  return (
    <div className="text-center py-8">
      <div
        className={`inline-block animate-spin rounded-full border-t-2 border-b-2 border-blue-500 ${
          isSmall ? "h-6 w-6" : "h-8 w-8"
        }`}
      />
      <p className={isSmall ? "mt-2 text-sm text-gray-400" : "mt-3 text-gray-300"}>{message}</p>
    </div>
  );
}
