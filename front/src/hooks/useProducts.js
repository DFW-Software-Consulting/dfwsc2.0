import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createProduct, getProducts } from "../api/products";
import { useAuth } from "../contexts/AuthContext";

export function useProducts() {
  const { token } = useAuth();
  return useQuery({
    queryKey: ["products"],
    queryFn: () => getProducts(token),
    enabled: !!token,
  });
}

export function useCreateProduct() {
  const { token } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => createProduct(token, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["products"] }),
  });
}
