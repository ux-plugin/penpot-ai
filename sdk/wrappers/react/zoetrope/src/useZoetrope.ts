import { useContext } from 'react';

import { ZoetropeContext } from './ZoetropeProvider';
import type { ZoetropeContextValue } from './types';

/**
 * Access the active zoetrope session. Must be called inside a
 * {@link ZoetropeProvider}.
 */
export function useZoetrope(): ZoetropeContextValue {
  const ctx = useContext(ZoetropeContext);
  if (ctx === null) {
    throw new Error(
      'useZoetrope() must be called inside a <ZoetropeProvider />.',
    );
  }
  return ctx;
}
