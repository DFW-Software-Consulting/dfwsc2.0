// The admin lists load one page (up to the API maximum). When the server holds
// more rows than that page, say so instead of silently hiding the rest.
export default function TruncationNotice({ shown, total, noun }) {
  if (typeof total !== "number" || total <= shown) return null;
  return (
    <p className="text-xs text-yellow-400 py-2 text-center" role="status">
      Showing {shown} of {total} {noun}
    </p>
  );
}
