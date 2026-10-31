export default function FormInput({
  id,
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  error,
  helper,
  disabled,
  maxLength,
  required,
  autoComplete,
  min,
  step,
  className = "",
  wrapperClassName = "",
}) {
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className={wrapperClassName}>
      {label && (
        <label htmlFor={id} className="block text-sm font-medium text-fg mb-1 transition-colors">
          {label}
        </label>
      )}
      <input
        id={id}
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        required={required}
        autoComplete={autoComplete}
        min={min}
        step={step}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className={`w-full rounded-md border border-line-strong bg-card px-3 py-2 text-fg placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-focus focus:border-focus transition-all ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`}
      />
      {helper && <p className="mt-1 text-xs text-fg-muted transition-colors">{helper}</p>}
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
