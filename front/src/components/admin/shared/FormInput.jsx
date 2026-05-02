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
  return (
    <div className={wrapperClassName}>
      {label && (
        <label
          htmlFor={id}
          className="block text-sm font-medium text-slate-700 dark:text-gray-300 mb-1 transition-colors"
        >
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
        className={`w-full rounded-md border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-900/50 px-3 py-2 text-slate-900 dark:text-gray-100 placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500 dark:focus:ring-blue-500 focus:border-brand-500 dark:focus:border-blue-500 transition-all ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`}
      />
      {helper && (
        <p className="mt-1 text-xs text-slate-500 dark:text-gray-400 transition-colors">{helper}</p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
