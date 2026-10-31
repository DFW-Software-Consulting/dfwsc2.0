/**
 * DFWSC wordmark: the vector mark plus live text.
 * The package's horizontal wordmark SVG sets "SOFTWARE CONSULTING" as an unoutlined
 * <text> in Satoshi, which would fall back to a system font in the browser. The mark
 * is pure paths, so it is shipped alone (/dfwsc-mark.svg) and the text is real text
 * that follows the theme color in both light and dark mode.
 */
export default function Logo({ className = "" }) {
  return (
    <span className={`inline-flex items-end gap-2 ${className}`}>
      <img src="/dfwsc-mark.svg" alt="DFW" width="52" height="40" className="h-10 w-auto" />
      <span className="whitespace-nowrap pb-[3px] text-[12px] min-[420px]:pb-[4px] min-[420px]:text-[16px] font-medium leading-none tracking-[0.04em] text-fg">
        SOFTWARE CONSULTING
      </span>
    </span>
  );
}
