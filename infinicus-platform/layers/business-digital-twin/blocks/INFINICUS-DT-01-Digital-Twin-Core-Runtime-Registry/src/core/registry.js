(function (global) {
  "use strict";

  function createRegistry(name) {
    const items = new Map();

    // Values may hold functions (service APIs) that structuredClone
    // rejects, so only the plain-data metadata is cloned.
    function snapshot(record) {
      return {
        ...record,
        metadata: structuredClone(record.metadata)
      };
    }

    function register(id, value, metadata = {}) {
      const key = String(id || "").trim();

      if (!key) {
        return global.INFINICUS.DT.result.failure(
          "REGISTRY_ID_REQUIRED",
          `${name} registry requires an identifier.`
        );
      }

      if (items.has(key)) {
        return global.INFINICUS.DT.result.failure(
          "REGISTRY_DUPLICATE",
          `${name} registry already contains: ${key}`
        );
      }

      const record = {
        id: key,
        value,
        metadata: structuredClone(metadata),
        registeredAt: new Date().toISOString()
      };

      items.set(key, record);

      return global.INFINICUS.DT.result.success(
        snapshot(record)
      );
    }

    function get(id) {
      const record = items.get(String(id || ""));

      return record
        ? global.INFINICUS.DT.result.success(snapshot(record))
        : global.INFINICUS.DT.result.failure(
            "REGISTRY_ITEM_NOT_FOUND",
            `${name} registry item was not found.`,
            { id }
          );
    }

    function has(id) {
      return items.has(String(id || ""));
    }

    function list() {
      return global.INFINICUS.DT.result.success(
        [...items.values()].map(snapshot)
      );
    }

    function remove(id) {
      const key = String(id || "");

      if (!items.has(key)) {
        return global.INFINICUS.DT.result.failure(
          "REGISTRY_ITEM_NOT_FOUND",
          `${name} registry item was not found.`,
          { id }
        );
      }

      const record = items.get(key);
      items.delete(key);

      return global.INFINICUS.DT.result.success(
        snapshot(record)
      );
    }

    return Object.freeze({
      name,
      register,
      get,
      has,
      list,
      remove,
      size: () => items.size
    });
  }

  global.INFINICUS.DT.registryFactory =
    Object.freeze({ createRegistry });
})(window);
