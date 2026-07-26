/**
 * React-bound branding context object + hook. Split from the non-React
 * `branding-base` surface so Node-side consumers can import branding values
 * without pulling `react` into their runtime closure.
 */
import { createContext, useContext } from "react";
import { DEFAULT_BRANDING } from "./branding-base.js";
export const BrandingContext = createContext(undefined);
export function useBranding() {
    return useContext(BrandingContext) ?? DEFAULT_BRANDING;
}
