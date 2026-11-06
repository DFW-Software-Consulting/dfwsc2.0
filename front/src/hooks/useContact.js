import { useMutation } from "@tanstack/react-query";
import { submitContact } from "../api/contact";

export function useContactForm() {
  return useMutation({
    mutationFn: (body) => submitContact(body),
  });
}
