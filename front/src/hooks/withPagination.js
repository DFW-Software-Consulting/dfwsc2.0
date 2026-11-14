// Normalises a list response (a bare array or a `{ data, total, limit, offset }` page) into the
// data array with a `pagination` property attached.
export function withPagination(response) {
  const data = Array.isArray(response) ? response : response.data;
  return Object.assign(data ?? [], {
    pagination: Array.isArray(response)
      ? { total: response.length, limit: response.length, offset: 0 }
      : { total: response.total, limit: response.limit, offset: response.offset },
  });
}
