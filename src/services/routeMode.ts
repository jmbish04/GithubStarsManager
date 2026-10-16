import type { RouteMode } from '../types';
import { useAppStore } from '../store/useAppStore';

/**
 * Helper functions for local routing preferences.
 * routeMode determines the outbound route for GitHub / Release data plane requests:
 * - 'auto'   : Retain current behavior (use backend if available, otherwise direct connection)
 * - 'backend': Route via backend only when available (preserves existing default ordering without re-sorting)
 * - 'browser': Bypass backend proxy and route directly through the current device's network
 *
 * Reads via `useAppStore.getState()` to pull the latest value on every invocation.
 * Does NOT subscribe to reactive state changes along the path, preventing routing strategies
 * from switching mid-flight for already constructed services or in-flight requests.
 * Changes to routeMode only apply to newly initiated requests.
 */

/**
 * Resolves the current routeMode, defaulting to 'auto' if missing or not a valid enum value.
 * Prevents initialization/test environments from misinterpreting undefined as browser and bypassing defaults.
 */
function resolveRouteMode(): RouteMode {
  const raw = useAppStore.getState().routeMode;
  return raw === 'backend' || raw === 'browser' ? raw : 'auto';
}

/** Whether requests should bypass the backend proxy and go directly through the current device's network. */
export const shouldBypassBackend = (): boolean => resolveRouteMode() === 'browser';
