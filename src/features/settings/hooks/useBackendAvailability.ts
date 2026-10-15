import { backend } from '../../../services/backendAdapter';

/**
 * Synchronously reads backend.isAvailable once, without subscriptions or local state—
 * verbatim equivalent to the original inline read in SettingsPanel (do not introduce subscriptions/state).
 */
export const useBackendAvailability = (): boolean => backend.isAvailable;
