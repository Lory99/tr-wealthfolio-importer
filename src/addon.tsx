import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import type { AddonContext, AddonEnableFunction } from "@wealthfolio/addon-sdk";
import { TradeRepublicImporter } from "./App";

// The host owns a single React root per addon and mounts the route `component`
// itself with no access to the addon context. Capture it at enable time so the
// route wrapper can hand it down. (Do NOT call createRoot yourself.)
let addonCtx: AddonContext | undefined;

const AddonRoute = () => (
  <QueryClientProvider client={addonCtx!.api.query.getClient() as QueryClient}>
    <TradeRepublicImporter ctx={addonCtx!} />
  </QueryClientProvider>
);

const enable: AddonEnableFunction = (ctx) => {
  addonCtx = ctx;

  // The route `id` MUST match `contributes.routes[].id` in manifest.json.
  ctx.router.add({
    id: "trade-republic-importer",
    path: "/addons/trade-republic-importer",
    component: AddonRoute,
  });

  ctx.onDisable(() => {
    addonCtx = undefined;
  });
};

export default enable;
