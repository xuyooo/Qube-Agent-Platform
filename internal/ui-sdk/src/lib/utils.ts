import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Register our custom font-size keys (tailwind.config.js) so twMerge treats
// text-{micro,mini,tiny} as font-size — otherwise it falls back to "unknown
// text-*" and dedupes them against color utilities like text-muted-foreground.
const twMergeCustom = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['micro', 'mini', 'tiny'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMergeCustom(clsx(inputs))
}
