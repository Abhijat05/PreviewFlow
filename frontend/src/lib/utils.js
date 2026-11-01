import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function formatBytesToMB(bytes) {
  if (!bytes) return 0;
  return Number((bytes / (1024 * 1024)).toFixed(1));
}
