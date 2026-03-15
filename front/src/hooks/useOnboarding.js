import { useMutation } from "@tanstack/react-query";
import { initiateOnboarding } from "../api/onboarding";

export function useInitiateOnboarding() {
  return useMutation({
    mutationFn: initiateOnboarding,
  });
}
