import FormInput from "./FormInput";

const OPTIONS_WITH_INHERIT = [
  { value: "none", label: "Inherit / None" },
  { value: "percent", label: "Percent (%)" },
  { value: "cents", label: "Flat (cents)" },
];

const OPTIONS_WITHOUT_INHERIT = [
  { value: "none", label: "None" },
  { value: "percent", label: "Percent (%)" },
  { value: "cents", label: "Flat (cents)" },
];

export default function FeeConfigSection({
  feeType,
  feeValue,
  onFeeTypeChange,
  onFeeValueChange,
  hint,
  hintColor = "gray",
  showHintAlways = false,
  disabled,
  radioName = "feeType",
  showInheritOption = false,
}) {
  const options = showInheritOption ? OPTIONS_WITH_INHERIT : OPTIONS_WITHOUT_INHERIT;
  const showHint = hint && (showHintAlways || feeType === "none");

  return (
    <div className="mb-4">
      <p className="block text-sm font-medium text-gray-300 mb-2">Processing Fee</p>
      <div className="flex flex-wrap gap-4 mb-2">
        {options.map(({ value, label }) => (
          <label
            key={value}
            className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer"
          >
            <input
              type="radio"
              name={radioName}
              value={value}
              checked={feeType === value}
              onChange={() => onFeeTypeChange(value)}
              disabled={disabled}
              className="accent-blue-500"
            />
            {label}
          </label>
        ))}
      </div>
      {feeType !== "none" && (
        <FormInput
          id={`${radioName}-value`}
          type="number"
          value={feeValue}
          onChange={(e) => onFeeValueChange(e.target.value)}
          placeholder={feeType === "percent" ? "e.g. 2.5" : "e.g. 50  (= $0.50)"}
          min="0"
          step={feeType === "percent" ? "0.01" : "1"}
          disabled={disabled}
        />
      )}
      {showHint && (
        <p className={`mt-1.5 text-xs ${hintColor === "blue" ? "text-blue-400" : "text-gray-400"}`}>
          {hint}
        </p>
      )}
    </div>
  );
}
