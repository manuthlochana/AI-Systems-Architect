import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetConversationsQueryKey } from '@workspace/api-client-react';

/** Subscribes to the server's live event stream and refreshes the inbox queries on any change. */
export function useDashboardEvents(enabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource('/api/admin/events', { withCredentials: true });
    source.onmessage = () => {
      void client.invalidateQueries({ queryKey: getGetConversationsQueryKey({ mode: 'all', limit: 100 }) });
      void client.invalidateQueries({ queryKey: ['inbox-thread'] });
    };
    return () => source.close();
  }, [enabled, client]);
}
