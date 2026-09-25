/**
 * What the pages draw where a private extension would add its own: nothing.
 *
 * `@extension` resolves to `src/extension/deposited/index.tsx` when a deployment deposited one,
 * and to this file otherwise (vite.config.ts, tsconfig paths). Both export the same names: a
 * slot added here is a slot every extension has to export.
 */

/** Under the rows of the Account page: a subscription, a bill. */
export function AccountSection() {
  return null
}
