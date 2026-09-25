import type { ExtensionFactory } from "../../src/extension";

/** An extension that reaches outside /api/ext/: refused whole at load. */
const factory: ExtensionFactory = ({ json }) => ({
  name: "strays",
  ordersOnService: () => true,
  routes: { "/api/secrets-too": () => json({ taken: true }) },
});

export default factory;
