// backend/tests/helpers/prismaMock.js
import { prisma } from "../../src/db.js";

const originalMethods = new Map();

/**
 * Creates mock implementations for Prisma models.
 */
export function mockPrisma(overrides = {}) {
  const models = ["user", "project", "preview", "previewMetric", "build", "webhookDelivery"];
  const defaultMethods = [
    "findUnique",
    "findFirst",
    "findMany",
    "create",
    "update",
    "updateMany",
    "upsert",
    "delete",
    "deleteMany",
    "count"
  ];

  for (const model of models) {
    if (!prisma[model]) {
      prisma[model] = {};
    }

    for (const method of defaultMethods) {
      const key = `${model}.${method}`;
      if (!originalMethods.has(key)) {
        originalMethods.set(key, prisma[model][method]);
      }

      // Check if an override is provided for model.method
      if (overrides[model] && overrides[model][method]) {
        prisma[model][method] = overrides[model][method];
      } else if (!overrides[model] || overrides[model][method] === undefined) {
        // Default safe stub that returns null/empty array/0 rather than querying DB
        prisma[model][method] = async () => {
          if (method === "findMany") return [];
          if (method === "count") return 0;
          return null;
        };
      }
    }
  }

  return {
    restore() {
      for (const [key, original] of originalMethods.entries()) {
        const [model, method] = key.split(".");
        if (original !== undefined) {
          prisma[model][method] = original;
        } else {
          delete prisma[model][method];
        }
      }
      originalMethods.clear();
    }
  };
}

/**
 * Executes an async callback with scoped Prisma mocks and guaranteed restoration.
 */
export async function withMockPrisma(overrides, fn) {
  const { restore } = mockPrisma(overrides);
  try {
    return await fn();
  } finally {
    restore();
  }
}
