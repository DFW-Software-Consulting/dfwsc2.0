export default function ErrorMessage({ message, className }) {
  if (!message) return null;
  return (
    <p role="alert" className={`text-sm text-red-400 ${className ?? ""}`}>
      {message}
    </p>
  );
}
