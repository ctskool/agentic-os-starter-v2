export const GALAXY_VARIANTS = {
  open: { label: "Open", arms: 3, radius: 3.2, winding: 1.65, width: 1 },
  tight: { label: "Tight", arms: 4, radius: 3.0, winding: 2.1, width: 0.72 },
  woven: { label: "Woven", arms: 5, radius: 2.85, winding: 2.45, width: 0.58 },
} as const;
export type GalaxyVariant = keyof typeof GALAXY_VARIANTS;
