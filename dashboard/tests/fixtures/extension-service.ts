import { existsSync, readFileSync } from "node:fs";
import type { ExtensionFactory } from "../../src/extension";

/**
 * The extension a hosted service would install, reduced to what the API tests exercise: every
 * account orders on the service's cloud accounts - but the address written in the file
 * TEST_OFF_SERVICE_FILE, read at every call, which a test writes to take an account off them mid-run -
 * an order is refused for the address named by TEST_REFUSE_ORDERS_FOR, and one route says who is
 * asking.
 */
const offService = (email: string): boolean => {
  const file = process.env.TEST_OFF_SERVICE_FILE;
  return file !== undefined && existsSync(file) && readFileSync(file, "utf8").trim() === email;
};

const factory: ExtensionFactory = ({ actor, json }) => ({
  name: "test-service",
  ordersOnService: (account) => !offService(account.email),
  refuseOrder: (account, verb) =>
    account.email === process.env.TEST_REFUSE_ORDERS_FOR
      ? { status: 402, error: `${verb} refused: no subscription on this account` }
      : null,
  routes: {
    "/api/ext/whoami": async (req) => {
      const who = await actor(req);
      return who.ok ? json({ id: who.account.id }) : who.response;
    },
  },
});

export default factory;
