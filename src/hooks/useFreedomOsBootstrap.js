import { useCallback, useEffect, useState } from "react";
import {
  fetchAgents,
  fetchCeoAgent,
  fetchCeoDigest,
  fetchNotifications,
} from "../utils/agentsApi.js";
import { describeAgentApiError } from "../components/freedomOs/freedomOsShared.js";

/**
 * Loads everything the Freedom OS home needs when the tab mounts: CEO config,
 * cached digest, the agent grid, and the unread-notification count — all in
 * parallel, each with its own error state so one failing call never blanks
 * the whole view. Plain useState/useEffect, no query library (matches the
 * rest of the app).
 */
export function useFreedomOsBootstrap({ user, enabled = true } = {}) {
  const [ceoAgent, setCeoAgent] = useState(null);
  const [ceoError, setCeoError] = useState("");
  const [digest, setDigest] = useState(null);
  const [digestError, setDigestError] = useState("");
  const [agents, setAgents] = useState(null);
  const [agentsError, setAgentsError] = useState("");
  const [unreadCount, setUnreadCount] = useState(0);
  const [isLoading, setIsLoading] = useState(enabled);
  const [reloadToken, setReloadToken] = useState(0);

  const options = { user };

  const refreshCeo = useCallback(async () => {
    try {
      const payload = await fetchCeoAgent({ user });
      setCeoAgent(payload?.ceoAgent || null);
      setCeoError("");
      return payload?.ceoAgent || null;
    } catch (error) {
      setCeoError(describeAgentApiError(error, "Unable to load your CEO Agent."));
      return null;
    }
  }, [user]);

  const refreshAgents = useCallback(async () => {
    try {
      const payload = await fetchAgents({ user });
      setAgents(Array.isArray(payload?.agents) ? payload.agents : []);
      setAgentsError("");
    } catch (error) {
      setAgentsError(describeAgentApiError(error, "Unable to load your agents."));
    }
  }, [user]);

  const refreshUnreadCount = useCallback(async () => {
    try {
      const payload = await fetchNotifications({ unreadOnly: true }, { user });
      setUnreadCount(Array.isArray(payload?.notifications) ? payload.notifications.length : 0);
    } catch {
      // Non-critical: leave the last known count in place.
    }
  }, [user]);

  const reload = useCallback(() => {
    setReloadToken((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!enabled || !user) return undefined;
    let cancelled = false;

    const bootstrap = async () => {
      setIsLoading(true);
      const [ceoResult, digestResult, agentsResult, notificationsResult] =
        await Promise.allSettled([
          fetchCeoAgent(options),
          fetchCeoDigest({}, options),
          fetchAgents(options),
          fetchNotifications({ unreadOnly: true }, options),
        ]);
      if (cancelled) return;

      if (ceoResult.status === "fulfilled") {
        setCeoAgent(ceoResult.value?.ceoAgent || null);
        setCeoError("");
      } else {
        setCeoError(describeAgentApiError(ceoResult.reason, "Unable to load your CEO Agent."));
      }

      if (digestResult.status === "fulfilled") {
        setDigest(digestResult.value || null);
        setDigestError("");
      } else {
        setDigestError(
          describeAgentApiError(digestResult.reason, "Unable to load the daily digest.")
        );
      }

      if (agentsResult.status === "fulfilled") {
        setAgents(Array.isArray(agentsResult.value?.agents) ? agentsResult.value.agents : []);
        setAgentsError("");
      } else {
        setAgentsError(describeAgentApiError(agentsResult.reason, "Unable to load your agents."));
      }

      if (notificationsResult.status === "fulfilled") {
        setUnreadCount(
          Array.isArray(notificationsResult.value?.notifications)
            ? notificationsResult.value.notifications.length
            : 0
        );
      }

      setIsLoading(false);
    };

    void bootstrap();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, user, reloadToken]);

  return {
    ceoAgent,
    setCeoAgent,
    ceoError,
    digest,
    setDigest,
    digestError,
    setDigestError,
    agents,
    setAgents,
    agentsError,
    unreadCount,
    setUnreadCount,
    isLoading,
    refreshCeo,
    refreshAgents,
    refreshUnreadCount,
    reload,
  };
}
