import { useMutation } from "@tanstack/react-query";
import {
  regenerateApiKey,
  requestApiKeyRegeneration,
  requestApiKeyRegenerationAdmin,
} from "../api/apiKey";
import { useAuth } from "../contexts/AuthContext";

export function useRequestApiKeyRegeneration() {
  return useMutation({
    mutationFn: (email) => requestApiKeyRegeneration(email),
  });
}

export function useRequestApiKeyRegenerationAdmin() {
  const { token } = useAuth();
  return useMutation({
    mutationFn: (clientId) => requestApiKeyRegenerationAdmin(token, clientId),
  });
}

export function useRegenerateApiKey() {
  return useMutation({
    mutationFn: (regenerationToken) => regenerateApiKey(regenerationToken),
  });
}
