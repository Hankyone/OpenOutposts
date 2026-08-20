import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";

export const HOMESTEAD_READINESS_KEY = "/api/homesteads/readiness";
const READINESS_REFRESH_INTERVAL_MS = 15_000;

interface HomesteadReadinessResponse {
  connected: boolean;
}

/** Live answer to whether a homestead can accept a session. */
export function useHomesteadReadiness() {
  const { data: session, status } = useAuthSession();
  const { data, error, isLoading } = useSWR<HomesteadReadinessResponse>(
    session ? HOMESTEAD_READINESS_KEY : null,
    { refreshInterval: READINESS_REFRESH_INTERVAL_MS }
  );

  return {
    connected: data?.connected ?? null,
    loading: status === "loading" || isLoading,
    unavailable: Boolean(error),
  };
}
