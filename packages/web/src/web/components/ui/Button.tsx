import { cn } from "../../lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  children: React.ReactNode;
}

const variantClass: Record<ButtonVariant, string> = {
  primary: "text-white hover:opacity-90 active:opacity-80",
  secondary: "hover:opacity-80",
  ghost: "hover:opacity-80",
  danger: "text-white hover:opacity-90",
};

const variantStyle: Record<ButtonVariant, React.CSSProperties> = {
  primary: { background: "var(--blue-primary)", color: "white" },
  secondary: { background: "var(--bg-elevated)", color: "var(--text-primary)", border: "1px solid var(--border-strong)" },
  ghost: { background: "transparent", color: "var(--text-secondary)" },
  danger: { background: "var(--red)", color: "white" },
};

const sizeClass: Record<ButtonSize, string> = {
  sm: "text-xs px-3 py-1.5 gap-1.5",
  md: "text-sm px-4 py-2 gap-2",
  lg: "text-base px-5 py-2.5 gap-2",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  children,
  disabled,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium transition-all duration-150 cursor-pointer",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        variantClass[variant],
        sizeClass[size],
        className
      )}
      style={variantStyle[variant]}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <svg className="animate-spin h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {children}
    </button>
  );
}
