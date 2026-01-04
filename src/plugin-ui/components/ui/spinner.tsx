import { Loader2 } from "lucide-react";
import { cn } from "@/plugin-ui/utils/utils";

interface SpinnerProps {
  className?: string;
  size?: "sm" | "md" | "lg";
}

const sizeClasses = {
  sm: "h-3 w-3",
  md: "h-4 w-4",
  lg: "h-6 w-6",
};

/**
 * Loading spinner component using Loader2 from lucide-react (shadcn UI compatible)
 */
export function Spinner({ className, size = "md" }: SpinnerProps) {
  return (
    <Loader2
      className={cn("animate-spin", sizeClasses[size], className)}
      aria-label="Loading"
    />
  );
}

/**
 * Loading spinner overlay component for node loading states
 * Centers the spinner within the container with a semi-transparent overlay
 */
interface SpinnerOverlayProps {
  className?: string;
  size?: "sm" | "md" | "lg";
}

export function SpinnerOverlay({
  className,
  size = "md",
}: SpinnerOverlayProps) {
  return (
    <div
      className={cn(
        "absolute inset-0 flex items-center justify-center bg-white/50 backdrop-blur-sm",
        className
      )}
      aria-label="Loading SVG"
    >
      <Spinner size={size} />
    </div>
  );
}

